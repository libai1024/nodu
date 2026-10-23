// SPDX-License-Identifier: MIT
//! Portable exports and read-only CubeMX discovery. Never execute project scripts here.
use std::{fs, path::{Path, PathBuf}};
use serde_json::{Value, json};
use crate::{catalog::Catalog, project::Project, proto::{Failure, Outcome}, toolkit::Toolkit, util::{read_json, write_json}};

fn copy_tree(from: &Path, to: &Path, project_root: bool) -> Outcome<()> {
    fs::create_dir_all(to).map_err(|e| Failure::io("创建导出目录", &e))?;
    for entry in fs::read_dir(from).map_err(|e| Failure::io("读取导出来源", &e))? {
        let entry = entry.map_err(|e| Failure::io("读取导出文件", &e))?;
        let name = entry.file_name();
        let text = name.to_string_lossy();
        if text == ".git" || text == ".DS_Store" || (project_root && ["build", ".nodu", ".cache", ".theia", ".vscode", "compile_commands.json", "CMakeUserPresets.json"].contains(&text.as_ref())) { continue; }
        let kind = entry.file_type().map_err(|e| Failure::io("读取文件类型", &e))?;
        if kind.is_symlink() { return Err(Failure::new("exportSymlink", format!("导出不跟随符号链接：{}", entry.path().display()))); }
        let dest = to.join(&name);
        if kind.is_dir() { copy_tree(&entry.path(), &dest, false)?; }
        else if kind.is_file() { fs::copy(entry.path(), dest).map_err(|e| Failure::io("复制导出文件", &e))?; }
    }
    Ok(())
}

pub fn export(project: &Project, toolkit: &Toolkit, destination: &Path) -> Outcome<Value> {
    if !destination.is_absolute() { return Err(Failure::new("badRequest", "导出位置必须是绝对路径。")); }
    let parent = destination.parent().and_then(|p| fs::canonicalize(p).ok()).ok_or_else(|| Failure::new("badRequest", "导出父目录不存在。"))?;
    let target = parent.join(destination.file_name().ok_or_else(|| Failure::new("badRequest", "导出文件夹名称无效。"))?);
    if parent.starts_with(&project.root) { return Err(Failure::new("badRequest", "请导出到工程目录以外，避免递归复制。")); }
    // create_dir is exclusive: never overwrite an existing folder, even if empty.
    fs::create_dir(&target).map_err(|e| Failure::io("创建独立工程（目标必须不存在）", &e))?;
    let result = (|| {
        copy_tree(&project.root, &target, true)?;
        if !project.is_external() && !target.join("Drivers").exists() {
            let sdk = toolkit.sdk(project.chip.0["sdk"]["dir"].as_str().unwrap_or_default());
            copy_tree(&sdk.join("Drivers"), &target.join("Drivers"), false)?;
            // Preserve SDK notices at their original relative locations as well as top-level notices.
            for entry in fs::read_dir(&sdk).map_err(|e| Failure::io("读取 SDK 许可", &e))? {
                let entry = entry.map_err(|e| Failure::io("读取 SDK 许可", &e))?;
                if entry.file_type().is_ok_and(|t| t.is_file()) {
                    fs::create_dir_all(target.join("SDK-notices")).map_err(|e| Failure::io("创建许可目录", &e))?;
                    fs::copy(entry.path(), target.join("SDK-notices").join(entry.file_name())).map_err(|e| Failure::io("复制 SDK 许可", &e))?;
                }
            }
        }
        if project.is_external() {
            let presets_path = target.join("CMakePresets.json");
            let mut presets = if presets_path.exists() { read_json(&presets_path)? } else { json!({"version": 6, "configurePresets": [], "buildPresets": []}) };
            let has_debug = presets["configurePresets"].as_array().is_some_and(|ps| ps.iter().any(|p| p["name"] == "debug"));
            if !has_debug {
                let toolchain = "cmake/nodu-export-arm-gcc.cmake";
                fs::create_dir_all(target.join("cmake")).map_err(|e| Failure::io("创建导出工具链目录", &e))?;
                fs::write(target.join(toolchain), include_str!("../../../../scope-extension/resources/stm32/templates/common/cmake/arm-gcc.cmake"))
                    .map_err(|e| Failure::io("写导出工具链", &e))?;
                if !presets["configurePresets"].is_array() { presets["configurePresets"] = json!([]); }
                presets["configurePresets"].as_array_mut().unwrap().push(json!({"name": "debug", "generator": "Ninja",
                    "binaryDir": "${sourceDir}/build/debug", "toolchainFile": format!("${{sourceDir}}/{toolchain}"), "cacheVariables": {"CMAKE_BUILD_TYPE": "Debug"}}));
            }
            if !presets["buildPresets"].is_array() { presets["buildPresets"] = json!([]); }
            if !presets["buildPresets"].as_array().unwrap().iter().any(|p| p["name"] == "debug") {
                presets["buildPresets"].as_array_mut().unwrap().push(json!({"name": "debug", "configurePreset": "debug"}));
            }
            write_json(&presets_path, &presets)?;
        }
        let instructions = format!("# 独立 STM32 工程\n\n此目录不依赖 Nodu。保留原工程 README，本文为导出说明。\n\n安装 Arm GNU Toolchain（原工具包版本 {}）、CMake >= 3.25 和 Ninja，将 arm-none-eabi-gcc、cmake、ninja 放入 PATH。\n\n```sh\ncmake --preset debug\ncmake --build --preset debug\n```\n\nHAL/CMSIS 已复制到 Drivers，相关许可保留在各组件目录。build 和本机配置未导出。\n", toolkit.version());
        fs::write(target.join("README-Nodu-export.md"), instructions).map_err(|e| Failure::io("写导出说明", &e))?;
        Ok(json!({"path": target.display().to_string(), "standalone": true}))
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&target); }
    result
}

fn has_startup(dir: &Path, depth: usize) -> bool {
    if depth > 3 { return false; }
    fs::read_dir(dir).ok().into_iter().flatten().filter_map(Result::ok).any(|entry| {
        let name = entry.file_name().to_string_lossy().to_string();
        let kind = entry.file_type().ok();
        if kind.as_ref().is_some_and(|t| t.is_file()) {
            name.to_lowercase().starts_with("startup_stm32") && name.to_lowercase().ends_with(".s")
        } else if kind.is_some_and(|t| t.is_dir()) && !["build", ".git", ".nodu"].contains(&name.as_str()) {
            has_startup(&entry.path(), depth + 1)
        } else { false }
    })
}

pub fn detect(root: &Path, catalog: &Catalog) -> Outcome<Value> {
    if root.join("nodu.json").exists() || !root.join("CMakeLists.txt").is_file() { return Ok(Value::Null); }
    let mut detected = None;
    for entry in fs::read_dir(root).map_err(|e| Failure::io("读取外部工程", &e))? {
        let entry = entry.map_err(|e| Failure::io("读取外部工程", &e))?;
        if entry.path().extension().is_some_and(|e| e == "ioc") && entry.file_type().is_ok_and(|t| t.is_file()) {
            let text = fs::read_to_string(entry.path()).map_err(|e| Failure::io("读取 CubeMX 配置", &e))?;
            for line in text.lines().filter(|line| line.starts_with("Mcu.Name=") || line.starts_with("Mcu.CPN=")) {
                if line.contains("STM32F103C8") { detected = Some("generic-f103c8"); }
                else if line.contains("STM32F407ZG") { detected = Some("alientek-explorer-f407"); }
            }
            if let Some(board) = detected {
                let board = catalog.board(board)?;
                return Ok(json!({"board": board.reference(), "mcu": board.mcu(), "name": root.file_name().unwrap_or_default().to_string_lossy()}));
            }
            return Ok(json!({"board": null, "mcu": null}));
        }
    }
    // A startup filename identifies a family/density, not necessarily an exact
    // package/Flash size. Require manual MCU selection instead of guessing C8.

    if has_startup(root, 0) { return Ok(json!({"board": null, "mcu": null})); }
    Ok(Value::Null)
}

pub fn import(root: &Path, board_ref: &str, catalog: &Catalog) -> Outcome<PathBuf> {
    let root = fs::canonicalize(root).map_err(|e| Failure::io("打开外部工程", &e))?;
    if root.join("nodu.json").exists() { return Err(Failure::new("exists", "工程已有 nodu.json，未覆盖。")); }
    let detected = detect(&root, catalog)?;
    if detected.is_null() { return Err(Failure::new("notProject", "需要 CMakeLists.txt 和 CubeMX .ioc 或 STM32 启动文件。")); }
    let board = catalog.board(board_ref)?;
    if detected["mcu"].as_str().is_some_and(|mcu| mcu != board.mcu()) { return Err(Failure::new("chipMismatch", "选择的芯片与 CubeMX 配置不一致。")); }
    let manifest = json!({"schema": 1, "kind": "stm32-hal", "name": root.file_name().unwrap_or_default().to_string_lossy(),
        "target": {"mcu": board.mcu(), "board": board.reference()}, "build": {"preset": "debug", "external": true},
        "flash": {"method": "stlink"}, "monitor": {"baud": 115200, "encoding": "utf-8"}});
    // The frontend asks about trust separately. Importing never grants trust.
    write_json(&root.join("nodu.json"), &manifest)?;
    Ok(root)
}

pub fn accept_toolkit(project: &Project, toolkit: &Toolkit) -> Outcome<()> {
    let path = project.root.join("nodu.lock.json");
    let mut lock = if path.exists() { read_json(&path)? } else { json!({"schema": 1}) };
    lock["toolkit"] = json!({"id": toolkit.manifest["id"], "version": toolkit.version()});
    write_json(&path, &lock)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copy_excludes_machine_state_and_rejects_links() {
        let root = std::env::temp_dir().join(format!("nodu-export-{}", crate::util::new_id("export")));
        fs::create_dir_all(root.join("source/.nodu")).unwrap();
        fs::write(root.join("source/.nodu/private"), "secret").unwrap();
        fs::write(root.join("source/main.c"), "int main(void) {}").unwrap();
        copy_tree(&root.join("source"), &root.join("target"), true).unwrap();
        assert!(!root.join("target/.nodu").exists());
        assert!(root.join("target/main.c").exists());
        #[cfg(unix)] {
            std::os::unix::fs::symlink("/etc/passwd", root.join("source/link")).unwrap();
            assert_eq!(copy_tree(&root.join("source"), &root.join("other"), true).unwrap_err().code, "exportSymlink");
        }
        fs::remove_dir_all(root).unwrap();
    }
}
