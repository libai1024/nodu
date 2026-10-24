// SPDX-License-Identifier: MIT
//! Small helpers: digests, JSON files, timestamps, identifiers.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::proto::{Failure, Outcome};

/// Canonical paths stay verbatim for authorization and filesystem operations.
/// MinGW tools do not reliably accept that namespace in their argv or cwd.
pub fn external_tool_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    #[cfg(windows)]
    { windows_tool_path(&text) }
    #[cfg(not(windows))]
    { text.into_owned() }
}

#[cfg(any(windows, test))]
fn windows_tool_path(text: &str) -> String {
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    if let Some(drive) = text.strip_prefix(r"\\?\") {
        let bytes = drive.as_bytes();
        if bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1..3] == *b":\\" {
            return drive.to_owned();
        }
    }
    text.to_owned()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

pub fn read_json(path: &Path) -> Outcome<Value> {
    let text = fs::read_to_string(path).map_err(|e| Failure::io(&format!("读取 {}", path.display()), &e))?;
    serde_json::from_str(&text)
        .map_err(|e| Failure::new("badFile", format!("{} 不是有效的 JSON：{e}", path.display())))
}

/// Write pretty JSON through a temporary sibling so readers never see half a file.
pub fn write_json(path: &Path, value: &Value) -> Outcome<()> {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_default();
    text.push('\n');
    write_atomic(path, text.as_bytes())
}

pub fn write_atomic(path: &Path, data: &[u8]) -> Outcome<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| Failure::io(&format!("创建 {}", parent.display()), &e))?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(data)?;
        file.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(Failure::io(&format!("写入 {}", path.display()), &e));
    }
    Ok(())
}

pub fn unix_now() -> (u64, u32) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (now.as_secs(), now.subsec_millis())
}

pub fn millis_now() -> u64 {
    let (secs, millis) = unix_now();
    secs * 1000 + u64::from(millis)
}

/// Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn parts(secs: u64) -> (i64, u32, u32, u64, u64, u64) {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil(days);
    (y, m, d, rem / 3600, rem / 60 % 60, rem % 60)
}

/// `2026-10-22T08:30:12Z` (UTC).
pub fn iso_now() -> String {
    let (y, m, d, hh, mm, ss) = parts(unix_now().0);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// `20261022-083012` (UTC), safe in file names on every platform.
pub fn stamp_now() -> String {
    let (y, m, d, hh, mm, ss) = parts(unix_now().0);
    format!("{y:04}{m:02}{d:02}-{hh:02}{mm:02}{ss:02}")
}

/// Short unique identifier for builds and runs.
pub fn new_id(prefix: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let (secs, millis) = unix_now();
    let seed = format!("{secs}.{millis}.{}.{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    format!("{prefix}-{}-{}", stamp_now(), &sha256_hex(seed.as_bytes())[..6])
}

pub fn str_field<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut node = value;
    for key in path {
        node = node.get(*key)?;
    }
    node.as_str()
}

pub fn u64_field(value: &Value, path: &[&str]) -> Option<u64> {
    let mut node = value;
    for key in path {
        node = node.get(*key)?;
    }
    node.as_u64()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_tool_paths_preserve_drive_and_unc_identity() {
        assert_eq!(windows_tool_path(r"\\?\D:\工程\main.c"), r"D:\工程\main.c");
        assert_eq!(windows_tool_path(r"\\?\UNC\server\share\main.c"), r"\\server\share\main.c");
        for path in [r"D:\main.c", r"\\server\share", r"\\?\Volume{abc}\main.c", r"\\.\COM3", "/tmp/file", r"\\?\D:relative"] {
            assert_eq!(windows_tool_path(path), path);
        }
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(20_748), (2026, 10, 22));
        assert_eq!(civil(11_016), (2000, 2, 29));
    }
}
