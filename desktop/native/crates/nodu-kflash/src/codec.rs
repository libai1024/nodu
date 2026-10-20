// SPDX-License-Identifier: MIT
// Ported from k210-studio nodu_flash_protocol.py (MIT) — bounded, I/O-free
// codecs for the source-built K210 ID reader.
// Source: k210-studio dc0aba3 desktop/scope-extension/resources/nodu_flash_protocol.py
// Source: sipeed/kflash.py 550828c768b16ef329695d3f5eace3f6bcf14af2 (MIT,
//   Copyright 2019 Vowstar) — K210 write/boot/SLIP methods
// Source: loboris/ktool 0345aa90d9b3830641373fb4e3ce4edf45d0a46f
//   src/isp/main.c and isp.h (Apache-2.0, Copyright 2020 LoBo) — DE
//   packet/CRC layout. No GPL slip.c/slip.h code is included.
//
// This module does not open ports, load code, reset a board, or certify a
// session. Passing synthetic bytes to its parser is never hardware-capacity
// evidence. See tools/flash-probe/ and docs/automatic-flash-source-audit.md
// for the separate, not-yet-hardware-validated loader candidate and source
// boundaries.

use crate::crc32::crc32;
use crate::error::{FlashError, Result};

pub const RAM_ENTRY: u32 = 0x8000_0000;
pub const MAX_IMAGE_BYTES: usize = 65536;
pub const MAX_ROM_CHUNK: usize = 1024;
pub const MAX_FRAME_BYTES: usize = 16 + MAX_ROM_CHUNK;
pub const STUB_OPERATIONS: [u8; 3] = [0xD2, 0xD7, 0xDE];

/// Winbond W25Q128JV Rev F (2018-03-27), identification table, p21.
/// Only these complete, documented IDs are accepted. No 2**density shortcut,
/// profile, partition size, historical ID, or wrapping read sets capacity.
pub static SUPPORTED_IDS: &[([u8; 3], &str, u64)] = &[
    ([0xEF, 0x40, 0x18], "Winbond W25Q128 family", 16_777_216),
    ([0xEF, 0x70, 0x18], "Winbond W25Q128 family", 16_777_216),
];

/// `slip_encode`: frame a bounded payload between 0xC0 delimiters.
pub fn slip_encode(payload: &[u8]) -> Result<Vec<u8>> {
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(FlashError::protocol("Invalid or oversized SLIP payload."));
    }
    let mut out = Vec::with_capacity(payload.len() + 2 + 8);
    out.push(0xC0);
    for &b in payload {
        match b {
            0xDB => out.extend_from_slice(&[0xDB, 0xDD]),
            0xC0 => out.extend_from_slice(&[0xDB, 0xDC]),
            _ => out.push(b),
        }
    }
    out.push(0xC0);
    Ok(out)
}

/// Incremental decoder; escaped bytes are appended exactly once.
///
/// Unlike the reviewed upstream recv_one_return(), this does not append an
/// escape suffix a second time after unescaping. Invalid escapes and overflow
/// fail closed, rather than yielding partially decoded capacity metadata.
#[derive(Debug)]
pub struct SlipDecoder {
    maximum: usize,
    buffer: Vec<u8>,
    started: bool,
    escaped: bool,
}

impl SlipDecoder {
    pub fn new(maximum: usize) -> Result<Self> {
        if !(1..=MAX_FRAME_BYTES).contains(&maximum) {
            return Err(FlashError::protocol("Invalid frame bound."));
        }
        Ok(Self {
            maximum,
            buffer: Vec::new(),
            started: false,
            escaped: false,
        })
    }

    /// Feed a read chunk (at most 4096 bytes); returns every completed frame.
    pub fn feed(&mut self, data: &[u8]) -> Result<Vec<Vec<u8>>> {
        if data.len() > 4096 {
            self.reset();
            return Err(FlashError::protocol(
                "Invalid or oversized serial read chunk.",
            ));
        }
        let mut frames = Vec::new();
        for &value in data {
            if value == 0xC0 {
                if self.escaped {
                    self.reset();
                    return Err(FlashError::protocol("Truncated SLIP escape."));
                }
                if self.started && !self.buffer.is_empty() {
                    frames.push(std::mem::take(&mut self.buffer));
                }
                self.buffer.clear();
                self.started = true;
                continue;
            }
            if !self.started {
                continue;
            }
            if self.escaped {
                self.escaped = false;
                if value == 0xDC {
                    self.buffer.push(0xC0);
                } else if value == 0xDD {
                    self.buffer.push(0xDB);
                } else {
                    self.reset();
                    return Err(FlashError::protocol("Invalid SLIP escape."));
                }
            } else if value == 0xDB {
                self.escaped = true;
                continue;
            } else {
                self.buffer.push(value);
            }
            if self.buffer.len() > self.maximum {
                self.reset();
                return Err(FlashError::protocol(
                    "SLIP response exceeds the fixed bound.",
                ));
            }
        }
        Ok(frames)
    }

    fn reset(&mut self) {
        self.buffer.clear();
        self.started = false;
        self.escaped = false;
    }

    /// Partial-frame byte count for bounded diagnostics (never the bytes).
    pub fn partial_len(&self) -> usize {
        self.buffer.len()
    }
    pub fn is_started(&self) -> bool {
        self.started
    }
    pub fn is_escaped(&self) -> bool {
        self.escaped
    }
}

/// Exact existing kflash greeting payload (without the SLIP delimiters).
pub fn rom_nop_request() -> [u8; 14] {
    [0xC2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
}

/// Only C3 writes spanning this bounded image at fixed `RAM_ENTRY`.
///
/// There is no caller-supplied target address, flash opcode, or jump target.
/// This is packet construction only; callers must separately authenticate
/// the built image's source and hash before any hardware execution is
/// considered.
pub fn rom_upload_packets(image: &[u8]) -> Result<Vec<Vec<u8>>> {
    if image.is_empty() || image.len() > MAX_IMAGE_BYTES {
        return Err(FlashError::protocol(
            "RAM image must contain 1..65536 bytes.",
        ));
    }
    let mut packets = Vec::new();
    let mut offset = 0usize;
    while offset < image.len() {
        let chunk = &image[offset..(offset + MAX_ROM_CHUNK).min(image.len())];
        let mut body = Vec::with_capacity(8 + chunk.len());
        body.extend_from_slice(&(RAM_ENTRY + offset as u32).to_le_bytes());
        body.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
        body.extend_from_slice(chunk);
        let mut packet = Vec::with_capacity(8 + body.len());
        packet.extend_from_slice(&0xC3u16.to_le_bytes());
        packet.extend_from_slice(&0u16.to_le_bytes());
        packet.extend_from_slice(&crc32(&body).to_le_bytes());
        packet.extend_from_slice(&body);
        packets.push(packet);
        offset += MAX_ROM_CHUNK;
    }
    Ok(packets)
}

/// The C5 boot packet: run the uploaded image at `RAM_ENTRY`.
pub fn rom_boot_request() -> Vec<u8> {
    let mut body = Vec::with_capacity(8);
    body.extend_from_slice(&RAM_ENTRY.to_le_bytes());
    body.extend_from_slice(&0u32.to_le_bytes());
    let mut packet = Vec::with_capacity(16);
    packet.extend_from_slice(&0xC5u16.to_le_bytes());
    packet.extend_from_slice(&0u16.to_le_bytes());
    packet.extend_from_slice(&crc32(&body).to_le_bytes());
    packet.extend_from_slice(&body);
    packet
}

/// A stub command request: only 0xD2 (NOP), 0xD7 (flash init), 0xDE (ID).
pub fn stub_request(operation: u8) -> Result<Vec<u8>> {
    if !STUB_OPERATIONS.contains(&operation) {
        return Err(FlashError::protocol(
            "Only NOP, controller initialization and ID are permitted.",
        ));
    }
    let body = [0u8; 8];
    let mut packet = Vec::with_capacity(16);
    packet.extend_from_slice(&u16::from(operation).to_le_bytes());
    packet.extend_from_slice(&0u16.to_le_bytes());
    packet.extend_from_slice(&crc32(&body).to_le_bytes());
    packet.extend_from_slice(&body);
    Ok(packet)
}

/// A ROM/stub acknowledgement is exactly `op,status`; ROM C2/C3 also allow
/// status 0 (kflash `recv_debug` DEFAULT), stub replies must always be E0.
pub fn validate_ack(payload: &[u8], operation: u8) -> Result<()> {
    if !matches!(operation, 0xC2 | 0xC3 | 0xD2 | 0xD7) {
        return Err(FlashError::protocol(
            "Unexpected acknowledgement operation.",
        ));
    }
    let allowed: &[u8] = match operation {
        0xC2 => &[0xC2, 0xE0],
        0xC3 => &[0xC3, 0xE0],
        0xD2 => &[0xD2, 0xE0],
        _ => &[0xD7, 0xE0],
    };
    let allowed_rom: Option<&[u8]> = match operation {
        0xC2 => Some(&[0xC2, 0x00]),
        0xC3 => Some(&[0xC3, 0x00]),
        _ => None,
    };
    if payload != allowed && allowed_rom != Some(payload) {
        return Err(FlashError::protocol(
            "Missing, mismatched or failed acknowledgement.",
        ));
    }
    Ok(())
}

/// Describe a CRC-checked, allowlisted DE response, without verified=True.
///
/// The upstream DE response is exactly 27 bytes and retains data_len=0 in its
/// 16-byte header, followed by JEDEC[3] + UID[8]. Its CRC covers all 19 bytes
/// after offset 8. The UID is deliberately discarded and never returned.
/// Internal 90h cross-checking belongs to the separately audited RAM
/// program; this result does not claim that the host received raw 90h bytes.
pub fn parse_jedec_response(payload: &[u8]) -> Result<serde_json::Value> {
    if payload.len() != 27 {
        // Report framing/status metadata only. Never expose an unexpected
        // payload (which can contain the device UID) in logs or exceptions.
        let operation = if payload.is_empty() {
            "missing".to_string()
        } else {
            format!("0x{:02X}", payload[0])
        };
        let status = if payload.len() > 1 {
            format!("0x{:02X}", payload[1])
        } else {
            "missing".to_string()
        };
        let detail = format!(
            "received {} bytes, operation={operation}, status={status}",
            payload.len()
        );
        return Err(FlashError::protocol(format!(
            "ID response must be exactly 27 bytes; {detail}. Capacity remains unverified."
        )));
    }
    let operation = u16::from_le_bytes([payload[0], payload[1]]);
    let reserved = u16::from_le_bytes([payload[2], payload[3]]);
    let checksum = u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]);
    let address = u32::from_le_bytes([payload[8], payload[9], payload[10], payload[11]]);
    let data_length = u32::from_le_bytes([payload[12], payload[13], payload[14], payload[15]]);
    if (operation, reserved, address, data_length) != (0xDE, 0, 0, 0) {
        return Err(FlashError::protocol(
            "ID response header does not match the fixed protocol.",
        ));
    }
    if checksum != crc32(&payload[8..]) {
        return Err(FlashError::protocol(
            "ID response CRC32 mismatch; capacity is not accepted.",
        ));
    }
    let jedec = &payload[16..19];
    let entry = SUPPORTED_IDS
        .iter()
        .copied()
        .find(|(id, _, _)| id.as_slice() == jedec);
    let Some((_, family, capacity)) = entry else {
        return Err(FlashError::protocol(
            "Unsupported physical JEDEC ID; capacity remains unverified.",
        ));
    };
    Ok(serde_json::json!({
        "jedecId": jedec.iter().map(|b| format!("{b:02X}")).collect::<String>(),
        "family": family,
        "capacityBytes": capacity,
        "addressBytes": 3,
    }))
}
