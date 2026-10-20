// SPDX-License-Identifier: MIT
// Ported from k210-studio nodu_flash_probe.py (MIT) — source-built RAM ID
// reader transport. ROM reset/SLIP framing follows sipeed/kflash.py 1.1.6
// (MIT); the DE packet layout follows loboris/ktool (Apache-2.0).
// Source: k210-studio dc0aba3 desktop/scope-extension/resources/nodu_flash_probe.py
//! desktop/scope-extension/resources/nodu_flash_probe.py

use std::collections::VecDeque;
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use nodu_serial::Transport;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::codec;
use crate::error::{FlashError, Result};
use crate::pyjson;

pub const STUB_SHA256: &str = "6e9843b2bf365637af3853b1d827fc832a1a5ac4cd8dc5f203053bf5d29833a2";
pub const STUB_SIZE: u64 = 8688;

fn probe_err(message: impl Into<String>) -> FlashError {
    FlashError::probe(message)
}

/// `validate_build()` — authenticate the pinned image before any I/O.
/// The Python `importlib.metadata.version('pyserial') == '3.5'` gate maps to
/// this crate itself being the reviewed transport implementation.
pub fn validate_build(stub_path: &Path) -> Result<Vec<u8>> {
    if stub_path.symlink_metadata().is_ok_and(|m| m.is_symlink()) || !stub_path.is_file() {
        return Err(probe_err(
            "The reviewed source-built RAM reader is not installed.",
        ));
    }
    if stub_path.metadata().map_or(0, |m| m.len()) != STUB_SIZE {
        return Err(probe_err(
            "RAM reader length differs from the reviewed build; no port was opened.",
        ));
    }
    let image = std::fs::read(stub_path).map_err(|e| FlashError::device(e.to_string()))?;
    if image.len() as u64 != STUB_SIZE
        || Sha256::digest(&image)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
            != STUB_SHA256
    {
        return Err(probe_err(
            "RAM reader size/SHA256 differs from the reviewed build; no port was opened.",
        ));
    }
    Ok(image)
}

/// The reviewed source-built read-only RAM reader
/// (`resources/flash-probe/probe.bin`, SHA256 = `STUB_SHA256`).
pub static STUB_IMAGE: &[u8] = include_bytes!("assets/probe.bin");

/// `validate_build()` for the embedded asset — same size+SHA256 gate the
/// on-disk variant applies, so callers need no filesystem path.
pub fn stub_image() -> Result<Vec<u8>> {
    let image = STUB_IMAGE;
    if image.len() as u64 != STUB_SIZE
        || Sha256::digest(image)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
            != STUB_SHA256
    {
        return Err(probe_err(
            "RAM reader size/SHA256 differs from the reviewed build; no port was opened.",
        ));
    }
    Ok(image.to_vec())
}

/// `_pause(duration, check)` — cooperative 10 ms slices.
fn pause(duration: Duration, check: &mut dyn FnMut() -> Result<()>) -> Result<()> {
    let end = Instant::now() + duration;
    while Instant::now() < end {
        check()?;
        let remain = end.saturating_duration_since(Instant::now());
        std::thread::sleep(remain.min(Duration::from_millis(10)));
    }
    Ok(())
}

/// `_pause` with the `_reset_boot` no-op check (recovery is not cancellable).
fn pause_recovery(duration: Duration) {
    let end = Instant::now() + duration;
    while Instant::now() < end {
        let remain = end.saturating_duration_since(Instant::now());
        std::thread::sleep(remain.min(Duration::from_millis(10)));
    }
}

/// `_reset_isp` — fixed kflash reset_to_isp_dan sequence.
fn reset_isp(port: &mut dyn Transport, check: &mut dyn FnMut() -> Result<()>) -> Result<()> {
    port.set_dtr(false)
        .and_then(|()| port.set_rts(false))
        .map_err(FlashError::from)?;
    pause(Duration::from_millis(100), check)?;
    port.set_dtr(false)
        .and_then(|()| port.set_rts(true))
        .map_err(FlashError::from)?;
    pause(Duration::from_millis(100), check)?;
    port.set_rts(false)
        .and_then(|()| port.set_dtr(true))
        .map_err(FlashError::from)?;
    pause(Duration::from_millis(100), check)
}

/// `_reset_boot` — release BOOT/reset in all cases (uncancellable).
fn reset_boot(port: &mut dyn Transport) -> Result<()> {
    port.set_dtr(false)
        .and_then(|()| port.set_rts(false))
        .map_err(FlashError::from)?;
    pause_recovery(Duration::from_millis(100));
    port.set_dtr(false)
        .and_then(|()| port.set_rts(true))
        .map_err(FlashError::from)?;
    pause_recovery(Duration::from_millis(100));
    port.set_rts(false)
        .and_then(|()| port.set_dtr(false))
        .map_err(FlashError::from)?;
    pause_recovery(Duration::from_millis(100));
    Ok(())
}

/// `_Link` — SLIP transport with bounded counters (never payload bytes).
#[allow(missing_debug_implementations)]
pub struct Link<'p> {
    port: &'p mut dyn Transport,
    decoder: codec::SlipDecoder,
    pending: VecDeque<Vec<u8>>,
    counters: Map<String, Value>,
}

impl<'p> Link<'p> {
    pub fn new(port: &'p mut dyn Transport) -> Self {
        let mut link = Self {
            port,
            decoder: codec::SlipDecoder::new(128).expect("bounded decoder"),
            pending: VecDeque::new(),
            counters: Map::new(),
        };
        link.reset_diagnostics();
        link
    }

    fn count(&mut self, name: &str, amount: u64) {
        let cur = self.counters.get(name).and_then(Value::as_u64).unwrap_or(0);
        self.counters.insert(
            name.to_string(),
            json!(cur.saturating_add(amount).min(0xFFFF_FFFF)),
        );
    }

    pub fn reset_diagnostics(&mut self) {
        self.counters = Map::new();
        for k in [
            "receivedBytes",
            "receiveChunks",
            "decodedFrames",
            "slipDelimiters",
            "slipEscapeMarkers",
            "slipErrors",
            "ignoredBootAcks",
        ] {
            self.counters.insert(k.to_string(), json!(0));
        }
    }

    /// `diagnostics()` — counters + bounded pending/partial sizes only.
    pub fn diagnostics(&self) -> Map<String, Value> {
        let mut map = self.counters.clone();
        map.insert("pendingFrames".into(), json!(self.pending.len().min(128)));
        map.insert(
            "partialFrameBytes".into(),
            json!(self.decoder.partial_len().min(128)),
        );
        map.insert("slipStarted".into(), json!(self.decoder.is_started()));
        map.insert("slipEscaped".into(), json!(self.decoder.is_escaped()));
        map
    }

    pub fn clear(&mut self) {
        let _ = self.port.reset_input_buffer();
        self.decoder = codec::SlipDecoder::new(128).expect("bounded decoder");
        self.pending.clear();
    }

    pub fn send(&mut self, packet: &[u8], check: &mut dyn FnMut() -> Result<()>) -> Result<()> {
        check()?;
        let frame = codec::slip_encode(packet)?;
        // pyserial `write` raising propagates unannotated (not caught by the
        // probe's except); short writes never happen through write_all.
        self.port.write_all(&frame).map_err(FlashError::from)
    }

    pub fn receive(
        &mut self,
        allow_boot_ack: bool,
        check: &mut dyn FnMut() -> Result<()>,
    ) -> Result<Vec<u8>> {
        let end = Instant::now() + Duration::from_millis(1500);
        let mut ignored = 0u32;
        while Instant::now() < end {
            check()?;
            if let Some(frame) = self.pending.pop_front() {
                // A ROM C5 acknowledgement may arrive just after the program
                // starts. It is not a stub success or an identity response.
                if allow_boot_ack && (frame == [0xC5, 0x00] || frame == [0xC5, 0xE0]) {
                    ignored += 1;
                    self.count("ignoredBootAcks", 1);
                    if ignored > 2 {
                        return Err(probe_err("Unexpected repeated ROM boot acknowledgements."));
                    }
                    continue;
                }
                return Ok(frame);
            }
            let mut chunk = [0u8; 128];
            let n = self.port.read(&mut chunk).map_err(FlashError::from)?;
            if n > 0 {
                let data = &chunk[..n];
                self.count("receivedBytes", n as u64);
                self.count("receiveChunks", 1);
                self.count(
                    "slipDelimiters",
                    data.iter().fold(0u64, |n, &b| n + u64::from(b == 0xC0)),
                );
                self.count(
                    "slipEscapeMarkers",
                    data.iter().fold(0u64, |n, &b| n + u64::from(b == 0xDB)),
                );
                match self.decoder.feed(data) {
                    Ok(frames) => {
                        self.count("decodedFrames", frames.len() as u64);
                        self.pending.extend(frames);
                    }
                    Err(e) => {
                        self.count("slipErrors", 1);
                        return Err(e);
                    }
                }
            }
        }
        Err(probe_err(
            "RAM identity transport timed out; capacity remains unverified.",
        ))
    }

    pub fn acknowledge(
        &mut self,
        packet: &[u8],
        operation: u8,
        allow_boot_ack: bool,
        check: &mut dyn FnMut() -> Result<()>,
    ) -> Result<()> {
        self.send(packet, check)?;
        let frame = self.receive(allow_boot_ack, check)?;
        codec::validate_ack(&frame, operation)
    }
}

/// The `try` body of `probe()`; `stage`/`diag` mirror the Python locals so
/// the `except` path can annotate with current state.
#[allow(clippy::too_many_arguments)]
fn probe_body(
    conn: &mut dyn Transport,
    image: &[u8],
    port: &str,
    bounded: &mut dyn FnMut() -> Result<()>,
    log: &mut dyn FnMut(&str),
    nonce: &str,
    session: &str,
    stage: &mut Map<String, Value>,
    diag: &mut Option<Map<String, Value>>,
) -> Result<Value> {
    conn.set_dtr(false)
        .and_then(|()| conn.set_rts(false))
        .map_err(FlashError::from)?;
    *stage = Map::new();
    stage.insert("stage".to_string(), json!("reset-isp"));
    reset_isp(conn, bounded)?;
    let mut lk = Link::new(conn);
    lk.clear();
    log(
        "RAM identity: ROM handshake at 115200 baud; only fixed SRAM upload/boot commands are permitted.",
    );
    for attempt in 0..3u32 {
        *stage = Map::new();
        stage.insert("stage".to_string(), json!("C2-handshake"));
        stage.insert("attempt".to_string(), json!(attempt + 1));
        lk.reset_diagnostics();
        match lk.acknowledge(&codec::rom_nop_request(), 0xC2, false, bounded) {
            Ok(()) => break,
            Err(e) => {
                *diag = Some(lk.diagnostics());
                if !e.is_probe_reportable() || attempt == 2 {
                    return Err(e);
                }
                lk.clear();
            }
        }
    }
    for packet in codec::rom_upload_packets(image)? {
        // A failed write/ACK never advances to C5 or executes a partial
        // image. No generic command or target address is accepted.
        let address = u32::from_le_bytes([packet[8], packet[9], packet[10], packet[11]]);
        *stage = Map::new();
        stage.insert("stage".to_string(), json!("C3-upload"));
        stage.insert(
            "sramOffset".to_string(),
            json!(address.wrapping_sub(codec::RAM_ENTRY)),
        );
        stage.insert("sramAddress".to_string(), json!(address));
        lk.reset_diagnostics();
        if let Err(e) = lk.acknowledge(&packet, 0xC3, false, bounded) {
            *diag = Some(lk.diagnostics());
            return Err(e);
        }
    }
    *stage = Map::new();
    stage.insert("stage".to_string(), json!("C5-boot"));
    lk.reset_diagnostics();
    if let Err(e) = lk.send(&codec::rom_boot_request(), bounded) {
        *diag = Some(lk.diagnostics());
        return Err(e);
    }
    pause(Duration::from_millis(50), bounded)?;
    lk.clear();
    *stage = Map::new();
    stage.insert("stage".to_string(), json!("D2-nop"));
    lk.reset_diagnostics();
    if let Err(e) = lk.acknowledge(&codec::stub_request(0xD2)?, 0xD2, true, bounded) {
        *diag = Some(lk.diagnostics());
        return Err(e);
    }
    *stage = Map::new();
    stage.insert("stage".to_string(), json!("D7-init"));
    lk.reset_diagnostics();
    if let Err(e) = lk.acknowledge(&codec::stub_request(0xD7)?, 0xD7, false, bounded) {
        *diag = Some(lk.diagnostics());
        return Err(e);
    }
    let mut identities = Vec::new();
    for read_number in 0..2u32 {
        *stage = Map::new();
        stage.insert("stage".to_string(), json!("DE-identity"));
        stage.insert("read".to_string(), json!(read_number + 1));
        lk.reset_diagnostics();
        if let Err(e) = lk.send(&codec::stub_request(0xDE)?, bounded) {
            *diag = Some(lk.diagnostics());
            return Err(e);
        }
        let frame = match lk.receive(false, bounded) {
            Ok(f) => f,
            Err(e) => {
                *diag = Some(lk.diagnostics());
                return Err(e);
            }
        };
        match codec::parse_jedec_response(&frame) {
            Ok(identity) => identities.push(identity),
            Err(e) => {
                *diag = Some(lk.diagnostics());
                return Err(e);
            }
        }
    }
    if identities[0] != identities[1] {
        *diag = Some(lk.diagnostics());
        return Err(probe_err(
            "Repeated current JEDEC reads disagree; capacity remains unverified.",
        ));
    }
    let mut result = identities[0].as_object().cloned().unwrap_or_default();
    result.insert("verified".to_string(), json!(true));
    result.insert("probePort".to_string(), json!(port));
    result.insert("requestNonce".to_string(), json!(nonce));
    result.insert("sessionBeforeProbe".to_string(), json!(session));
    result.insert("stubSha256".to_string(), json!(STUB_SHA256));
    result.insert("stubBytes".to_string(), json!(STUB_SIZE));
    result.insert(
        "source".to_string(),
        json!("source-built-kendryte-sdk-v0.5.6"),
    );
    result.insert("protocol".to_string(), json!("ktool-DE-fixed27-readonly"));
    result.insert(
        "readAt".to_string(),
        json!(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        ),
    );
    result.insert(
        "legacy90Check".to_string(),
        json!("enforced internally by the fixed RAM reader; raw bytes not returned"),
    );
    log(
        "RAM identity: two CRC-checked, allowlisted current JEDEC responses agree. Returning to the installed firmware.",
    );
    Ok(Value::Object(result))
}

/// `probe(port, check=, log=, nonce=, session=)` — caller owns the PortLock
/// and supplies `open_port` (serial open at 115200/50 ms, exclusive). The
/// transport is closed on every exit path like `connection.close()` in the
/// Python `finally`.
pub fn probe(
    open_port: impl FnOnce(&str) -> io::Result<Box<dyn Transport>>,
    port: &str,
    image: Vec<u8>,
    check: &mut dyn FnMut() -> Result<()>,
    log: &mut dyn FnMut(&str),
    nonce: Option<&str>,
    session: Option<&str>,
) -> Result<Value> {
    if port.is_empty() || port.contains("://") {
        return Err(probe_err("A local worker-owned serial port is required."));
    }
    if nonce.is_none_or(|n| n.len() != 32) || session.is_none_or(|s| s.is_empty()) {
        return Err(probe_err(
            "A fresh worker request and source session are required.",
        ));
    }
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut bounded = move || -> Result<()> {
        check()?;
        if Instant::now() > deadline {
            return Err(probe_err(
                "RAM identity operation exceeded its fixed time bound.",
            ));
        }
        Ok(())
    };

    let mut stage = Map::new();
    stage.insert("stage".to_string(), json!("serial-open"));
    let mut diag: Option<Map<String, Value>> = None;
    let mut opened = false;
    let mut connection: Option<Box<dyn Transport>> = None;

    let mut result = (|| -> Result<Value> {
        let mut conn = open_port(port).map_err(|e| FlashError::device(e.to_string()))?;
        opened = true;
        let r = probe_body(
            conn.as_mut(),
            &image,
            port,
            &mut bounded,
            log,
            nonce.unwrap_or(""),
            session.unwrap_or(""),
            &mut stage,
            &mut diag,
        );
        connection = Some(conn);
        r
    })();

    // `except (ProbeError, protocol.ProtocolError)` — annotate only those.
    if let Err(e) = result.as_mut() {
        if e.is_probe_reportable() {
            let mut metadata = stage.clone();
            if let Some(d) = diag.take() {
                for (k, v) in d {
                    metadata.insert(k, v);
                }
            }
            let packed = pyjson::dumps_sorted_compact(&Value::Object(metadata));
            e.set_message(format!("{} Failure metadata: {}", e.message(), packed));
        }
    }

    // `finally`: restore boot pins (even over an in-flight error — the
    // Python `raise ... from exc` in the nested try replaces it), then close.
    let close_result = if opened {
        connection
            .as_mut()
            .map_or(Ok(()), |conn| reset_boot(conn.as_mut()))
    } else {
        Ok(())
    };
    drop(connection); // connection.close()
    match close_result {
        Err(_) => Err(probe_err(
            "RAM reader exit could not restore the boot pins; reconnect recovery is required.",
        )),
        Ok(()) => result,
    }
}
