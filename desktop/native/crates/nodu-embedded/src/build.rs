// SPDX-License-Identifier: MIT
//! Configure, build and the artifact store (FUNCTIONAL-DESIGN §5).
//!
//! The current-build pointer is removed when a build starts, so a failed or
//! interrupted build never leaves an older artifact looking current (B7).
//! The input digest is taken before and after; a mismatch marks the result
//! stale and it is not stored as current.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use fs2::FileExt;
use regex::Regex;
use serde_json::{Value, json};

use crate::diag::{self, Context, Parser, Rules};
use crate::process::{self, Control};
use crate::project::Project;
use crate::proto::{Failure, Outcome, Output};
use crate::toolkit::Toolkit;
use crate::util::{iso_now, millis_now, read_json, sha256_file, sha256_hex, write_json};

const CONFIGURE_TIMEOUT: Duration = Duration::from_secs(120);
const BUILD_TIMEOUT: Duration = Duration::from_secs(600);
const KEEP_ARTIFACTS: usize = 5;
pub const FILES: [&str; 4] = ["firmware.bin", "firmware.elf", "firmware.hex", "firmware.map"];

#[derive(Debug)]
pub struct Env<'a> {
    pub toolkit: &'a Toolkit,
    pub rules: &'a Rules,
    pub out: &'a Output,
    pub cancel: &'a AtomicBool,
}

/// Held for the duration of a configure or build; released on drop.
#[derive(Debug)]
struct BuildLock(fs::File);

impl Drop for BuildLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

fn lock_build(project: &Project) -> Outcome<BuildLock> {
    let dir = project.state_dir();
    fs::create_dir_all(&dir).map_err(|e| Failure::io("创建 .nodu", &e))?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join("build.lock"))
        .map_err(|e| Failure::io("打开编译锁", &e))?;
    file.try_lock_exclusive()
        .map_err(|_| Failure::new("buildBusy", "这个工程正在另一个窗口中编译。"))?;
    Ok(BuildLock(file))
}

fn configure_stamp(project: &Project, toolkit: &Toolkit) -> Value {
    json!({"toolkit": toolkit.root.display().to_string(), "version": toolkit.version(),
           "preset": project.preset(), "printfFloat": project.printf_float()})
}

fn diag_context(project: &Project, toolkit: &Toolkit) -> Context {
    let series_lower = project.chip.series().to_lowercase();
    let conf_name = format!("{series_lower}_hal_conf.h");
    let conf = fs::read_to_string(project.root.join("Core/Inc").join(&conf_name)).unwrap_or_default();
    let sdk_dir = crate::util::str_field(&project.chip.0, &["sdk", "dir"]).unwrap_or_default();
    let sdk = toolkit.sdk(sdk_dir);
    let template = fs::read_to_string(
        sdk.join(format!("Drivers/{}_HAL_Driver/Inc/{series_lower}_hal_conf_template.h", project.chip.series())),
    )
    .unwrap_or_default();
    Context {
        project: project.root.clone(),
        build_dir: project.build_dir(),
        sdk: fs::canonicalize(&sdk).unwrap_or(sdk),
        hal_conf_name: conf_name,
        enabled_modules: diag::modules_in(&conf, true),
        known_modules: diag::modules_in(&template, false),
    }
}

fn run_tool(env: &Env<'_>, project: &Project, args: &[String], timeout: Duration, parser: &mut Parser, phase: &str, build_id: &str) -> Outcome<process::Finished> {
    let progress = Regex::new(r"^\[(\d+)/(\d+)\] (.*)$").expect("regex");
    let out = env.out;
    process::run(
        &env.toolkit.cmake(),
        args,
        &project.root,
        &env.toolkit.child_env(),
        timeout,
        &|| env.cancel.load(Ordering::Relaxed),
        &mut |line| {
            parser.line(line);
            if let Some(c) = progress.captures(line) {
                let file = c[3].rsplit(['/', '\\']).next().unwrap_or_default().trim_end_matches(".obj").to_string();
                out.event("build.progress", json!({"buildId": build_id, "phase": phase,
                    "done": c[1].parse::<u64>().unwrap_or(0), "total": c[2].parse::<u64>().unwrap_or(0), "file": file}));
            }
            out.event("build.output", json!({"buildId": build_id, "line": line}));
            Control::Continue
        },
    )
}

/// Run `cmake --preset` when the build directory is missing or was
/// configured with a different toolkit or options. Returns whether it ran.
fn ensure_configured(env: &Env<'_>, project: &Project, clean: bool, parser: &mut Parser, build_id: &str) -> Outcome<Option<process::Finished>> {
    let build_dir = project.build_dir();
    let stamp_path = project.state_dir().join("configure.json");
    let stamp = configure_stamp(project, env.toolkit);
    let current = read_json(&stamp_path).ok();
    let configured = build_dir.join("CMakeCache.txt").is_file() && build_dir.join("build.ninja").is_file();
    if clean {
        let _ = fs::remove_dir_all(&build_dir);
    } else if configured && current.as_ref() == Some(&stamp) {
        return Ok(None);
    } else {
        // A cache from another toolkit location holds stale compiler paths.
        let _ = fs::remove_file(build_dir.join("CMakeCache.txt"));
        let _ = fs::remove_dir_all(build_dir.join("CMakeFiles"));
    }
    env.out.event("build.progress", json!({"buildId": build_id, "phase": "configure", "done": 0, "total": 0, "file": ""}));
    let args = vec![
        "--preset".to_string(),
        project.preset().to_string(),
        format!("-DNODU_PRINTF_FLOAT={}", if project.printf_float() { "ON" } else { "OFF" }),
    ];
    let done = run_tool(env, project, &args, CONFIGURE_TIMEOUT, parser, "configure", build_id)?;
    if done.ok() {
        write_json(&stamp_path, &stamp)?;
    } else {
        let _ = fs::remove_file(&stamp_path);
    }
    Ok(Some(done))
}

/// Configure only (for the clangd compilation database).
pub fn configure(env: &Env<'_>, project: &Project) -> Outcome<Value> {
    let _lock = lock_build(project)?;
    let rules = Rules::default();
    let mut parser = Parser::new(diag_context(project, env.toolkit), rules);
    let ran = ensure_configured(env, project, false, &mut parser, "configure")?;
    let ok = ran.as_ref().is_none_or(process::Finished::ok);
    Ok(json!({"ok": ok, "ran": ran.is_some(), "compileCommands": project.build_dir().join("compile_commands.json").display().to_string(),
              "diagnostics": parser.finish()}))
}

pub fn build(env: &Env<'_>, project: &Project, clean: bool, build_id: &str) -> Outcome<Value> {
    let _lock = lock_build(project)?;
    let started = Instant::now();
    let current_path = project.state_dir().join("current-build.json");
    let _ = fs::remove_file(&current_path);
    let digest_before = project.input_digest(env.toolkit);
    let mut parser = Parser::new(diag_context(project, env.toolkit), env.rules.clone());
    let mut output = String::new();

    let failed = |parser: Parser, output: &str, phase: &str| -> Value {
        let diagnostics = parser.finish();
        json!({"ok": false, "buildId": build_id, "phase": phase, "diagnostics": diagnostics,
               "errors": diagnostics.iter().filter(|d| d["severity"] == "error").count(),
               "warnings": diagnostics.iter().filter(|d| d["severity"] == "warning").count(),
               "output": process::tail(output, 16_000), "ms": started.elapsed().as_millis() as u64})
    };

    if let Some(done) = ensure_configured(env, project, clean, &mut parser, build_id)? {
        output.push_str(&done.output);
        if !done.ok() {
            return Ok(failed(parser, &output, "configure"));
        }
    }
    let args = vec!["--build".to_string(), project.build_dir().display().to_string()];
    let done = run_tool(env, project, &args, BUILD_TIMEOUT, &mut parser, "build", build_id)?;
    output.push_str(&done.output);
    if !done.ok() {
        return Ok(failed(parser, &output, "build"));
    }
    let diagnostics = parser.finish();
    let mut capacity = diag::capacity(&output);
    if capacity.as_object().is_some_and(serde_json::Map::is_empty) {
        capacity = read_json(&project.state_dir().join("capacity.json")).unwrap_or(capacity);
    } else {
        let _ = write_json(&project.state_dir().join("capacity.json"), &capacity);
    }
    let digest_after = project.input_digest(env.toolkit);
    let stale = digest_after != digest_before;
    let artifact = store_artifact(env.toolkit, project, &digest_before, &capacity, build_id)?;
    if !stale {
        write_json(&current_path, &json!({
            "bundle": artifact["bundleSha256"], "inputDigest": digest_before, "finishedAt": iso_now(),
            "binaryBytes": artifact["binaryBytes"], "capacity": capacity, "buildId": build_id,
        }))?;
    }
    prune_artifacts(project);
    Ok(json!({
        "ok": true, "buildId": build_id, "stale": stale, "diagnostics": diagnostics,
        "errors": 0, "warnings": diagnostics.iter().filter(|d| d["severity"] == "warning").count(),
        "capacity": capacity, "artifact": artifact, "ms": started.elapsed().as_millis() as u64,
        "output": process::tail(&output, 16_000),
    }))
}

/// Same digest P0 used: SHA-256 of Python's `json.dumps(hashes, sort_keys=True)`.
pub fn bundle_digest(hashes: &[(String, String)]) -> String {
    let mut sorted = hashes.to_vec();
    sorted.sort();
    let body: Vec<String> = sorted.iter().map(|(k, v)| format!("\"{k}\": \"{v}\"")).collect();
    sha256_hex(format!("{{{}}}", body.join(", ")).as_bytes())
}

fn tool_output(toolkit: &Toolkit, tool: &str, args: &[&str]) -> String {
    std::process::Command::new(toolkit.gcc_tool(tool))
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn store_artifact(toolkit: &Toolkit, project: &Project, input_digest: &str, capacity: &Value, build_id: &str) -> Outcome<Value> {
    let build_dir = project.build_dir();
    let mut hashes = Vec::new();
    for name in FILES {
        let path = build_dir.join(name);
        let digest = sha256_file(&path).map_err(|e| Failure::io(&format!("读取 {name}"), &e))?;
        hashes.push((name.to_string(), digest));
    }
    let bundle = bundle_digest(&hashes);
    let dir = project.state_dir().join("artifacts").join(&bundle);
    let bin = fs::read(build_dir.join("firmware.bin")).map_err(|e| Failure::io("读取 firmware.bin", &e))?;
    if bin.len() < 8 {
        return Err(Failure::new("badArtifact", "firmware.bin 太小，不是有效的程序。"));
    }
    let word = |i: usize| u64::from(u32::from_le_bytes([bin[i], bin[i + 1], bin[i + 2], bin[i + 3]]));
    let (stack, reset) = (word(0), word(4));
    let chip = &project.chip;
    let elf = build_dir.join("firmware.elf");
    let elf_text = elf.display().to_string();
    let attributes = tool_output(toolkit, "readelf", &["-A", &elf_text]);
    let cpu = Regex::new(r#"Tag_CPU_name: "([^"]+)""#).expect("regex")
        .captures(&attributes).map(|c| c[1].to_string()).unwrap_or_default();
    let expected_cpu = crate::util::str_field(&chip.0, &["elfCpu"]).unwrap_or_default();
    if !expected_cpu.is_empty() && !cpu.eq_ignore_ascii_case(expected_cpu) {
        return Err(Failure::new("archMismatch", format!(
            "程序是为 Arm {cpu} 编译的，但 nodu.json 的芯片 {} 需要 {expected_cpu}。检查 CMake 中的 -mcpu 是否被改过。", chip.name())));
    }
    let ram_end = chip.ram_base() + chip.ram_size();
    if stack < chip.ram_base() || stack > ram_end {
        return Err(Failure::new("badArtifact", format!("初始栈指针 0x{stack:08x} 不在 RAM 内。检查链接脚本。")));
    }
    if reset & 1 == 0 || reset < chip.flash_base() || reset >= chip.flash_base() + chip.flash_size() {
        return Err(Failure::new("badArtifact", format!("复位向量 0x{reset:08x} 不在 Flash 内。检查启动文件与链接脚本。")));
    }
    let symbols = tool_output(toolkit, "nm", &[&elf_text]);
    let tick = Regex::new(r"(?m)^([0-9a-fA-F]{8}) [bBdD] uwTick$").expect("regex")
        .captures(&symbols).and_then(|c| u64::from_str_radix(&c[1], 16).ok());
    let record = json!({
        "schema": 1, "bundleSha256": bundle, "buildId": build_id, "createdAt": iso_now(), "createdMs": millis_now(),
        "project": project.name(), "mcu": chip.id(), "board": project.board.reference(),
        "binaryBytes": bin.len(), "binarySha256": hashes.iter().find(|(k, _)| k == "firmware.bin").map(|(_, v)| v.clone()),
        "fileSha256": hashes.iter().map(|(k, v)| (k.clone(), json!(v))).collect::<serde_json::Map<_, _>>(),
        "initialStack": format!("0x{stack:08x}"), "resetVector": format!("0x{reset:08x}"),
        "elfCpu": cpu, "tickAddress": tick, "capacity": capacity, "inputDigest": input_digest,
        "toolkit": toolkit.version(), "sdk": project.manifest.get("sdk"),
        "erase": chip.erase_plan(bin.len() as u64),
    });
    // An existing bundle directory is reused only if every file still matches.
    let intact = dir.join("artifact.json").is_file()
        && hashes.iter().all(|(name, digest)| sha256_file(&dir.join(name)).ok().as_deref() == Some(digest.as_str()));
    if !intact {
        if dir.exists() {
            make_writable(&dir);
            let _ = fs::remove_dir_all(&dir);
        }
        fs::create_dir_all(&dir).map_err(|e| Failure::io("创建产物目录", &e))?;
        for name in FILES {
            let target = dir.join(name);
            fs::copy(build_dir.join(name), &target).map_err(|e| Failure::io(&format!("保存 {name}"), &e))?;
            if let Ok(meta) = fs::metadata(&target) {
                let mut perms = meta.permissions();
                perms.set_readonly(true);
                let _ = fs::set_permissions(&target, perms);
            }
        }
        write_json(&dir.join("artifact.json"), &record)?;
    }
    Ok(record)
}

fn prune_artifacts(project: &Project) {
    let root = project.state_dir().join("artifacts");
    let Ok(entries) = fs::read_dir(&root) else { return };
    let mut all: Vec<(u64, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| {
            let created = read_json(&e.path().join("artifact.json")).ok()
                .and_then(|v| v.get("createdMs").and_then(Value::as_u64)).unwrap_or(0);
            (created, e.path())
        })
        .collect();
    all.sort_by_key(|(created, _)| std::cmp::Reverse(*created));
    let keep = read_json(&project.state_dir().join("current-build.json")).ok()
        .and_then(|v| v.get("bundle").and_then(Value::as_str).map(str::to_string));
    for (_, path) in all.into_iter().skip(KEEP_ARTIFACTS) {
        if keep.as_deref() == path.file_name().and_then(|n| n.to_str()) {
            continue;
        }
        make_writable(&path);
        let _ = fs::remove_dir_all(&path);
    }
}

fn make_writable(dir: &Path) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        if let Ok(meta) = entry.metadata() {
            let mut perms = meta.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(entry.path(), perms);
        }
    }
}

/// The artifact a download may use: current, not stale, files unmodified.
pub fn current_artifact(project: &Project, toolkit: &Toolkit, bundle: Option<&str>) -> Outcome<(Value, PathBuf)> {
    let current = read_json(&project.state_dir().join("current-build.json"))
        .map_err(|_| Failure::new("noBuild", "还没有成功编译的程序。先编译。"))?;
    let current_bundle = current.get("bundle").and_then(Value::as_str).unwrap_or_default().to_string();
    if let Some(bundle) = bundle {
        if bundle != current_bundle {
            return Err(Failure::new("staleBuild", "要下载的程序不是最近一次编译的结果。重新编译后再下载。"));
        }
    }
    if current.get("inputDigest").and_then(Value::as_str) != Some(project.input_digest(toolkit).as_str()) {
        return Err(Failure::new("staleBuild", "编译之后文件有修改。重新编译后再下载。"));
    }
    let dir = project.state_dir().join("artifacts").join(&current_bundle);
    let record = read_json(&dir.join("artifact.json"))?;
    let mut hashes = Vec::new();
    for name in FILES {
        let digest = sha256_file(&dir.join(name)).map_err(|e| Failure::io(&format!("读取 {name}"), &e))?;
        if record.get("fileSha256").and_then(|m| m.get(name)).and_then(Value::as_str) != Some(digest.as_str()) {
            return Err(Failure::new("tampered", format!("产物 {name} 在编译后被修改过，拒绝下载。重新编译。")));
        }
        hashes.push((name.to_string(), digest));
    }
    if bundle_digest(&hashes) != current_bundle {
        return Err(Failure::new("tampered", "产物摘要不一致，拒绝下载。重新编译。"));
    }
    Ok((record, dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_digest_matches_p0_record() {
        // tools/stm32-p0/evidence/f103c8-artifact.json
        let hashes = vec![
            ("firmware.elf".to_string(), "302271a39d0bf35a5c77270724e9dabb7147d075fc847c3ac333aa9efb36b36d".to_string()),
            ("firmware.bin".to_string(), "fa7b5878122e240ac4d058b93f94a6df554cec7c72ba090371a6672069b03f95".to_string()),
            ("firmware.hex".to_string(), "0018fd3746ce341048831921f7acfa619b1546b48cfc1afa3d961fa0cf1636fd".to_string()),
            ("firmware.map".to_string(), "0a96579b1781014d824c621ee8fa61b431f4cbf69696095e1d2fcae8e4695ea3".to_string()),
        ];
        assert_eq!(bundle_digest(&hashes), "5d11bde3208123c07be1f1365721d4e9c6cd0f6c12a106fd46306c98fce052e0");
    }
}
