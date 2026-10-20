// SPDX-License-Identifier: MIT
// Ported from sipeed/kflash.py 1.1.6 (MIT, Copyright 2019 Vowstar) — the
// MAIXLoader paths exercised by `KFlash().process(terminal=False, dev=port,
// baudrate=1500000, board=None, sram=False, file=bin_path, callback=progress,
// noansi=True, io_mode='dio')` from nodu_firmware.flash_image (MIT).
// Source: sipeed/kflash.py 550828c768b16ef329695d3f5eace3f6bcf14af2 kflash.py
//
// The legacy `recv_one_return` SLIP reader retains the upstream post-escape
// byte quirk. Safety exceptions: D4 checksum errors fail closed, and the
// worker's deadline bounds otherwise unlimited busy/retry loops. Erase, ELF,
// kfpkg extraction, SRAM boot and manual board selection are not exposed.

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use nodu_serial::Transport;
use sha2::{Digest, Sha256};

use crate::crc32::crc32;
use crate::error::{ErrorKind, FlashError, Result};

const ISP_RECEIVE_TIMEOUT: f64 = 0.5;
const ISP_RECEIVE_TIMEOUT_POST_GREETING: f64 = 3.0;
const MAX_RETRY_TIMES: u32 = 10;
const ISP_FLASH_SECTOR_SIZE: usize = 4096;
const ISP_FLASH_DATA_FRAME_SIZE: usize = ISP_FLASH_SECTOR_SIZE * 16;
const DEADLINE_ERROR: &str = "Firmware writer deadline exceeded; recovery backup must be retained.";
/// `terminal_size=(50, 1)` — non-terminal, no auto-size → fixed columns.
const TERMINAL_COLUMNS: usize = 50;
const PROGRESS_BAR_LENGTH: usize = TERMINAL_COLUMNS - 35;

/// `ISP_PROG` from kflash 1.1.6, already zlib-decompressed (16512 bytes).
pub static ISP_PROG: &[u8] = include_bytes!("assets/isp_prog.bin");

fn dev(message: impl Into<String>) -> FlashError {
    FlashError::device(message)
}

/// `tuple2str((ERROR_MSG, parts..., DEFAULT))` with `noansi` — '[ERROR]' +
/// each element + trailing ' '.
fn error_tuple(parts: &[&str]) -> String {
    let mut ret = String::from("[ERROR]");
    for part in parts {
        ret += part;
        ret += " ";
    }
    ret
}

/// `printProgressBar` — emits the '\r'-prefixed line through `log` (the
/// worker printer trims it) then invokes `callback(kind, iteration, total,
/// suffix)` with the upstream kind mapping.
fn print_progress_bar(
    iteration: u64,
    total: u64,
    prefix: &str,
    suffix: &str,
    filename: &str,
    log: &mut dyn FnMut(&str),
    callback: &mut dyn FnMut(&str, u64, u64, &str),
) {
    let percent = format!("{:.1}", 100.0 * (iteration as f64 / total as f64));
    let filled = (PROGRESS_BAR_LENGTH as u64 * iteration / total) as usize;
    let bar = "=".repeat(filled) + &"-".repeat(PROGRESS_BAR_LENGTH - filled);
    let text = format!("\r{prefix} |{bar}| {percent}% {suffix}");
    klog(&[text.as_str()], log);
    // `if iteration == total: KFlash.log()` — empty text → printer drops it.
    let kind = if prefix == "Downloading ISP:" {
        "ISP"
    } else if prefix == "Programming BIN:" && filename.is_empty() {
        "BIN"
    } else {
        filename
    };
    callback(kind, iteration, total, suffix);
}

/// `KFlash.print_callback` → the worker `printer`: `' '.join(map(str,
/// parts)).strip()`, emitted only when non-empty.
fn klog(parts: &[&str], log: &mut dyn FnMut(&str)) {
    let text = parts.join(" ").trim().to_string();
    if !text.is_empty() {
        log(&text);
    }
}

/// Which branch a response `parse` failure maps to upstream.
#[derive(Debug, Clone, Copy)]
enum ParseFail {
    /// `data[i]` indexing raised `IndexError` (len < 2).
    Index,
    /// `Operation(op)`/`ErrorCode(reason)`/`decode` raised → bare except.
    Other,
}

const ISP_OPS: &[u8] = &[0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xD1, 0xC6];
const ISP_CODES: &[u8] = &[0x00, 0xE0, 0xE1, 0xE2, 0xE3];
const FLASH_OPS: &[u8] = &[0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9];
const FLASH_CODES: &[u8] = &[0x00, 0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7];

/// `ISPResponse.parse` — (op, reason, text). An unknown op logs
/// 'Warning: recv unknown op' and keeps going upstream; an unknown *reason*
/// raises (ValueError) inside the caller's error-code comparison.
fn isp_parse(
    data: &[u8],
    log: &mut dyn FnMut(&str),
) -> std::result::Result<(u8, u8, String), ParseFail> {
    if data.is_empty() || data.len() < 2 {
        return Err(ParseFail::Index);
    }
    let op = data[0];
    let reason = data[1];
    let mut text = String::new();
    if !ISP_OPS.contains(&op) {
        klog(&["Warning: recv unknown op", &op.to_string()], log);
        // `if ISPOperation(op) == ISP_DEBUG_INFO` raised → text stays ''
    } else if op == 0xD1 {
        match std::str::from_utf8(&data[2..]) {
            Ok(t) => text = t.to_string(),
            Err(_) => return Err(ParseFail::Other), // decode() raised
        }
    }
    Ok((op, reason, text))
}

/// `FlashModeResponse.parse` — unknown op/reason → ValueError → bare except.
fn flash_parse(data: &[u8]) -> std::result::Result<(u8, u8, String), ParseFail> {
    if data.len() < 2 {
        return Err(ParseFail::Index);
    }
    let op = data[0];
    let reason = data[1];
    if !FLASH_OPS.contains(&op) {
        return Err(ParseFail::Other);
    }
    let mut text = String::new();
    if op == 0xD1 {
        match std::str::from_utf8(&data[2..]) {
            Ok(t) => text = t.to_string(),
            Err(_) => return Err(ParseFail::Other),
        }
    }
    if !FLASH_CODES.contains(&reason) {
        return Err(ParseFail::Other);
    }
    if text.trim().is_empty() {
        text = match reason {
            0xE0 => String::new(), // `text = None` upstream → falsy
            0xE1 => "bad data len".to_string(),
            0xE2 => "bad data checksum".to_string(),
            0xE4 => "bad initialization".to_string(),
            0xE3 => "invalid command".to_string(),
            0xE5 => "bad flash erase".to_string(),
            0xE6 => "bad flash write".to_string(),
            0xE7 => "flash is busy".to_string(),
            _ => "unknown error".to_string(), // reason 0x00
        };
    }
    Ok((op, reason, text))
}

/// `MAIXLoader` — the kflash 1.1.6 serial protocol driver.
#[allow(missing_debug_implementations)]
pub struct Loader<'k> {
    port: Box<dyn Transport>,
    kill: &'k AtomicBool,
    closed: bool,
    receive_timeout: Duration,
    deadline: Option<Instant>,
}

impl<'k> Loader<'k> {
    pub fn new(port: Box<dyn Transport>, kill: &'k AtomicBool, deadline: Option<Instant>) -> Self {
        Self {
            port,
            kill,
            closed: false,
            receive_timeout: Duration::from_secs_f64(ISP_RECEIVE_TIMEOUT),
            deadline,
        }
    }

    fn is_open(&self) -> bool {
        !self.closed
    }

    /// `self._port.open()` after a close; the transport object survives, so
    /// this just marks it usable again.
    fn reopen(&mut self) {
        self.closed = false;
    }

    /// `raise_exception` — closes the port then raises.
    fn raise_exception<T>(&mut self, error: FlashError) -> Result<T> {
        self.closed = true;
        Err(error)
    }

    fn check_kill(&mut self) -> Result<()> {
        if self.kill.load(Ordering::SeqCst) {
            self.closed = true;
            return Err(dev("Cancel"));
        }
        if self.deadline.is_some_and(|d| Instant::now() >= d) {
            return self.raise_exception(dev(DEADLINE_ERROR));
        }
        Ok(())
    }

    /// `write(packet)` — SLIP escape + frame; `port.write` semantics.
    fn write(&mut self, packet: &[u8]) -> Result<()> {
        self.check_kill()?;
        if self.closed {
            return Err(dev("write to closed port"));
        }
        let mut buf = Vec::with_capacity(packet.len() + 2 + 8);
        buf.push(0xC0);
        for &b in packet {
            match b {
                0xDB => buf.extend_from_slice(&[0xDB, 0xDD]),
                0xC0 => buf.extend_from_slice(&[0xDB, 0xDC]),
                _ => buf.push(b),
            }
        }
        buf.push(0xC0);
        self.port.write_all(&buf).map_err(FlashError::from)
    }

    /// `self._port.write(literal)` — pre-framed bytes (greeting/reboot).
    fn raw_write(&mut self, data: &[u8]) -> Result<()> {
        self.check_kill()?;
        if self.closed {
            return Err(dev("write to closed port"));
        }
        self.port.write_all(data).map_err(FlashError::from)
    }

    /// `recv_one_return(timeout_s)` — byte-at-a-time SLIP reader keeping the
    /// upstream escape quirk (the post-escape byte is appended as well) and
    /// open-ended start-of-frame search.
    fn recv_one_return(&mut self, timeout: Option<Duration>) -> Result<Vec<u8>> {
        let timeout = timeout.unwrap_or(self.receive_timeout);
        let start = Instant::now();
        let mut data = Vec::new();
        // find start border — non-C0 bytes are skipped silently upstream
        loop {
            self.check_kill()?;
            if start.elapsed() > timeout {
                return self.raise_exception(FlashError::timeout());
            }
            let mut one = [0u8; 1];
            let n = self.port.read(&mut one).map_err(FlashError::from)?;
            if n == 0 {
                continue;
            }
            if one[0] == 0xC0 {
                break;
            }
        }
        let mut in_escape = false;
        loop {
            self.check_kill()?;
            if start.elapsed() > timeout {
                return self.raise_exception(FlashError::timeout());
            }
            if self.closed {
                return Err(dev("Attempting to use a port that is not open"));
            }
            let mut one = [0u8; 1];
            let n = self.port.read(&mut one).map_err(FlashError::from)?;
            if n == 0 {
                continue;
            }
            let c = one[0];
            if c == 0xC0 {
                break;
            }
            if in_escape {
                in_escape = false;
                if c == 0xDC {
                    data.push(0xC0);
                } else if c == 0xDD {
                    data.push(0xDB);
                } else {
                    return self.raise_exception(dev(format!(
                        "Invalid SLIP escape ({:?}{:?})",
                        [0xDBu8],
                        [c]
                    )));
                }
            } else if c == 0xDB {
                in_escape = true;
            }
            // Upstream appends `c` unconditionally — including escape bytes.
            data.push(c);
        }
        Ok(data)
    }

    // —— reset sequences (verbatim kflash 1.1.6 pin orders) ——

    /// `reset_to_isp_dan`: DTR F,RTS F / DTR F,RTS T / RTS F,DTR T.
    fn reset_to_isp_dan(&mut self) -> Result<()> {
        self.port
            .set_dtr(false)
            .and_then(|()| self.port.set_rts(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_dtr(false)
            .and_then(|()| self.port.set_rts(true))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_rts(false)
            .and_then(|()| self.port.set_dtr(true))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    /// `reset_to_isp_kd233`: DTR F,RTS F / DTR T,RTS F / RTS T,DTR F.
    fn reset_to_isp_kd233(&mut self) -> Result<()> {
        self.port
            .set_dtr(false)
            .and_then(|()| self.port.set_rts(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_dtr(true)
            .and_then(|()| self.port.set_rts(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_rts(true)
            .and_then(|()| self.port.set_dtr(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    /// `reset_to_isp_goD`: DTR T,RTS T / RTS F,DTR T / RTS F,DTR T.
    fn reset_to_isp_go_d(&mut self) -> Result<()> {
        self.port
            .set_dtr(true)
            .and_then(|()| self.port.set_rts(true))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_rts(false)
            .and_then(|()| self.port.set_dtr(true))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_rts(false)
            .and_then(|()| self.port.set_dtr(true))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    /// `reset_to_boot_dan`: DTR F,RTS F / DTR F,RTS T / RTS F,DTR F.
    fn reset_to_boot_dan(&mut self) -> Result<()> {
        self.port
            .set_dtr(false)
            .and_then(|()| self.port.set_rts(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_dtr(false)
            .and_then(|()| self.port.set_rts(true))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_rts(false)
            .and_then(|()| self.port.set_dtr(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    /// `reset_to_boot_kd233`: DTR F,RTS F / DTR T,RTS F / RTS F,DTR F.
    fn reset_to_boot_kd233(&mut self) -> Result<()> {
        self.port
            .set_dtr(false)
            .and_then(|()| self.port.set_rts(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_dtr(true)
            .and_then(|()| self.port.set_rts(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_rts(false)
            .and_then(|()| self.port.set_dtr(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    /// `reset_to_boot_goD`: DTR F,RTS F / RTS F,DTR T / RTS T,DTR T.
    fn reset_to_boot_go_d(&mut self) -> Result<()> {
        self.port
            .set_dtr(false)
            .and_then(|()| self.port.set_rts(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_rts(false)
            .and_then(|()| self.port.set_dtr(true))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_rts(true)
            .and_then(|()| self.port.set_dtr(true))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    /// `reset_to_boot_maixgo` (goE): DTR F,RTS F / RTS F,DTR T / RTS F,DTR F.
    /// Unreachable through auto-detect; kept for parity.
    #[allow(dead_code)]
    fn reset_to_boot_maixgo(&mut self) -> Result<()> {
        self.port
            .set_dtr(false)
            .and_then(|()| self.port.set_rts(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_rts(false)
            .and_then(|()| self.port.set_dtr(true))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port
            .set_rts(false)
            .and_then(|()| self.port.set_dtr(false))
            .map_err(FlashError::from)?;
        std::thread::sleep(Duration::from_millis(100));
        Ok(())
    }

    /// `greeting()` — raw C2 frame + parse-and-discard the ACK. Any parse
    /// failure propagates like the upstream exceptions.
    fn greeting(&mut self, log: &mut dyn FnMut(&str)) -> Result<()> {
        self.raw_write(&[0xC0, 0xC2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xC0])?;
        let data = self.recv_one_return(None)?;
        match isp_parse(&data, log) {
            Ok(_) => Ok(()),
            Err(ParseFail::Index) => Err(dev("index out of range")),
            Err(ParseFail::Other) => Err(dev(format!(
                "{} is not a valid ISPOperation",
                data.first().copied().unwrap_or(0)
            ))),
        }
    }

    /// `flash_greeting()` — D2 NOP to the stub, retries to MAX_RETRY_TIMES.
    fn flash_greeting(&mut self, log: &mut dyn FnMut(&str)) -> Result<()> {
        let mut retry_count = 0u32;
        loop {
            self.check_kill()?;
            if self
                .raw_write(&[0xC0, 0xD2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xC0])
                .is_err()
            {
                return self.raise_exception(dev(error_tuple(&[
                    "The serial port has been disconnected, please try again, use slow mode, or reduce the baud rate.",
                ])));
            }
            retry_count += 1;
            let (op, reason, _text) = match self.recv_one_return(None) {
                Ok(data) => match flash_parse(&data) {
                    Ok(p) => p,
                    Err(ParseFail::Index) => {
                        if retry_count > MAX_RETRY_TIMES {
                            return self.raise_exception(dev(error_tuple(&[
                                "Failed to Connect to K210's Stub",
                            ])));
                        }
                        klog(&["[WARN]", "Index Error, retrying..."], log);
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    Err(ParseFail::Other) => {
                        if retry_count > MAX_RETRY_TIMES {
                            return self.raise_exception(dev(error_tuple(&[
                                "Failed to Connect to K210's Stub",
                            ])));
                        }
                        klog(&["[WARN]", "Unexcepted Error, retrying..."], log);
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                },
                Err(e) => {
                    let which = if e.kind() == ErrorKind::Timeout {
                        "Timeout Error, retrying..."
                    } else {
                        "Unexcepted Error, retrying..."
                    };
                    if retry_count > MAX_RETRY_TIMES {
                        return self.raise_exception(dev(error_tuple(&[
                            "Failed to Connect to K210's Stub",
                        ])));
                    }
                    klog(&["[WARN]", which], log);
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            if op == 0xD2 && reason == 0xE0 {
                klog(&["[INFO]", "Boot to Flashmode Successfully"], log);
                let _ = self.port.reset_input_buffer();
                let _ = self.port.flush();
                break;
            }
            if retry_count > MAX_RETRY_TIMES {
                return self
                    .raise_exception(dev(error_tuple(&["Failed to Connect to K210's Stub"])));
            }
            klog(&["[WARN]", "Unexcepted Return recevied, retrying..."], log);
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }

    /// `boot()` — C5 packet to 0x80000000.
    fn boot(&mut self, log: &mut dyn FnMut(&str)) -> Result<()> {
        klog(&["[INFO]", "Booting From 0x80000000"], log);
        let mut body = Vec::with_capacity(8);
        body.extend_from_slice(&0x8000_0000u32.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        let crc = crc32(&body);
        let mut packet = Vec::with_capacity(16);
        packet.extend_from_slice(&0xC5u16.to_le_bytes());
        packet.extend_from_slice(&0u16.to_le_bytes());
        packet.extend_from_slice(&crc.to_le_bytes());
        packet.extend_from_slice(&body);
        self.write(&packet)
    }

    /// `recv_debug()` — ROM ACK validation (DEFAULT or OK); timeout is a
    /// soft False with the 'receive data time out' log block.
    fn recv_debug(&mut self, log: &mut dyn FnMut(&str)) -> Result<bool> {
        let ret = self.recv_one_return(None)?;
        if ret.len() < 2 {
            let dashes = "-".repeat(30);
            klog(&[&dashes], log);
            klog(&["receive data time out"], log);
            klog(&[&dashes], log);
            return Ok(false);
        }
        let (_op, reason, text) = match isp_parse(&ret, log) {
            Ok(v) => v,
            // `data[0]`/`data[1]` IndexError is unreachable (len>=2 above).
            Err(ParseFail::Index) => (0, 0, String::new()),
            Err(ParseFail::Other) => return Err(dev("decode failure in ISP debug info")),
        };
        if !text.is_empty() {
            let dashes = "-".repeat(30);
            klog(&[&dashes], log);
            klog(&[text.as_str()], log);
            klog(&[&dashes], log);
        }
        if !ISP_CODES.contains(&reason) {
            // ISPResponse.ErrorCode(reason) → ValueError propagates.
            return Err(dev(format!("{reason} is not a valid ErrorCode")));
        }
        if !matches!(reason, 0 | 0xE0) {
            klog(&["Failed, retry, errcode=", &format!("{reason:#x}")], log);
            return Ok(false);
        }
        Ok(true)
    }

    /// `init_flash(1)` — D7 init; 'Selected Flash:  On-Board'.
    fn init_flash(&mut self, log: &mut dyn FnMut(&str)) -> Result<()> {
        klog(&["[INFO]", "Selected Flash: ", "On-Board"], log);
        let mut body = Vec::with_capacity(8);
        body.extend_from_slice(&1u32.to_le_bytes());
        body.extend_from_slice(&0u32.to_le_bytes());
        let crc = crc32(&body);
        let mut out = Vec::with_capacity(16);
        out.extend_from_slice(&0xD7u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&body);
        let mut retry_count = 0u32;
        loop {
            self.check_kill()?;
            self.write(&out)?;
            retry_count += 1;
            let (op, reason, _text) = match self.recv_one_return(None) {
                Ok(data) => match flash_parse(&data) {
                    Ok(p) => p,
                    Err(ParseFail::Index) => {
                        if retry_count > MAX_RETRY_TIMES {
                            return self.raise_exception(dev(error_tuple(&[
                                "Failed to initialize flash",
                            ])));
                        }
                        klog(&["[WARN]", "Index Error, retrying..."], log);
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                    Err(ParseFail::Other) => {
                        if retry_count > MAX_RETRY_TIMES {
                            return self.raise_exception(dev(error_tuple(&[
                                "Failed to initialize flash",
                            ])));
                        }
                        klog(&["[WARN]", "Unexcepted Error, retrying..."], log);
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                },
                Err(e) => {
                    let which = if e.kind() == ErrorKind::Timeout {
                        "Timeout Error, retrying..."
                    } else {
                        "Unexcepted Error, retrying..."
                    };
                    if retry_count > MAX_RETRY_TIMES {
                        return self
                            .raise_exception(dev(error_tuple(&["Failed to initialize flash"])));
                    }
                    klog(&["[WARN]", which], log);
                    std::thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            if op == 0xD7 && reason == 0xE0 {
                klog(&["[INFO]", "Initialization flash Successfully"], log);
                break;
            }
            if retry_count > MAX_RETRY_TIMES {
                return self.raise_exception(dev(error_tuple(&["Failed to initialize flash"])));
            }
            klog(&["[WARN]", "Unexcepted Return recevied, retrying..."], log);
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }

    /// `change_baudrate(1500000)` — D6 + port re-baud; the goE OPENEC branch
    /// is unreachable because auto-detection never yields goE.
    fn change_baudrate(&mut self, baudrate: u32, log: &mut dyn FnMut(&str)) -> Result<()> {
        klog(
            &["[INFO]", "Selected Baudrate: ", &baudrate.to_string()],
            log,
        );
        let mut body = Vec::with_capacity(12);
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&4u32.to_le_bytes());
        body.extend_from_slice(&baudrate.to_le_bytes());
        let crc = crc32(&body);
        let mut out = Vec::with_capacity(20);
        out.extend_from_slice(&0xD6u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&body);
        self.write(&out)?;
        std::thread::sleep(Duration::from_millis(50));
        self.port.set_baud_rate(baudrate).map_err(FlashError::from)
    }

    /// `flash_dataframe` — ISP (RAM) upload in 1024-byte C3 frames with the
    /// unbounded `recv_debug` retry kept faithful.
    fn flash_dataframe(
        &mut self,
        data: &[u8],
        progress: &mut dyn FnMut(&str, u64, u64, &str),
        log: &mut dyn FnMut(&str),
    ) -> Result<()> {
        let mut address = 0x8000_0000u32;
        let total_len = data.len() as u64;
        let mut write_len = 0u64;
        let time_start = Instant::now();
        for chunk in data.chunks(1024) {
            self.check_kill()?;
            loop {
                self.check_kill()?;
                let mut body = Vec::with_capacity(8 + chunk.len());
                body.extend_from_slice(&address.to_le_bytes());
                body.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
                body.extend_from_slice(chunk);
                let crc = crc32(&body);
                let mut out = Vec::with_capacity(8 + body.len());
                out.extend_from_slice(&0xC3u16.to_le_bytes());
                out.extend_from_slice(&0u16.to_le_bytes());
                out.extend_from_slice(&crc.to_le_bytes());
                out.extend_from_slice(&body);
                self.write(&out)?;
                address += chunk.len() as u32;
                if self.recv_debug(log)? {
                    break;
                }
            }
            let time_delta = time_start.elapsed().as_secs_f64();
            write_len += chunk.len() as u64;
            let mut speed = String::new();
            if time_delta > 1.0 {
                speed = format!("{}kiB/s", (write_len as f64 / 1024.0 / time_delta) as u64);
            }
            print_progress_bar(
                write_len,
                total_len,
                "Downloading ISP:",
                &speed,
                "",
                log,
                progress,
            );
        }
        Ok(())
    }

    /// `dump_to_flash(data, address, size)` — D4 frames. The operation
    /// deadline bounds upstream's otherwise unbounded retries and E7 busy.
    /// E2 checksum errors stop immediately rather than accepting bad data.
    fn dump_to_flash(
        &mut self,
        data: &[u8],
        address: u32,
        size: usize,
        log: &mut dyn FnMut(&str),
    ) -> Result<()> {
        let mut address = address;
        for chunk in data.chunks(size.max(1)) {
            let mut body = Vec::with_capacity(8 + chunk.len());
            body.extend_from_slice(&address.to_le_bytes());
            body.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
            body.extend_from_slice(chunk);
            let crc = crc32(&body);
            let mut out = Vec::with_capacity(8 + body.len());
            out.extend_from_slice(&0xD4u16.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&body);
            let mut retry_count = 0u32;
            loop {
                self.write(&out)?;
                retry_count += 1;
                let parsed = match self.recv_one_return(Some(Duration::from_secs(90))) {
                    Ok(data) => flash_parse(&data).ok(),
                    Err(_) => None,
                };
                let Some((op, reason, _text)) = parsed else {
                    // except Exception → reopen-if-closed → continue (the
                    // upstream retry_count check after `continue` is dead).
                    if !self.is_open() {
                        self.reopen();
                    }
                    continue;
                };
                if op == 0xD4 && reason == 0xE0 {
                    let _ = self.port.reset_input_buffer();
                    let _ = self.port.flush();
                    break;
                } else if op == 0xD4 && reason == 0xE7 {
                    let _ = self.port.reset_input_buffer();
                    let _ = self.port.flush();
                    retry_count = 0;
                    std::thread::sleep(Duration::from_millis(500));
                } else if op == 0xD4 && reason == 0xE2 {
                    return self.raise_exception(dev(
                        "Flash data checksum error; writing stopped before the next block.",
                    ));
                } else {
                    if retry_count > MAX_RETRY_TIMES {
                        return self.raise_exception(dev(error_tuple(&[
                            "Failed to write to K210's flash",
                        ])));
                    }
                    klog(&["[WARN]", "Unexcepted Return recevied, retrying..."], log);
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            address += chunk.len() as u32;
        }
        Ok(())
    }

    /// `isp_reboot` — D5; result is True only on (D5, E0).
    fn isp_reboot(&mut self, log: &mut dyn FnMut(&str)) -> Result<bool> {
        let result;
        let mut retry_count = 0u32;
        loop {
            self.check_kill()?;
            self.raw_write(&[0xC0, 0xD5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xC0])?;
            retry_count += 1;
            match self.recv_one_return(Some(Duration::from_secs(90))) {
                Err(e) => {
                    // TimeoutError branch vs bare except branch (capital
                    // 'K210' differs between them upstream).
                    let (which, message) = if e.kind() == ErrorKind::Timeout {
                        ("Timeout Error, retrying...", "Failed to reboot k210")
                    } else {
                        ("Unexcepted Error, retrying...", "Failed to reboot k210")
                    };
                    if retry_count > MAX_RETRY_TIMES {
                        return self.raise_exception(dev(error_tuple(&[message])));
                    }
                    klog(&["[WARN]", which], log);
                    std::thread::sleep(Duration::from_millis(100));
                }
                Ok(data) => match flash_parse(&data) {
                    Err(ParseFail::Index) => {
                        if retry_count > MAX_RETRY_TIMES {
                            return self
                                .raise_exception(dev(error_tuple(&["Failed to reboot K210"])));
                        }
                        klog(&["[WARN]", "Index Error, retrying..."], log);
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Err(ParseFail::Other) => {
                        if retry_count > MAX_RETRY_TIMES {
                            return self
                                .raise_exception(dev(error_tuple(&["Failed to reboot k210"])));
                        }
                        klog(&["[WARN]", "Unexcepted Error, retrying..."], log);
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Ok((0xD5, 0xE0, _)) => {
                        klog(
                            &["[INFO]", "The ISP stub tells us the k210 is rebooting ..."],
                            log,
                        );
                        let _ = self.port.reset_input_buffer();
                        let _ = self.port.flush();
                        result = true;
                        break;
                    }
                    Ok((0xD5, 0xE7, _)) => {
                        klog(
                            &[
                                "[INFO]",
                                "Flash is busy, waiting for the previous operation to complete ...",
                            ],
                            log,
                        );
                        let _ = self.port.reset_input_buffer();
                        let _ = self.port.flush();
                        std::thread::sleep(Duration::from_secs(5));
                    }
                    Ok(_) => {
                        if retry_count > MAX_RETRY_TIMES {
                            return self.raise_exception(dev(error_tuple(&["Failed to reboot"])));
                        }
                        klog(&["[WARN]", "Unexcepted Return recevied, retrying..."], log);
                        std::thread::sleep(Duration::from_millis(100));
                    }
                },
            }
        }
        Ok(result)
    }

    /// `install_flash_bootloader` — `flash_dataframe` at 0x80000000.
    fn install_flash_bootloader(
        &mut self,
        data: &[u8],
        progress: &mut dyn FnMut(&str, u64, u64, &str),
        log: &mut dyn FnMut(&str),
    ) -> Result<()> {
        self.flash_dataframe(data, progress, log)
    }

    /// `flash_firmware(bin, aes_key=None, address_offset=0,
    /// sha256Prefix=True, filename='', io_mode='dio')` — prefix + D4 frames.
    fn flash_firmware(
        &mut self,
        firmware_bin: &[u8],
        progress: &mut dyn FnMut(&str, u64, u64, &str),
        log: &mut dyn FnMut(&str),
    ) -> Result<()> {
        // sha256Prefix=True, aes_key=None, io_mode='dio':
        // aes_cipher_flag = b'\x00' | 0x02 → b'\x02'.
        klog(
            &[
                "[INFO]",
                "Flash mode: DIO, Dual SPI serial throughput rates reach around 20 Mbps",
            ],
            log,
        );
        let firmware_len = firmware_bin.len() as u32;
        let mut data = Vec::with_capacity(5 + firmware_bin.len());
        data.push(0x02);
        data.extend_from_slice(&firmware_len.to_le_bytes());
        data.extend_from_slice(firmware_bin);
        let sha256_hash = Sha256::digest(&data);
        let mut firmware_with_header = data;
        firmware_with_header.extend_from_slice(&sha256_hash);
        let total_len = firmware_with_header.len() as u64;
        let time_start = Instant::now();
        let mut write_len = 0u64;
        for chunk in firmware_with_header.chunks(ISP_FLASH_DATA_FRAME_SIZE) {
            self.check_kill()?;
            let chunk_len = chunk.len();
            self.dump_to_flash(chunk, write_len as u32, chunk_len, log)?;
            write_len += chunk_len as u64;
            let time_delta = time_start.elapsed().as_secs_f64();
            let mut speed = String::new();
            if time_delta > 1.0 {
                speed = format!("{}kiB/s", (write_len as f64 / 1024.0 / time_delta) as u64);
            }
            print_progress_bar(
                write_len,
                total_len,
                "Programming BIN:",
                &speed,
                "",
                log,
                progress,
            );
        }
        Ok(())
    }
}

/// `KFlash().process(terminal=False, dev=port, baudrate=1500000, board=None,
/// sram=False, file=path, callback=progress, noansi=True, io_mode='dio')`.
///
/// `open_port` creates the 115200/100ms serial transport (worker injects the
/// real opener; tests inject `MemoryTransport`). `kill` mirrors
/// `KFlash.killProcess`/`loader._kill_process` — the worker never sets it
/// today (flash_in_progress already blocks stop/disconnect). The worker
/// supplies its operation deadline; each read/write and retry observes it.
pub fn process(
    open_port: impl FnOnce(&str) -> io::Result<Box<dyn Transport>>,
    port: &str,
    file: &Path,
    progress: &mut dyn FnMut(&str, u64, u64, &str),
    log: &mut dyn FnMut(&str),
    kill: &AtomicBool,
    deadline: Option<Instant>,
) -> Result<()> {
    if deadline.is_some_and(|d| Instant::now() >= d) {
        return Err(dev(DEADLINE_ERROR));
    }
    // args.noansi → BASH_TIPS emptied; INFO/WARN/ERROR are plain tags.
    klog(&["[INFO]", "ANSI colors not used"], log);
    // args.port != 'DEFAULT' → manual path.
    klog(&["[INFO]", "COM Port Selected Manually: ", port], log);
    let transport = open_port(port).map_err(|e| FlashError::device(e.to_string()))?;
    let mut loader = Loader::new(transport, kill, deadline);
    klog(
        &[
            "[INFO]",
            "Default baudrate is",
            "115200",
            ", later it may be changed to the value you set.",
        ],
        log,
    );

    let process_result = (|loader: &mut Loader| -> Result<()> {
        use std::io::Read;
        // 0. Check firmware (FMT_BINARY path only; worker pins .bin).
        if !file.exists() {
            return Err(dev(error_tuple(&[
                "Unable to find the firmware at ",
                &file.display().to_string(),
            ])));
        }
        let mut header = [0u8; 4];
        let mut f = std::fs::File::open(file).map_err(FlashError::from)?;
        let n = f.read(&mut header).map_err(FlashError::from)?;
        let header = &header[..n];
        if header.starts_with(b"PK") {
            if file.extension().and_then(|e| e.to_str()) != Some("kfpkg") {
                klog(
                    &[
                        "[INFO]",
                        "Find a zip file, but not with ext .kfpkg:",
                        &file.display().to_string(),
                    ],
                    log,
                );
            } else {
                return Err(dev(
                    "The reviewed writer only accepts the pinned .bin image; kfpkg extraction is not ported.",
                ));
            }
        }
        if header.starts_with(b"\x7fELF") {
            return Err(dev(error_tuple(&[
                "This is an ELF file and cannot be programmed to flash directly:",
                &file.display().to_string(),
            ])));
        }

        // 1. Greeting — board auto-detect: dan → kd233 → goD → kd233 inside
        // each of up to 15 iterations; only TimeoutError is retried.
        klog(&["[INFO]", "Trying to Enter the ISP Mode..."], log);
        let mut retry_count = 0u32;
        let mut board: Option<&'static str> = None;
        loop {
            loader.check_kill()?;
            if !loader.is_open() {
                loader.reopen();
            }
            retry_count += 1;
            if retry_count > 15 {
                return Err(dev(error_tuple(&[
                    "No valid Kendryte K210 found in Auto Detect, Check Your Connection or Specify One by`-p /dev/ttyUSB0`",
                ])));
            }
            let mut detected = false;
            for (mark, reset, name, announce) in [
                (".", 0u8, "dan", "Automatically detected dan/bit/trainer"),
                ("_", 1, "kd233", "Automatically detected goE/kd233/bit_mic"),
                (".", 2, "goD", "Automatically detected goD"),
                ("_", 1, "kd233", "Automatically detected goE/kd233/bit_mic"),
            ] {
                let mut attempt = |l: &mut Loader| -> Result<()> {
                    klog(&[mark], log);
                    match reset {
                        0 => l.reset_to_isp_dan()?,
                        1 => l.reset_to_isp_kd233()?,
                        _ => l.reset_to_isp_go_d()?,
                    }
                    l.greeting(log)
                };
                match attempt(loader) {
                    Ok(()) => {
                        board = Some(name);
                        klog(&[], log); // KFlash.log() — empty → dropped
                        klog(&["[INFO]", announce], log);
                        detected = true;
                        break;
                    }
                    Err(e) => {
                        if e.kind() == ErrorKind::Timeout {
                            if !loader.is_open() {
                                loader.reopen();
                            }
                            continue;
                        }
                        // `except Exception as e` → 'Greeting fail'.
                        klog(&[], log);
                        return Err(dev(format!(
                            "Greeting fail, check serial port ({})",
                            e.message()
                        )));
                    }
                }
            }
            if detected {
                break;
            }
        }

        // ISP_RECEIVE_TIMEOUT = 3 — 'dinosaur infested' line kept faithful.
        loader.receive_timeout = Duration::from_secs_f64(ISP_RECEIVE_TIMEOUT_POST_GREETING);

        klog(&[], log);
        klog(
            &["[INFO]", "Greeting Message Detected, Start Downloading ISP"],
            log,
        );

        // 2. install ISP_PROG then boot it.
        loader.install_flash_bootloader(ISP_PROG, progress, log)?;
        loader.boot(log)?;

        // `self.loader._port.baudrate = 115200`.
        loader
            .port
            .set_baud_rate(115200)
            .map_err(FlashError::from)?;
        klog(&["[INFO]", "Wait For 0.1 second for ISP to Boot"], log);
        std::thread::sleep(Duration::from_millis(100));
        loader.flash_greeting(log)?;

        // args.baudrate(1500000) != 115200 → change_baudrate + re-greet.
        loader.change_baudrate(1_500_000, log)?;
        klog(
            &["[INFO]", "Baudrate changed, greeting with ISP again ... "],
            log,
        );
        loader.flash_greeting(log)?;

        loader.init_flash(log)?;

        // args.erase is False → skipped. FMT_BINARY → flash_firmware.
        let firmware_bin = std::fs::read(file).map_err(FlashError::from)?;
        loader.flash_firmware(&firmware_bin, progress, log)?;

        // 3. boot — isp_reboot; on a False result the physical reset by the
        // auto-detected board runs (upstream only checks three names).
        klog(&["[INFO]", "Rebooting..."], log);
        if !loader.isp_reboot(log)? {
            match board {
                Some("dan") => loader.reset_to_boot_dan()?,
                Some("kd233") => loader.reset_to_boot_kd233()?,
                Some("goD") => loader.reset_to_boot_go_d()?,
                _ => klog(
                    &["[WARN]", "Board unknown !! please press reset to boot!!"],
                    log,
                ),
            }
        }
        Ok(())
    })(&mut loader);

    // `self.loader._port.close()` in every path (drop order).
    drop(loader);
    process_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodu_serial::MemoryTransport;

    #[test]
    fn expired_writer_deadline_never_sends_flash_data() {
        let transport = MemoryTransport::new();
        let kill = AtomicBool::new(false);
        let mut loader = Loader::new(Box::new(transport.clone()), &kill, Some(Instant::now()));
        let failure = loader
            .dump_to_flash(&[1, 2, 3], 0, 3, &mut |_| {})
            .unwrap_err();
        assert!(failure.message().contains("deadline"), "{failure}");
        assert!(transport.written().is_empty());
    }

    #[test]
    fn writer_deadline_bounds_an_unresponsive_serial_reply() {
        let transport = MemoryTransport::new();
        let kill = AtomicBool::new(false);
        let mut loader = Loader::new(
            Box::new(transport),
            &kill,
            Some(Instant::now() + Duration::from_millis(10)),
        );
        let failure = loader
            .recv_one_return(Some(Duration::from_secs(90)))
            .unwrap_err();
        assert!(failure.message().contains("deadline"), "{failure}");
    }

    #[test]
    fn flash_checksum_error_stops_before_next_block() {
        let transport = MemoryTransport::new();
        transport.feed(&[0xC0, 0xD4, 0xE2, 0xC0]);
        let kill = AtomicBool::new(false);
        let mut loader = Loader::new(
            Box::new(transport.clone()),
            &kill,
            Some(Instant::now() + Duration::from_secs(1)),
        );
        let failure = loader
            .dump_to_flash(&[0x11, 0x22, 0x33, 0x44], 0, 2, &mut |_| {})
            .unwrap_err();
        assert!(failure.message().contains("checksum"), "{failure}");
        let written = transport.written();
        assert!(
            written.starts_with(&[0xC0, 0xD4])
                && written.ends_with(&[0xC0])
                && !written.windows(2).any(|pair| pair == [0xC0, 0xC0])
        );
    }

    #[test]
    fn flash_busy_reply_cannot_retry_past_deadline() {
        let transport = MemoryTransport::new();
        transport.feed(&[0xC0, 0xD4, 0xE7, 0xC0]);
        let kill = AtomicBool::new(false);
        let mut loader = Loader::new(
            Box::new(transport.clone()),
            &kill,
            Some(Instant::now() + Duration::from_millis(250)),
        );
        let failure = loader
            .dump_to_flash(&[0x11, 0x22], 0, 2, &mut |_| {})
            .unwrap_err();
        assert!(failure.message().contains("deadline"), "{failure}");
        let written = transport.written();
        assert!(
            written.starts_with(&[0xC0, 0xD4])
                && written.ends_with(&[0xC0])
                && !written.windows(2).any(|pair| pair == [0xC0, 0xC0])
        );
    }
}
