// SPDX-License-Identifier: MIT
// Ported from k210-studio nodu_firmware.py (MIT) — the two-entry KFPKG
// writer (`zipfile.ZipFile(w, ZIP_DEFLATED)` on a seekable file) and the
// strict `_validate_restore_package` reader. The upstream kflash 1.1.6
// `extractall` path is intentionally not reproduced.
// Source: k210-studio dc0aba3 desktop/scope-extension/resources/nodu_firmware.py

use std::fs;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use serde_json::{Value, json};

use crate::crc32::crc32;
use crate::deflate::{self, Inflater};
use crate::error::FlashError;
use crate::error::Result;
use crate::pyjson;

fn fw(message: impl Into<String>) -> FlashError {
    FlashError::firmware(message)
}

/// Localtime conversion equivalent to CPython `time.localtime(st.st_mtime)`,
/// then the DOS packing `zipfile.ZipInfo` applies.
fn dos_datetime(unix_seconds: i64) -> Option<(u16, u16)> {
    let utc = time::OffsetDateTime::from_unix_timestamp(unix_seconds).ok()?;
    let offset = time::UtcOffset::current_local_offset().ok()?;
    let dt = utc.to_offset(offset);
    let year = i32::from(dt.year());
    // Python strict_timestamps: ValueError for pre-1980; clamp post-2107.
    if year < 1980 {
        return None;
    }
    let (year, mon, day, hour, min, sec) = if year > 2107 {
        (2107i32, 12u8, 31u8, 23u8, 59u8, 58u8)
    } else {
        (
            year,
            dt.month() as u8,
            dt.day(),
            dt.hour(),
            dt.minute(),
            dt.second(),
        )
    };
    let dostime = ((hour as u16) << 11) | ((min as u16) << 5) | ((sec as u16) / 2);
    let dosdate = (((year - 1980) as u16) << 9) | ((mon as u16) << 5) | day as u16;
    Some((dostime, dosdate))
}

/// One member of a generated package; mirrors `ZipInfo.from_file` fields.
#[derive(Debug)]
pub struct Member {
    pub name: String,
    pub dostime: u16,
    pub dosdate: u16,
    /// `ZipInfo.external_attr` — `(st_mode & 0xFFFF) << 16` on POSIX.
    pub external_attr: u32,
    /// Already-raw (pre-compression) member bytes.
    pub data: Vec<u8>,
}

/// `archive.write(source, source.name)` for a regular file.
pub fn member_from_file(path: &Path) -> Result<Member> {
    let meta = fs::metadata(path).map_err(|e| FlashError::device(e.to_string()))?;
    let mtime = meta.mtime();
    let (dostime, dosdate) =
        dos_datetime(mtime).ok_or_else(|| fw("zipfile does not support timestamps before 1980"))?;
    let mode = meta.mode() & 0xFFFF;
    let data = fs::read(path).map_err(|e| FlashError::device(e.to_string()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Member {
        name,
        dostime,
        dosdate,
        external_attr: mode << 16,
        data,
    })
}

/// `archive.writestr('flash-list.json', compact)` — `ZipInfo(filename,
/// date_time=time.localtime(time.time())[:6])`, external_attr `0o600<<16`.
fn member_writestr(name: &str, data: Vec<u8>) -> Result<Member> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (dostime, dosdate) =
        dos_datetime(now).ok_or_else(|| fw("zipfile does not support timestamps before 1980"))?;
    Ok(Member {
        name: name.to_string(),
        dostime,
        dosdate,
        external_attr: 0o600 << 16,
        data,
    })
}

/// Byte-identical `zipfile.ZipFile(file, 'w', ZIP_DEFLATED)` on a seekable
/// POSIX file: local headers with real CRC/sizes rewritten in place (no data
/// descriptors), central directory with `create_system=3`, EOCD, no comment.
pub fn write_package(mut out: impl Write, members: &[Member]) -> Result<()> {
    struct Central {
        dostime: u16,
        dosdate: u16,
        crc: u32,
        csize: u32,
        usize_: u32,
        name: Vec<u8>,
        external_attr: u32,
        offset: u32,
    }
    let mut central = Vec::with_capacity(members.len());
    let mut offset: u64 = 0;
    let mut written: Vec<u8> = Vec::new();
    for member in members {
        let name = member.name.as_bytes();
        let crc = crc32(&member.data);
        let packed = deflate::deflate(&member.data);
        let csize = packed.len() as u32;
        let usize_ = member.data.len() as u32;
        let mut header = Vec::with_capacity(30 + name.len());
        header.extend_from_slice(b"PK\x03\x04");
        header.extend_from_slice(&20u16.to_le_bytes()); // version needed
        header.extend_from_slice(&0u16.to_le_bytes()); // flag_bits
        header.extend_from_slice(&8u16.to_le_bytes()); // ZIP_DEFLATED
        header.extend_from_slice(&member.dostime.to_le_bytes());
        header.extend_from_slice(&member.dosdate.to_le_bytes());
        header.extend_from_slice(&crc.to_le_bytes());
        header.extend_from_slice(&csize.to_le_bytes());
        header.extend_from_slice(&usize_.to_le_bytes());
        header.extend_from_slice(&(name.len() as u16).to_le_bytes());
        header.extend_from_slice(&0u16.to_le_bytes()); // extra len
        header.extend_from_slice(name);
        written.extend_from_slice(&header);
        written.extend_from_slice(&packed);
        central.push(Central {
            dostime: member.dostime,
            dosdate: member.dosdate,
            crc,
            csize,
            usize_,
            name: name.to_vec(),
            external_attr: member.external_attr,
            offset: offset as u32,
        });
        offset += (30 + name.len()) as u64 + u64::from(csize);
    }
    let central_offset = offset;
    let mut central_bytes = Vec::new();
    for c in &central {
        central_bytes.extend_from_slice(b"PK\x01\x02");
        central_bytes.extend_from_slice(&(20u16 | (3 << 8)).to_le_bytes()); // made by zipfile/POSIX
        central_bytes.extend_from_slice(&20u16.to_le_bytes()); // needed
        central_bytes.extend_from_slice(&0u16.to_le_bytes()); // flags
        central_bytes.extend_from_slice(&8u16.to_le_bytes()); // deflate
        central_bytes.extend_from_slice(&c.dostime.to_le_bytes());
        central_bytes.extend_from_slice(&c.dosdate.to_le_bytes());
        central_bytes.extend_from_slice(&c.crc.to_le_bytes());
        central_bytes.extend_from_slice(&c.csize.to_le_bytes());
        central_bytes.extend_from_slice(&c.usize_.to_le_bytes());
        central_bytes.extend_from_slice(&(c.name.len() as u16).to_le_bytes());
        central_bytes.extend_from_slice(&0u16.to_le_bytes()); // extra
        central_bytes.extend_from_slice(&0u16.to_le_bytes()); // comment
        central_bytes.extend_from_slice(&0u16.to_le_bytes()); // disk start
        central_bytes.extend_from_slice(&0u16.to_le_bytes()); // internal attr
        central_bytes.extend_from_slice(&c.external_attr.to_le_bytes());
        central_bytes.extend_from_slice(&c.offset.to_le_bytes());
        central_bytes.extend_from_slice(&c.name);
    }
    written.extend_from_slice(&central_bytes);
    written.extend_from_slice(b"PK\x05\x06");
    written.extend_from_slice(&0u16.to_le_bytes()); // disk
    written.extend_from_slice(&0u16.to_le_bytes()); // central disk
    written.extend_from_slice(&(central.len() as u16).to_le_bytes());
    written.extend_from_slice(&(central.len() as u16).to_le_bytes());
    written.extend_from_slice(&(central_bytes.len() as u32).to_le_bytes());
    written.extend_from_slice(&(central_offset as u32).to_le_bytes());
    written.extend_from_slice(&0u16.to_le_bytes()); // comment len
    out.write_all(&written)
        .map_err(|e| FlashError::device(e.to_string()))?;
    Ok(())
}

/// `make_restore_packages`' inner `with zipfile.ZipFile(...) as archive`:
/// `archive.write(source, source.name)` + the compact flash-list.json.
pub fn write_restore_package(mut out: impl Write, source: &Path) -> Result<()> {
    let raw = member_from_file(source)?;
    let listing = member_writestr(
        "flash-list.json",
        pyjson::dumps_compact(&json!({
            "version": "0.1.0",
            "files": [{"address": "0x00000000", "bin": raw.name, "sha256Prefix": false}],
        }))
        .into_bytes(),
    )?;
    write_package(&mut out, &[raw, listing])
}

/// What the Python `except (...)` tuple wraps vs lets through.
enum InnerFail {
    /// `FirmwareError` — propagates unwrapped.
    Direct(FlashError),
    /// OSError/BadZipFile/UnicodeError/ValueError/RuntimeError/struct.error/
    /// zlib.error — wrapped as
    /// 'Restore package is unreadable or failed ZIP/JSON/CRC validation.'
    Wrapped(&'static str),
}

type InnerResult<T> = std::result::Result<T, InnerFail>;

fn direct<T>(e: FlashError) -> InnerResult<T> {
    Err(InnerFail::Direct(e))
}

fn wrapped<T>(cause: &'static str) -> InnerResult<T> {
    Err(InnerFail::Wrapped(cause))
}

struct CentralInfo {
    name: Vec<u8>,
    flags: u16,
    method: u16,
    crc: u32,
    csize: u32,
    usize_: u32,
    extra: Vec<u8>,
    comment: Vec<u8>,
    disk: u16,
    external_attr: u32,
    header_offset: u32,
}

fn inner(
    path: &Path,
    raw_name: &str,
    expected_size: u64,
    expected_sha: &str,
    check: &mut dyn FnMut() -> Result<()>,
) -> InnerResult<()> {
    if path.symlink_metadata().is_ok_and(|m| m.is_symlink()) || !path.is_file() {
        return direct(fw(
            "A required restore package is missing or is a symbolic link.",
        ));
    }
    let archive_size = fs::metadata(path)
        .map_err(|_| InnerFail::Wrapped("OSError"))?
        .len();
    if !(22..=expected_size + 69632).contains(&archive_size) {
        return direct(fw("Restore package container exceeds its bounded size."));
    }
    let raw_bytes = fs::read(path).map_err(|_| InnerFail::Wrapped("OSError"))?;
    let n = raw_bytes.len();
    // struct.unpack('<4s4H2IH', last 22 bytes)
    let end = &raw_bytes[n - 22..];
    let signature = &end[0..4];
    let disk = u16::from_le_bytes([end[4], end[5]]);
    let central_disk = u16::from_le_bytes([end[6], end[7]]);
    let disk_count = u16::from_le_bytes([end[8], end[9]]);
    let count = u16::from_le_bytes([end[10], end[11]]);
    let central_size = u32::from_le_bytes([end[12], end[13], end[14], end[15]]);
    let central_offset = u32::from_le_bytes([end[16], end[17], end[18], end[19]]) as u64;
    let comment_size = u16::from_le_bytes([end[20], end[21]]);
    if signature != b"PK\x05\x06"
        || disk != 0
        || central_disk != 0
        || disk_count != 2
        || count != 2
        || comment_size != 0
        || central_size > 1024
        || central_offset + u64::from(central_size) != archive_size - 22
    {
        return direct(fw(
            "Restore package has an unexpected ZIP directory or trailing data.",
        ));
    }
    // Central directory records (zipfile's own parse of this container).
    let mut members = Vec::new();
    let mut cursor = central_offset as usize;
    let central_end = (central_offset + u64::from(central_size)) as usize;
    while cursor < central_end {
        if cursor + 46 > central_end || raw_bytes[cursor..cursor + 4] != *b"PK\x01\x02" {
            return wrapped("BadZipFile");
        }
        let h = &raw_bytes[cursor..cursor + 46];
        let namelen = u16::from_le_bytes([h[28], h[29]]) as usize;
        let extralen = u16::from_le_bytes([h[30], h[31]]) as usize;
        let commentlen = u16::from_le_bytes([h[32], h[33]]) as usize;
        let record_end = cursor + 46 + namelen + extralen + commentlen;
        if record_end > central_end {
            return wrapped("BadZipFile");
        }
        let name = raw_bytes[cursor + 46..cursor + 46 + namelen].to_vec();
        // `info.filename.encode('ascii')` — non-ASCII member names are a
        // UnicodeEncodeError (a UnicodeError) at this exact point.
        if !name.iter().all(|b| b.is_ascii()) {
            return wrapped("UnicodeError");
        }
        members.push(CentralInfo {
            name,
            flags: u16::from_le_bytes([h[8], h[9]]),
            method: u16::from_le_bytes([h[10], h[11]]),
            crc: u32::from_le_bytes([h[16], h[17], h[18], h[19]]),
            csize: u32::from_le_bytes([h[20], h[21], h[22], h[23]]),
            usize_: u32::from_le_bytes([h[24], h[25], h[26], h[27]]),
            extra: raw_bytes[cursor + 46 + namelen..cursor + 46 + namelen + extralen].to_vec(),
            comment: raw_bytes[record_end - commentlen..record_end].to_vec(),
            disk: u16::from_le_bytes([h[34], h[35]]),
            external_attr: u32::from_le_bytes([h[38], h[39], h[40], h[41]]),
            header_offset: u32::from_le_bytes([h[42], h[43], h[44], h[45]]),
        });
        cursor = record_end;
    }
    if members.len() != 2 {
        return direct(fw(
            "Restore package must contain exactly its known raw image and flash-list.json.",
        ));
    }
    let names: Vec<&[u8]> = members.iter().map(|m| m.name.as_slice()).collect();
    let raw_name_bytes = raw_name.as_bytes();
    let names_ok = names
        .iter()
        .all(|n| *n == raw_name_bytes || *n == b"flash-list.json")
        && names[0] != names[1];
    if !names_ok {
        return direct(fw(
            "Restore package must contain exactly its known raw image and flash-list.json.",
        ));
    }
    // Iterate in stored order (sorted by header_offset).
    members.sort_by_key(|m| m.header_offset);
    let mut offset: u64 = 0;
    for info in &members {
        let is_symlink = (info.external_attr >> 16) & 0o170000 == 0o120000;
        if u64::from(info.header_offset) != offset
            || info.flags != 0
            || !info.extra.is_empty()
            || !info.comment.is_empty()
            || info.disk != 0
            || is_symlink
            || !matches!(info.method, 0 | 8)
        {
            return direct(fw(
                "Restore package contains an unsupported ZIP entry or layout.",
            ));
        }
        let o = offset as usize;
        if o + 30 > n {
            return wrapped("OSError");
        }
        let h = &raw_bytes[o..o + 30];
        let namelen = u16::from_le_bytes([h[26], h[27]]) as usize;
        let extralen = u16::from_le_bytes([h[28], h[29]]) as usize;
        let local_crc = u32::from_le_bytes([h[14], h[15], h[16], h[17]]);
        let local_csize = u32::from_le_bytes([h[18], h[19], h[20], h[21]]);
        let local_usize = u32::from_le_bytes([h[22], h[23], h[24], h[25]]);
        let local_flags = u16::from_le_bytes([h[6], h[7]]);
        let local_method = u16::from_le_bytes([h[8], h[9]]);
        if h[0..4] != *b"PK\x03\x04"
            || local_flags != info.flags
            || local_method != info.method
            || local_crc != info.crc
            || local_csize != info.csize
            || local_usize != info.usize_
            || namelen != info.name.len()
            || extralen != 0
            || o + 30 + namelen > n
            || raw_bytes[o + 30..o + 30 + namelen] != info.name[..]
        {
            return direct(fw(
                "Restore package local ZIP header does not match its directory.",
            ));
        }
        offset += 30 + namelen as u64 + u64::from(info.csize);
    }
    if offset != central_offset
        || u64::from(central_size)
            != members
                .iter()
                .map(|m| 46 + m.name.len() as u64)
                .sum::<u64>()
    {
        return direct(fw(
            "Restore package contains unreferenced or extra ZIP data.",
        ));
    }
    let member_data = |info: &CentralInfo| -> InnerResult<Vec<u8>> {
        let start = info.header_offset as usize + 30 + info.name.len();
        let end = start + info.csize as usize;
        if end > n {
            return wrapped("BadZipFile");
        }
        let packed = &raw_bytes[start..end];
        let data = match info.method {
            0 => packed.to_vec(),
            8 => Inflater::inflate_all(packed).map_err(|_| InnerFail::Wrapped("error"))?,
            _ => unreachable!(),
        };
        // zipfile checks CRC on EOF and the uncompressed length bound.
        if data.len() as u64 != u64::from(info.usize_) {
            return wrapped("BadZipFile");
        }
        if crc32(&data) != info.crc {
            return wrapped("BadZipFile");
        }
        Ok(data)
    };
    let listing = members
        .iter()
        .find(|m| m.name == b"flash-list.json")
        .unwrap();
    if !(0 < listing.usize_ && listing.usize_ <= 4096) {
        return direct(fw("Restore package flash-list.json exceeds its bound."));
    }
    let data = member_data(listing)?;
    if data.len() > 4097 {
        // read(4097) truncation can never exceed this; zipfile EOF/CRC runs
        // at close — `data` is the full member here.
        return wrapped("BadZipFile");
    }
    let text = std::str::from_utf8(&data).map_err(|_| InnerFail::Wrapped("UnicodeError"))?;
    let plan = match pyjson::loads_strict(text) {
        Ok(v) => v,
        Err(e) if e.cause == "FirmwareError" => {
            return direct(fw("Restore package JSON contains a duplicate key."));
        }
        Err(_) => return wrapped("ValueError"),
    };
    let schema_ok = plan.as_object().is_some_and(|o| {
        o.len() == 2
            && o.get("version") == Some(&json!("0.1.0"))
            && o.get("files")
                .and_then(Value::as_array)
                .is_some_and(|f| f.len() == 1 && f[0].is_object())
    });
    if !schema_ok {
        return direct(fw(
            "Restore package flash-list.json has an unexpected schema.",
        ));
    }
    let entry = &plan["files"][0];
    let entry_ok = entry.as_object().is_some_and(|e| {
        e.len() == 3
            && e.get("address") == Some(&json!("0x00000000"))
            && e.get("bin").and_then(Value::as_str) == Some(raw_name)
            && e.get("sha256Prefix") == Some(&Value::Bool(false))
    });
    if !entry_ok {
        return direct(fw(
            "Restore package must restore the known raw image at address zero without a new prefix.",
        ));
    }
    if data != pyjson::dumps_compact(&plan).into_bytes() {
        return direct(fw(
            "Restore package JSON is not the reviewed kflash-compatible compact format.",
        ));
    }
    let payload = members.iter().find(|m| m.name == raw_name_bytes).unwrap();
    if u64::from(payload.usize_) != expected_size {
        return direct(fw(
            "Restore package expanded image length differs from its current raw image.",
        ));
    }
    // Streamed 64 KiB reads with check() between them, bounded + hashed.
    let data = member_data(payload)?;
    {
        use sha2::Digest;
        let mut digest = sha2::Sha256::new();
        let mut received = 0u64;
        for chunk in data.chunks(65536) {
            check().map_err(|e| InnerFail::Direct(e))?;
            received += chunk.len() as u64;
            if received > expected_size {
                return direct(fw(
                    "Restore package expanded past its fixed raw image bound.",
                ));
            }
            digest.update(chunk);
        }
        let hexed = digest
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        if received != expected_size || hexed != expected_sha {
            return direct(fw(
                "Restore package payload SHA256 differs from the current raw image.",
            ));
        }
    }
    Ok(())
}

/// `_validate_restore_package(path, raw_name, expected_size, expected_sha,
/// check)` — same FirmwareError wrapping boundary as Python.
pub fn validate_restore_package(
    path: &Path,
    raw_name: &str,
    expected_size: u64,
    expected_sha: &str,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<()> {
    match inner(path, raw_name, expected_size, expected_sha, check) {
        Err(InnerFail::Direct(e)) => Err(e),
        Err(InnerFail::Wrapped(cause)) => Err(fw(
            "Restore package is unreadable or failed ZIP/JSON/CRC validation.",
        )
        .with_cause(cause)),
        Ok(()) => Ok(()),
    }
}
