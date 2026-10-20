// SPDX-License-Identifier: MIT
// Ported from k210-studio nodu_firmware.py (MIT).
// Source: k210-studio dc0aba3 desktop/scope-extension/resources/nodu_firmware.py
//! Pinned firmware cache, bounded backup framing and K210 boot validation.
//! Pure/host-side only: opening ports and driving serial belongs to the
//! caller (the worker), exactly as in the Python module.

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::error::{FlashError, Result};
use crate::kfpkg;
use crate::pyjson;

pub const VERSION: &str = "maixpy_v0.6.3_2_gd8901fd22";
pub const URL: &str = "https://dl.sipeed.com/fileList/MAIX/MaixPy/release/master/maixpy_v0.6.3_2_gd8901fd22/maixpy_v0.6.3_2_gd8901fd22.bin";
pub const SHA256: &str = "6dde2d59adc344ee0c7f96300528b4feff5e36c160f5cc0066016389394f15fa";
pub const SIZE: u64 = 2_116_288;
pub const WRITE_BYTES: u64 = SIZE + 37;
pub const SECTOR_END: u64 = WRITE_BYTES.div_ceil(4096) * 4096;
pub const FLASH_BYTES: u64 = 16 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 3072;
pub const MAX_USER_FILE: u64 = 128 * 1024 * 1024;
pub const MAX_USER_TOTAL: u64 = 256 * 1024 * 1024;

fn fw(message: impl Into<String>) -> FlashError {
    FlashError::firmware(message)
}

fn hex_digest(digest: &[u8]) -> String {
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// `private_directory(value, fresh=False)` — absolute path, no symlinks,
/// fresh dirs must not pre-exist, every missing ancestor created `0o700`,
/// final directory forced to `0o700`.
pub fn private_directory(value: &str, fresh: bool) -> Result<PathBuf> {
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err(fw(
            "Backup/cache directory must be an absolute backend-managed path.",
        ));
    }
    if path.symlink_metadata().is_ok_and(|m| m.is_symlink()) {
        return Err(fw("Backup/cache directory must not be a symbolic link."));
    }
    if fresh && path.exists() {
        return Err(fw("Backup directory already exists; use a new directory."));
    }
    let mut missing = Vec::new();
    let mut ancestor = path.to_path_buf();
    while !ancestor.exists() {
        missing.push(ancestor.clone());
        match ancestor.parent() {
            Some(p) => ancestor = p.to_path_buf(),
            None => break,
        }
    }
    for directory in missing.iter().rev() {
        fs::DirBuilder::new()
            .mode(0o700)
            .create(directory)
            .map_err(|e| FlashError::device(e.to_string()))?;
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|e| FlashError::device(e.to_string()))?;
    Ok(path.to_path_buf())
}

/// `private_file(path, mode)`: `O_WRONLY|O_CREAT`, `O_EXCL` for the default
/// `'xb'` or `O_TRUNC` for `'wb'`; mode `0o600`.
pub fn private_file(path: &Path, exclusive: bool) -> Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).mode(0o600);
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    options
        .open(path)
        .map_err(|e| FlashError::device(e.to_string()))
}

/// `file_sha256` — stream 1 MiB at a time.
pub fn file_sha256(path: &Path) -> Result<String> {
    let mut stream = fs::File::open(path).map_err(|e| FlashError::device(e.to_string()))?;
    let mut digest = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = stream
            .read(&mut buf)
            .map_err(|e| FlashError::device(e.to_string()))?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    Ok(hex_digest(&digest.finalize()))
}

/// `write_json`: private_file('wb') + `json.dumps(value, indent=2) + '\n'`
/// + fsync.
pub fn write_json(path: &Path, value: &Value) -> Result<()> {
    let mut stream = private_file(path, false)?;
    let body = format!("{}\n", pyjson::dumps_indent2(value));
    stream
        .write_all(body.as_bytes())
        .and_then(|()| stream.sync_all())
        .map_err(|e| FlashError::device(e.to_string()))
}

/// `plan()` — the fixed firmware plan dict (key order preserved).
pub fn plan() -> Value {
    json!({
        "version": VERSION,
        "url": URL,
        "sha256": SHA256,
        "address": 0,
        "size": SIZE,
        "writeBytes": WRITE_BYTES,
        "sectorEnd": SECTOR_END,
        "ready": true,
    })
}

/// `validate_image`: not a symlink, a file, exactly `SIZE` bytes, pinned SHA256.
pub fn validate_image(path: &Path) -> Result<PathBuf> {
    let meta = if path.symlink_metadata().is_ok_and(|m| m.is_symlink()) {
        None
    } else {
        path.metadata().ok().filter(|m| m.is_file())
    };
    if meta.is_none_or(|m| m.len() != SIZE) {
        return Err(fw(
            "Official firmware image size is not the pinned 2116288 bytes.",
        ));
    }
    if file_sha256(path)? != SHA256 {
        return Err(fw(
            "Official firmware image SHA256 does not match the pinned release.",
        ));
    }
    Ok(path.to_path_buf())
}

/// `prepare(cache_dir, source_file=None, check, log, download)`.
///
/// `download` is invoked only when no verified local source exists — it must
/// return a readable byte stream of the pinned URL body (the worker supplies
/// a `curl` subprocess; tests supply memory readers). Streaming, mid-transfer
/// size bound, digest accumulation and fsync are performed here, exactly like
/// the Python loop.
pub fn prepare(
    cache_dir: Option<&str>,
    source_file: Option<&str>,
    mut check: impl FnMut() -> Result<()>,
    mut log: impl FnMut(&str),
    mut download: impl FnMut() -> Result<Box<dyn Read>>,
) -> Result<PathBuf> {
    let root = private_directory(cache_dir.unwrap_or(""), false)?;
    let destination = root.join(format!("{VERSION}.bin"));
    if destination.exists() {
        if validate_image(&destination).is_err() {
            // Do not silently replace an unrelated existing file.
            return Err(fw(
                "Existing firmware cache is invalid; move it aside before preparing again.",
            ));
        }
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o600))
            .map_err(|e| FlashError::device(e.to_string()))?;
        log("Official firmware cache verified (SHA256).");
        return Ok(destination);
    }
    // tempfile.mkstemp(prefix='.firmware-', suffix='.part') equivalent:
    // O_EXCL creation with a random-ish unique name at mode 0o600.
    let temporary = loop {
        let candidate = root.join(format!(".firmware-{:016x}.part", unique_suffix()));
        match private_file(&candidate, true) {
            Ok(file) => break (candidate, file),
            Err(e) if e.kind() == crate::error::ErrorKind::Device => {
                if candidate.exists() {
                    continue; // collision — mkstemp would retry too
                }
                return Err(e);
            }
            Err(e) => return Err(e),
        }
    };
    let (temporary, mut output) = temporary;
    let result = (|temporary: &Path, output: &mut fs::File| -> Result<PathBuf> {
        let mut incoming: Box<dyn Read> = match source_file {
            Some(src) if Path::new(src).exists() => {
                let source = validate_image(Path::new(src))?;
                log("Copying the verified official firmware from the local installation.");
                Box::new(fs::File::open(source).map_err(FlashError::from)?)
            }
            _ => {
                log("Downloading the pinned official MaixPy firmware.");
                download()?
            }
        };
        let mut received = 0u64;
        let mut digest = Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            check()?;
            let n = incoming
                .read(&mut buf)
                .map_err(|e| FlashError::device(e.to_string()))?;
            if n == 0 {
                break;
            }
            received += n as u64;
            if received > SIZE {
                return Err(fw("Official firmware download exceeds the pinned size."));
            }
            output
                .write_all(&buf[..n])
                .map_err(|e| FlashError::device(e.to_string()))?;
            digest.update(&buf[..n]);
        }
        output
            .sync_all()
            .map_err(|e| FlashError::device(e.to_string()))?;
        if received != SIZE || hex_digest(&digest.finalize()) != SHA256 {
            return Err(fw(
                "Official firmware download failed size/SHA256 verification.",
            ));
        }
        check()?;
        // Destination is backend-managed and did not exist when preparation began.
        if destination.exists() {
            return Err(fw(
                "Firmware cache path appeared during preparation; retry.",
            ));
        }
        fs::rename(temporary, &destination).map_err(|e| FlashError::device(e.to_string()))?;
        log("Official firmware ready: 2116288 bytes, SHA256 verified.");
        Ok(destination)
    })(&temporary, &mut output);
    // Python finally: close fd + remove only our own unfinished download.
    drop(output);
    if result.is_err() && temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// `boot_region(data)` → `(metadata dict, region bytes)`.
pub fn boot_region(data: &[u8]) -> Result<(Map<String, Value>, Vec<u8>)> {
    if data.len() < 37 {
        return Err(fw("Flash image is too short for a K210 boot header."));
    }
    let length = u32::from_le_bytes([data[1], data[2], data[3], data[4]]) as usize;
    if length == 0 || length as u64 > FLASH_BYTES - 37 || length + 37 > data.len() {
        return Err(fw(
            "Original firmware boot length is outside the complete flash image.",
        ));
    }
    // Verified MaixPy DIO images use 0x02; older images also use 0x00.
    // Preserve the actual flag in restore packages instead of inventing it.
    if !matches!(data[0], 0x00 | 0x02) {
        return Err(fw(
            "Unsupported original boot flag; backup retained, flashing blocked.",
        ));
    }
    let header_digest = Sha256::digest(&data[..5 + length]);
    if header_digest[..] != data[5 + length..37 + length] {
        return Err(fw(
            "Original firmware header SHA256 verification failed; flashing blocked.",
        ));
    }
    let region = data[..length + 37].to_vec();
    let mut metadata = Map::new();
    metadata.insert("flag".to_string(), json!(data[0]));
    metadata.insert("firmwareBytes".to_string(), json!(length));
    metadata.insert(
        "firmwareSha256".to_string(),
        json!(hex_digest(&Sha256::digest(&data[5..5 + length]))),
    );
    metadata.insert("bootBytes".to_string(), json!(region.len()));
    metadata.insert(
        "bootSha256".to_string(),
        json!(hex_digest(&Sha256::digest(&region))),
    );
    Ok((metadata, region))
}

/// `make_restore_packages(directory, full_path, boot_data)` → `boot_path`.
///
/// Writes `original-boot-region.raw.bin`, `boot-restore.kfpkg` and
/// `full-flash-restore.kfpkg`, then binds them with
/// `validate_restore_packages`.
pub fn make_restore_packages(
    directory: &Path,
    full_path: &Path,
    boot_data: &[u8],
    check: impl FnMut() -> Result<()>,
) -> Result<PathBuf> {
    let canonical_full = fs::canonicalize(full_path).unwrap_or_else(|_| full_path.to_path_buf());
    let expected_full = fs::canonicalize(directory)
        .unwrap_or_else(|_| directory.to_path_buf())
        .join("full-flash.raw.bin");
    let valid_full = !full_path.symlink_metadata().is_ok_and(|m| m.is_symlink())
        && full_path.is_file()
        && canonical_full == expected_full
        && fs::metadata(full_path).map_or(0, |m| m.len()) == FLASH_BYTES;
    if !valid_full {
        return Err(fw(
            "Restore packages require the current complete raw flash image.",
        ));
    }
    let image = fs::read(full_path).map_err(|e| FlashError::device(e.to_string()))?;
    let (metadata, original_boot) = boot_region(&image)?;
    if boot_data != original_boot {
        return Err(fw(
            "Boot restore bytes differ from the complete raw flash image.",
        ));
    }
    let boot_path = directory.join("original-boot-region.raw.bin");
    {
        let mut stream = private_file(&boot_path, true)?;
        stream
            .write_all(boot_data)
            .and_then(|()| stream.sync_all())
            .map_err(|e| FlashError::device(e.to_string()))?;
    }
    for (target, source) in [
        ("boot-restore.kfpkg", boot_path.as_path()),
        ("full-flash-restore.kfpkg", full_path),
    ] {
        let path = directory.join(target);
        let mut file = private_file(&path, true)?;
        kfpkg::write_restore_package(&mut file, source)
            .map_err(|e| FlashError::device(e.to_string()))?;
        file.sync_all()
            .map_err(|e| FlashError::device(e.to_string()))?;
    }
    let mut manifest = metadata;
    manifest.insert("flashBytes".to_string(), json!(FLASH_BYTES));
    manifest.insert("flashSha256".to_string(), json!(file_sha256(full_path)?));
    validate_restore_packages(directory, &Value::Object(manifest), check)?;
    Ok(boot_path)
}

/// `validate_restore_packages(directory, manifest, check)` — bind both
/// recoverable KFPKG payloads to the current raw files/manifest.
pub fn validate_restore_packages(
    directory: &Path,
    manifest: &Value,
    check: impl FnMut() -> Result<()>,
) -> Result<()> {
    let mut check = check;
    if directory.symlink_metadata().is_ok_and(|m| m.is_symlink()) || !directory.is_dir() {
        return Err(fw(
            "Restore package directory is missing or is a symbolic link.",
        ));
    }
    for (package, raw_name, size_key, hash_key) in [
        (
            "boot-restore.kfpkg",
            "original-boot-region.raw.bin",
            "bootBytes",
            "bootSha256",
        ),
        (
            "full-flash-restore.kfpkg",
            "full-flash.raw.bin",
            "flashBytes",
            "flashSha256",
        ),
    ] {
        let size = manifest.get(size_key).and_then(Value::as_i64);
        let digest = manifest.get(hash_key).and_then(Value::as_str);
        let source = directory.join(raw_name);
        let size_ok = size.is_some_and(|s| {
            (37..=FLASH_BYTES as i64).contains(&s)
                && (size_key != "flashBytes" || s == FLASH_BYTES as i64)
        });
        let digest_ok = digest.is_some_and(|d| {
            d.len() == 64
                && d.bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        });
        let source_ok = !source.symlink_metadata().is_ok_and(|m| m.is_symlink())
            && source.is_file()
            && fs::metadata(&source).map_or(0, |m| m.len()) == size.unwrap_or(-1) as u64
            && file_sha256(&source)? == digest.unwrap_or("");
        if !(size_ok && digest_ok && source_ok) {
            return Err(fw(
                "Current raw recovery image does not match its restore manifest.",
            ));
        }
        kfpkg::validate_restore_package(
            &directory.join(package),
            raw_name,
            size.unwrap_or(0) as u64,
            digest.unwrap_or(""),
            &mut check,
        )?;
    }
    Ok(())
}

/// `eligible_file` — every regular file is copied opaquely.
pub fn eligible_file() -> (bool, Option<String>) {
    (true, None)
}

/// `ensure_space(directory, user_bytes)` — 3×16 MiB recovery payloads plus
/// user bytes plus 16 MiB headroom must fit in free space.
pub fn ensure_space(directory: &Path, user_bytes: u64) -> Result<()> {
    if user_bytes > MAX_USER_TOTAL {
        return Err(fw(
            "Standalone program/model backup exceeds 256 MiB; flashing is blocked.",
        ));
    }
    let required = FLASH_BYTES * 3 + user_bytes + 16 * 1024 * 1024;
    if fs2::available_space(directory).map_err(|e| FlashError::device(e.to_string()))? < required {
        return Err(fw(
            "Insufficient local disk space for a complete verified backup; flashing is blocked.",
        ));
    }
    Ok(())
}

/// `validate_backup(directory, manifest, progress)` — revalidate every local
/// recovery byte before permitting ISP entry. Returns `(full_path, metadata)`.
pub fn validate_backup(
    directory: &Path,
    manifest: &Value,
    mut progress: impl FnMut(u64, u64),
) -> Result<(PathBuf, Map<String, Value>)> {
    if directory.symlink_metadata().is_ok_and(|m| m.is_symlink()) || !directory.is_dir() {
        return Err(fw(
            "Verified backup directory is missing or is a symbolic link.",
        ));
    }
    let root = fs::canonicalize(directory).unwrap_or_else(|_| directory.to_path_buf());
    let full_path = root.join("full-flash.raw.bin");
    let full_ok = !full_path.symlink_metadata().is_ok_and(|m| m.is_symlink())
        && full_path.is_file()
        && fs::metadata(&full_path).map_or(0, |m| m.len()) == FLASH_BYTES
        && manifest.get("flashBytes").and_then(Value::as_u64) == Some(FLASH_BYTES)
        && file_sha256(&full_path)?
            == manifest
                .get("flashSha256")
                .and_then(Value::as_str)
                .unwrap_or("");
    if !full_ok {
        return Err(fw(
            "Complete local flash recovery image is missing, changed, or unverified.",
        ));
    }
    let image = fs::read(&full_path).map_err(|e| FlashError::device(e.to_string()))?;
    let (metadata, _) = boot_region(&image)?;
    if metadata.get("bootSha256").and_then(Value::as_str)
        != manifest.get("bootSha256").and_then(Value::as_str)
    {
        return Err(fw(
            "Original boot recovery image changed; flashing is blocked.",
        ));
    }
    let files = manifest.get("files").and_then(Value::as_array);
    let files = files.cloned().unwrap_or_default();
    let entries: Vec<&Value> = files
        .iter()
        .filter(|e| e.get("status").and_then(Value::as_str) == Some("verified"))
        .collect();
    if files.iter().any(|e| {
        !matches!(
            e.get("status").and_then(Value::as_str),
            Some("verified" | "directory")
        )
    }) {
        return Err(fw(
            "Backup manifest contains incomplete file copies; flashing is blocked.",
        ));
    }
    progress(0, entries.len() as u64);
    for (index, entry) in entries.iter().enumerate() {
        let remote = entry.get("path").and_then(Value::as_str).unwrap_or("");
        let local_name = entry.get("local").and_then(Value::as_str).unwrap_or("");
        let relative = Path::new(local_name);
        let expected = Path::new("files").join(remote.trim_start_matches('/'));
        let relative_is_parent_free = !relative.is_absolute()
            && !relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir));
        if !remote.starts_with('/')
            || remote.split('/').any(|s| s == "..")
            || remote.contains('\\')
            || !relative_is_parent_free
            || relative != expected
        {
            return Err(fw(
                "Backup file path is outside its controlled recovery directory.",
            ));
        }
        let mut local = root.clone();
        for part in relative.components() {
            local = local.join(part.as_os_str());
            if local.symlink_metadata().is_ok_and(|m| m.is_symlink()) {
                return Err(fw(
                    "A local recovery file or parent directory is a symbolic link.",
                ));
            }
        }
        let resolved = fs::canonicalize(&local).unwrap_or_else(|_| local.clone());
        if !resolved.starts_with(&root) {
            return Err(fw("Recovery file escaped its backup directory."));
        }
        let size = entry.get("size").and_then(Value::as_u64).unwrap_or(0);
        let digest = entry.get("sha256").and_then(Value::as_str).unwrap_or("");
        if !local.is_file()
            || fs::metadata(&local).map_or(u64::MAX, |m| m.len()) != size
            || file_sha256(&local)? != digest
        {
            return Err(fw(format!(
                "A standalone local recovery file is missing or changed: {remote}"
            )));
        }
        progress(index as u64 + 1, entries.len() as u64);
    }
    let total = entries.len() as u64;
    validate_restore_packages(&root, manifest, move || {
        progress(total, total);
        Ok(())
    })?;
    Ok((full_path, metadata))
}

/// Python `repr` of a str (single-quote preferred, double when the value
/// contains `'` but no `"`). Non-ASCII printable characters pass through,
/// matching CPython `repr` for the POSIX device paths this receives.
pub fn py_repr_str(text: &str) -> String {
    let single = text.contains('\'');
    let double = text.contains('"');
    let quote = if single && !double { '"' } else { '\'' };
    let mut s = String::new();
    s.push(quote);
    for c in text.chars() {
        match c {
            '\\' => s.push_str("\\\\"),
            c if c == quote => {
                s.push('\\');
                s.push(c);
            }
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            '\t' => s.push_str("\\t"),
            c if (c as u32) < 0x20 || (c as u32) == 0x7f => {
                s.push_str(&format!("\\x{:02x}", c as u32));
            }
            c => s.push(c),
        }
    }
    s.push(quote);
    s
}

/// `dump_script(size, remote_path=None, offset=0)` — the on-device bounded
/// range reader; transfer offsets stay relative to this range.
pub fn dump_script(size: u64, remote_path: Option<&str>, offset: u64) -> Result<String> {
    let is_file = remote_path.is_some();
    if is_file && remote_path.is_none_or(|p| p.is_empty() || p.contains('\0')) {
        return Err(fw(
            "Snapshot file path must be a nonempty string without NUL.",
        ));
    }
    let limit = if is_file { MAX_USER_FILE } else { FLASH_BYTES };
    if offset > limit || size > limit - offset {
        return Err(fw(
            "Snapshot range exceeds its fixed Flash or user-file bound.",
        ));
    }
    let source = if is_file {
        format!("_nodu_backup_file.read(min(3072,{size}-_nodu_backup_offset))")
    } else {
        format!(
            "utils.flash_read({offset}+_nodu_backup_offset,min(3072,{size}-_nodu_backup_offset))"
        )
    };
    let mut lines = vec![
        "import ubinascii, uhashlib".to_string(),
        "from Maix import utils".to_string(),
        "_nodu_backup_hash=uhashlib.sha256()".to_string(),
        "_nodu_backup_offset=0".to_string(),
    ];
    if let Some(path) = remote_path {
        lines.push(format!(
            "_nodu_backup_file=open({},\"rb\")",
            py_repr_str(path)
        ));
    }
    lines.push("try:".to_string());
    if is_file {
        lines.push(format!(" _nodu_backup_file.seek({offset})"));
    }
    lines.push(format!(" while _nodu_backup_offset<{size}:"));
    lines.push(format!("  _nodu_backup_chunk={source}"));
    lines.push("  if not _nodu_backup_chunk: raise Exception('Unexpected backup EOF')".to_string());
    lines.push("  _nodu_backup_hash.update(_nodu_backup_chunk)".to_string());
    lines.push(
        "  if _nodu_backup_chunk==_nodu_backup_chunk[:1]*len(_nodu_backup_chunk):".to_string(),
    );
    lines.push("   print(\"NODU_FILL %08x:%02x:%d\"%(_nodu_backup_offset,_nodu_backup_chunk[0],len(_nodu_backup_chunk)))".to_string());
    lines.push("  else:".to_string());
    lines.push("   print(\"NODU_DATA %08x:\"%_nodu_backup_offset+ubinascii.b2a_base64(_nodu_backup_chunk).decode().strip())".to_string());
    lines.push("  _nodu_backup_offset+=len(_nodu_backup_chunk)".to_string());
    lines.push(
        " print(\"NODU_SHA256 \"+ubinascii.hexlify(_nodu_backup_hash.digest()).decode())"
            .to_string(),
    );
    lines.push("finally:".to_string());
    lines.push(
        if is_file {
            " _nodu_backup_file.close()"
        } else {
            " pass"
        }
        .to_string(),
    );
    Ok(lines.join("\n"))
}

/// `BackupReceiver` — strict offset/size/hash verifier for a controlled
/// raw-REPL dump; writes via `private_file` (O_EXCL, 0o600).
#[allow(missing_debug_implementations)]
pub struct BackupReceiver {
    destination: PathBuf,
    size: u64,
    received: u64,
    digest: Sha256,
    remote_digest: Option<String>,
    stream: Option<fs::File>,
}

impl BackupReceiver {
    pub fn new(destination: &Path, size: u64) -> Result<Self> {
        Ok(Self {
            destination: destination.to_path_buf(),
            size,
            received: 0,
            digest: Sha256::new(),
            remote_digest: None,
            stream: Some(private_file(destination, true)?),
        })
    }

    /// Set the `(received, total)` progress callback destination later; kept
    /// as a stored callback in Python — here callers pass it per call.
    pub fn received(&self) -> u64 {
        self.received
    }

    /// `line()` — one stripped (no CR) bounded protocol line.
    pub fn line(&mut self, line: &[u8], progress: &mut dyn FnMut(u64, u64)) -> Result<()> {
        if line.len() > 4200 {
            return Err(fw("Backup line exceeds its bounded chunk size."));
        }
        if line.starts_with(b"NODU_SHA256 ") {
            // Python `line[12:].decode('ascii')` — ASCII, not UTF-8.
            let value = match std::str::from_utf8(&line[12..]) {
                Ok(v) if v.is_ascii() => v,
                _ => {
                    return Err(fw("Invalid device SHA256 response encoding.")
                        .with_cause("UnicodeDecodeError"));
                }
            };
            if self.remote_digest.is_some()
                || value.len() != 64
                || !value
                    .bytes()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
            {
                return Err(fw("Invalid or duplicate device SHA256 response."));
            }
            self.remote_digest = Some(value.to_string());
            return Ok(());
        }
        if line.starts_with(b"NODU_FILL ") {
            // parts = line[10:].split(b':'); all fields strictly shaped.
            let parts: Vec<&[u8]> = line[10..].split(|&b| b == b':').collect();
            let parsed = if parts.len() != 3
                || parts[0].len() != 8
                || parts[1].len() != 2
                || parts[2].is_empty()
                || parts[2].len() > 4
                || !parts[0]
                    .iter()
                    .chain(parts[1].iter())
                    .all(|b| b"0123456789abcdef".contains(b))
                || !parts[2].iter().all(|b| b.is_ascii_digit())
            {
                None
            } else {
                let fields = || {
                    let offset =
                        u64::from_str_radix(std::str::from_utf8(parts[0]).map_err(|_| ())?, 16)
                            .map_err(|_| ())?;
                    let value =
                        u8::from_str_radix(std::str::from_utf8(parts[1]).map_err(|_| ())?, 16)
                            .map_err(|_| ())?;
                    let count: usize = std::str::from_utf8(parts[2])
                        .map_err(|_| ())?
                        .parse()
                        .map_err(|_| ())?;
                    Ok::<_, ()>((offset, value, count))
                };
                match fields() {
                    Ok((offset, value, count)) => {
                        let expected = CHUNK_BYTES.min((self.size - self.received) as usize);
                        if count != expected || count == 0 {
                            None
                        } else {
                            Some((offset, vec![value; count]))
                        }
                    }
                    Err(()) => None,
                }
            };
            match parsed {
                Some((offset, data)) => self.chunk(offset as i64, &data, progress)?,
                None => {
                    return Err(fw("Malformed bounded fill chunk.").with_cause("ValueError"));
                }
            }
            return Ok(());
        }
        if !line.starts_with(b"NODU_DATA ") || line.len() < 19 || line[18] != b':' {
            return Err(fw("Unexpected backup response; raw data was not logged."));
        }
        if self.remote_digest.is_some() {
            return Err(fw("Backup data arrived after the final hash."));
        }
        // Python `int(line[10:18], 16)` — accepts surrounding whitespace,
        // a sign and a 0x prefix; negatives fail later at the offset check.
        let parse = (|| -> Result<(i64, Vec<u8>)> {
            let offset = py_int_base(&line[10..18], 16)
                .ok_or_else(|| fw("Malformed backup chunk.").with_cause("ValueError"))?;
            let data =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &line[19..])
                    .map_err(|_| fw("Malformed backup chunk.").with_cause("Error"))?;
            Ok((offset, data))
        })();
        let (offset, data) = parse?;
        self.chunk(offset, &data, progress)
    }

    fn chunk(
        &mut self,
        offset: i64,
        data: &[u8],
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<()> {
        if self.remote_digest.is_some() {
            return Err(fw("Backup data arrived after the final hash."));
        }
        let expected = CHUNK_BYTES.min((self.size - self.received) as usize);
        if offset != self.received as i64 || data.len() != expected || expected == 0 {
            return Err(fw(
                "Backup offset/chunk size mismatch; flashing is blocked.",
            ));
        }
        if let Some(stream) = self.stream.as_mut() {
            stream
                .write_all(data)
                .map_err(|e| FlashError::device(e.to_string()))?;
        }
        self.digest.update(data);
        self.received += data.len() as u64;
        progress(self.received, self.size);
        Ok(())
    }

    /// `finish()` — fsync, size/remote-hash check, local read-back check.
    pub fn finish(mut self, progress: &mut dyn FnMut(u64, u64)) -> Result<String> {
        let _ = progress;
        if let Some(mut stream) = self.stream.take() {
            stream
                .flush()
                .and_then(|()| stream.sync_all())
                .map_err(|e| FlashError::device(e.to_string()))?;
        }
        let digest = hex_digest(&self.digest.clone().finalize());
        if self.received != self.size || Some(&digest) != self.remote_digest.as_ref() {
            return Err(fw(
                "Complete backup size/device SHA256 verification failed.",
            ));
        }
        if file_sha256(&self.destination)? != digest {
            return Err(fw("Local backup read-back SHA256 verification failed."));
        }
        Ok(digest)
    }
}

/// Emulation of Python `int(bytes_like, base)` for the 8-byte protocol
/// fields: strips ASCII whitespace *including* `\x0b` (Python's str.strip
/// is broader than Rust's `is_ascii_whitespace`), accepts an optional
/// `+`/`-` sign, an optional `0x` prefix, and PEP 515 single `_` separators
/// between digits (also right after `0x`). Returns `None` on anything else
/// (Python raises `ValueError`/`TypeError`, which callers map to
/// `FirmwareError("Malformed backup chunk.")`).
pub fn py_int_base(data: &[u8], base: u32) -> Option<i64> {
    let text = std::str::from_utf8(data).ok()?;
    let text = text.trim_matches(|c: char| c.is_ascii_whitespace() || c == '\x0b');
    let (neg, text) = match text.strip_prefix('-') {
        Some(t) => (true, t),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let (text, had_prefix) = if base == 16 {
        match text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
            Some(t) => (t, true),
            None => (text, false),
        }
    } else {
        (text, false)
    };
    // Digits with single underscores between them; `0x_1f` is valid but a
    // leading `_` after a bare sign is not, and `__`/trailing `_` are not.
    if text.is_empty() {
        return None;
    }
    let bytes = text.as_bytes();
    let mut clean = String::with_capacity(text.len());
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'_' {
            let prev_digit = i > 0 && bytes[i - 1].is_ascii_hexdigit();
            let next_digit = i + 1 < bytes.len() && bytes[i + 1].is_ascii_hexdigit();
            // `0x_` case: underscore directly after the base prefix is
            // legal even with no preceding digit.
            let after_prefix = i == 0 && had_prefix;
            if !(next_digit && (prev_digit || after_prefix)) {
                return None;
            }
            continue;
        }
        if !b.is_ascii_hexdigit() {
            return None;
        }
        clean.push(b as char);
    }
    let magnitude = i64::from_str_radix(&clean, base).ok()?;
    Some(if neg { -magnitude } else { magnitude })
}

/// `flash_image(path, port, log, report_progress)` — validate the pinned
/// image, then drive the kflash 1.1.6 loader port. `open_port` creates the
/// 115200 serial transport (the worker passes the real opener; tests pass
/// `MemoryTransport`). The Python `KFlash.print_callback` printer and the
/// deduplicating `progress` wrapper are folded in here.
pub fn flash_image(
    path: &Path,
    port: &str,
    open_port: impl FnOnce(&str) -> std::io::Result<Box<dyn nodu_serial::Transport>>,
    log: &mut dyn FnMut(&str),
    report_progress: &mut dyn FnMut(&str, u64, u64),
    deadline: Instant,
) -> Result<()> {
    validate_image(path)?;
    // kflash==1.1.6 pinned in Python — this crate IS the reviewed port.
    // `progress` and `log` share one callback object upstream; RefCell
    // reproduces that while satisfying Rust's single-&mut rule.
    let shared_log = std::cell::RefCell::new(log);
    let mut last_progress: std::collections::HashMap<String, u64> =
        std::collections::HashMap::new();
    let mut progress = |kind: &str, iteration: u64, total: u64, _suffix: &str| {
        let percent = iteration
            .saturating_mul(100)
            .checked_div(total)
            .unwrap_or(0);
        if last_progress.get(kind).copied() != Some(percent) {
            last_progress.insert(kind.to_string(), percent);
            report_progress(&format!("flash-{kind}"), iteration, total);
            (*shared_log.borrow_mut())(&format!(
                "Firmware {kind} {percent}% ({iteration}/{total})"
            ));
        }
    };
    let kill = std::sync::atomic::AtomicBool::new(false);
    let mut log_adapter = |s: &str| (*shared_log.borrow_mut())(s);
    crate::kflash::process(
        open_port,
        port,
        path,
        &mut progress,
        &mut log_adapter,
        &kill,
        Some(deadline),
    )
}

/// `time.monotonic` source for callers is Instant; this is the worker's
/// `uuid.uuid4().hex` substitute for temp/ranges names.
pub fn unique_suffix() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ (u64::from(std::process::id()) << 16) ^ COUNTER.fetch_add(1, Ordering::SeqCst)
}
