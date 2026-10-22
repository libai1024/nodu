// SPDX-License-Identifier: MIT
//! STM32 toolkit lookup and integrity (FUNCTIONAL-DESIGN §4).
//!
//! The Node backend passes the toolkit root (`--toolkit`); `NODU_STM32_TOOLKIT`
//! overrides it. `toolkit.json` lists every file with size and SHA-256. The
//! quick check compares sizes; the full check hashes everything once and the
//! result is cached in the user data directory.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::proto::{Failure, Outcome};
use crate::util::{read_json, sha256_file, str_field, write_json};

#[derive(Debug, Clone)]
pub struct Toolkit {
    pub root: PathBuf,
    pub manifest: Value,
}

const EXE: &str = if cfg!(windows) { ".exe" } else { "" };

impl Toolkit {
    pub fn open(root: &Path) -> Outcome<Self> {
        let manifest_path = root.join("toolkit.json");
        if !manifest_path.is_file() {
            return Err(Failure::new(
                "toolkitMissing",
                "找不到 STM32 工具包。重新安装 Nodu 可以修复；开发环境请运行 node scripts/build-toolkit.cjs。",
            )
            .with_detail(json!({"root": root.display().to_string()})));
        }
        let manifest = read_json(&manifest_path)?;
        Ok(Self { root: root.to_path_buf(), manifest })
    }

    pub fn version(&self) -> &str {
        str_field(&self.manifest, &["version"]).unwrap_or("unknown")
    }

    pub fn tool(&self, component: &str, name: &str) -> PathBuf {
        self.root.join(component).join("bin").join(format!("{name}{EXE}"))
    }
    pub fn cmake(&self) -> PathBuf {
        self.tool("cmake", "cmake")
    }
    pub fn ninja(&self) -> PathBuf {
        self.tool("ninja", "ninja")
    }
    pub fn openocd(&self) -> PathBuf {
        self.tool("openocd", "openocd")
    }
    pub fn openocd_scripts(&self) -> PathBuf {
        self.root.join("openocd/share/openocd/scripts")
    }
    pub fn stm32flash(&self) -> PathBuf {
        self.tool("stm32flash", "stm32flash")
    }
    pub fn gcc_tool(&self, name: &str) -> PathBuf {
        self.tool("arm-gnu", &format!("arm-none-eabi-{name}"))
    }
    pub fn clangd(&self) -> PathBuf {
        self.tool("clangd", "clangd")
    }
    pub fn sdk(&self, dir: &str) -> PathBuf {
        self.root.join("sdk").join(dir)
    }

    /// Environment for tool child processes: only toolkit directories and the
    /// minimum system path, English messages, no inherited `CMAKE_*` settings.
    pub fn child_env(&self) -> BTreeMap<String, String> {
        let mut env = BTreeMap::new();
        let mut path: Vec<PathBuf> = ["cmake", "ninja", "arm-gnu", "openocd", "stm32flash"]
            .iter()
            .map(|c| self.root.join(c).join("bin"))
            .collect();
        if cfg!(windows) {
            if let Ok(root) = std::env::var("SystemRoot") {
                path.push(PathBuf::from(&root).join("System32"));
                path.push(PathBuf::from(root));
                env.insert("SystemRoot".into(), std::env::var("SystemRoot").unwrap_or_default());
            }
        } else {
            path.push("/usr/bin".into());
            path.push("/bin".into());
        }
        let joined = std::env::join_paths(path).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        env.insert("PATH".into(), joined);
        env.insert("LC_ALL".into(), "C".into());
        env.insert("LANG".into(), "C".into());
        env.insert("NODU_STM32_TOOLKIT".into(), self.root.display().to_string());
        for key in ["HOME", "TMPDIR", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA"] {
            if let Ok(value) = std::env::var(key) {
                env.insert(key.into(), value);
            }
        }
        env
    }

    fn files(&self) -> Vec<(String, u64, String)> {
        self.manifest
            .get("files")
            .and_then(Value::as_array)
            .map(|files| {
                files
                    .iter()
                    .filter_map(|f| {
                        Some((
                            f.get("path")?.as_str()?.to_string(),
                            f.get("size")?.as_u64()?,
                            f.get("sha256")?.as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Existence and size of every file. `full` also hashes them.
    pub fn check(&self, full: bool, cache: Option<&Path>) -> Value {
        let files = self.files();
        let mut missing = Vec::new();
        let mut damaged = Vec::new();
        for (rel, size, sha) in &files {
            let path = self.root.join(rel);
            match std::fs::metadata(&path) {
                Ok(meta) if meta.len() == *size => {
                    if full && sha256_file(&path).ok().as_deref() != Some(sha.as_str()) {
                        damaged.push(rel.clone());
                    }
                }
                Ok(_) => damaged.push(rel.clone()),
                Err(_) => missing.push(rel.clone()),
            }
        }
        let ok = !files.is_empty() && missing.is_empty() && damaged.is_empty();
        let report = json!({
            "ok": ok,
            "full": full,
            "version": self.version(),
            "profile": self.manifest.get("profile").cloned().unwrap_or(Value::Null),
            "root": self.root.display().to_string(),
            "fileCount": files.len(),
            "totalBytes": self.manifest.get("totalBytes").cloned().unwrap_or(Value::Null),
            "components": self.manifest.get("components").cloned().unwrap_or(Value::Null),
            "sdk": self.manifest.get("sdk").cloned().unwrap_or(Value::Null),
            "missing": missing.iter().take(50).collect::<Vec<_>>(),
            "damaged": damaged.iter().take(50).collect::<Vec<_>>(),
            "problemCount": missing.len() + damaged.len(),
            "checkedAt": crate::util::iso_now(),
        });
        if full {
            if let Some(cache) = cache {
                let _ = write_json(cache, &report);
            }
        }
        report
    }
}

/// Returns the cached full-check report if it matches this toolkit version.
pub fn cached_full_check(cache: &Path, toolkit: &Toolkit) -> Option<Value> {
    let report = read_json(cache).ok()?;
    (report.get("version").and_then(Value::as_str) == Some(toolkit.version())
        && report.get("ok").and_then(Value::as_bool) == Some(true))
    .then_some(report)
}
