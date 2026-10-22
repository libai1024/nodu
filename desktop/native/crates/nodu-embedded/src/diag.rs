// SPDX-License-Identifier: MIT
//! Compiler, linker and CMake output parsing with Chinese explanations
//! (FUNCTIONAL-DESIGN §5.3–§5.5).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{Value, json};

/// One explanation rule from `diagnostics.zh-CN.json`.
#[derive(Debug, Clone)]
struct Rule {
    id: String,
    pattern: Regex,
    check: Option<String>,
    title: String,
    explain: String,
    fix: String,
}

#[derive(Debug, Clone, Default)]
pub struct Rules {
    rules: Vec<Rule>,
}

impl Rules {
    pub fn load(path: &Path) -> Self {
        let Ok(text) = std::fs::read_to_string(path) else { return Self::default() };
        let Ok(value) = serde_json::from_str::<Value>(&text) else { return Self::default() };
        let rules = value
            .get("rules")
            .and_then(Value::as_array)
            .map(|rules| {
                rules
                    .iter()
                    .filter_map(|r| {
                        Some(Rule {
                            id: r.get("id")?.as_str()?.to_string(),
                            pattern: Regex::new(r.get("pattern")?.as_str()?).ok()?,
                            check: r.get("check").and_then(Value::as_str).map(str::to_string),
                            title: r.get("title")?.as_str()?.to_string(),
                            explain: r.get("explain")?.as_str()?.to_string(),
                            fix: r.get("fix")?.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self { rules }
    }

    /// First matching rule, with `{name}` placeholders filled from captures.
    pub fn explain(&self, message: &str, ctx: &Context) -> Option<Value> {
        for rule in &self.rules {
            let Some(caps) = rule.pattern.captures(message) else { continue };
            let mut vars: BTreeMap<String, String> = BTreeMap::new();
            for name in rule.pattern.capture_names().flatten() {
                if let Some(m) = caps.name(name) {
                    vars.insert(name.to_string(), m.as_str().to_string());
                }
            }
            vars.insert("conf".into(), ctx.hal_conf_name.clone());
            if rule.check.as_deref() == Some("halModuleDisabled") {
                let module = vars.get("mod").cloned().unwrap_or_default();
                if ctx.enabled_modules.is_empty() || ctx.enabled_modules.contains(&module) || !ctx.known_modules.contains(&module) {
                    continue;
                }
            }
            let fill = |text: &str| {
                let mut out = text.to_string();
                for (k, v) in &vars {
                    out = out.replace(&format!("{{{k}}}"), v);
                }
                out
            };
            return Some(json!({"rule": rule.id, "title": fill(&rule.title), "explain": fill(&rule.explain), "fix": fill(&rule.fix)}));
        }
        None
    }
}

/// Project facts some rules need (enabled HAL modules).
#[derive(Debug, Clone, Default)]
pub struct Context {
    pub project: PathBuf,
    pub build_dir: PathBuf,
    pub sdk: PathBuf,
    pub hal_conf_name: String,
    pub enabled_modules: Vec<String>,
    /// Modules the SDK has (`hal_conf_template.h`), so `HAL_Foo_` typos are not blamed on configuration.
    pub known_modules: Vec<String>,
}

pub fn modules_in(conf_text: &str, enabled_only: bool) -> Vec<String> {
    let pattern = if enabled_only {
        r"(?m)^[ \t]*#define[ \t]+HAL_([A-Z0-9_]+)_MODULE_ENABLED"
    } else {
        r"(?m)HAL_([A-Z0-9_]+)_MODULE_ENABLED"
    };
    let re = Regex::new(pattern).expect("regex");
    let mut out: Vec<String> = re.captures_iter(conf_text).map(|c| c[1].to_string()).collect();
    out.sort();
    out.dedup();
    out
}

/// Byte column (1-based) → UTF-16 column (1-based) on that line of the file.
fn utf16_column(file: &Path, line: u64, byte_col: u64) -> u64 {
    let Ok(text) = std::fs::read(file) else { return byte_col };
    let Some(content) = text.split(|b| *b == b'\n').nth(line.saturating_sub(1) as usize) else { return byte_col };
    let end = (byte_col.saturating_sub(1) as usize).min(content.len());
    let prefix = String::from_utf8_lossy(&content[..end]);
    prefix.encode_utf16().count() as u64 + 1
}

#[derive(Debug)]
pub struct Parser {
    ctx: Context,
    rules: Rules,
    items: Vec<Value>,
    cmake_error: Option<Value>,
}

impl Parser {
    pub fn new(ctx: Context, rules: Rules) -> Self {
        Self { ctx, rules, items: Vec::new(), cmake_error: None }
    }

    fn resolve(&self, file: &str) -> PathBuf {
        let path = PathBuf::from(file);
        if path.is_absolute() { path } else { self.ctx.build_dir.join(path) }
    }

    fn display(&self, path: &Path) -> (String, bool) {
        let normal = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        if let Ok(rel) = normal.strip_prefix(&self.ctx.project) {
            return (rel.to_string_lossy().replace('\\', "/"), false);
        }
        let sdk = normal.starts_with(&self.ctx.sdk);
        (normal.to_string_lossy().into_owned(), sdk)
    }

    fn push(&mut self, mut item: Value) {
        let message = item["message"].as_str().unwrap_or_default().to_string();
        if let Some(explanation) = self.rules.explain(&message, &self.ctx) {
            item["explanation"] = explanation;
        }
        self.items.push(item);
    }

    pub fn line(&mut self, line: &str) {
        let gcc = Regex::new(r"^(?P<file>.+?):(?P<line>\d+):(?P<col>\d+): (?P<sev>fatal error|error|warning|note): (?P<msg>.*?)(?: \[(?P<flag>-W[^\]]+)\])?$").expect("regex");
        let ld_line = Regex::new(r"^(?P<file>[^:]+\.[cshS]):(?P<line>\d+):(?:\s*\(.*?\):)?\s*(?P<msg>(?:undefined reference|multiple definition).*)$").expect("regex");
        let ld_plain = Regex::new(r"(?:^|: )(?P<msg>(?:region [`'][A-Z]+' overflowed by \d+ bytes|undefined reference to .*|multiple definition of .*|cannot find .*|section .* will not fit in region .*))$").expect("regex");
        let cmake = Regex::new(r"^CMake Error at (?P<file>.+?):(?P<line>\d+)").expect("regex");
        if let Some(c) = gcc.captures(line) {
            let path = self.resolve(&c["file"]);
            let (file, in_sdk) = self.display(&path);
            let severity = if c["sev"].contains("error") { "error" } else { &c["sev"] };
            let line_no: u64 = c["line"].parse().unwrap_or(1);
            let byte_col: u64 = c["col"].parse().unwrap_or(1);
            if severity == "note" {
                if let Some(last) = self.items.last_mut() {
                    let notes = last["notes"].as_array_mut();
                    let note = json!({"file": file, "line": line_no, "column": utf16_column(&path, line_no, byte_col), "message": &c["msg"]});
                    match notes {
                        Some(notes) => notes.push(note),
                        None => last["notes"] = json!([note]),
                    }
                }
                return;
            }
            if in_sdk && severity == "warning" {
                return; // SDK-internal warnings are not the student's (B3)
            }
            self.push(json!({
                "source": "compiler", "severity": severity, "file": file, "absolute": path.display().to_string(),
                "line": line_no, "column": utf16_column(&path, line_no, byte_col), "byteColumn": byte_col,
                "message": &c["msg"], "flag": c.name("flag").map(|m| m.as_str()), "inSdk": in_sdk,
            }));
        } else if let Some(c) = ld_line.captures(line) {
            let path = self.resolve(&c["file"]);
            let (file, in_sdk) = self.display(&path);
            let line_no: u64 = c["line"].parse().unwrap_or(1);
            self.push(json!({"source": "linker", "severity": "error", "file": file, "absolute": path.display().to_string(),
                "line": line_no, "column": 1, "message": &c["msg"], "inSdk": in_sdk}));
        } else if let Some(c) = ld_plain.captures(line) {
            let message = c["msg"].to_string();
            // "will not fit" always precedes the overflow line that says by how much.
            if message.contains("will not fit") || self.items.iter().any(|i| i["message"] == message.as_str()) {
                return;
            }
            self.push(json!({"source": "linker", "severity": "error", "file": null, "message": message}));
        } else if let Some(c) = cmake.captures(line) {
            let path = self.resolve(&c["file"]);
            let (file, _) = self.display(&path);
            self.cmake_error = Some(json!({"source": "cmake", "severity": "error", "file": file,
                "absolute": path.display().to_string(), "line": c["line"].parse::<u64>().unwrap_or(1), "column": 1, "message": ""}));
        } else if let Some(pending) = self.cmake_error.as_mut() {
            // CMake prints the message indented below the "CMake Error at" line.
            let text = line.trim();
            if text.is_empty() {
                if pending["message"].as_str().is_some_and(|m| !m.is_empty()) {
                    let done = self.cmake_error.take().unwrap_or_default();
                    self.push(done);
                }
            } else if line.starts_with(' ') {
                let joined = format!("{} {}", pending["message"].as_str().unwrap_or_default(), text);
                pending["message"] = json!(joined.trim());
            }
        }
    }

    pub fn finish(mut self) -> Vec<Value> {
        if let Some(pending) = self.cmake_error.take() {
            self.push(pending);
        }
        self.items
    }
}

/// `--print-memory-usage` table → `{FLASH: {used, size, percent}, RAM: …}`.
pub fn capacity(output: &str) -> Value {
    let row = Regex::new(r"^\s*([A-Z0-9_]+):\s+(\d+)\s*(B|KB|MB|GB)\s+(\d+)\s*(B|KB|MB|GB)\s+([\d.]+)%").expect("regex");
    let scale = |unit: &str| match unit {
        "KB" => 1024,
        "MB" => 1024 * 1024,
        "GB" => 1024 * 1024 * 1024,
        _ => 1,
    };
    let mut regions = serde_json::Map::new();
    for line in output.lines() {
        if let Some(c) = row.captures(line) {
            let used = c[2].parse::<u64>().unwrap_or(0) * scale(&c[3]);
            let size = c[4].parse::<u64>().unwrap_or(0) * scale(&c[5]);
            let percent: f64 = c[6].parse().unwrap_or(0.0);
            regions.insert(c[1].to_string(), json!({"used": used, "size": size, "percent": percent}));
        }
    }
    Value::Object(regions)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parser() -> Parser {
        let rules = Rules::load(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scope-extension/resources/stm32/diagnostics.zh-CN.json"));
        let ctx = Context {
            project: PathBuf::from("/p"),
            build_dir: PathBuf::from("/p/build/debug"),
            sdk: PathBuf::from("/tk/sdk/cube-f1"),
            hal_conf_name: "stm32f1xx_hal_conf.h".into(),
            enabled_modules: vec!["GPIO".into(), "RCC".into()],
            known_modules: vec!["ADC".into(), "GPIO".into(), "RCC".into(), "UART".into()],
        };
        Parser::new(ctx, rules)
    }

    #[test]
    fn compiler_lines_with_notes_and_flags() {
        let mut p = parser();
        p.line("/p/Core/Src/main.c:12:5: error: implicit declaration of function 'HAL_UART_Transmit' [-Wimplicit-function-declaration]");
        p.line("/p/Core/Src/main.c:3:1: note: include '<stdio.h>' or provide a declaration");
        p.line("/p/Core/Src/main.c:20:9: warning: unused variable 'x' [-Wunused-variable]");
        p.line("/tk/sdk/cube-f1/Drivers/x.c:1:1: warning: something in HAL");
        let items = p.finish();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["file"], "Core/Src/main.c");
        assert_eq!(items[0]["flag"], "-Wimplicit-function-declaration");
        assert_eq!(items[0]["explanation"]["rule"], "hal-module-disabled");
        assert_eq!(items[0]["notes"].as_array().unwrap().len(), 1);
        assert_eq!(items[1]["explanation"]["rule"], "unused-variable");
    }

    #[test]
    fn enabled_module_falls_back_to_generic_rule() {
        let mut p = parser();
        p.line("/p/Core/Src/main.c:12:5: error: implicit declaration of function 'HAL_GPIO_Toggle'");
        p.line("/p/Core/Src/main.c:13:5: error: implicit declaration of function 'HAL_Foo_Bar'");
        let items = p.finish();
        assert_eq!(items[0]["explanation"]["rule"], "implicit-declaration");
        assert_eq!(items[1]["explanation"]["rule"], "implicit-declaration");
    }

    #[test]
    fn linker_errors() {
        let mut p = parser();
        p.line("/arm/bin/ld: CMakeFiles/firmware.dir/Core/Src/main.c.obj: in function `main':");
        p.line("/p/Core/Src/main.c:30:(.text.main+0x1c): undefined reference to `led_on'");
        p.line("/arm/bin/ld: firmware.elf section `.bss' will not fit in region `RAM'");
        p.line("/arm/bin/ld: region `RAM' overflowed by 4096 bytes");
        let items = p.finish();
        assert_eq!(items.len(), 2, "{items:?}");
        assert_eq!(items[0]["explanation"]["rule"], "undefined-reference");
        assert_eq!(items[0]["line"], 30);
        assert_eq!(items[1]["explanation"]["rule"], "ram-overflow");
        assert!(items[1]["explanation"]["title"].as_str().unwrap().contains("4096"));
    }

    #[test]
    fn cmake_error_block() {
        let mut p = parser();
        p.line("CMake Error at cmake/nodu.cmake:15 (message):");
        p.line("  找不到 STM32F1xx HAL。");
        p.line("");
        let items = p.finish();
        assert_eq!(items[0]["source"], "cmake");
        assert!(items[0]["message"].as_str().unwrap().contains("HAL"));
    }

    #[test]
    fn memory_usage_table() {
        let text = "Memory region         Used Size  Region Size  %age Used\n           FLASH:        3592 B         1 MB      0.34%\n             RAM:        1960 B       128 KB      1.50%\n";
        let cap = capacity(text);
        assert_eq!(cap["FLASH"]["used"], 3592);
        assert_eq!(cap["FLASH"]["size"], 1_048_576);
        assert_eq!(cap["RAM"]["size"], 131_072);
    }

    #[test]
    fn utf16_columns_skip_chinese_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.c");
        std::fs::write(&file, "int a; /* 中文 */ x\n").unwrap();
        // "x" is at byte 21 (1-based): 7 ASCII + "/* " + 6 bytes + " */ ".
        assert_eq!(utf16_column(&file, 1, 21), 17);
    }
}
