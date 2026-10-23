// SPDX-License-Identifier: MIT
//! Request dispatch (FUNCTIONAL-DESIGN §10.2). Quick requests run on the
//! reader thread; builds and device operations each run on one worker at a
//! time, so a second build or download is refused instead of interleaving.
//! `cancel` reaches the running job through its queue's flag.

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};

use crate::build::{self, Env};
use crate::catalog::Catalog;
use crate::diag::Rules;
use crate::flash::{self, Backups, Ctx, Image, Target};
use crate::locks;
use crate::monitor::Monitor;
use crate::process;
use crate::project::{self, NewProject, Project, TrustStore};
use crate::proto::{Failure, Outcome, Output, arg_bool, arg_opt_str, arg_str};
use crate::stlink;
use crate::toolkit::{self, Toolkit};
use crate::util::{new_id, read_json};

const MAX_LINE: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Queue {
    Build,
    Device,
}

#[derive(Debug)]
struct Inner {
    out: Arc<Output>,
    catalog: Catalog,
    toolkit_root: PathBuf,
    data_dir: PathBuf,
    rules: Rules,
    toolkit: Mutex<Option<(Toolkit, Value)>>,
    monitor: Mutex<Monitor>,
    build_busy: AtomicBool,
    device_busy: AtomicBool,
    build_cancel: AtomicBool,
    device_cancel: AtomicBool,
    backups: Backups,
    trust: TrustStore,
}

#[derive(Debug)]
pub struct Service {
    inner: Arc<Inner>,
}

impl Service {
    pub fn new(resources: PathBuf, toolkit_root: PathBuf, data_dir: PathBuf, sink: Box<dyn std::io::Write + Send>) -> Self {
        let rules = Rules::load(&resources.join("diagnostics.zh-CN.json"));
        Self {
            inner: Arc::new(Inner {
                out: Arc::new(Output::new(sink)),
                catalog: Catalog::new(&resources),
                toolkit_root,
                backups: Backups::new(&data_dir),
                trust: TrustStore::new(&data_dir),
                data_dir,
                rules,
                toolkit: Mutex::new(None),
                monitor: Mutex::new(Monitor::default()),
                build_busy: AtomicBool::new(false),
                device_busy: AtomicBool::new(false),
                build_cancel: AtomicBool::new(false),
                device_cancel: AtomicBool::new(false),
            }),
        }
    }

    /// Serve until stdin closes, then end every tool process still running.
    pub fn serve(&self, input: impl BufRead) {
        for line in input.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            if line.len() > MAX_LINE {
                self.inner.out.reply(&Value::Null, Err(Failure::new("badRequest", "请求超过 4 MiB。")));
                continue;
            }
            match serde_json::from_str::<Value>(&line) {
                Ok(request) => {
                    let id = request.get("id").cloned().unwrap_or(Value::Null);
                    let method = request.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
                    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
                    Inner::handle(&self.inner, id, &method, args);
                }
                Err(e) => self.inner.out.reply(&Value::Null, Err(Failure::new("badRequest", format!("无法解析请求：{e}")))),
            }
        }
        self.inner.build_cancel.store(true, Ordering::Relaxed);
        self.inner.device_cancel.store(true, Ordering::Relaxed);
        if let Ok(mut monitor) = self.inner.monitor.lock() {
            monitor.close(&self.inner.out);
        }
        process::kill_all();
    }
}

impl Inner {
    fn handle(inner: &Arc<Self>, id: Value, method: &str, args: Value) {
        let queue = match method {
            "build" | "configure" | "checkToolkit" => Some(Queue::Build),
            "identify" | "flash" | "reset" | "restore" => Some(Queue::Device),
            _ => None,
        };
        let Some(queue) = queue else {
            let result = inner.quick(method, &args);
            inner.out.reply(&id, result);
            return;
        };
        let (busy, cancel) = match queue {
            Queue::Build => (&inner.build_busy, &inner.build_cancel),
            Queue::Device => (&inner.device_busy, &inner.device_cancel),
        };
        if busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed).is_err() {
            let failure = match queue {
                Queue::Build => Failure::new("buildBusy", "正在编译。等它完成，或先停止。"),
                Queue::Device => Failure::new("deviceBusy", "正在下载或识别开发板。等它完成，或先停止。"),
            };
            inner.out.reply(&id, Err(failure));
            return;
        }
        cancel.store(false, Ordering::Relaxed);
        let worker = Arc::clone(inner);
        let method = method.to_string();
        thread::spawn(move || {
            let result = worker.job(&method, &args);
            match queue {
                Queue::Build => worker.build_busy.store(false, Ordering::Release),
                Queue::Device => worker.device_busy.store(false, Ordering::Release),
            }
            worker.out.reply(&id, result);
        });
    }

    fn toolkit(&self) -> Outcome<Toolkit> {
        let mut guard = self.toolkit.lock().map_err(|_| Failure::new("internal", "工具包状态不可用"))?;
        if guard.is_none() {
            let toolkit = Toolkit::open(&self.toolkit_root)?;
            let report = toolkit.check(false, None);
            *guard = Some((toolkit, report));
        }
        let (toolkit, report) = guard.as_ref().expect("set above");
        if report["ok"] != json!(true) {
            return Err(Failure::new(
                "toolkitBroken",
                format!("STM32 工具包有 {} 个文件缺失或损坏。重新安装 Nodu 可以修复；如果反复出现，检查杀毒软件是否隔离了 Nodu 的文件。", report["problemCount"]),
            )
            .with_detail(report.clone()));
        }
        Ok(toolkit.clone())
    }

    fn check_cache(&self) -> PathBuf {
        self.data_dir.join("stm32").join("toolkit-check.json")
    }

    fn project(&self, args: &Value) -> Outcome<Project> {
        Project::open(Path::new(arg_str(args, "path")?), &self.catalog)
    }

    fn trusted(&self, project: &Project) -> Outcome<()> {
        if self.trust.is_trusted(&project.root) {
            Ok(())
        } else {
            Err(Failure::new("untrusted", "这个工程还没有被信任。编译会执行工程里的 CMake 脚本，确认来源可靠后再信任。"))
        }
    }

    fn project_status(&self, project: &Project) -> Value {
        let current = read_json(&project.state_dir().join("current-build.json")).ok();
        let toolkit = self.toolkit();
        let stale = match (&current, &toolkit) {
            (Some(current), Ok(toolkit)) => current.get("inputDigest").and_then(Value::as_str) != Some(project.input_digest(toolkit).as_str()),
            _ => true,
        };
        let mut summary = project.summary();
        summary["lockedToolkitVersion"] = read_json(&project.root.join("nodu.lock.json")).ok().and_then(|v| v.pointer("/toolkit/version").cloned()).unwrap_or(Value::Null);
        summary["trusted"] = json!(self.trust.is_trusted(&project.root));
        summary["currentBuild"] = current.unwrap_or(Value::Null);
        summary["buildStale"] = json!(stale);
        summary["toolkit"] = match toolkit {
            Ok(t) => json!({"ok": true, "version": t.version(), "root": t.root.display().to_string()}),
            Err(f) => json!({"ok": false, "code": f.code, "message": f.message, "detail": f.detail}),
        };
        summary
    }

    fn quick(&self, method: &str, args: &Value) -> Outcome<Value> {
        match method {
            "ping" => Ok(json!({"version": env!("CARGO_PKG_VERSION")})),
            "catalog" => self.catalog.listing(),
            "readToolkitLicense" => Toolkit::open(&self.toolkit_root)?.license_text(arg_str(args, "file")?),
            "checkToolkit" => {
                let full = arg_bool(args, "full");
                let toolkit = Toolkit::open(&self.toolkit_root)?;
                let report = if !full {
                    toolkit::cached_full_check(&self.check_cache(), &toolkit).map_or_else(|| toolkit.check(false, None), |mut cached| {
                        // Sizes are re-checked every time; hashes come from the cached full check.
                        let quick = toolkit.check(false, None);
                        if quick["ok"] != json!(true) { quick } else { cached["fullCheckedAt"] = cached["checkedAt"].clone(); cached["inventory"] = quick["inventory"].clone(); cached }
                    })
                } else {
                    toolkit.check(true, Some(&self.check_cache()))
                };
                if let Ok(mut guard) = self.toolkit.lock() {
                    *guard = Some((toolkit, report.clone()));
                }
                Ok(report)
            }
            "createProject" => {
                let toolkit = self.toolkit()?;
                let request = NewProject {
                    parent: Path::new(arg_str(args, "parent")?),
                    name: arg_str(args, "name")?,
                    board: arg_str(args, "board")?,
                    template: arg_str(args, "template")?,
                    led: args.get("led").filter(|v| v.is_object()),
                    method: arg_opt_str(args, "method").unwrap_or("stlink"),
                };
                let root = project::create(&request, &self.catalog, &toolkit)?;
                self.trust.trust(&root)?;
                let project = Project::open(&root, &self.catalog)?;
                Ok(self.project_status(&project))
            }
            "detectExternal" => crate::exchange::detect(Path::new(arg_str(args, "path")?), &self.catalog),
            "importExternal" => {
                let root = crate::exchange::import(Path::new(arg_str(args, "path")?), arg_str(args, "board")?, &self.catalog)?;
                Ok(self.project_status(&Project::open(&root, &self.catalog)?))
            }
            "exportProject" => crate::exchange::export(&self.project(args)?, &self.toolkit()?, Path::new(arg_str(args, "destination")?)),
            "acceptToolkit" => {
                let project = self.project(args)?;
                crate::exchange::accept_toolkit(&project, &self.toolkit()?)?;
                Ok(self.project_status(&project))
            }
            "openProject" => {
                let project = self.project(args)?;
                Ok(self.project_status(&project))
            }
            "createModule" => {
                if self.build_busy.load(Ordering::Acquire) { return Err(Failure::new("buildBusy", "编译结束后再创建模块。")); }
                project::create_module(&self.project(args)?, arg_str(args, "name")?)
            }
            "trustProject" => {
                let project = self.project(args)?;
                self.trust.trust(&project.root)?;
                Ok(self.project_status(&project))
            }
            "setProjectOption" => {
                let mut project = self.project(args)?;
                let value = args.get("value").cloned().unwrap_or(Value::Null);
                let (pointer, value) = match arg_str(args, "key")? {
                    "flashMethod" if value == "stlink" || value == "uart" => ("/flash/method", value),
                    "monitorBaud" if value.as_u64().is_some_and(|b| (1200..=4_000_000).contains(&b)) => ("/monitor/baud", value),
                    "monitorEncoding" if value == "utf-8" || value == "gbk" => ("/monitor/encoding", value),
                    "printfFloat" if value.is_boolean() => ("/build/printfFloat", value),
                    "chipVendor" if value == "st" || value == "compatible" => ("/target/vendor", value),
                    "preset" if value == "debug" || value == "release" => ("/build/preset", value),
                    "uartPort" if value.is_string() || value.is_null() => ("/flash/port", value),
                    _ => return Err(Failure::new("badRequest", "不支持的工程选项。")),
                };
                project.set_manifest(pointer, value)?;
                Ok(self.project_status(&project))
            }
            "setProjectOptions" => {
                if self.build_busy.load(Ordering::Acquire) || self.device_busy.load(Ordering::Acquire) {
                    return Err(Failure::new("busy", "任务结束后再保存工程设置。"));
                }
                let mut project = self.project(args)?;
                let options = args["options"].as_object().ok_or_else(|| Failure::new("badRequest", "工程设置无效。"))?;
                let mut values = Vec::new();
                for (key, value) in options {
                    let pointer = match key.as_str() {
                        "autoBoot" => { crate::auto_boot::AutoBoot::parse(value, project.chip.id())?; "/flash/autoBoot" },
                        "printfFloat" if value.is_boolean() => "/build/printfFloat",
                        "preset" if value == "debug" || value == "release" => "/build/preset",
                        "chipVendor" if value == "st" || value == "compatible" => "/target/vendor",
                        _ => return Err(Failure::new("badRequest", "不支持的工程设置。")),
                    };
                    values.push((pointer, value.clone()));
                }
                project.set_manifests(&values)?;
                Ok(self.project_status(&project))
            }
            "cancel" => {
                let flag = match arg_opt_str(args, "queue") {
                    Some("device") => &self.device_cancel,
                    _ => &self.build_cancel,
                };
                flag.store(true, Ordering::Relaxed);
                Ok(json!({"cancelled": true}))
            }
            "listProbes" => Ok(json!(crate::probes::list())),
            "listPorts" => {
                let ports: Vec<Value> = nodu_serial::list_ports()
                    .into_iter()
                    .filter(|p| !(cfg!(target_os = "macos") && p.path.starts_with("/dev/tty.")))
                    .filter_map(|p| serde_json::to_value(p).ok())
                    .map(|mut p| {
                        let st = p["vid"].as_u64() == Some(0x0483);
                        p["stlinkVcp"] = json!(st);
                        p
                    })
                    .collect();
                Ok(json!(ports))
            }
            "listBackups" => Ok(json!(self.backups.list(arg_opt_str(args, "uid")))),
            "openMonitor" => {
                let port = arg_str(args, "port")?;
                let baud = args.get("baud").and_then(Value::as_u64).unwrap_or(115_200) as u32;
                let mut monitor = self.monitor.lock().map_err(|_| Failure::new("internal", "监视器不可用"))?;
                let profile = if args["path"].is_string() { let project = self.project(args)?;
                    crate::auto_boot::AutoBoot::parse(&project.manifest["flash"]["autoBoot"], project.chip.id())?
                } else { None };
                monitor.open(&self.out, port, baud, profile)
            }
            "closeMonitor" => {
                if let Ok(mut monitor) = self.monitor.lock() {
                    monitor.available()?;
                    monitor.close(&self.out);
                }
                Ok(json!({"open": false}))
            }
            "writeMonitor" => {
                let data = B64.decode(arg_str(args, "data")?).map_err(|_| Failure::new("badRequest", "数据不是有效的 base64。"))?;
                if data.len() > 64 * 1024 {
                    return Err(Failure::new("badRequest", "一次最多发送 64 KB。"));
                }
                self.monitor.lock().map_err(|_| Failure::new("internal", "监视器不可用"))?.write(&data)?;
                Ok(json!({"sent": data.len()}))
            }
            "monitorStatus" => Ok(self.monitor.lock().map(|m| m.status()).unwrap_or(json!({"open": false}))),
            "clangd" => {
                let toolkit = self.toolkit()?;
                let project = self.project(args)?;
                Ok(json!({
                    "command": toolkit.clangd().display().to_string(),
                    "args": [
                        format!("--compile-commands-dir={}", project.build_dir().display()),
                        format!("--query-driver={}", toolkit.gcc_tool("gcc").display()),
                        "--header-insertion=never", "--background-index", "--clang-tidy=false",
                        "--log=error", "-j=2", "--pch-storage=memory",
                    ],
                    "cwd": project.root.display().to_string(),
                    "env": toolkit.child_env(),
                    "sdk": toolkit.sdk(crate::util::str_field(&project.chip.0, &["sdk", "dir"]).unwrap_or_default()).display().to_string(),
                }))
            }
            _ => Err(Failure::new("badRequest", format!("未知方法 {method}"))),
        }
    }

    fn job(&self, method: &str, args: &Value) -> Outcome<Value> {
        if method == "checkToolkit" { return self.quick(method, args); }
        let toolkit = self.toolkit()?;
        let project = self.project(args)?;
        match method {
            "configure" | "build" => {
                self.trusted(&project)?;
                let env = Env { toolkit: &toolkit, rules: &self.rules, out: &self.out, cancel: &self.build_cancel };
                if method == "configure" {
                    return build::configure(&env, &project);
                }
                let build_id = new_id("b");
                self.out.event("build.started", json!({"buildId": build_id, "path": project.root.display().to_string()}));
                let result = build::build(&env, &project, arg_bool(args, "clean"), &build_id);
                let done = match &result {
                    Ok(value) => value.clone(),
                    Err(f) => json!({"ok": false, "buildId": build_id, "code": f.code, "message": f.message}),
                };
                self.out.event("build.done", done);
                result
            }
            "identify" => {
                let method = arg_opt_str(args, "method").unwrap_or(project.flash_method());
                if method == "uart" {
                    return Err(Failure::new("badRequest", "串口方式在下载时识别芯片（需要先进入引导模式）。"));
                }
                let probe = arg_opt_str(args, "probe").unwrap_or_default();
                let session = stlink::Session { toolkit: &toolkit, chip: &project.chip, board: &project.board,
                    serial: probe, out: &self.out, cancel: &self.device_cancel, run_id: "identify" };
                let (probe, _lock) = stlink::select_probe(&session)?;
                let session = stlink::Session { serial: &probe, ..session };
                let mut identity = session.identify()?;
                identity["matches"] = json!(flash::check_identity(&project.chip, &identity, 0).map_err(|f| f.message).err());
                identity["deviceName"] = json!(flash::device_name(identity["deviceId"].as_u64().unwrap_or(0)));
                identity["hasBackup"] = json!(self.backups.has(&identity));
                Ok(identity)
            }
            "reset" => {
                let probe = arg_opt_str(args, "probe").unwrap_or_default();
                let session = stlink::Session { toolkit: &toolkit, chip: &project.chip, board: &project.board,
                    serial: probe, out: &self.out, cancel: &self.device_cancel, run_id: "reset" };
                let (probe, _lock) = stlink::select_probe(&session)?;
                let session = stlink::Session { serial: &probe, ..session };
                flash::check_identity(&project.chip, &session.identify()?, 0)?;
                session.reset()?;
                Ok(json!({"reset": true}))
            }
            "flash" | "restore" => self.download(method, args, &toolkit, &project),
            _ => Err(Failure::new("badRequest", format!("未知方法 {method}"))),
        }
    }

    fn download(&self, method: &str, args: &Value, toolkit: &Toolkit, project: &Project) -> Outcome<Value> {
        check_compatible(&project.manifest, args)?;
        let image = if method == "restore" {
            let (record, file) = self.backups.get(arg_str(args, "backup")?)?;
            Image {
                bytes: record["bytes"].as_u64().unwrap_or(0),
                sha256: record["sha256"].as_str().unwrap_or_default().to_string(),
                file,
                bundle: None,
                tick: None,
                restore_uid: record["uid"].as_str().map(str::to_string),
            }
        } else {
            self.trusted(project)?;
            let (record, dir) = build::current_artifact(project, toolkit, arg_opt_str(args, "bundle"))?;
            Image {
                file: dir.join("firmware.bin"),
                bytes: record["binaryBytes"].as_u64().unwrap_or(0),
                sha256: record["binarySha256"].as_str().unwrap_or_default().to_string(),
                bundle: record["bundleSha256"].as_str().map(str::to_string),
                tick: record["tickAddress"].as_u64(),
                restore_uid: None,
            }
        };
        let profile = crate::auto_boot::AutoBoot::parse(&project.manifest["flash"]["autoBoot"], project.chip.id())?;
        let method_name = arg_opt_str(args, "method").unwrap_or(project.flash_method()).to_string();
        let port = arg_opt_str(args, "port")
            .or_else(|| crate::util::str_field(&project.manifest, &["flash", "port"]))
            .unwrap_or_default()
            .to_string();
        let baud = crate::util::u64_field(&project.board.value, &["flash", "uart", "baud"]).unwrap_or(115_200) as u32;
        let target = Target {
            method: &method_name,
            probe: arg_opt_str(args, "probe").unwrap_or_default(),
            port: &port,
            baud,
            skip_backup: arg_bool(args, "skipBackup"),
        };
        let run_id = new_id("r");
        self.out.event("flash.started", json!({"runId": run_id, "path": project.root.display().to_string(), "method": method_name, "restore": method == "restore",
            "bytes": image.bytes, "erase": project.chip.erase_plan(image.bytes)}));
        let ctx = Ctx { toolkit, project, backups: &self.backups, out: &self.out, cancel: &self.device_cancel };

        // Serial ISP borrows the monitor's port lock and gives it back afterwards (§9).
        let mut resume = None;
        let port_lock = if method_name == "uart" {
            if port.is_empty() {
                return Err(Failure::new("noPort", "串口下载需要先选择串口。"));
            }
            let mut monitor = self.monitor.lock().map_err(|_| Failure::new("internal", "监视器不可用"))?;
            if monitor.is_on(&port) {
                let baud = monitor.status()["baud"].as_u64().unwrap_or(115_200) as u32;
                let (name, lock) = monitor.lend(&self.out).ok_or_else(|| Failure::new("internal", "监视器交接失败"))?;
                resume = Some((name, baud));
                Some(lock)
            } else {
                Some(locks::lock_port(&port, "STM32 串口下载")?)
            }
        } else {
            None
        };
        let result = flash::run(&ctx, &target, &image, &run_id);
        if let (Some((name, baud)), Some(lock)) = (resume, port_lock) {
            if let Ok(mut monitor) = self.monitor.lock() {
                monitor.resume(&self.out, &name, baud, lock, profile);
            }
        }
        let done = match &result {
            Ok(value) => value.clone(),
            Err(f) => json!({"ok": false, "runId": run_id, "code": f.code, "message": f.message, "detail": f.detail}),
        };
        self.out.event("flash.done", done);
        result
    }
}

fn check_compatible(manifest: &Value, args: &Value) -> Outcome<()> {
    if manifest.pointer("/target/vendor").and_then(Value::as_str) == Some("compatible") && !arg_bool(args, "compatibleConfirmed") {
        return Err(Failure::new("compatibilityConfirmation", "兼容芯片尚未验证，请确认具体型号后再下载。"));
    }
    Ok(())
}
