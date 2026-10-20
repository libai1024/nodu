// SPDX-License-Identifier: MIT
// Resource update sidecar library for `nodu-resources` (version check,
// package install/reset with staged atomic swap). The user-visible flow
// mirrors the original IDE; the install path is hardened (staging + backup
// swap instead of delete-then-extract, and archive-safety limits).
// Ported from openmv-qt-creator openmvplugin.cpp (MIT)
//
// Source: openmv/qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv/openmvplugin.cpp
#![forbid(unsafe_code)]

use std::fmt;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

const VERSION_BODY_LIMIT: u64 = 64;
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_ENTRIES: usize = 20_000;
const MAX_TOTAL_UNCOMPRESSED: u64 = 512 * 1024 * 1024;
const MAX_FILE_UNCOMPRESSED: u64 = 64 * 1024 * 1024;
const IO_CHUNK: usize = 64 * 1024;

/// Operation failure; `Cancelled` is the user-abort path (stdin EOF).
#[derive(Debug)]
pub enum Error {
    Cancelled,
    Message(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => f.write_str("cancelled"),
            Self::Message(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for Error {}

impl Error {
    /// Plain-message error (argument / I/O / protocol failures).
    pub fn msg(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }
}

impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        Self::Message(e.to_string())
    }
}

impl From<zip::result::ZipError> for Error {
    fn from(e: zip::result::ZipError) -> Self {
        Self::Message(format!("cannot read resource archive: {e}"))
    }
}

impl From<ureq::Error> for Error {
    fn from(e: ureq::Error) -> Self {
        Self::Message(match e {
            ureq::Error::StatusCode(code) => format!("network request failed with status {code}"),
            ureq::Error::Http(http) => format!("network request failed: {http}"),
            other => format!("network request failed: {other}"),
        })
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// `x.y.z` — the original `^(\d+)\.(\d+)\.(\d+)$` shape, tuple compare.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl Version {
    /// Strict original-regex parse: three dot-separated all-digit groups.
    pub fn parse(text: &str) -> Option<Self> {
        let parts: Vec<&str> = text.split('.').collect();
        if parts.len() != 3
            || parts
                .iter()
                .any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
        {
            return None;
        }
        Some(Self {
            major: parts[0].parse().ok()?,
            minor: parts[1].parse().ok()?,
            patch: parts[2].parse().ok()?,
        })
    }
}

/// Outcome of `check-version` / `check-resources`.
#[derive(Debug, Clone, Copy)]
pub struct CheckResult {
    pub latest: Version,
    pub newer: bool,
}

/// Only https:// plus loopback http for tests; anything else is refused.
fn ensure_safe_url(url: &str) -> Result<()> {
    if url.starts_with("https://") {
        return Ok(());
    }
    for host in ["http://127.0.0.1", "http://localhost"] {
        if url == host
            || url.starts_with(&format!("{host}:"))
            || url.starts_with(&format!("{host}/"))
        {
            return Ok(());
        }
    }
    Err(Error::msg(format!(
        "refusing non-HTTPS url {url:?} (loopback http allowed for tests)"
    )))
}

fn agent_for(url: &str, timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        // Redirects may never downgrade an https request to http; loopback
        // http test URLs opt out.
        .https_only(url.starts_with("https://"))
        .max_redirects(5)
        // OS trust roots — the same trust store the original Qt network
        // stack used (and corporate proxy CAs live there).
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .new_agent()
}

/// GET a version file: <=64 bytes body, trimmed, original-regex parse.
fn fetch_version(agent: &ureq::Agent, url: &str) -> Result<Version> {
    let mut response = agent.get(url).call()?;
    let body = response
        .body_mut()
        .with_config()
        .limit(VERSION_BODY_LIMIT + 1)
        .read_to_vec()
        .map_err(|e| Error::msg(format!("cannot read version file: {e}")))?;
    if body.len() as u64 > VERSION_BODY_LIMIT {
        return Err(Error::msg("version response larger than 64 bytes"));
    }
    let text = String::from_utf8(body).map_err(|_| Error::msg("version response is not UTF-8"))?;
    Version::parse(text.trim())
        .ok_or_else(|| Error::msg(format!("version response {text:?} is not x.y.z")))
}

/// `check-version` / `check-resources`: compare the fetched version to the
/// installed/recorded one.
pub fn check(url: &str, installed: Version) -> Result<CheckResult> {
    ensure_safe_url(url)?;
    let agent = agent_for(url, VERSION_TIMEOUT);
    let latest = fetch_version(&agent, url)?;
    Ok(CheckResult {
        latest,
        newer: latest > installed,
    })
}

/// Read the recorded resources version file (`{"major":..,..}`); missing or
/// malformed reads as `0.0.0` so a stale/empty file always triggers reset.
pub fn read_version_file(path: &Path) -> Version {
    let Ok(text) = fs::read_to_string(path) else {
        return Version {
            major: 0,
            minor: 0,
            patch: 0,
        };
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Version {
            major: 0,
            minor: 0,
            patch: 0,
        };
    };
    let pick = |key: &str| {
        json.get(key)
            .and_then(serde_json::Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
    };
    match (pick("major"), pick("minor"), pick("patch")) {
        (Some(major), Some(minor), Some(patch)) => Version {
            major,
            minor,
            patch,
        },
        _ => Version {
            major: 0,
            minor: 0,
            patch: 0,
        },
    }
}

fn write_version_file(path: &Path, version: Version) -> Result<()> {
    let body = serde_json::json!({
        "major": version.major,
        "minor": version.minor,
        "patch": version.patch,
    });
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, serde_json::to_string(&body).unwrap_or_default())?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn sibling(parent: &Path, dest: &Path, tag: &str) -> PathBuf {
    let name = dest.file_name().unwrap_or_default().to_string_lossy();
    parent.join(format!(".{name}.{tag}-{}", std::process::id()))
}

/// Sweep residue from killed installs (same-dest tmp/staging dirs); a backup
/// dir is left alone — it still holds a restorable copy.
fn clean_stale(parent: &Path, dest: &Path) -> Result<()> {
    let name = dest.file_name().unwrap_or_default().to_string_lossy();
    for entry in fs::read_dir(parent)? {
        let entry = entry?;
        let fname = entry.file_name().to_string_lossy().into_owned();
        if fname.starts_with(&format!(".{name}.tmp-"))
            || fname.starts_with(&format!(".{name}.staging-"))
        {
            if entry.file_type()?.is_dir() {
                fs::remove_dir_all(entry.path())?;
            } else {
                fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}

/// Streaming GET to `file` with progress + cancellation. Returns bytes.
fn download(
    agent: &ureq::Agent,
    url: &str,
    file: &mut fs::File,
    progress: &dyn Fn(u64, Option<u64>),
    cancel: &dyn Fn() -> bool,
) -> Result<u64> {
    let mut response = agent.get(url).call()?;
    let total = response.body().content_length();
    let mut reader = response.body_mut().as_reader();
    let mut buf = vec![0u8; IO_CHUNK];
    let mut downloaded = 0u64;
    loop {
        if cancel() {
            return Err(Error::Cancelled);
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        downloaded += n as u64;
        progress(downloaded, total);
    }
    file.flush()?;
    Ok(downloaded)
}

/// hex SHA-256 of a file, streaming.
fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; IO_CHUNK];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// `<url>.sha256` sidecar: first whitespace-separated token, 64 hex chars.
fn fetch_expected_sha(agent: &ureq::Agent, url: &str) -> Result<String> {
    let mut response = agent.get(&format!("{url}.sha256")).call()?;
    let body = response
        .body_mut()
        .with_config()
        .limit(4096)
        .read_to_vec()
        .map_err(|e| Error::msg(format!("cannot read checksum file: {e}")))?;
    let text = String::from_utf8(body).map_err(|_| Error::msg("checksum file is not UTF-8"))?;
    let token = text
        .split_whitespace()
        .next()
        .ok_or_else(|| Error::msg("checksum file is empty"))?;
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::msg("checksum file has no 64-hex token"));
    }
    Ok(token.to_ascii_lowercase())
}

/// Byte-for-byte recursive copy (reset from the bundled directory); same
/// limits as extraction so a corrupted bundle cannot explode either.
fn copy_tree(src: &Path, dst: &Path, count: &mut usize, total: &mut u64) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        if *count >= MAX_ENTRIES {
            return Err(Error::msg(format!(
                "bundled resources exceed {MAX_ENTRIES} entries"
            )));
        }
        *count += 1;
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            return Err(Error::msg(format!(
                "bundled entry {} is a symlink",
                entry.file_name().to_string_lossy()
            )));
        }
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&entry.path(), &to, count, total)?;
        } else if ty.is_file() {
            let size = entry.metadata()?.len();
            if size > MAX_FILE_UNCOMPRESSED || *total + size > MAX_TOTAL_UNCOMPRESSED {
                return Err(Error::msg("bundled resources exceed the size limits"));
            }
            *total += size;
            fs::copy(entry.path(), &to)?;
        } else {
            return Err(Error::msg(format!(
                "bundled entry {} is not a file or directory",
                entry.file_name().to_string_lossy()
            )));
        }
    }
    Ok(())
}

/// Raw entry-name policy: zip 8.x `enclosed_name` *strips* leading root /
/// drive components instead of rejecting them, so absolute paths and any
/// `..` component are refused here up front (both `/` and `\` separators —
/// Windows tools treat both as separators).
fn entry_name_safe(raw: &str) -> bool {
    if raw.is_empty() || raw.contains('\0') || raw.starts_with('/') || raw.starts_with('\\') {
        return false;
    }
    let b = raw.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return false; // drive-letter prefix
    }
    raw.split(['/', '\\']).all(|part| part != "..")
}

/// Safe extraction: rejects absolute paths, `..` components, symlinks and
/// other non-regular entries; limits entry count, total size, and per-file
/// size — on bytes actually written, not header claims.
fn extract_zip(archive_path: &Path, staging: &Path) -> Result<()> {
    fs::create_dir_all(staging)?; // also covers archives with no file entries
    let file = fs::File::open(archive_path)?;
    let mut archive = zip::ZipArchive::new(io::BufReader::new(file))?;
    if archive.len() > MAX_ENTRIES {
        return Err(Error::msg(format!(
            "archive has more than {MAX_ENTRIES} entries"
        )));
    }
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        // zip 9 returns a ZipResult for the name: undecodable names are
        // rejected outright rather than lossy-mangled.
        let name = entry
            .name()
            .map_err(|e| Error::msg(format!("undecodable entry name: {e}")))?
            .into_owned();
        if !entry_name_safe(&name) {
            return Err(Error::msg(format!("unsafe path in archive: {name}")));
        }
        let rel = entry
            .enclosed_name()
            .ok_or_else(|| Error::msg(format!("unsafe path in archive: {name}")))?;
        if entry.is_symlink() {
            return Err(Error::msg(format!("archive entry {name} is a symlink")));
        }
        // unix_mode file-type bits: allow regular files and dirs only.
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170000;
            if kind != 0 && kind != 0o100000 && kind != 0o040000 {
                return Err(Error::msg(format!(
                    "archive entry {name} is not a regular file or directory"
                )));
            }
        }
        let target = staging.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&target)?;
        let mut buf = vec![0u8; IO_CHUNK];
        let mut written = 0u64;
        loop {
            let n = entry.read(&mut buf)?;
            if n == 0 {
                break;
            }
            written += n as u64;
            total += n as u64;
            if written > MAX_FILE_UNCOMPRESSED {
                return Err(Error::msg(format!(
                    "archive entry {name} exceeds {MAX_FILE_UNCOMPRESSED} bytes"
                )));
            }
            if total > MAX_TOTAL_UNCOMPRESSED {
                return Err(Error::msg(format!(
                    "archive exceeds {MAX_TOTAL_UNCOMPRESSED} bytes"
                )));
            }
            out.write_all(&buf[..n])?;
        }
    }
    Ok(())
}

/// staging -> dest swap: dest -> .bak-<pid>, staging -> dest, delete backup;
/// a staging-rename failure restores the backup so the old resources survive.
fn swap_in_inner(staging: &Path, dest: &Path, fail_after_backup: bool) -> Result<()> {
    let Some(parent) = dest.parent() else {
        return Err(Error::msg("destination has no parent directory"));
    };
    if !dest.exists() {
        fs::rename(staging, dest)?;
        return Ok(());
    }
    let backup = sibling(parent, dest, "bak");
    fs::rename(dest, &backup)?;
    let renamed = if fail_after_backup {
        Err(io::Error::other("injected failure"))
    } else {
        fs::rename(staging, dest)
    };
    if let Err(e) = renamed {
        if let Err(restore) = fs::rename(&backup, dest) {
            let _ = fs::remove_dir_all(staging);
            return Err(Error::msg(format!(
                "swap failed ({e}) and restore failed too ({restore}); old resources kept at {}",
                backup.display()
            )));
        }
        let _ = fs::remove_dir_all(staging);
        return Err(Error::msg(format!(
            "swap failed, previous resources restored: {e}"
        )));
    }
    // Backup removal failure is cosmetic; resources are already in place.
    let _ = fs::remove_dir_all(&backup);
    Ok(())
}

fn swap_in(staging: &Path, dest: &Path) -> Result<()> {
    swap_in_inner(staging, dest, false)
}

fn dest_parent(dest: &Path) -> Result<PathBuf> {
    let parent = dest.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    Ok(parent.to_path_buf())
}

/// Events emitted while `install` runs: byte progress during the download
/// and the "downloading" / "installing" phase transitions for the UI.
#[derive(Debug, Clone, Copy)]
pub enum InstallEvent {
    Progress { downloaded: u64, total: Option<u64> },
    Phase(&'static str),
}

/// `install`: download `template`(%1 %2 %3 -> version) to a sibling temp
/// file, optionally verify `<url>.sha256`, extract to a sibling staging dir,
/// swap in place, then write the version file. Cancellation (or any error)
/// leaves the old resources and the old version untouched.
pub fn install(
    template: &str,
    version: Version,
    dest: &Path,
    version_file: &Path,
    require_sha256: bool,
    events: &dyn Fn(InstallEvent),
    cancel: &dyn Fn() -> bool,
) -> Result<()> {
    let url = template
        .replace("%1", &version.major.to_string())
        .replace("%2", &version.minor.to_string())
        .replace("%3", &version.patch.to_string());
    ensure_safe_url(&url)?;
    // Downloads get a generous global bound; the 15 s cap is only for the
    // small version/ checksum files.
    let agent = agent_for(&url, Duration::from_mins(15));
    let parent = dest_parent(dest)?;
    clean_stale(&parent, dest)?;

    let temp = sibling(&parent, dest, "tmp");
    let staging = sibling(&parent, dest, "staging");
    // Single cleanup scope: anything that fails before the swap removes the
    // temp file and the staging dir but never touches `dest`.
    let progress = |downloaded: u64, total: Option<u64>| {
        events(InstallEvent::Progress { downloaded, total });
    };
    let outcome = (|| -> Result<()> {
        events(InstallEvent::Phase("downloading"));
        {
            let mut file = fs::File::create(&temp)?;
            download(&agent, &url, &mut file, &progress, cancel)?;
        }
        events(InstallEvent::Phase("installing"));
        if require_sha256 {
            let expected = fetch_expected_sha(&agent, &url)?;
            if sha256_file(&temp)? != expected {
                return Err(Error::msg("archive sha256 does not match the .sha256 file"));
            }
        }
        extract_zip(&temp, &staging)?;
        Ok(())
    })();
    let _ = fs::remove_file(&temp);
    if let Err(e) = outcome {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    if cancel() {
        let _ = fs::remove_dir_all(&staging);
        return Err(Error::Cancelled);
    }
    swap_in(&staging, dest)?;
    write_version_file(version_file, version)?;
    Ok(())
}

/// `reset`: copy the bundled resource tree through the same staging+swap so
/// a failed copy cannot destroy existing resources; then write the version.
pub fn reset(bundled: &Path, dest: &Path, version_file: &Path, version: Version) -> Result<()> {
    if !bundled.is_dir() {
        return Err(Error::msg(format!(
            "bundled resource dir {} missing",
            bundled.display()
        )));
    }
    let parent = dest_parent(dest)?;
    clean_stale(&parent, dest)?;
    let staging = sibling(&parent, dest, "staging");
    let mut count = 0usize;
    let mut total = 0u64;
    if let Err(e) = copy_tree(bundled, &staging, &mut count, &mut total) {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    swap_in(&staging, dest)?;
    write_version_file(version_file, version)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parse_matches_original_regex() {
        assert_eq!(
            Version::parse("0.2.5"),
            Some(Version {
                major: 0,
                minor: 2,
                patch: 5
            })
        );
        assert!(
            Version::parse("01.02.003").is_some(),
            "leading zeros allowed"
        );
        for bad in [
            "", "0.2", "0.2.5.1", "0.2.x", " 0.2.5", "0.2.5\n", "-1.2.3", "0..5",
        ] {
            assert!(Version::parse(bad).is_none(), "{bad:?}");
        }
        assert!(
            Version {
                major: 0,
                minor: 2,
                patch: 6
            } > Version {
                major: 0,
                minor: 2,
                patch: 5
            }
        );
        assert!(
            Version {
                major: 1,
                minor: 0,
                patch: 0
            } > Version {
                major: 0,
                minor: 99,
                patch: 99
            }
        );
    }

    #[test]
    fn url_policy() {
        assert!(ensure_safe_url("https://example.com/x.zip").is_ok());
        assert!(ensure_safe_url("http://127.0.0.1:8080/x").is_ok());
        assert!(ensure_safe_url("http://localhost/x").is_ok());
        assert!(ensure_safe_url("http://example.com/x").is_err());
        assert!(ensure_safe_url("ftp://127.0.0.1/x").is_err());
    }

    #[test]
    fn swap_rolls_back_when_rename_fails() {
        let dir = std::env::temp_dir().join(format!("nodu-swap-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let dest = dir.join("resources");
        fs::create_dir_all(dest.join("old")).unwrap();
        fs::write(dest.join("old/a.txt"), "old").unwrap();
        let staging = dir.join("staging");
        fs::create_dir_all(staging.join("new")).unwrap();
        fs::write(staging.join("new/b.txt"), "new").unwrap();
        let err = swap_in_inner(&staging, &dest, true).unwrap_err();
        assert!(err.to_string().contains("restored"), "{err}");
        assert!(dest.join("old/a.txt").exists(), "old resources restored");
        assert!(!staging.exists(), "staging removed");
        let _ = fs::remove_dir_all(&dir);
    }
}
