// SPDX-License-Identifier: MIT
//! STM32 HAL projects: creation from templates, `nodu.json`, trust and the
//! input digest (FUNCTIONAL-DESIGN §2, §5.1, §11).

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::catalog::{Board, Catalog, Chip};
use crate::proto::{Failure, Outcome};
use crate::toolkit::Toolkit;
use crate::util::{hex, iso_now, read_json, sha256_file, str_field, write_json};

/// Create a source/header pair without overwriting either file or following App outside the project.
pub fn create_module(project: &Project, name: &str) -> Outcome<Value> {
    use std::io::Write;
    let valid = Regex::new(r"^[A-Za-z][A-Za-z0-9_]{0,63}$").expect("regex");
    let upper = name.to_ascii_uppercase();
    if !valid.is_match(name) || ["CON", "PRN", "AUX", "NUL"].contains(&upper.as_str())
        || Regex::new(r"^(COM|LPT)[0-9]$").expect("regex").is_match(&upper) {
        return Err(Failure::new("badRequest", "名称须以字母开头，只含字母、数字或下划线，最多 64 字符。"));
    }
    if project.is_external() { return Err(Failure::new("externalProject", "外部 CMake 工程请在源文件目录中创建模块并加入构建。")); }
    let dir = project.root.join("App");
    fs::create_dir_all(&dir).map_err(|e| Failure::io("创建 App 目录", &e))?;
    let dir = fs::canonicalize(&dir).map_err(|e| Failure::io("检查 App 目录", &e))?;
    if !dir.starts_with(&project.root) { return Err(Failure::new("badRequest", "App 目录不能指向工程外。")); }
    let c = dir.join(format!("{name}.c")); let h = dir.join(format!("{name}.h"));
    let mut source = fs::OpenOptions::new().write(true).create_new(true).open(&c)
        .map_err(|e| Failure::io("创建源文件（不覆盖已有文件）", &e))?;
    let result = (|| {
        let mut header = fs::OpenOptions::new().write(true).create_new(true).open(&h)
            .map_err(|e| Failure::io("创建头文件（不覆盖已有文件）", &e))?;
        let written = (|| {
            source.write_all(format!("#include \"{name}.h\"\n").as_bytes())?;
            header.write_all(format!("#ifndef NODU_APP_{upper}_H\n#define NODU_APP_{upper}_H\n\n#ifdef __cplusplus\nextern \"C\" {{\n#endif\n\n\n#ifdef __cplusplus\n}}\n#endif\n\n#endif\n").as_bytes())?;
            source.sync_all()?; header.sync_all()
        })();
        if let Err(e) = written { drop(header); let _ = fs::remove_file(&h); return Err(Failure::io("写入模块", &e)); }
        Ok(json!({"source": c, "header": h}))
    })();
    if result.is_err() { drop(source); let _ = fs::remove_file(&c); }
    result
}

#[derive(Debug, Clone)]
pub struct Project {
    pub root: PathBuf,
    pub manifest: Value,
    pub chip: Chip,
    pub board: Board,
}

impl Project {
    pub fn open(path: &Path, catalog: &Catalog) -> Outcome<Self> {
        let root = fs::canonicalize(path).map_err(|e| Failure::io(&format!("打开工程 {}", path.display()), &e))?;
        let manifest_path = root.join("nodu.json");
        if !manifest_path.is_file() {
            return Err(Failure::new("notProject", "这个文件夹里没有 nodu.json，不是 Nodu 的 STM32 工程。"));
        }
        let manifest = read_json(&manifest_path)?;
        if str_field(&manifest, &["kind"]) != Some("stm32-hal") {
            return Err(Failure::new("notProject", "nodu.json 的 kind 不是 stm32-hal。"));
        }
        let mcu = str_field(&manifest, &["target", "mcu"])
            .ok_or_else(|| Failure::new("badManifest", "nodu.json 缺少 target.mcu。"))?;
        let chip = catalog.chip(mcu)?;
        let board_ref = str_field(&manifest, &["target", "board"])
            .ok_or_else(|| Failure::new("badManifest", "nodu.json 缺少 target.board。"))?;
        let board = catalog.board(board_ref)?;
        if board.mcu() != chip.id() {
            return Err(Failure::new("badManifest", format!("板卡包 {board_ref} 的芯片是 {}，与 target.mcu {mcu} 不一致。", board.mcu())));
        }
        Ok(Self { root, manifest, chip, board })
    }

    pub fn name(&self) -> &str {
        str_field(&self.manifest, &["name"]).unwrap_or("firmware")
    }
    pub fn is_external(&self) -> bool { self.manifest.pointer("/build/external").and_then(Value::as_bool).unwrap_or(false) }
    pub fn preset(&self) -> &str {
        match str_field(&self.manifest, &["build", "preset"]) {
            Some("release") => "release",
            _ => "debug",
        }
    }
    pub fn build_dir(&self) -> PathBuf {
        self.root.join("build").join(self.preset())
    }
    pub fn state_dir(&self) -> PathBuf {
        self.root.join(".nodu")
    }
    pub fn printf_float(&self) -> bool {
        self.manifest.pointer("/build/printfFloat").and_then(Value::as_bool).unwrap_or(false)
    }
    pub fn flash_method(&self) -> &str {
        match str_field(&self.manifest, &["flash", "method"]) {
            Some("uart") => "uart",
            _ => "stlink",
        }
    }
    pub fn monitor(&self) -> Value {
        self.manifest.get("monitor").cloned().unwrap_or_else(|| json!({"baud": 115_200}))
    }

    pub fn summary(&self) -> Value {
        json!({
            "path": self.root.display().to_string(),
            "name": self.name(),
            "manifest": self.manifest,
            "chip": self.chip.0,
            "board": self.board.value,
            "preset": self.preset(),
            "flashMethod": self.flash_method(),
        })
    }

    /// Update one manifest field (download method, monitor settings) in place.
    pub fn set_manifest(&mut self, pointer: &str, value: Value) -> Outcome<()> {
        self.set_manifests(&[(pointer, value)])
    }

    pub fn set_manifests(&mut self, values: &[(&str, Value)]) -> Outcome<()> {
        let mut manifest = self.manifest.clone();
        for (pointer, value) in values {
        let mut node = &mut manifest;
        let keys: Vec<&str> = pointer.trim_start_matches('/').split('/').collect();
        for key in &keys[..keys.len() - 1] {
            if !node.get(*key).is_some_and(Value::is_object) {
                node[*key] = json!({});
            }
            node = &mut node[*key];
        }
        node[keys[keys.len() - 1]] = value.clone();
        }
        write_json(&self.root.join("nodu.json"), &manifest)?;
        self.manifest = manifest;
        Ok(())
    }

    /// Digest of every project input (§5.1), excluding generated directories.
    pub fn input_digest(&self, toolkit: &Toolkit) -> String {
        let mut files = Vec::new();
        let dacir = str_field(&self.manifest, &["build", "adapter"]) == Some("dacir-directory-v1");
        collect_inputs(&self.root, Path::new(""), &mut files, dacir);
        files.sort();
        let mut hasher = Sha256::new();
        hasher.update(format!("toolkit={}\n", toolkit.version()).as_bytes());
        for rel in files {
            let digest = sha256_file(&self.root.join(&rel)).unwrap_or_default();
            hasher.update(format!("{}={digest}\n", rel.to_string_lossy().replace('\\', "/")).as_bytes());
        }
        hex(&hasher.finalize())
    }
}

const SKIP_DIRS: [&str; 6] = ["build", ".nodu", ".cache", ".git", ".theia", ".vscode"];

fn collect_inputs(root: &Path, rel: &Path, out: &mut Vec<PathBuf>, dacir: bool) {
    let Ok(entries) = fs::read_dir(root.join(rel)) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let child = rel.join(&*name);
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if rel.as_os_str().is_empty()
                && (SKIP_DIRS.contains(&name.as_ref()) || (dacir && [".studio", "runs"].contains(&name.as_ref()))) {
                continue;
            }
            if out.len() < 20_000 {
                collect_inputs(root, &child, out, dacir);
            }
        } else if kind.is_file() && name != ".DS_Store" {
            out.push(child);
        }
    }
}

/// Projects the user created in Nodu or explicitly trusted (§11): building
/// runs CMake scripts from the project, so an unknown folder is not built.
pub struct TrustStore {
    path: PathBuf,
}

impl std::fmt::Debug for TrustStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TrustStore")
    }
}

impl TrustStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { path: data_dir.join("stm32").join("trusted-projects.json") }
    }
    fn list(&self) -> Vec<String> {
        read_json(&self.path)
            .ok()
            .and_then(|v| serde_json::from_value(v.get("projects")?.clone()).ok())
            .unwrap_or_default()
    }
    pub fn is_trusted(&self, root: &Path) -> bool {
        self.list().contains(&root.display().to_string())
    }
    pub fn trust(&self, root: &Path) -> Outcome<()> {
        let mut list = self.list();
        let key = root.display().to_string();
        if !list.contains(&key) {
            list.push(key);
        }
        write_json(&self.path, &json!({"schema": 1, "projects": list}))
    }
}

#[derive(Debug)]
pub struct NewProject<'a> {
    pub parent: &'a Path,
    pub name: &'a str,
    pub board: &'a str,
    pub template: &'a str,
    /// Legacy input retained for protocol compatibility; board facts remain authoritative.
    pub led: Option<&'a Value>,
    pub method: &'a str,
}

pub fn validate_name(name: &str) -> Outcome<()> {
    let ok = !name.is_empty()
        && name.len() <= 40
        && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(Failure::new("badName", "工程名只能用英文字母、数字、- 和 _，以字母开头，最多 40 个字符。"))
    }
}

struct Led {
    port: char,
    pin: u8,
    active_low: bool,
}

fn parse_led(chip: &Chip, board: &Board, _given: Option<&Value>) -> Outcome<Led> {
    let source = board.verified_led().ok_or_else(|| {
        Failure::new("needLed", "板卡包尚未核对 LED，不能使用闪烁模板。请先使用空工程或串口示例。")
    })?;
    let (port, pin) = if let Some(text) = source.get("pin").and_then(Value::as_str) {
        let mut chars = text.trim().trim_start_matches('P').chars();
        let port = chars.next().unwrap_or(' ');
        (port, chars.as_str().parse::<u8>().unwrap_or(255))
    } else {
        let port = source.get("port").and_then(Value::as_str).and_then(|p| p.chars().next()).unwrap_or(' ');
        (port, source.get("pin").and_then(Value::as_u64).map_or(255, |p| p as u8))
    };
    let port = port.to_ascii_uppercase();
    let ports = str_field(&chip.0, &["gpioPorts"]).unwrap_or("ABC");
    if !ports.contains(port) || pin > 15 {
        return Err(Failure::new("badLed", format!("{} 没有引脚 P{port}{pin}。端口可选 {ports}，引脚 0–15。", chip.name())));
    }
    let active_low = source.get("activeLow").and_then(Value::as_bool).unwrap_or(true);
    Ok(Led { port, pin, active_low })
}

fn led_block(led: Option<&Led>) -> String {
    let Some(led) = led else { return String::new() };
    let (on, off) = if led.active_low { ("GPIO_PIN_RESET", "GPIO_PIN_SET") } else { ("GPIO_PIN_SET", "GPIO_PIN_RESET") };
    format!(
        "\n/* LED0：P{port}{pin}，{level}点亮。 */\n#define LED0_GPIO_PORT GPIO{port}\n#define LED0_PIN GPIO_PIN_{pin}\n#define LED0_GPIO_CLK_ENABLE() __HAL_RCC_GPIO{port}_CLK_ENABLE()\n#define LED0_ON_LEVEL {on}\n#define LED0_OFF_LEVEL {off}\n",
        port = led.port,
        pin = led.pin,
        level = if led.active_low { "低电平" } else { "高电平" },
    )
}

fn substitute(text: &str, vars: &BTreeMap<&str, String>) -> String {
    let mut out = text.to_string();
    for (key, value) in vars {
        out = out.replace(&format!("{{{{{key}}}}}"), value);
    }
    out
}

fn copy_template_dir(from: &Path, to: &Path, vars: &BTreeMap<&str, String>, written: &mut BTreeMap<String, String>, root: &Path) -> Outcome<()> {
    let Ok(entries) = fs::read_dir(from) else { return Ok(()) };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".DS_Store" || name == "board.json" {
            continue;
        }
        let target_name = if name == "gitignore" { ".gitignore".to_string() } else { substitute(&name, vars) };
        let source = entry.path();
        let target = to.join(&target_name);
        if source.is_dir() {
            copy_template_dir(&source, &target, vars, written, root)?;
        } else {
            let text = fs::read_to_string(&source).map_err(|e| Failure::io(&format!("读取模板 {}", source.display()), &e))?;
            write_text(&target, &substitute(&text, vars), written, root)?;
        }
    }
    Ok(())
}

fn write_text(path: &Path, text: &str, written: &mut BTreeMap<String, String>, root: &Path) -> Outcome<()> {
    crate::util::write_atomic(path, text.as_bytes())?;
    let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/");
    written.insert(rel, crate::util::sha256_hex(text.as_bytes()));
    Ok(())
}

/// Official `hal_conf_template.h` with only `modules` enabled; the rest stay
/// as commented `#define`s so students can enable a module themselves.
pub fn hal_conf(template: &str, modules: &[String], hse: Option<u64>) -> String {
    let define = Regex::new(r"(?m)^#define (HAL_([A-Z0-9_]+)_MODULE_ENABLED)[ \t]*$").expect("regex");
    let mut out = define
        .replace_all(template, |caps: &regex::Captures| {
            if modules.iter().any(|m| m == &caps[2]) {
                format!("#define {}", &caps[1])
            } else {
                format!("/* #define {} */", &caps[1])
            }
        })
        .into_owned();
    if let Some(hse) = hse {
        let value = Regex::new(r"(?m)^(\s*#define HSE_VALUE\s+)\d+U").expect("regex");
        out = value.replace_all(&out, format!("${{1}}{hse}U")).into_owned();
    }
    out
}

pub fn create(request: &NewProject<'_>, catalog: &Catalog, toolkit: &Toolkit) -> Outcome<PathBuf> {
    validate_name(request.name)?;
    let parent = fs::canonicalize(request.parent).map_err(|e| Failure::io("打开位置", &e))?;
    let root = parent.join(request.name);
    if root.exists() {
        return Err(Failure::new("exists", format!("{} 已经存在。换一个名字，或选择其他位置。", root.display())));
    }
    let board = catalog.board(request.board)?;
    let chip = catalog.chip(board.mcu())?;
    let templates = catalog.templates()?;
    let template = templates
        .iter()
        .find(|t| str_field(t, &["id"]) == Some(request.template))
        .ok_or_else(|| Failure::new("unknownTemplate", format!("没有模板 {}。", request.template)))?;
    let needs: Vec<&str> = template.get("needs").and_then(Value::as_array)
        .map(|n| n.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let led = if needs.contains(&"led") { Some(parse_led(&chip, &board, request.led)?) } else { None };
    if needs.contains(&"debugUart") && !board.has_debug_uart() {
        return Err(Failure::new("unsupported", "这块板子没有可用的调试串口。"));
    }

    let series = chip.series().to_string();
    let lower = series.to_lowercase();
    let sdk_dir = str_field(&chip.0, &["sdk", "dir"]).unwrap_or_default().to_string();
    let sdk = toolkit.sdk(&sdk_dir);
    let uart = board.value.get("debugUart").cloned().unwrap_or(Value::Null);
    let memory = {
        let mut lines = vec![
            format!("  FLASH (rx)  : ORIGIN = 0x{:08X}, LENGTH = {}K", chip.flash_base(), chip.flash_size() / 1024),
            format!("  RAM   (xrw) : ORIGIN = 0x{:08X}, LENGTH = {}K", chip.ram_base(), chip.ram_size() / 1024),
        ];
        if let Some(ccm) = chip.0.pointer("/ram/ccm") {
            lines.push(format!(
                "  CCM   (xrw) : ORIGIN = 0x{:08X}, LENGTH = {}K  /* 不能用于 DMA，默认不使用 */",
                ccm["base"].as_u64().unwrap_or(0),
                ccm["size"].as_u64().unwrap_or(0) / 1024
            ));
        }
        lines.join("\n")
    };
    let mut vars: BTreeMap<&str, String> = BTreeMap::new();
    vars.insert("NAME", request.name.to_string());
    vars.insert("CMAKE_NAME", request.name.replace('-', "_"));
    vars.insert("SERIES_LOWER", lower.clone());
    vars.insert("SERIES_UPPER", series.to_uppercase());
    vars.insert("MCU_NAME", chip.name().to_string());
    vars.insert("MEMORY", memory);
    vars.insert("BOARD_NAME", board.name().to_string());
    vars.insert("BOARD_ID", board.id().to_string());
    vars.insert("BOARD_VERSION", board.version().to_string());
    vars.insert("UART_INSTANCE", uart["instance"].as_str().unwrap_or("USART1").to_string());
    vars.insert("UART_TX", uart["tx"].as_str().unwrap_or("PA9").to_string());
    vars.insert("UART_RX", uart["rx"].as_str().unwrap_or("PA10").to_string());
    vars.insert("UART_BAUD", uart["baud"].as_u64().unwrap_or(115_200).to_string());
    vars.insert("LED_BLOCK", led_block(led.as_ref()));

    fs::create_dir_all(&root).map_err(|e| Failure::io("创建工程目录", &e))?;
    let result = (|| -> Outcome<()> {
        let mut written = BTreeMap::new();
        let templates_root = catalog.root.join("templates");
        copy_template_dir(&templates_root.join("common"), &root, &vars, &mut written, &root)?;
        copy_template_dir(&templates_root.join(format!("family-{}", chip.family())), &root, &vars, &mut written, &root)?;
        copy_template_dir(&board.dir, &root, &vars, &mut written, &root)?;
        copy_template_dir(&templates_root.join(request.template), &root, &vars, &mut written, &root)?;
        fs::create_dir_all(root.join("App")).map_err(|e| Failure::io("创建 App 目录", &e))?;
        write_text(&root.join("App/README.md"), "把自己的模块（.c 与 .h）放在这里，编译时自动参与。\n", &mut written, &root)?;
        // The linker template is named per MCU, as STM32CubeMX does.
        let linker = root.join("Linker").join(format!("{}_FLASH.ld", chip.id()));
        fs::rename(root.join("Linker/FLASH.ld"), &linker).map_err(|e| Failure::io("链接脚本", &e))?;
        if let Some(digest) = written.remove("Linker/FLASH.ld") {
            written.insert(format!("Linker/{}_FLASH.ld", chip.id()), digest);
        }

        // Official files that are part of what students learn (§2.1).
        let device = sdk.join("Drivers/CMSIS/Device/ST").join(&series);
        let startup = str_field(&chip.0, &["startup"]).unwrap_or_default();
        let copies = [
            (device.join("Source/Templates/gcc").join(startup), root.join("Startup").join(startup)),
            (device.join(format!("Source/Templates/system_{lower}.c")), root.join(format!("Core/Src/system_{lower}.c"))),
        ];
        for (from, to) in copies {
            let text = fs::read_to_string(&from).map_err(|e| Failure::io(&format!("读取 SDK 文件 {}", from.display()), &e))?;
            write_text(&to, &text, &mut written, &root)?;
        }
        let conf_template = sdk.join(format!("Drivers/{series}_HAL_Driver/Inc/{lower}_hal_conf_template.h"));
        let conf = fs::read_to_string(&conf_template).map_err(|e| Failure::io("读取 hal_conf 模板", &e))?;
        let hse = crate::util::u64_field(&board.value, &["clock", "hse"]);
        write_text(&root.join(format!("Core/Inc/{lower}_hal_conf.h")), &hal_conf(&conf, &catalog.hal_modules(), hse), &mut written, &root)?;

        let cpu_flags: Vec<String> = chip.0.get("cpuFlags").and_then(Value::as_array)
            .map(|f| f.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        let target = format!(
            "# 芯片：{name}。由 Nodu 根据 nodu.json 生成；更换芯片请新建工程。\nset(NODU_MCU {mcu})\nset(NODU_SERIES {series})\nset(NODU_SDK_DIR {sdk_dir})\nset(NODU_CHIP_DEFINE {define})\nset(NODU_CPU_FLAGS {flags})\nset(NODU_LINKER_SCRIPT Linker/{mcu}_FLASH.ld)\n",
            name = chip.name(),
            mcu = chip.id(),
            define = str_field(&chip.0, &["define"]).unwrap_or_default(),
            flags = cpu_flags.join(" "),
        );
        write_text(&root.join("cmake/nodu-target.cmake"), &target, &mut written, &root)?;

        let sdk_id = str_field(&chip.0, &["sdk", "id"]).unwrap_or_default();
        let sdk_version = str_field(&chip.0, &["sdk", "version"]).unwrap_or_default();
        let manifest = json!({
            "schema": 1,
            "kind": "stm32-hal",
            "name": request.name,
            "target": { "mcu": chip.id(), "board": board.reference() },
            "sdk": format!("{sdk_id}@{sdk_version}"),
            "build": { "preset": "debug", "printfFloat": false },
            "flash": { "method": if request.method == "uart" { "uart" } else { "stlink" } },
            "monitor": { "baud": uart["baud"].as_u64().unwrap_or(115_200), "encoding": "utf-8", "lineEnding": "lf" },
        });
        write_json(&root.join("nodu.json"), &manifest)?;
        let sdk_lock = toolkit.manifest.pointer(&format!("/sdk/{sdk_dir}")).cloned().unwrap_or(Value::Null);
        let lock = json!({
            "schema": 1,
            "createdAt": iso_now(),
            "sdk": { "id": sdk_id, "version": sdk_version, "commit": sdk_lock.get("commit"),
                     "hal": sdk_lock.get("halCommit"), "device": sdk_lock.get("deviceCommit") },
            "toolkit": { "id": toolkit.manifest.get("id"), "version": toolkit.version() },
            "board": { "id": board.id(), "version": board.version(), "sha256": board.digest() },
            "template": { "id": request.template, "version": template.get("version"), "files": written },
        });
        write_json(&root.join("nodu.lock.json"), &lock)
    })();
    if let Err(failure) = result {
        let _ = fs::remove_dir_all(&root);
        return Err(failure);
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dacir_runtime_outputs_do_not_invalidate_build_inputs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for name in ["src/main.c", "include/config.h", "drivers/runs/driver.c", ".studio/firmware/a.bin", "runs/latest.json"] {
            let file = root.join(name);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, "initial").unwrap();
        }
        let snapshot = |dacir| {
            let mut files = Vec::new();
            collect_inputs(root, Path::new(""), &mut files, dacir);
            files.sort();
            files.into_iter().map(|path| {
                let hash = sha256_file(&root.join(&path)).unwrap();
                (path, hash)
            }).collect::<Vec<_>>()
        };
        let before = snapshot(true);
        assert_eq!(before.len(), 3);
        assert_eq!(snapshot(false).len(), 5);
        fs::write(root.join("runs/latest.json"), "changed run").unwrap();
        fs::write(root.join(".studio/firmware/a.bin"), "changed import").unwrap();
        assert_eq!(snapshot(true), before);
        fs::write(root.join("src/main.c"), "changed source").unwrap();
        assert_ne!(snapshot(true), before);
    }

    #[test]
    fn names() {
        assert!(validate_name("blink-f103").is_ok());
        assert!(validate_name("1abc").is_err());
        assert!(validate_name("中文").is_err());
        assert!(validate_name("a b").is_err());
        assert!(validate_name("../x").is_err());
    }

    #[test]
    fn hal_conf_keeps_disabled_modules_as_comments() {
        let template = "#define HAL_MODULE_ENABLED\n#define HAL_ADC_MODULE_ENABLED\n#define HAL_GPIO_MODULE_ENABLED\n/* #define HAL_CAN_LEGACY_MODULE_ENABLED */\n  #define HSE_VALUE              25000000U /*!< x */\n";
        let out = hal_conf(template, &["GPIO".into()], Some(8_000_000));
        assert!(out.contains("#define HAL_MODULE_ENABLED\n"));
        assert!(out.contains("/* #define HAL_ADC_MODULE_ENABLED */"));
        assert!(out.contains("\n#define HAL_GPIO_MODULE_ENABLED\n"));
        assert!(out.contains("/* #define HAL_CAN_LEGACY_MODULE_ENABLED */"));
        assert!(out.contains("8000000U"));
    }
}
