// SPDX-License-Identifier: MIT
// Ported from openmv-qt-creator@af179e44cddf396a5ab618792d71e9de5cc67032:
// src/plugins/openmv (MIT) and MaixPy-v1@d8901fd2272f000226f1c1037c1eb7c412b88e66:
// components/micropython/port/src/omv/ide_dbg.c (MIT).
// Source: openmv-qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv
// Source: MaixPy-v1 d8901fd2272f000226f1c1037c1eb7c412b88e66 components/micropython/port/src/omv/ide_dbg.c
//! MaixPy IDE binary protocol session (`USBDBG` commands over serial).
//!
//! Wire format: host→device header `[0x30, cmd, len:u32 LE]` plus an optional
//! payload; device→host replies are raw bytes of the length declared in the
//! request header (`IDE_DBG_MAX_PACKET` = 64 caps most replies).

use std::time::{Duration, Instant};

use nodu_repl::{Check, ReplError};
use nodu_serial::Transport;
use sha2::{Digest, Sha256};

/// Baud rate the board switches to once `repl.init(..., ide=True)` runs.
pub const BAUD: u32 = 1_500_000;

const CMD_HEADER: u8 = 0x30;
const CMD_SCRIPT_EXEC: u8 = 0x05;
const CMD_SCRIPT_STOP: u8 = 0x06;
const CMD_FILE_SAVE: u8 = 0x07;
const CMD_SYS_RESET: u8 = 0x0c;
const CMD_FB_ENABLE: u8 = 0x0d;
const CMD_FW_VERSION: u8 = 0x80;
const CMD_FRAME_SIZE: u8 = 0x81;
const CMD_FRAME_DUMP: u8 = 0x82;
const CMD_ARCH_STR: u8 = 0x83;
const CMD_SCRIPT_RUNNING: u8 = 0x87;
/// The original plugin's stall recovery (`READ_STALL_TIMEOUT = 1000`): when
/// a partially received reply stops making progress, a bare
/// `SCRIPT_RUNNING` header is written mid-reply. The firmware finishes the
/// pending payload first and appends this many reply bytes after it — the
/// host write is what flushes the serial bridge's held tail.
const SCRIPT_RUNNING_REPLY: usize = 4;
const STALL_BUDGET: Duration = Duration::from_millis(1000);
const CMD_FILE_SAVE_STATUS: u8 = 0x88;
const CMD_QUERY_STATUS: u8 = 0x8d;
const CMD_TX_LEN: u8 = 0x8e;
const CMD_TX_BUF: u8 = 0x8f;

const QUERY_ACK: [u8; 4] = [0xAA, 0xBB, 0xEE, 0xFF];
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_TX: usize = 2 * 1024 * 1024;
const MAX_FILENAME: usize = 512;
const MAX_FILE: usize = 2 * 1024 * 1024;
const MAX_FRAME_DIM: u32 = 2048;
const MAX_FRAME_PIXELS: u64 = 1_048_576;
const MAX_JPEG: usize = 2 * 1024 * 1024;
const WRITE_CHUNK: usize = 1024;
const WRITE_PACE: Duration = Duration::from_millis(1);
// Original openmvpluginserialport.cpp paces completed commands so the
// board/USB serial bridge can settle before the next transaction.
const COMMAND_PACE: Duration = Duration::from_millis(if cfg!(target_os = "macos") { 2 } else { 1 });
const READ_SLICE: Duration = Duration::from_millis(50);
const FILE_SAVE_TIMEOUT: Duration = Duration::from_secs(30);
const FILE_SAVE_POLL: Duration = Duration::from_millis(20);
const MAX_EXEC: usize = 256 * 1024;
const QUERY_TIMEOUT_CAP: Duration = Duration::from_millis(500);
const STOP_WAIT: Duration = Duration::from_secs(8);
const DESYNC: &str = "Command stream desynchronized mid-payload; close the port and reconnect.";

/// One decoded camera frame from `USBDBG_FRAME_DUMP`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub jpeg: Vec<u8>,
}

/// `FILE_SAVE` status codes returned by `USBDBG_FILE_SAVE_STATUS` (0x88).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileSaveStatus {
    Done,
    Receiving,
    Saving,
    NoMemory,
    OpenFailed,
    WriteFailed,
    ChecksumFailed,
    Internal,
}

impl FileSaveStatus {
    fn from(v: u32) -> Result<Self, ReplError> {
        Ok(match v {
            0 => Self::Done,
            1 => Self::Receiving,
            5 => Self::Saving,
            2 => Self::NoMemory,
            3 => Self::OpenFailed,
            4 => Self::WriteFailed,
            6 => Self::ChecksumFailed,
            100 => Self::Internal,
            other => {
                return Err(ReplError::protocol(format!(
                    "Unknown FILE_SAVE status code {other}."
                )));
            }
        })
    }

    fn describe(self) -> &'static str {
        match self {
            Self::NoMemory => "board reports insufficient memory",
            Self::OpenFailed => "board failed to open the file",
            Self::WriteFailed => "board failed to write the file",
            Self::ChecksumFailed => "checksum check failed on the board",
            Self::Internal => "board reports an internal error",
            _ => "unexpected file save state",
        }
    }
}

/// Blocking IDE-protocol session over an already-connected `Transport`.
#[allow(missing_debug_implementations)]
pub struct IdeSession<'a> {
    transport: &'a mut dyn Transport,
    check: Check,
    timeout: Duration,
    /// Recovery-poke interval for an incomplete reply
    /// (`-override_read_stall_timeout` overrides the 1 s default): once any
    /// reply bytes have arrived, a mid-reply `SCRIPT_RUNNING` recovery write
    /// goes out every interval until the reply completes — matching the
    /// original plugin, which does not re-arm on incoming bytes.
    /// `None` disables recovery (overall `timeout` only).
    stall_timeout: Option<Duration>,
    /// Recovery writes issued by the in-progress `read_opt`; resync uses it
    /// to bound how many poke replies may legitimately still be in flight.
    pokes: u32,
}

impl<'a> IdeSession<'a> {
    pub fn new(transport: &'a mut dyn Transport, check: Check, timeout: Duration) -> Self {
        Self {
            transport,
            check,
            timeout,
            stall_timeout: Some(STALL_BUDGET),
            pokes: 0,
        }
    }

    /// Builder: replace the recovery-poke interval. `None` disables recovery
    /// entirely — an incomplete reply then just waits out the overall
    /// `timeout` before failing closed.
    #[must_use]
    pub fn with_stall_timeout(mut self, stall: Option<Duration>) -> Self {
        self.stall_timeout = stall;
        self
    }

    /// Issue a device→host command (bit 7 set) and read exactly `length`
    /// reply bytes. A zero-byte timeout is a protocol error here; only
    /// `query_status` treats it as "IDE mode not entered".
    pub fn read_command(&mut self, cmd: u8, length: usize) -> Result<Vec<u8>, ReplError> {
        if cmd & 0x80 == 0 {
            return Err(ReplError::protocol(format!(
                "Command 0x{cmd:02x} is host-to-device, not a reply command."
            )));
        }
        if length > MAX_RESPONSE {
            return Err(ReplError::protocol(format!(
                "Reply length {length} exceeds the 2 MiB bound."
            )));
        }
        self.send_header(cmd, length as u32)?;
        self.read_opt(length, self.timeout)?.ok_or_else(|| {
            ReplError::protocol(format!("Timed out reading {length} IDE bytes (got 0)."))
        })
    }

    /// Issue a command whose header declares `declared_length` and then send
    /// `payload` bytes. The declared length may differ from the payload size
    /// (firmware `FB_ENABLE` reads an i16 that is not counted in the header).
    pub fn write_command(
        &mut self,
        cmd: u8,
        declared_length: u32,
        payload: &[u8],
    ) -> Result<(), ReplError> {
        if cmd & 0x80 != 0 {
            return Err(ReplError::protocol(format!(
                "Command 0x{cmd:02x} is a device reply, not host-to-device."
            )));
        }
        // FB_ENABLE declares 0 but still carries an i16 payload; every other
        // host command declares its exact payload length.
        let expected = if cmd == CMD_FB_ENABLE {
            0
        } else {
            payload.len() as u32
        };
        if declared_length != expected {
            return Err(ReplError::protocol(format!(
                "Command 0x{cmd:02x} declares {declared_length} bytes but payload is {}.",
                payload.len()
            )));
        }
        self.send_header(cmd, declared_length)?;
        // Pace writes for the CH340, one 1 KiB chunk per millisecond. Once the
        // header is on the wire any failure leaves the firmware expecting the
        // remaining payload bytes: report a desync, never a plain cancel.
        for chunk in payload.chunks(WRITE_CHUNK) {
            if (self.check)().is_err() {
                return Err(ReplError::protocol(DESYNC));
            }
            if self.transport.write_all(chunk).is_err() || self.transport.flush().is_err() {
                return Err(ReplError::protocol(DESYNC));
            }
            std::thread::sleep(WRITE_PACE);
        }
        std::thread::sleep(COMMAND_PACE);
        Ok(())
    }

    /// `USBDBG_QUERY_STATUS` (0x8d): 4-byte `AA BB EE FF` acknowledgement.
    /// `false` means the board produced zero bytes inside the capped window
    /// (firmware did not enter IDE mode); any actual reply other than the
    /// exact ack — including four zero bytes — is a protocol error.
    pub fn query_status(&mut self) -> Result<bool, ReplError> {
        self.send_header(CMD_QUERY_STATUS, 4)?;
        match self.read_opt(QUERY_ACK.len(), self.timeout.min(QUERY_TIMEOUT_CAP))? {
            None => Ok(false),
            Some(reply) if reply == QUERY_ACK => Ok(true),
            Some(reply) => Err(ReplError::protocol(format!(
                "Unexpected IDE query reply: {reply:02x?}."
            ))),
        }
    }

    /// `USBDBG_FW_VERSION` (0x80): three LE u32 (major, minor, patch). Also
    /// causes the firmware to remove `/flash/ide_mode.conf`.
    pub fn version(&mut self) -> Result<[u32; 3], ReplError> {
        let buf = self.read_command(CMD_FW_VERSION, 12)?;
        Ok([
            u32::from_le_bytes(take4(&buf, 0)?),
            u32::from_le_bytes(take4(&buf, 4)?),
            u32::from_le_bytes(take4(&buf, 8)?),
        ])
    }

    /// `USBDBG_ARCH_STR` (0x83): 64-byte NUL-padded architecture string.
    pub fn architecture(&mut self) -> Result<String, ReplError> {
        let buf = self.read_command(CMD_ARCH_STR, 64)?;
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        Ok(String::from_utf8_lossy(&buf[..end]).trim().to_string())
    }

    /// `USBDBG_SCRIPT_STOP` (0x06).
    pub fn stop(&mut self) -> Result<(), ReplError> {
        self.write_command(CMD_SCRIPT_STOP, 0, &[])
    }

    /// `USBDBG_SCRIPT_STOP` then poll `running` until the firmware reports
    /// stopped (bounded); error if the script is still running at deadline.
    pub fn stop_and_wait(&mut self, timeout: Duration) -> Result<(), ReplError> {
        self.stop()?;
        self.wait_stopped(timeout)
    }

    /// Poll `USBDBG_SCRIPT_RUNNING` until false or `timeout` elapses.
    pub fn wait_stopped(&mut self, timeout: Duration) -> Result<(), ReplError> {
        let deadline = Instant::now() + timeout;
        loop {
            (self.check)()?;
            if !self.running()? {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(ReplError::device(
                    "Board did not stop the running script within the deadline.",
                ));
            }
            std::thread::sleep(FILE_SAVE_POLL);
        }
    }

    /// `USBDBG_SCRIPT_RUNNING` (0x87): u32 LE bool.
    pub fn running(&mut self) -> Result<bool, ReplError> {
        let buf = self.read_command(CMD_SCRIPT_RUNNING, 4)?;
        Ok(u32::from_le_bytes(take4(&buf, 0)?) != 0)
    }

    /// `USBDBG_SCRIPT_EXEC` (0x05): script source as UTF-8.
    pub fn execute(&mut self, code: &[u8]) -> Result<(), ReplError> {
        if code.is_empty() || code.len() > MAX_EXEC {
            return Err(ReplError::device(
                "Script must be 1 byte to 256 KiB for IDE execution.",
            ));
        }
        self.write_command(CMD_SCRIPT_EXEC, code.len() as u32, code)
    }

    /// `USBDBG_TX_BUF_LEN` (0x8e) + `USBDBG_TX_BUF` (0x8f): pending stdout.
    pub fn output(&mut self) -> Result<Vec<u8>, ReplError> {
        let len_buf = self.read_command(CMD_TX_LEN, 4)?;
        let len = u32::from_le_bytes(take4(&len_buf, 0)?) as usize;
        if len == 0 {
            return Ok(Vec::new());
        }
        if len > MAX_TX {
            return Err(ReplError::protocol(format!(
                "TX buffer length {len} exceeds the 2 MiB bound."
            )));
        }
        self.read_command(CMD_TX_BUF, len)
    }

    /// `USBDBG_FB_ENABLE` (0x0d): header declares length 0 followed by an
    /// i16 LE payload (firmware `ide_dbg.c` reads it outside the length field).
    pub fn framebuffer(&mut self, enabled: bool) -> Result<(), ReplError> {
        let flag: i16 = i16::from(enabled);
        self.write_command(CMD_FB_ENABLE, 0, &flag.to_le_bytes())
    }

    /// `USBDBG_FRAME_SIZE` (0x81) + `USBDBG_FRAME_DUMP` (0x82).
    ///
    /// Returns `None` when the reported width is zero: firmware then leaves
    /// the other header fields stale; they are ignored per the original host.
    /// A valid frame locks the framebuffer until it is dumped (or FB is
    /// disabled); invalid headers disable FB to release that lock.
    pub fn frame(&mut self) -> Result<Option<Frame>, ReplError> {
        // Write failures still propagate directly: a dead TX side is an
        // unrecoverable desync no probe can fix.
        self.send_header(CMD_FRAME_SIZE, 12)?;
        let header = match self.read_opt(12, self.timeout.min(FRAME_READ_BUDGET)) {
            Ok(Some(h)) => h,
            Ok(None) => {
                return self.frame_resync(ReplError::protocol(
                    "Timed out reading 12 frame-size bytes (got 0).",
                ));
            }
            Err(e) => return self.frame_resync(e),
        };
        let width = u32::from_le_bytes(take4(&header, 0)?);
        let height = u32::from_le_bytes(take4(&header, 4)?);
        let jpeg_len = u32::from_le_bytes(take4(&header, 8)?) as usize;
        if width == 0 {
            return Ok(None);
        }
        let valid = height > 0
            && width <= MAX_FRAME_DIM
            && height <= MAX_FRAME_DIM
            && u64::from(width) * u64::from(height) <= MAX_FRAME_PIXELS
            && (4..=MAX_JPEG).contains(&jpeg_len);
        if !valid {
            // Release the framebuffer lock held by the bogus size report.
            let _ = self.framebuffer(false);
            return Err(ReplError::protocol(format!(
                "Invalid frame header: {width}x{height}, {jpeg_len} JPEG bytes."
            )));
        }
        // A zero-byte dump timeout means the firmware may still send the
        // frame later; writing FB-disable now could desync the stream, so
        // any read failure first goes through `frame_resync`: a verified
        // clean channel drops this frame instead of killing the session.
        self.send_header(CMD_FRAME_DUMP, jpeg_len as u32)?;
        let jpeg = match self.read_opt(jpeg_len, self.timeout.min(FRAME_READ_BUDGET)) {
            Ok(Some(j)) => j,
            Ok(None) => {
                return self.frame_resync(ReplError::protocol(format!(
                    "Timed out reading {jpeg_len} frame bytes (got 0)."
                )));
            }
            Err(e) => return self.frame_resync(e),
        };
        let jpeg_ok = jpeg.starts_with(&[0xff, 0xd8])
            && jpeg.ends_with(&[0xff, 0xd9])
            && jpeg_dimensions(&jpeg).is_some_and(|(w, h)| w == width && h == height);
        if !jpeg_ok {
            // Payload consumed in full: stream stays synchronized, lock
            // release is safe to attempt.
            let _ = self.framebuffer(false);
            return Err(ReplError::protocol(
                "Frame payload is not a complete JPEG matching its header.",
            ));
        }
        Ok(Some(Frame {
            width,
            height,
            jpeg,
        }))
    }

    /// `USBDBG_FILE_SAVE` (0x07) + status polling (0x88).
    ///
    /// Payload: `[sha256(following bytes)][filename NUL, padded to 4][data]`.
    pub fn save_file(&mut self, name: &str, data: &[u8]) -> Result<(), ReplError> {
        if name.is_empty() {
            return Err(ReplError::device("File name must not be empty."));
        }
        if name.len() > MAX_FILENAME {
            return Err(ReplError::device("File name exceeds 512 bytes."));
        }
        if name.contains('\0') || name.contains('\\') || name.contains("..") {
            return Err(ReplError::device(
                "File name must not contain NUL, backslash or '..'.",
            ));
        }
        if data.len() > MAX_FILE {
            return Err(ReplError::device("File data exceeds the 2 MiB bound."));
        }
        // FILE_SAVE runs while scripts are stopped; wait for the firmware
        // to actually unwind before sending the payload.
        self.stop_and_wait(STOP_WAIT)?;
        let name_len = (name.len() + 1 + 3) & !3; // NUL + pad to 4
        let mut payload = Vec::with_capacity(32 + name_len + data.len());
        payload.extend_from_slice(&[0u8; 32]);
        let mut padded = name.as_bytes().to_vec();
        padded.resize(name_len, 0);
        payload.extend_from_slice(&padded);
        payload.extend_from_slice(data);
        let digest = Sha256::digest(&payload[32..]);
        payload[..32].copy_from_slice(&digest);
        self.write_command(CMD_FILE_SAVE, payload.len() as u32, &payload)?;

        let deadline = Instant::now() + FILE_SAVE_TIMEOUT;
        loop {
            (self.check)()?;
            let buf = self.read_command(CMD_FILE_SAVE_STATUS, 4)?;
            match FileSaveStatus::from(u32::from_le_bytes(take4(&buf, 0)?))? {
                FileSaveStatus::Done => return Ok(()),
                FileSaveStatus::Receiving | FileSaveStatus::Saving => {
                    if Instant::now() >= deadline {
                        return Err(ReplError::device(
                            "Timed out waiting for the board to save the file.",
                        ));
                    }
                    std::thread::sleep(FILE_SAVE_POLL);
                }
                other => {
                    return Err(ReplError::device(format!(
                        "FILE_SAVE failed: {}.",
                        other.describe()
                    )));
                }
            }
        }
    }

    /// `USBDBG_SYS_RESET` (0x0c).
    pub fn reset(&mut self) -> Result<(), ReplError> {
        self.write_command(CMD_SYS_RESET, 0, &[])
    }

    fn send_header(&mut self, cmd: u8, declared_length: u32) -> Result<(), ReplError> {
        (self.check)()?;
        let mut header = [0u8; 6];
        header[0] = CMD_HEADER;
        header[1] = cmd;
        header[2..].copy_from_slice(&declared_length.to_le_bytes());
        // A failed header write may have emitted partial command bytes:
        // the stream is desynchronized and must be closed, not reused.
        self.transport
            .write_all(&header)
            .map_err(|e| ReplError::protocol(format!("{DESYNC}: {e}")))?;
        self.transport
            .flush()
            .map_err(|e| ReplError::protocol(format!("{DESYNC}: {e}")))
    }

    /// Read exactly `length` bytes within `timeout`. `Ok(None)` is only a
    /// clean zero-byte timeout; a reply that never completes is a protocol
    /// error because the stream can no longer be resynchronized safely.
    fn read_opt(&mut self, length: usize, timeout: Duration) -> Result<Option<Vec<u8>>, ReplError> {
        if length > MAX_RESPONSE {
            return Err(ReplError::protocol(format!(
                "Reply length {length} exceeds the 2 MiB bound."
            )));
        }
        // `out` may grow past `length`: every recovery poke adds a
        // SCRIPT_RUNNING reply whose 4 bytes arrive appended after the
        // payload we still owe. Only the first `length` bytes are returned.
        let mut out = vec![0u8; length];
        let mut expected = length;
        let mut got = 0usize;
        self.pokes = 0;
        let deadline = Instant::now() + timeout;
        // Stall tracking only matters once the reply has started: a zero-byte
        // wait keeps using the overall timeout (the firmware may simply be
        // idle or not in IDE mode — never write into that stream).
        // The original does NOT restart this timer on arriving bytes: while
        // the reply is incomplete it pokes once per second regardless, which
        // also covers a tail that dribbles in too slowly to ever finish.
        let mut last_poke = Instant::now();
        while got < expected {
            // The request header was already sent, so a cancelled check or
            // a dead read leaves the stream position unknown — desync.
            (self.check)().map_err(|e| {
                ReplError::protocol(format!(
                    "{DESYNC}: {e} (received {got}/{expected} IDE bytes)"
                ))
            })?;
            if got > 0
                && let Some(stall) = self.stall_timeout
                && last_poke.elapsed() >= stall
            {
                // Same recovery as the original plugin: a mid-reply
                // SCRIPT_RUNNING header write wakes the firmware's USB task
                // so the held tail flushes; expect its 4-byte answer after
                // the pending payload and restart the poke timer.
                self.send_header(CMD_SCRIPT_RUNNING, SCRIPT_RUNNING_REPLY as u32)
                    .map_err(|e| {
                        ReplError::protocol(format!(
                            "{DESYNC}: {e} (recovery write after {got}/{expected} IDE bytes)"
                        ))
                    })?;
                expected += SCRIPT_RUNNING_REPLY;
                out.resize(expected, 0);
                self.pokes += 1;
                last_poke = Instant::now();
                eprintln!(
                    "IDE reply recovery poke #{} (received {got}/{expected} bytes)",
                    self.pokes
                );
                continue;
            }
            if Instant::now() >= deadline {
                return if got == 0 {
                    Ok(None)
                } else {
                    Err(ReplError::protocol(format!(
                        "Timed out reading {expected} IDE bytes (got {got}, {} recovery writes).",
                        self.pokes
                    )))
                };
            }
            let want = (expected - got).min(4096);
            match self.transport.read(&mut out[got..got + want]) {
                Ok(0) => std::thread::sleep(READ_SLICE.min(Duration::from_millis(5))),
                Ok(n) => got += n,
                Err(e) => return Err(ReplError::protocol(format!("{DESYNC}: {e}"))),
            }
        }
        std::thread::sleep(COMMAND_PACE);
        out.truncate(length);
        Ok(Some(out))
    }

    /// Frame payload never completed: verify the wire is clean, then drop
    /// this frame instead of tearing down the connection — the original
    /// plugin likewise hands its caller a truncated buffer rather than
    /// disconnecting; we additionally prove resynchronization first.
    /// Only frame reads get this grace: a truncated CONTROL reply still
    /// fails closed since its contents carry real protocol meaning.
    fn frame_resync(&mut self, e: ReplError) -> Result<Option<Frame>, ReplError> {
        if self.resync() {
            eprintln!("Dropped an incomplete frame reply ({e}); stream verified synchronized.");
            return Ok(None);
        }
        Err(e)
    }

    /// After an incomplete frame reply, prove the firmware has nothing left
    /// in flight so the stream is safe to keep using. One poke answer may
    /// legitimately still land (bounded residue); anything beyond it means
    /// real misalignment. Then confirm the command channel still answers
    /// `SCRIPT_RUNNING` and goes quiet again.
    ///
    /// Deliberately bypasses `self.check`: the recovery runs after the
    /// caller's deadline/cancellation already fired, under its own bounded
    /// wall clock (~2.5 s worst case) — the same trade-off the original's
    /// blocking `waitForReadyRead` loop makes.
    fn resync(&mut self) -> bool {
        let mut scratch = [0u8; 4096];
        let mut tolerated = SCRIPT_RUNNING_REPLY;
        let drain_end = Instant::now() + Duration::from_millis(300);
        while Instant::now() < drain_end {
            match self.transport.read(&mut scratch) {
                Ok(0) => std::thread::sleep(Duration::from_millis(10)),
                Ok(n) => {
                    if n > tolerated {
                        return false;
                    }
                    tolerated -= n;
                }
                Err(_) => return false,
            }
        }
        // Liveness probe on the command channel: firmware answers
        // SCRIPT_RUNNING whether idle or running.
        let mut header = [0u8; 6];
        header[0] = CMD_HEADER;
        header[1] = CMD_SCRIPT_RUNNING;
        header[2..].copy_from_slice(&(SCRIPT_RUNNING_REPLY as u32).to_le_bytes());
        if self.transport.write_all(&header).is_err() || self.transport.flush().is_err() {
            return false;
        }
        let mut buf = [0u8; 4];
        let mut got = 0usize;
        let probe_end = Instant::now() + Duration::from_secs(2);
        while got < buf.len() && Instant::now() < probe_end {
            match self.transport.read(&mut buf[got..]) {
                Ok(0) => std::thread::sleep(Duration::from_millis(5)),
                Ok(n) => got += n,
                Err(_) => return false,
            }
        }
        if got != 4 || u32::from_le_bytes(buf) > 1 {
            return false;
        }
        // The clean answer arrived; the channel must now stay quiet —
        // a late payload tail arriving here is misalignment, not residue.
        std::thread::sleep(Duration::from_millis(50));
        matches!(self.transport.in_waiting(), Ok(0))
    }
}

/// Frame reads get an internal budget below the caller's operation window:
/// a healthy dump completes far under a second, so a read that burns 8 s is
/// already lost — and the slack leaves room for `resync` before the shared
/// deadline forces a desync teardown.
const FRAME_READ_BUDGET: Duration = Duration::from_secs(8);

/// Decode the JPEG SOF segment for pixel dimensions without decoding pixels.
fn jpeg_dimensions(jpeg: &[u8]) -> Option<(u32, u32)> {
    let mut decoder = jpeg_decoder::Decoder::new(std::io::Cursor::new(jpeg));
    decoder.read_info().ok()?;
    let info = decoder.info()?;
    Some((u32::from(info.width), u32::from(info.height)))
}

fn take4(buf: &[u8], at: usize) -> Result<[u8; 4], ReplError> {
    buf.get(at..at + 4)
        .and_then(|s| <[u8; 4]>::try_from(s).ok())
        .ok_or_else(|| ReplError::protocol("IDE reply shorter than declared."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nodu_repl::never_cancel;
    use nodu_serial::MemoryTransport;
    use std::collections::VecDeque;
    use std::io;

    fn session(t: &mut MemoryTransport) -> IdeSession<'_> {
        IdeSession::new(t, never_cancel(), Duration::from_secs(2))
    }

    fn written(t: &MemoryTransport) -> Vec<u8> {
        t.written()
    }

    #[test]
    fn query_header_vector_and_ack() {
        let mut t = MemoryTransport::new();
        t.feed(&[0xAA, 0xBB, 0xEE, 0xFF]);
        assert!(session(&mut t).query_status().unwrap());
        assert_eq!(written(&t), vec![0x30, 0x8d, 4, 0, 0, 0]);
    }

    #[test]
    fn query_zero_is_not_ide_partial_is_error() {
        // Zero bytes arriving at all => false (firmware not in IDE mode).
        let mut t = MemoryTransport::new();
        let mut s = IdeSession::new(&mut t, never_cancel(), Duration::from_millis(30));
        assert!(!s.query_status().unwrap());
        // Four actual zero bytes are a received reply, not "no reply".
        let mut t = MemoryTransport::new();
        t.feed(&[0, 0, 0, 0]);
        assert!(session(&mut t).query_status().is_err());
        let mut t = MemoryTransport::new();
        t.feed(&[0xAA, 0xBB, 0xEE, 0x00]);
        assert!(session(&mut t).query_status().is_err());
    }

    /// Reply that stalls mid-payload, then completes — including its
    /// `SCRIPT_RUNNING` poke answers — once each recovery write lands.
    struct StallRecovery {
        head: VecDeque<u8>,
        pending: VecDeque<Vec<u8>>,
        written: Vec<u8>,
        pokes: u32,
    }

    impl StallRecovery {
        fn new(head: &[u8]) -> Self {
            Self {
                head: head.iter().copied().collect(),
                pending: VecDeque::new(),
                written: Vec::new(),
                pokes: 0,
            }
        }
    }

    impl nodu_serial::Transport for StallRecovery {
        fn in_waiting(&mut self) -> io::Result<usize> {
            Ok(self.head.len())
        }

        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let mut n = 0;
            while n < buf.len() {
                let Some(b) = self.head.pop_front() else {
                    break;
                };
                buf[n] = b;
                n += 1;
            }
            Ok(n)
        }

        fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
            self.written.extend_from_slice(buf);
            if buf == [0x30, CMD_SCRIPT_RUNNING, 4, 0, 0, 0] {
                self.pokes += 1;
                if let Some(chunk) = self.pending.pop_front() {
                    self.head.extend(chunk);
                }
            }
            Ok(())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
        fn reset_input_buffer(&mut self) -> io::Result<()> {
            Ok(())
        }
        fn set_baud_rate(&mut self, _baud: u32) -> io::Result<()> {
            Ok(())
        }
        fn unread(&mut self, data: &[u8]) {
            for &b in data.iter().rev() {
                self.head.push_front(b);
            }
        }
        fn set_dtr(&mut self, _level: bool) -> io::Result<()> {
            Ok(())
        }
        fn set_rts(&mut self, _level: bool) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn stalled_reply_recovers_via_script_running_poke() {
        // Original-plugin semantics: reply starts (2 of 8), stalls; the
        // recovery write flushes the tail plus a 4-byte running answer.
        // Firmware semantics: the poke write flushes the held payload tail,
        // then appends its own 4-byte running answer — all in one burst.
        let mut t = StallRecovery::new(&[0x01, 0x02]);
        t.pending
            .push_back(vec![0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 1, 0, 0, 0]);
        let mut s = IdeSession::new(&mut t, never_cancel(), Duration::from_secs(10))
            .with_stall_timeout(Some(Duration::from_millis(30)));
        let reply = s.read_command(0x80, 8).unwrap();
        assert_eq!(reply, vec![1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(t.pokes, 1);
        // Stream is back in sync: the poke reply was consumed, not left over.
    }

    #[test]
    fn repeated_stalls_poke_until_overall_timeout() {
        // Tail never arrives: each stall budget emits one poke until the
        // overall deadline fails closed with the poke count in the error.
        let mut t = StallRecovery::new(&[0x01, 0x02]);
        let mut s = IdeSession::new(&mut t, never_cancel(), Duration::from_millis(220))
            .with_stall_timeout(Some(Duration::from_millis(40)));
        let err = s
            .read_command(0x80, 8)
            .expect_err("unrecovered stall errors");
        assert!(err.is_protocol(), "{err:?}");
        assert!(err.to_string().contains("recovery writes"), "{err}");
        assert!(t.pokes >= 2, "pokes: {}", t.pokes);
    }

    #[test]
    fn zero_byte_reply_never_pokes() {
        // A reply that never starts stays a clean overall timeout — the
        // recovery write must not fire into a possibly non-IDE stream.
        let mut t = StallRecovery::new(&[]);
        let mut s = IdeSession::new(&mut t, never_cancel(), Duration::from_millis(120))
            .with_stall_timeout(Some(Duration::from_millis(20)));
        assert!(s.read_command(0x80, 8).is_err());
        assert_eq!(t.pokes, 0);
    }

    #[test]
    fn stalled_recovery_write_failure_is_desync() {
        // A poke that cannot even be written leaves stream state unknown.
        struct DeadWrite(StallRecovery);
        impl nodu_serial::Transport for DeadWrite {
            fn in_waiting(&mut self) -> io::Result<usize> {
                self.0.in_waiting()
            }
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                self.0.read(buf)
            }
            fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
                // The request header itself still works; only a recovery
                // poke write dies with the port gone mid-reply.
                if buf == [0x30, CMD_SCRIPT_RUNNING, 4, 0, 0, 0] {
                    return Err(io::Error::new(io::ErrorKind::BrokenPipe, "port gone"));
                }
                self.0.write_all(buf)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
            fn reset_input_buffer(&mut self) -> io::Result<()> {
                Ok(())
            }
            fn set_baud_rate(&mut self, _b: u32) -> io::Result<()> {
                Ok(())
            }
            fn unread(&mut self, data: &[u8]) {
                self.0.unread(data);
            }
            fn set_dtr(&mut self, _l: bool) -> io::Result<()> {
                Ok(())
            }
            fn set_rts(&mut self, _l: bool) -> io::Result<()> {
                Ok(())
            }
        }
        let mut t = DeadWrite(StallRecovery::new(&[0x01, 0x02]));
        let mut s = IdeSession::new(&mut t, never_cancel(), Duration::from_secs(10))
            .with_stall_timeout(Some(Duration::from_millis(20)));
        let err = s.read_command(0x80, 8).expect_err("dead poke errors");
        assert!(err.is_protocol(), "{err:?}");
        assert!(err.to_string().contains("recovery write"), "{err}");
    }

    #[test]
    fn overall_timeout_without_stall_recovery() {
        // Disabled stall handling keeps the historical behaviour: a partial
        // reply simply waits for the overall deadline, no poke is written.
        let mut t = MemoryTransport::new();
        t.feed(&[0x01, 0x02]);
        let mut s = IdeSession::new(&mut t, never_cancel(), Duration::from_millis(120))
            .with_stall_timeout(None);
        let err = s.read_command(0x80, 8).expect_err("overall timeout");
        assert!(err.to_string().contains("Timed out"), "{err}");
    }

    #[test]
    fn fb_enable_declares_zero_and_sends_i16() {
        let mut t = MemoryTransport::new();
        session(&mut t).framebuffer(true).unwrap();
        assert_eq!(written(&t), vec![0x30, 0x0d, 0, 0, 0, 0, 1, 0]);
    }

    #[test]
    fn byte_split_reads_reassemble() {
        let mut t = MemoryTransport::new();
        // Feed version reply one byte at a time via separate feed calls.
        let mut v = Vec::new();
        for u in [0u32, 6, 3] {
            v.extend_from_slice(&u.to_le_bytes());
        }
        for b in &v {
            t.feed(&[*b]);
        }
        assert_eq!(session(&mut t).version().unwrap(), [0, 6, 3]);
    }

    #[test]
    fn truncated_reply_times_out() {
        let mut t = MemoryTransport::new();
        t.feed(&[0xAA, 0xBB]); // 2 of 4 bytes
        let mut s = IdeSession::new(&mut t, never_cancel(), Duration::from_millis(30));
        assert!(s.query_status().is_err());
    }

    #[test]
    fn tx_oversize_rejected_before_request() {
        let mut t = MemoryTransport::new();
        t.feed(&u32::MAX.to_le_bytes()); // TX_LEN reply
        let mut s = session(&mut t);
        assert!(s.output().is_err());
        // The oversized TX_BUF command must NOT be issued.
        assert_eq!(written(&t), vec![0x30, 0x8e, 4, 0, 0, 0]);
    }

    #[test]
    fn no_frame_ignores_stale_fields() {
        let mut t = MemoryTransport::new();
        let mut hdr = Vec::new();
        for v in [0u32, 240, 999999] {
            hdr.extend_from_slice(&v.to_le_bytes());
        }
        t.feed(&hdr);
        assert_eq!(session(&mut t).frame().unwrap(), None);
    }

    #[test]
    fn invalid_frame_header_disables_fb() {
        let mut t = MemoryTransport::new();
        let mut hdr = Vec::new();
        for v in [100u32, 100, 10u32 * 1024 * 1024] {
            hdr.extend_from_slice(&v.to_le_bytes());
        }
        t.feed(&hdr);
        assert!(session(&mut t).frame().is_err());
        // Lock released via FB_ENABLE(false): [0x30,0x0d,0...,0,0] + i16 0.
        assert!(written(&t).ends_with(&[0x30, 0x0d, 0, 0, 0, 0, 0, 0]));
    }

    #[test]
    fn valid_frame_round_trip() {
        let jpeg: &[u8] = include_bytes!("../tests/fixtures/frame-4x4.jpg");
        let mut t = MemoryTransport::new();
        let mut feed = Vec::new();
        for v in [4u32, 4, jpeg.len() as u32] {
            feed.extend_from_slice(&v.to_le_bytes());
        }
        feed.extend_from_slice(jpeg);
        t.feed(&feed);
        let f = session(&mut t).frame().unwrap().unwrap();
        assert_eq!((f.width, f.height), (4, 4));
        assert_eq!(f.jpeg, jpeg);
        assert_eq!(written(&t)[..6], [0x30, 0x81, 12, 0, 0, 0]);
    }

    #[test]
    fn frame_rejects_zero_height_and_bad_jpeg() {
        let jpeg: &[u8] = include_bytes!("../tests/fixtures/frame-4x4.jpg");
        // width set but height zero => invalid header.
        let mut t = MemoryTransport::new();
        let mut hdr = Vec::new();
        for v in [4u32, 0, jpeg.len() as u32] {
            hdr.extend_from_slice(&v.to_le_bytes());
        }
        t.feed(&hdr);
        assert!(session(&mut t).frame().is_err());
        assert!(written(&t).ends_with(&[0x30, 0x0d, 0, 0, 0, 0, 0, 0]));
        // JPEG whose own metadata does not match the header dims is rejected.
        let mut t = MemoryTransport::new();
        let mut feed = Vec::new();
        for v in [8u32, 8, jpeg.len() as u32] {
            feed.extend_from_slice(&v.to_le_bytes());
        }
        feed.extend_from_slice(jpeg);
        t.feed(&feed);
        assert!(session(&mut t).frame().is_err());
        // Synchronized after a fully consumed payload: FB disable attempted.
        assert!(written(&t).ends_with(&[0x30, 0x0d, 0, 0, 0, 0, 0, 0]));
    }

    /// A Transport that only yields `cap` bytes per read, exercising the
    /// fragment-reassembly loop for real.
    pub(crate) struct Fragmented<'a> {
        inner: &'a mut MemoryTransport,
        cap: usize,
    }
    impl Transport for Fragmented<'_> {
        fn in_waiting(&mut self) -> io::Result<usize> {
            self.inner.in_waiting()
        }
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let want = buf.len().min(self.cap);
            self.inner.read(&mut buf[..want])
        }
        fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
            self.inner.write_all(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.inner.flush()
        }
        fn reset_input_buffer(&mut self) -> io::Result<()> {
            self.inner.reset_input_buffer()
        }
        fn set_baud_rate(&mut self, baud: u32) -> io::Result<()> {
            self.inner.set_baud_rate(baud)
        }
        fn unread(&mut self, data: &[u8]) {
            self.inner.unread(data);
        }
        fn set_dtr(&mut self, level: bool) -> io::Result<()> {
            self.inner.set_dtr(level)
        }
        fn set_rts(&mut self, level: bool) -> io::Result<()> {
            self.inner.set_rts(level)
        }
    }

    #[test]
    fn fragmented_reads_reassemble_all_replies() {
        for cap in [1usize, 2] {
            let jpeg: &[u8] = include_bytes!("../tests/fixtures/frame-4x4.jpg");
            let mut t = MemoryTransport::new();
            let mut feed = Vec::new();
            for v in [0u32, 6, 3] {
                feed.extend_from_slice(&v.to_le_bytes());
            }
            for v in [4u32, 4, jpeg.len() as u32] {
                feed.extend_from_slice(&v.to_le_bytes());
            }
            feed.extend_from_slice(jpeg);
            t.feed(&feed);
            {
                let mut frag = Fragmented { inner: &mut t, cap };
                let mut sess = IdeSession::new(&mut frag, never_cancel(), Duration::from_secs(5));
                assert_eq!(sess.version().unwrap(), [0, 6, 3]);
                let f = sess.frame().unwrap().unwrap();
                assert_eq!((f.width, f.height), (4, 4));
                assert_eq!(f.jpeg, jpeg);
            }
        }
    }

    #[test]
    fn save_file_payload_layout_and_status() {
        let mut t = MemoryTransport::new();
        t.feed(&0u32.to_le_bytes()); // running = false
        t.feed(&0u32.to_le_bytes()); // status 0 = done
        let data = b"hello".to_vec();
        session(&mut t).save_file("test.py", &data).unwrap();
        let w = written(&t);
        // stop header, running query, then FILE_SAVE header + payload, then status.
        assert_eq!(&w[..6], &[0x30, 0x06, 0, 0, 0, 0]);
        assert_eq!(&w[6..12], &[0x30, 0x87, 4, 0, 0, 0]);
        let name_len = ("test.py".len() + 1 + 3) & !3;
        let payload_len = 32 + name_len + data.len();
        let hdr = &w[12..18];
        assert_eq!(hdr[..2], [0x30, 0x07]);
        assert_eq!(
            u32::from_le_bytes(hdr[2..6].try_into().unwrap()) as usize,
            payload_len
        );
        let payload = &w[18..18 + payload_len];
        // sha256(name+data) verification
        let mut body = Vec::new();
        body.extend_from_slice(b"test.py\0");
        body.extend_from_slice(&vec![0u8; name_len - 8]);
        body.extend_from_slice(&data);
        assert_eq!(&payload[..32], Sha256::digest(&body).as_slice());
        assert_eq!(&payload[32..32 + name_len], body[..name_len].as_ref());
        assert_eq!(&payload[32 + name_len..], data.as_slice());
    }

    #[test]
    fn save_file_rejects_bad_names_and_status_errors() {
        let mut t = MemoryTransport::new();
        let mut s = session(&mut t);
        for bad in ["", "a\\b", "../x", "a\0b"] {
            assert!(s.save_file(bad, b"x").is_err(), "{bad}");
        }
        // Status 3 (open fail) surfaces a specific error.
        let mut t = MemoryTransport::new();
        t.feed(&0u32.to_le_bytes()); // running = false
        t.feed(&3u32.to_le_bytes());
        let e = session(&mut t).save_file("x.py", b"x").unwrap_err();
        assert!(e.to_string().contains("open"), "{e}");
    }

    #[test]
    fn cancelled_during_upload() {
        let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let c = cancelled.clone();
        let check: Check = std::sync::Arc::new(move || {
            if c.load(std::sync::atomic::Ordering::SeqCst) {
                Err(ReplError::cancelled())
            } else {
                Ok(())
            }
        });
        let mut t = MemoryTransport::new();
        let mut s = IdeSession::new(&mut t, check, Duration::from_secs(1));
        cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
        let big = vec![7u8; 4096];
        assert!(s.execute(&big).is_err());
    }

    /// Counts payload writes so the cancel can fire between chunks.
    pub(crate) struct Counting<'a> {
        inner: &'a mut MemoryTransport,
        count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }
    impl Transport for Counting<'_> {
        fn in_waiting(&mut self) -> io::Result<usize> {
            self.inner.in_waiting()
        }
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.inner.read(buf)
        }
        fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
            // The 6-byte header is write #0; payload writes bump >=1.
            if !(buf.len() == 6 && buf[0] == 0x30) {
                self.count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            self.inner.write_all(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.inner.flush()
        }
        fn reset_input_buffer(&mut self) -> io::Result<()> {
            self.inner.reset_input_buffer()
        }
        fn set_baud_rate(&mut self, baud: u32) -> io::Result<()> {
            self.inner.set_baud_rate(baud)
        }
        fn unread(&mut self, data: &[u8]) {
            self.inner.unread(data);
        }
        fn set_dtr(&mut self, level: bool) -> io::Result<()> {
            self.inner.set_dtr(level)
        }
        fn set_rts(&mut self, level: bool) -> io::Result<()> {
            self.inner.set_rts(level)
        }
    }

    #[test]
    fn cancel_after_first_payload_chunk_is_desync() {
        // Cancellation that lands after the header + first chunk are on the
        // wire must surface as a protocol desync, not a plain cancel: the
        // firmware interprets any later bytes as remaining payload.
        let writes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let writes2 = writes.clone();
        let check: Check = std::sync::Arc::new(move || {
            if writes2.load(std::sync::atomic::Ordering::SeqCst) > 0 {
                Err(ReplError::cancelled())
            } else {
                Ok(())
            }
        });
        let mut transport = MemoryTransport::new();
        {
            let mut counting = Counting {
                inner: &mut transport,
                count: writes,
            };
            let mut sess = IdeSession::new(&mut counting, check, Duration::from_secs(1));
            let big = vec![7u8; 4096];
            let e = sess.execute(&big).unwrap_err();
            assert!(e.is_protocol(), "{e}");
        }
        let w = written(&transport);
        // Header + exactly one 1 KiB payload chunk; nothing else appended.
        assert_eq!(w.len(), 6 + 1024);
        assert_eq!(&w[..6], &[0x30, 0x05, 0x00, 0x10, 0x00, 0x00]);
    }

    #[test]
    fn command_direction_and_length_are_checked() {
        let mut t = MemoryTransport::new();
        let mut s = session(&mut t);
        // Reply-direction command on the write path.
        assert!(s.write_command(0x87, 0, &[]).is_err());
        // Host command on the read path.
        assert!(s.read_command(0x06, 4).is_err());
        // Declared length mismatch (non-FB) is rejected before writing.
        assert!(s.write_command(0x06, 4, &[]).is_err());
        // Empty or oversized scripts are rejected.
        assert!(s.execute(b"").is_err());
        assert!(s.execute(&vec![0u8; 257 * 1024]).is_err());
    }

    /// A transport whose `write_all` always fails partway.
    struct BrokenWrite;
    impl Transport for BrokenWrite {
        fn in_waiting(&mut self) -> io::Result<usize> {
            Ok(0)
        }
        fn read(&mut self, _buf: &mut [u8]) -> io::Result<usize> {
            Ok(0)
        }
        fn write_all(&mut self, _buf: &[u8]) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "test write failure",
            ))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
        fn reset_input_buffer(&mut self) -> io::Result<()> {
            Ok(())
        }
        fn set_baud_rate(&mut self, _baud: u32) -> io::Result<()> {
            Ok(())
        }
        fn unread(&mut self, _data: &[u8]) {}
        fn set_dtr(&mut self, _level: bool) -> io::Result<()> {
            Ok(())
        }
        fn set_rts(&mut self, _level: bool) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn zero_byte_reply_timeout_is_protocol() {
        // Ordinary read commands have no `None` escape: no reply after the
        // header was sent is a protocol error, never a skippable timeout.
        let mut t = MemoryTransport::new();
        let mut s = IdeSession::new(&mut t, never_cancel(), Duration::from_millis(30));
        let e = s.running().unwrap_err();
        assert!(e.is_protocol(), "{e}");
    }

    #[test]
    fn check_failure_after_partial_read_is_protocol() {
        // One reply byte arrived, then the caller deadline fires: post-header
        // cancellation is a desync — Protocol, not a clean Timeout/Cancelled.
        // Check calls: send_header (#0), read_opt pre-read (#1) — both pass —
        // then the byte is consumed and the next loop check (#2) fails.
        let mut t = MemoryTransport::new();
        t.feed(&[0xAA]);
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c2 = calls.clone();
        let check: Check = std::sync::Arc::new(move || {
            if c2.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 1 {
                Err(ReplError::timeout("test deadline"))
            } else {
                Ok(())
            }
        });
        let e = {
            let mut s = IdeSession::new(&mut t, check, Duration::from_secs(30));
            s.version().unwrap_err()
        };
        assert!(e.is_protocol(), "{e}");
        assert!(e.to_string().contains("received 1/12 IDE bytes"), "{e}");
        // The fed reply byte really was consumed before the failure fired.
        assert_eq!(t.in_waiting().unwrap(), 0);
    }

    #[test]
    fn completed_read_observes_original_command_pacing() {
        // The original plugin sleeps after every completed command; a fully
        // received reply must cost at least COMMAND_PACE.
        let mut t = MemoryTransport::new();
        let mut v = Vec::new();
        for u in [0u32, 6, 3] {
            v.extend_from_slice(&u.to_le_bytes());
        }
        t.feed(&v);
        let started = Instant::now();
        assert_eq!(session(&mut t).version().unwrap(), [0, 6, 3]);
        assert!(
            started.elapsed() >= COMMAND_PACE,
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn empty_write_observes_original_command_pacing() {
        // No-payload commands (STOP/RESET) observe the same pacing.
        let mut t = MemoryTransport::new();
        let started = Instant::now();
        session(&mut t).stop().unwrap();
        assert!(
            started.elapsed() >= COMMAND_PACE,
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn failed_header_write_is_protocol_desync() {
        // A header write that errors may have emitted partial bytes: the
        // stream is desynced, so this is Protocol, not a plain I/O error.
        let mut t = BrokenWrite;
        let mut s = IdeSession::new(&mut t, never_cancel(), Duration::from_millis(30));
        let e = s.stop().unwrap_err();
        assert!(e.is_protocol(), "{e}");
    }
}
