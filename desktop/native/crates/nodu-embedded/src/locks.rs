// SPDX-License-Identifier: MIT
//! Cross-process resource locks (FUNCTIONAL-DESIGN §9).
//!
//! The serial lock uses exactly the path scheme of `nodu_device::PortLock`
//! (`$TMPDIR/nodu-device-locks/<sha256(canonical port)[..32]>.lock`, flock),
//! so the K210 service, `nodu-terminal` and this service exclude each other.
//! Probes get `probe-<serial>.lock` in the same directory. Locks are released
//! by the OS when the process exits, including on a crash.

use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use fs2::FileExt;
use serde_json::json;

use crate::proto::{Failure, Outcome};
use crate::util::sha256_hex;

#[derive(Debug)]
pub struct ResourceLock {
    file: File,
}

impl Drop for ResourceLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn lock_dir() -> Outcome<PathBuf> {
    let root = std::env::temp_dir().join("nodu-device-locks");
    std::fs::create_dir_all(&root).map_err(|e| Failure::io("创建锁目录", &e))?;
    Ok(root)
}

/// Same canonical form as `nodu_device::PortLock` (macOS `tty.` → `cu.`).
pub fn canonical_port(port: &str) -> String {
    std::fs::canonicalize(port)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| port.to_string())
        .replace("/dev/tty.", "/dev/cu.")
}

fn acquire(name: &str, owner: &str, busy: impl FnOnce(Option<String>) -> Failure) -> Outcome<ResourceLock> {
    let path = lock_dir()?.join(name);
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| Failure::io("打开锁文件", &e))?;
    if file.try_lock_exclusive().is_err() {
        // K210 locks are empty files; ours carry an owner description.
        let mut text = String::new();
        let _ = file.read_to_string(&mut text);
        let holder = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("owner").and_then(|o| o.as_str()).map(str::to_string));
        return Err(busy(holder));
    }
    let _ = file.set_len(0);
    let _ = file.seek(SeekFrom::Start(0));
    let _ = file.write_all(json!({"pid": std::process::id(), "owner": owner}).to_string().as_bytes());
    Ok(ResourceLock { file })
}

pub fn lock_port(port: &str, owner: &str) -> Outcome<ResourceLock> {
    let digest = sha256_hex(canonical_port(port).as_bytes());
    acquire(&format!("{}.lock", &digest[..32]), owner, |holder| {
        let who = holder.unwrap_or_else(|| "K210 设备连接或终端".to_string());
        Failure::new("portBusy", format!("串口 {port} 正被{who}占用。先断开那边的连接，再重试。"))
    })
}

pub fn lock_probe(serial: &str, owner: &str) -> Outcome<ResourceLock> {
    let safe: String = serial.chars().filter(char::is_ascii_alphanumeric).take(48).collect();
    let name = if safe.is_empty() { "probe-stlink.lock".to_string() } else { format!("probe-{safe}.lock") };
    acquire(&name, owner, |holder| {
        let who = holder.unwrap_or_else(|| "另一个 Nodu 窗口".to_string());
        Failure::new("probeBusy", format!("ST-LINK 正被{who}使用。等它完成后再试。"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_lock_excludes_second_owner_and_names_holder() {
        let port = "/dev/cu.nodu-embedded-lock-test";
        let first = lock_port(port, "STM32 串口监视器").expect("first");
        let error = lock_port(port, "串口下载").expect_err("second must fail");
        assert_eq!(error.code, "portBusy");
        assert!(error.message.contains("STM32 串口监视器"), "{}", error.message);
        drop(first);
        assert!(lock_port(port, "串口下载").is_ok());
    }

    #[test]
    fn tty_and_cu_share_a_lock() {
        let _first = lock_port("/dev/tty.nodu-embedded-alias", "监视器").expect("first");
        assert!(lock_port("/dev/cu.nodu-embedded-alias", "下载").is_err());
    }
}
