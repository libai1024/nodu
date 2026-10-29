// SPDX-License-Identifier: MIT
//! Download orchestration shared by ST-LINK and serial ISP (FUNCTIONAL-DESIGN
//! §7.1, §7.4, §7.5): check the chip, back up a chip the first time, write
//! only what the image needs, read back and compare, then start the program.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use regex::Regex;
use serde_json::{Value, json};

use crate::catalog::Chip;
use crate::project::Project;
use crate::proto::{Failure, Outcome, Output};
use crate::stlink;
use crate::toolkit::Toolkit;
use crate::uart;
use crate::util::{iso_now, read_json, sha256_file, stamp_now, write_json};

/// Device IDs (DBGMCU_IDCODE[11:0]) of the STM32 lines students meet most.
pub fn device_name(id: u64) -> &'static str {
    match id {
        0x410 => "STM32F103（中容量，如 C8 / CB）",
        0x412 => "STM32F103（小容量）",
        0x414 => "STM32F103（大容量，如 RC / ZE）",
        0x418 => "STM32F105 / F107",
        0x430 => "STM32F103（超大容量）",
        0x413 => "STM32F405 / F407",
        0x419 => "STM32F42x / F43x",
        0x423 | 0x433 => "STM32F401",
        0x431 => "STM32F411",
        0x421 => "STM32F446",
        _ => "未知型号",
    }
}

/// Reject before anything is erased (F3, F8).
pub fn check_identity(chip: &Chip, identity: &Value, needed: u64) -> Outcome<()> {
    let id = identity["deviceId"].as_u64().unwrap_or(0);
    let kib = identity["flashKiB"].as_u64().unwrap_or(0);
    if id != chip.device_id() {
        let size = if kib > 0 { format!("，{kib} KB") } else { String::new() };
        return Err(Failure::new("wrongChip", format!(
            "板上是 {}（设备 ID 0x{id:03x}{size}），工程的目标是 {}。没有写入。请换板，或为这块板新建工程。",
            device_name(id), chip.name()))
        .with_detail(json!({"identity": identity})));
    }
    if identity["readProtected"].as_bool() == Some(true) {
        return Err(Failure::new("readProtected",
            "芯片开启了读保护。Nodu 不会解除读保护（解除会擦除整片 Flash）。如需继续，请用 STM32CubeProgrammer 处理后再试。")
            .with_detail(json!({"identity": identity})));
    }
    if kib * 1024 < needed {
        return Err(Failure::new("tooLarge", format!("芯片 Flash 只有 {kib} KB，程序需要 {} KB。", needed.div_ceil(1024))));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct Backups {
    root: PathBuf,
}

impl Backups {
    pub fn new(data_dir: &Path) -> Self {
        Self { root: data_dir.join("stm32").join("backups") }
    }

    fn chip_key(identity: &Value) -> String {
        format!("{:03x}-{}", identity["deviceId"].as_u64().unwrap_or(0), identity["uid"].as_str().unwrap_or_default())
    }

    pub fn list(&self, uid: Option<&str>) -> Vec<Value> {
        let mut out = Vec::new();
        for chip in fs::read_dir(&self.root).into_iter().flatten().flatten() {
            let key = chip.file_name().to_string_lossy().into_owned();
            if uid.is_some_and(|u| !key.ends_with(&format!("-{u}"))) {
                continue;
            }
            for entry in fs::read_dir(chip.path()).into_iter().flatten().flatten() {
                if let Ok(mut record) = read_json(&entry.path().join("backup.json")) {
                    record["id"] = json!(format!("{key}/{}", entry.file_name().to_string_lossy()));
                    out.push(record);
                }
            }
        }
        out.sort_by(|a, b| b["createdAt"].as_str().cmp(&a["createdAt"].as_str()));
        out
    }

    pub fn has(&self, identity: &Value) -> bool {
        let dir = self.root.join(Self::chip_key(identity));
        fs::read_dir(dir).into_iter().flatten().flatten().any(|entry| {
            let id = format!("{}/{}", Self::chip_key(identity), entry.file_name().to_string_lossy());
            self.get(&id).ok().is_some_and(|(record, file)| record["uid"] == identity["uid"]
                && record["flashKiB"] == identity["flashKiB"]
                && fs::metadata(file).map(|m| m.len()).ok() == identity["flashKiB"].as_u64().map(|n| n * 1024))
        })
    }

    pub fn get(&self, id: &str) -> Outcome<(Value, PathBuf)> {
        let shape = Regex::new(r"^[0-9a-f]{3}-[0-9a-f]{24}/\d{8}-\d{6}$").expect("regex");
        if !shape.is_match(id) {
            return Err(Failure::new("badRequest", "无效的备份编号。"));
        }
        let dir = self.root.join(id);
        let record = read_json(&dir.join("backup.json")).map_err(|_| Failure::new("noBackup", "找不到这份备份。"))?;
        let file = dir.join("flash.bin");
        if sha256_file(&file).ok().as_deref() != record["sha256"].as_str() {
            return Err(Failure::new("badBackup", "备份文件已损坏（摘要不一致），不能用于恢复。"));
        }
        Ok((record, file))
    }

    fn new_slot(&self, identity: &Value) -> Outcome<PathBuf> {
        let dir = self.root.join(Self::chip_key(identity)).join(stamp_now());
        fs::create_dir_all(&dir).map_err(|e| Failure::io("创建备份目录", &e))?;
        Ok(dir)
    }

    fn seal(&self, dir: &Path, identity: &Value, method: &str, factory: bool) -> Outcome<Value> {
        let file = dir.join("flash.bin");
        let size = fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
        let expected = identity["flashKiB"].as_u64().unwrap_or(0) * 1024;
        if size == 0 || size != expected {
            let _ = fs::remove_dir_all(dir);
            return Err(Failure::new("backupFailed", format!("备份不完整：读到 {size} 字节，应为 {expected} 字节。没有写入。")));
        }
        let record = json!({
            "schema": 1, "createdAt": iso_now(), "deviceId": identity["deviceId"], "deviceName": device_name(identity["deviceId"].as_u64().unwrap_or(0)),
            "uid": identity["uid"], "flashKiB": identity["flashKiB"], "bytes": size,
            "sha256": sha256_file(&file).map_err(|e| Failure::io("读取备份", &e))?,
            "method": method, "firstBackup": factory, "factory": false, "nodu": env!("CARGO_PKG_VERSION"),
        });
        write_json(&dir.join("backup.json"), &record)?;
        let mut record = record;
        record["id"] = json!(format!("{}/{}", Self::chip_key(identity), dir.file_name().unwrap_or_default().to_string_lossy()));
        Ok(record)
    }
}

/// What to write: a built artifact or a backup being restored.
#[derive(Debug)]
pub struct Image {
    pub file: PathBuf,
    pub bytes: u64,
    pub sha256: String,
    pub bundle: Option<String>,
    pub tick: Option<u64>,
    /// Restores never take another backup and must go to the same chip.
    pub restore_uid: Option<String>,
}

#[derive(Debug)]
pub struct Target<'a> {
    pub method: &'a str,
    pub probe: &'a str,
    pub port: &'a str,
    pub baud: u32,
    pub skip_backup: bool,
    /// Optional pinned target identity for an externally prepared operation.
    pub expected_uid: Option<&'a str>,
}

#[derive(Debug)]
pub struct Ctx<'a> {
    pub toolkit: &'a Toolkit,
    pub project: &'a Project,
    pub backups: &'a Backups,
    pub out: &'a Output,
    pub cancel: &'a AtomicBool,
}

fn step(out: &Output, run_id: &str, name: &str, state: &str) {
    out.event("flash.step", json!({"runId": run_id, "step": name, "state": state}));
}

fn check_restore(image: &Image, identity: &Value) -> Outcome<()> {
    if let Some(uid) = &image.restore_uid {
        if identity["uid"].as_str() != Some(uid.as_str()) {
            return Err(Failure::new("wrongChip", "这份备份来自另一颗芯片（唯一 ID 不同），不能恢复到这块板上。"));
        }
    }
    Ok(())
}

fn compare_readback(readback: &Path, image: &Image) -> Outcome<String> {
    let digest = sha256_file(readback).map_err(|e| Failure::io("读取读回文件", &e))?;
    let _ = fs::remove_file(readback);
    if digest != image.sha256 {
        return Err(Failure::new("verifyFailed", "写入后读回的内容与程序不一致。芯片里的程序可能不完整，重新下载即可恢复。"));
    }
    Ok(digest)
}

pub fn run(ctx: &Ctx<'_>, target: &Target<'_>, image: &Image, run_id: &str) -> Outcome<Value> {
    let started = Instant::now();
    let runs = ctx.project.state_dir().join("runs");
    fs::create_dir_all(&runs).map_err(|e| Failure::io("创建运行记录目录", &e))?;
    let readback = runs.join(format!("{run_id}-readback.bin"));
    let mut record = json!({
        "runId": run_id, "startedAt": iso_now(), "bundle": image.bundle, "method": target.method,
        "bytes": image.bytes, "restore": image.restore_uid.is_some(), "steps": [],
    });
    let result = match target.method {
        "uart" => run_uart(ctx, target, image, run_id, &readback, &mut record),
        _ => run_stlink(ctx, target, image, run_id, &readback, &mut record),
    };
    let _ = fs::remove_file(&readback);
    record["ms"] = json!(started.elapsed().as_millis() as u64);
    match &result {
        Ok(value) => {
            record["result"] = json!(if value["needsBootRestore"] == json!(true) { "awaitingBootRestore" }
                else if value["running"] == json!(false) { "notRunning" } else if value["autoBoot"] == json!(true) { "runRequested" } else { "running" });
            record["readbackSha256"] = value["readbackSha256"].clone();
        }
        Err(failure) => {
            record["result"] = json!("failed");
            record["error"] = json!({"code": failure.code, "message": failure.message});
        }
    }
    let _ = write_json(&runs.join(format!("{run_id}.json")), &record);
    result.map(|mut value| {
        value["runId"] = json!(run_id);
        value["ms"] = record["ms"].clone();
        value
    })
}

fn run_stlink(ctx: &Ctx<'_>, target: &Target<'_>, image: &Image, run_id: &str, readback: &Path, record: &mut Value) -> Outcome<Value> {
    let session = stlink::Session {
        toolkit: ctx.toolkit, chip: &ctx.project.chip, board: &ctx.project.board,
        serial: target.probe, out: ctx.out, cancel: ctx.cancel, run_id,
    };
    step(ctx.out, run_id, "identify", "running");
    let (probe, _lock) = stlink::select_probe(&session)?;
    let session = stlink::Session { serial: &probe, ..session };
    record["probe"] = json!(probe);
    let identity = session.identify()?;
    record["target"] = identity.clone();
    check_identity(&ctx.project.chip, &identity, image.bytes)?;
    if let Some(expected) = target.expected_uid {
        if !(64..=128).contains(&identity["flashKiB"].as_u64().unwrap_or(0)) || identity["readProtected"].as_bool() != Some(false) {
            return Err(Failure::new("wrongChip", "目标容量或读保护状态不满足课程要求，没有写入。"));
        }
        if identity["uid"].as_str() != Some(expected) {
            return Err(Failure::new("chipChanged", "目标芯片已变化，没有写入。请重新识别。"));
        }
    }
    check_restore(image, &identity)?;
    step(ctx.out, run_id, "identify", "done");
    let uid_words = identity["uidWords"].as_str().unwrap_or_default().to_string();

    let mut backup = Value::Null;
    if image.restore_uid.is_none() && !ctx.backups.has(&identity) {
        if target.skip_backup {
            record["backupSkipped"] = json!(true);
        } else {
            let dir = ctx.backups.new_slot(&identity)?;
            let bytes = identity["flashKiB"].as_u64().unwrap_or(0) * 1024;
            if let Err(failure) = session.backup(&uid_words, &dir.join("flash.bin"), bytes) {
                let _ = fs::remove_dir_all(&dir);
                return Err(failure);
            }
            backup = ctx.backups.seal(&dir, &identity, "stlink", true)?;
            step(ctx.out, run_id, "backup", "done");
        }
    }
    if crate::util::sha256_file(&image.file).ok().as_deref() != Some(image.sha256.as_str()) {
        return Err(Failure::new("tampered", "要写入的文件在下载前被修改，已停止。重新编译。"));
    }
    session.program(&uid_words, &image.file, readback, image.bytes)?;
    let digest = compare_readback(readback, image)?;
    step(ctx.out, run_id, "verify", "done");
    step(ctx.out, run_id, "run", "running");
    let ran = session.start_verified(&uid_words, image.tick)?;
    step(ctx.out, run_id, "run", "done");
    Ok(json!({
        "ok": true, "method": "stlink", "identity": identity, "backup": backup,
        "erase": ctx.project.chip.erase_plan(image.bytes), "bytes": image.bytes,
        "readbackSha256": digest, "running": ran["running"], "needsBootRestore": false,
    }))
}

fn run_uart(ctx: &Ctx<'_>, target: &Target<'_>, image: &Image, run_id: &str, readback: &Path, record: &mut Value) -> Outcome<Value> {
    if let Some(profile) = crate::auto_boot::AutoBoot::parse(&ctx.project.manifest["flash"]["autoBoot"], ctx.project.chip.id())? {
        return run_uart_auto(ctx, target, image, run_id, readback, record, profile);
    }
    let chip = &ctx.project.chip;
    let port = target.port;
    if port.is_empty() {
        return Err(Failure::new("noPort", "串口下载需要先选择串口。"));
    }
    ctx.out.event("flash.awaitUser", json!({"runId": run_id, "kind": "enterBoot", "port": port,
        "boot": ctx.project.board.value.get("boot")}));
    step(ctx.out, run_id, "identify", "running");
    let identity = {
        let mut link = uart::wait_for_rom(port, target.baud, ctx.cancel)?;
        ctx.out.event("flash.detected", json!({"runId": run_id}));
        uart::identify(&mut link, chip.reg("flashSize"), chip.reg("uid"))?
    };
    record["target"] = identity.clone();
    check_identity(chip, &identity, image.bytes)?;
    if let Some(expected) = target.expected_uid {
        if identity["uid"].as_str() != Some(expected) || !(64..=128).contains(&identity["flashKiB"].as_u64().unwrap_or(0)) || identity["readProtected"].as_bool() != Some(false) {
            return Err(Failure::new("chipChanged", "目标芯片已变化，没有写入。"));
        }
    }
    check_restore(image, &identity)?;
    step(ctx.out, run_id, "identify", "done");
    let base = chip.flash_base();
    if ctx.cancel.load(Ordering::Relaxed) { return Err(Failure::cancelled()); }

    let mut backup = Value::Null;
    if image.restore_uid.is_none() && !ctx.backups.has(&identity) {
        if target.skip_backup {
            record["backupSkipped"] = json!(true);
        } else {
            step(ctx.out, run_id, "backup", "running");
            let dir = ctx.backups.new_slot(&identity)?;
            let bytes = identity["flashKiB"].as_u64().unwrap_or(0) * 1024;
            let args = uart::read_args(target.baud, &dir.join("flash.bin"), base, bytes, port);
            if let Err(failure) = uart::stm32flash(ctx.toolkit, &args, ctx.out, run_id, "backup", ctx.cancel) {
                let _ = fs::remove_dir_all(&dir);
                return Err(failure);
            }
            backup = ctx.backups.seal(&dir, &identity, "uart", true)?;
            step(ctx.out, run_id, "backup", "done");
        }
    }
    if crate::util::sha256_file(&image.file).ok().as_deref() != Some(image.sha256.as_str()) {
        return Err(Failure::new("tampered", "要写入的文件在下载前被修改，已停止。重新编译。"));
    }
    if ctx.cancel.load(Ordering::Relaxed) { return Err(Failure::cancelled()); }
    step(ctx.out, run_id, "program", "running");
    uart::stm32flash(ctx.toolkit, &uart::write_args(target.baud, &image.file, base, image.bytes, port), ctx.out, run_id, "program", ctx.cancel)?;
    step(ctx.out, run_id, "program", "done");
    step(ctx.out, run_id, "verify", "running");
    uart::stm32flash(ctx.toolkit, &uart::read_args(target.baud, readback, base, image.bytes, port), ctx.out, run_id, "verify", ctx.cancel)?;
    let digest = compare_readback(readback, image)?;
    step(ctx.out, run_id, "verify", "done");
    ctx.out.event("flash.awaitUser", json!({"runId": run_id, "kind": "exitBoot", "port": port,
        "boot": ctx.project.board.value.get("boot")}));
    Ok(json!({
        "ok": true, "method": "uart", "identity": identity, "backup": backup,
        "erase": chip.erase_plan(image.bytes), "bytes": image.bytes,
        "readbackSha256": digest, "running": Value::Null, "needsBootRestore": true,
    }))
}

/// Keep one serial handle from reset through readback: reopening an external tool could change DTR/RTS.
fn run_uart_auto(ctx: &Ctx<'_>, target: &Target<'_>, image: &Image, run_id: &str, readback: &Path, record: &mut Value, profile: crate::auto_boot::AutoBoot) -> Outcome<Value> {
    if ctx.cancel.load(Ordering::Relaxed) { return Err(Failure::cancelled()); }
    if image.bytes == 0 || image.bytes > 65536 { return Err(Failure::new("tooLarge", "自动 ISP 仅支持 64 KiB 以内的 F103C8 固件。")); }
    let mut link = uart::open_rom(target.port, target.baud)?;
    run_uart_auto_link(ctx, target, image, run_id, readback, record, profile, &mut link)
}

#[allow(clippy::too_many_arguments)]
fn run_uart_auto_link(ctx: &Ctx<'_>, target: &Target<'_>, image: &Image, run_id: &str, readback: &Path, record: &mut Value, profile: crate::auto_boot::AutoBoot, mut link: &mut dyn crate::auto_boot::BootPort) -> Outcome<Value> {
    let mut programming = false;
    let result = (|| {
        step(ctx.out, run_id, "identify", "running");
        crate::auto_boot::pulse(link, profile, true)?;
        uart::wait_on_link(&mut link, ctx.cancel)?;
        ctx.out.event("flash.detected", json!({"runId": run_id}));
        let chip = &ctx.project.chip;
        let identity = uart::identify(&mut link, chip.reg("flashSize"), chip.reg("uid"))?;
        record["target"] = identity.clone(); check_identity(chip, &identity, image.bytes)?; check_restore(image, &identity)?;
        if identity["flashKiB"].as_u64() != Some(64) { return Err(Failure::new("wrongChip", "自动 ISP 需要 64 KiB 的 STM32F103C8T6。")); }
        let supported = uart::commands(&mut link)?;
        if ![0x11, 0x31].iter().all(|cmd| supported.contains(cmd)) || !supported.iter().any(|cmd| *cmd == 0x43 || *cmd == 0x44) {
            return Err(Failure::new("romProtocol", "Bootloader 缺少读取、写入或擦除命令。"));
        }
        step(ctx.out, run_id, "identify", "done");
        let read = |link: &mut dyn uart::ReadWrite, length: usize, stage: &str, cancellable: bool| -> Outcome<Vec<u8>> {
            let mut bytes = Vec::with_capacity(length);
            while bytes.len() < length {
                if cancellable && ctx.cancel.load(Ordering::Relaxed) { return Err(Failure::cancelled()); }
                bytes.extend(uart::read_memory(link, chip.flash_base() as u32 + bytes.len() as u32, (length - bytes.len()).min(256))?);
                ctx.out.event("flash.progress", json!({"runId":run_id,"step":stage,"percent":100.0 * bytes.len() as f64 / length as f64}));
            }
            Ok(bytes)
        };
        let mut backup = Value::Null;
        if image.restore_uid.is_none() && !ctx.backups.has(&identity) {
            if target.skip_backup { record["backupSkipped"] = json!(true); }
            else {
                step(ctx.out, run_id, "backup", "running");
                let bytes = read(&mut link, 65536, "backup", true)?;
                let dir = ctx.backups.new_slot(&identity)?;
                if let Err(e) = fs::write(dir.join("flash.bin"), bytes) { let _ = fs::remove_dir_all(&dir); return Err(Failure::io("保存首次备份", &e)); }
                backup = ctx.backups.seal(&dir, &identity, "uart", true)?;
                step(ctx.out, run_id, "backup", "done");
            }
        }
        let bytes = fs::read(&image.file).map_err(|e| Failure::io("读取固件", &e))?;
        if bytes.len() as u64 != image.bytes || crate::util::sha256_hex(&bytes) != image.sha256 {
            return Err(Failure::new("tampered", "固件在下载前被修改，已停止。"));
        }
        if ctx.cancel.load(Ordering::Relaxed) { return Err(Failure::cancelled()); }
        // Once erasure begins, complete writing and readback without cancellation.
        step(ctx.out, run_id, "program", "running");
        programming = true;
        uart::erase_f103(&mut link, &supported, bytes.len())?;
        for (index, chunk) in bytes.chunks(256).enumerate() {
            uart::write_memory(&mut link, chip.flash_base() as u32 + (index * 256) as u32, chunk)?;
            ctx.out.event("flash.progress", json!({"runId":run_id,"step":"program","percent":100.0 * ((index * 256 + chunk.len()) as f64) / bytes.len() as f64}));
        }
        step(ctx.out, run_id, "program", "done"); step(ctx.out, run_id, "verify", "running");
        fs::write(readback, read(&mut link, bytes.len(), "verify", false)?).map_err(|e| Failure::io("保存读回文件", &e))?;
        let digest = compare_readback(readback, image)?;
        step(ctx.out, run_id, "verify", "done"); step(ctx.out, run_id, "run", "running");
        crate::auto_boot::pulse(link, profile, false)?;
        step(ctx.out, run_id, "run", "done");
        Ok(json!({"ok":true,"method":"uart","identity":identity,"backup":backup,"erase":chip.erase_plan(image.bytes),
            "bytes":image.bytes,"readbackSha256":digest,"running":Value::Null,"needsBootRestore":false,"autoBoot":true}))
    })();
    // Do not reset into a partially written image on failure. Only release the reset line.
    if result.is_err() { let _ = link.rts(profile.idle_rts()); }
    result.map_err(|mut error: Failure| {
        if programming { error.message = format!("{} 程序可能不完整，未请求运行；修复连接后重新下载。", error.message); }
        error
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Catalog;

    fn chip() -> Chip {
        Catalog::new(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scope-extension/resources/stm32"))
            .chip("STM32F407ZGTx")
            .unwrap()
    }

    struct AutoPort { reads: std::io::Cursor<Vec<u8>>, writes: Vec<u8>, pins: Vec<String> }
    impl std::io::Read for AutoPort { fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> { std::io::Read::read(&mut self.reads, b) } }
    impl std::io::Write for AutoPort {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> { self.writes.extend(b); Ok(b.len()) }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    impl crate::auto_boot::Signals for AutoPort {
        fn dtr(&mut self, b: bool) -> Outcome<()> { self.pins.push(format!("dtr:{b}")); Ok(()) }
        fn rts(&mut self, b: bool) -> Outcome<()> { self.pins.push(format!("rts:{b}")); Ok(()) }
        fn delay(&mut self, _: u64) {}
    }
    #[test]
    fn automatic_isp_backs_up_programs_verifies_and_only_then_resets() {
        let catalog = Catalog::new(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scope-extension/resources/stm32"));
        for corrupt in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let project = Project { root: dir.path().to_path_buf(), manifest: json!({}), chip: catalog.chip("STM32F103C8Tx").unwrap(), board: catalog.board("chip-f103c8").unwrap() };
            let toolkit = Toolkit { root: dir.path().to_path_buf(), manifest: json!({}) };
            let backups = Backups::new(dir.path()); let out = Output::new(Box::new(Vec::<u8>::new())); let cancel = AtomicBool::new(false);
            let ctx = Ctx { project: &project, toolkit: &toolkit, backups: &backups, out: &out, cancel: &cancel };
            let target = Target { method: "uart", port: "simulated", probe: "", baud: 115200, skip_backup: false, expected_uid: None };
            let bytes = vec![1, 2, 3, 4, 5, 6, 7, 8]; let file = dir.path().join("firmware.bin"); fs::write(&file, &bytes).unwrap();
            let image = Image { file, bytes: 8, sha256: crate::util::sha256_hex(&bytes), bundle: None, tick: None, restore_uid: None };
            let profile = crate::auto_boot::AutoBoot { enabled: true, confirmed: true, boot0_high_dtr: false, reset_active_rts: true };
            let a = uart::ACK;
            let mut replies = vec![a, a, 1, 4, 0x10, a]; // SYNC and GET_ID
            replies.extend([a,a,a,64,0]); // Flash size
            replies.extend([a,a,a]); replies.extend([0x12;12]); // UID
            replies.extend([a,4,0x22,0x00,0x11,0x31,0x43,a]); // GET
            for _ in 0..256 { replies.extend([a,a,a]); replies.extend([0x55;256]); } // Full first backup
            replies.extend([a,a]); // Erase one page
            replies.extend([a,a,a]); // Write
            replies.extend([a,a,a]); replies.extend(if corrupt { vec![0;8] } else { bytes.clone() }); // Readback
            let mut port = AutoPort { reads: std::io::Cursor::new(replies), writes: vec![], pins: vec![] };
            let result = run_uart_auto_link(&ctx, &target, &image, "simulated", &dir.path().join("readback.bin"), &mut json!({}), profile, &mut port);
            assert_eq!(port.reads.position() as usize, port.reads.get_ref().len());
            let records = backups.list(None); assert_eq!(records.len(), 1);
            assert_eq!(records[0]["firstBackup"], true); assert_eq!(records[0]["factory"], false);
            assert_eq!(records[0]["bytes"], 65536);
            assert_eq!(records[0]["sha256"], crate::util::sha256_hex(&vec![0x55;65536]));
            assert!(port.writes.windows(4).any(|b| b == [0x43, 0xbc, 0, 0]));
            if corrupt {
                assert_eq!(result.unwrap_err().code, "verifyFailed");
                assert_eq!(port.pins, ["rts:true","dtr:false","rts:false","rts:false"]); // No run pulse
            } else {
                let result = result.unwrap(); assert_eq!(result["needsBootRestore"], false); assert_eq!(result["autoBoot"], true);
                assert_eq!(result["readbackSha256"], image.sha256);
                assert_eq!(port.pins, ["rts:true","dtr:false","rts:false","rts:true","dtr:true","rts:false"]);
            }
        }
    }

    #[test]
    fn identity_checks_reject_before_erase() {
        let f103 = json!({"deviceId": 0x410, "flashKiB": 64, "uid": "0671ff37", "readProtected": false});
        let error = check_identity(&chip(), &f103, 3592).expect_err("wrong chip");
        assert_eq!(error.code, "wrongChip");
        assert!(error.message.contains("STM32F103") && error.message.contains("STM32F407ZGT6"), "{}", error.message);
        let locked = json!({"deviceId": 0x413, "flashKiB": 1024, "uid": "x", "readProtected": true});
        assert_eq!(check_identity(&chip(), &locked, 3592).expect_err("rdp").code, "readProtected");
        let small = json!({"deviceId": 0x413, "flashKiB": 2, "uid": "x", "readProtected": false});
        assert_eq!(check_identity(&chip(), &small, 3592).expect_err("size").code, "tooLarge");
    }

    #[test]
    fn backups_seal_list_and_verify() {
        let dir = tempfile::tempdir().unwrap();
        let backups = Backups::new(dir.path());
        let identity = json!({"deviceId": 0x410, "flashKiB": 1, "uid": "0671ff373634574e431e5512"});
        assert!(!backups.has(&identity));
        let slot = backups.new_slot(&identity).unwrap();
        fs::write(slot.join("flash.bin"), vec![0xA5; 1024]).unwrap();
        let record = backups.seal(&slot, &identity, "stlink", true).unwrap();
        assert!(backups.has(&identity));
        assert_eq!(backups.list(Some("0671ff373634574e431e5512")).len(), 1);
        assert!(backups.list(Some("ffffffffffffffffffffffff")).is_empty());
        let (_, file) = backups.get(record["id"].as_str().unwrap()).unwrap();
        fs::write(&file, vec![0; 1024]).unwrap();
        assert_eq!(backups.get(record["id"].as_str().unwrap()).unwrap_err().code, "badBackup");
        assert!(backups.get("../../etc").is_err());
    }

    #[test]
    fn short_backup_is_discarded() {
        let dir = tempfile::tempdir().unwrap();
        let backups = Backups::new(dir.path());
        let identity = json!({"deviceId": 0x410, "flashKiB": 64, "uid": "0671ff373634574e431e5512"});
        let slot = backups.new_slot(&identity).unwrap();
        fs::write(slot.join("flash.bin"), vec![0; 100]).unwrap();
        assert_eq!(backups.seal(&slot, &identity, "uart", true).unwrap_err().code, "backupFailed");
        assert!(!slot.exists());
    }
}
