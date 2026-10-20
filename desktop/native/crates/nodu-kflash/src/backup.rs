// SPDX-License-Identifier: MIT
// Ported from k210-studio nodu_device_worker.py backup framing/recovery
// helpers (MIT).
// Source: k210-studio dc0aba3 desktop/scope-extension/resources/nodu_device_worker.py
//! Streaming-restore recovery helpers and the raw-REPL backup line
//! classifier. Only host-safe parsing/serial state lives here; worker
//! orchestration stays in `nodu-device`.

use std::time::{Duration, Instant};

use nodu_serial::Transport;
use serde_json::{Map, Value, json};

use crate::error::{FlashError, Result};
use crate::firmware::CHUNK_BYTES;

fn dev(message: impl Into<String>) -> FlashError {
    FlashError::device(message)
}

/// `_fast_backup_serial`: pre-empt pending device output, then (for the
/// fastest baud) settle + drain any late device output before upload.
pub fn fast_backup_serial(
    serial: &mut dyn Transport,
    baud: u32,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<()> {
    let () = serial.unread(b"\x03\x04");
    let deadline = Instant::now() + Duration::from_secs(1);
    while serial.in_waiting().unwrap_or(0) > 0 && Instant::now() < deadline {
        check()?;
        let mut buf = [0u8; 1024];
        let _ = serial.read(&mut buf);
        std::thread::sleep(Duration::from_millis(1));
    }
    serial
        .reset_input_buffer()
        .map_err(|e| dev(e.to_string()))?;
    if baud == 3_000_000 {
        std::thread::sleep(Duration::from_millis(60));
        while serial.in_waiting().unwrap_or(0) > 0 {
            check()?;
            let mut buf = [0u8; 1024];
            let _ = serial.read(&mut buf);
            std::thread::sleep(Duration::from_millis(1));
        }
        serial
            .reset_input_buffer()
            .map_err(|e| dev(e.to_string()))?;
    }
    Ok(())
}

/// `backup_frame_metadata(line, expected_bytes)` — strict bounded-line
/// diagnostics for backup/probe logging. Never returns raw data. Key order
/// matches the Python dict literals (`preserve_order`).
pub fn frame_metadata(line: &[u8], expected_bytes: usize) -> Value {
    let mut result = Map::new();
    result.insert("bytes".to_string(), json!(line.len()));
    result.insert("sha256".to_string(), json!(sha2_hex(line)));
    result.insert("kind".to_string(), json!("other"));
    result.insert(
        "hasDataMarker".to_string(),
        json!(
            line.windows(b"NODU_DATA ".len())
                .any(|w| w == b"NODU_DATA ")
        ),
    );
    if line.starts_with(b"NODU_DATA ") {
        *result.get_mut("kind").unwrap() = json!("data");
        let header = &line[10..line.len().min(18)];
        let valid_offset =
            header.len() == 8 && header.iter().all(|b| b"0123456789abcdefABCDEF".contains(b));
        // update(offset=..., offsetHexValid=..., colonValid=...)
        result.insert(
            "offset".to_string(),
            if valid_offset {
                json!(
                    i64::from_str_radix(std::str::from_utf8(header).unwrap_or("0"), 16)
                        .unwrap_or(0)
                )
            } else {
                Value::Null
            },
        );
        result.insert("offsetHexValid".to_string(), json!(valid_offset));
        result.insert(
            "colonValid".to_string(),
            json!(line.get(18..19) == Some(&b":"[..])),
        );
        let encoded: &[u8] = if line.len() >= 19 { &line[19..] } else { b"" };
        let mut invalid: Vec<Value> = Vec::new();
        let mut count = 0usize;
        for (position, &value) in encoded.iter().enumerate() {
            if !value.is_ascii_alphanumeric() && value != b'+' && value != b'/' && value != b'=' {
                count += 1;
                if invalid.len() < 16 {
                    let kind = if value == 13 {
                        "cr"
                    } else if value == 10 {
                        "lf"
                    } else if value < 32 || value == 127 {
                        "control"
                    } else if value > 127 {
                        "non-ascii"
                    } else {
                        "non-base64-ascii"
                    };
                    invalid.push(json!({"position": position, "kind": kind}));
                }
            }
        }
        result.insert("encodedBytes".to_string(), json!(encoded.len()));
        result.insert(
            "expectedEncodedBytes".to_string(),
            json!(4 * ((expected_bytes + 2) / 3)),
        );
        result.insert("base64Remainder".to_string(), json!(encoded.len() % 4));
        result.insert(
            "paddingBytes".to_string(),
            json!(
                encoded
                    .iter()
                    .fold(0usize, |n, &c| n + usize::from(c == b'='))
            ),
        );
        result.insert("invalidCount".to_string(), json!(count));
        result.insert("invalid".to_string(), Value::Array(invalid));
    } else if line.starts_with(b"NODU_FILL ") {
        *result.get_mut("kind").unwrap() = json!("fill");
    } else if line.starts_with(b"NODU_SHA256 ") {
        let value = &line[12..];
        *result.get_mut("kind").unwrap() = json!("sha256");
        result.insert("digestBytes".to_string(), json!(value.len()));
        result.insert(
            "digestHexValid".to_string(),
            json!(value.len() == 64 && value.iter().all(|b| b"0123456789abcdef".contains(b))),
        );
    } else if line.starts_with(b">>>") || line.starts_with(b"raw REPL;") || line.starts_with(b"OK")
    {
        *result.get_mut("kind").unwrap() = json!("repl-control");
    }
    Value::Object(result)
}

/// `_backup_line_timeout(total)`.
pub fn line_timeout(total: u64) -> Duration {
    Duration::from_secs_f64((3.0f64).max(total as f64 / CHUNK_BYTES as f64 * 0.08))
}

fn sha2_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}
