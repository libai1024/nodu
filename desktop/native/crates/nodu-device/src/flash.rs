// SPDX-License-Identifier: MIT
// Ported from k210-studio nodu_device_worker.py firmware orchestration (MIT).
// Source: k210-studio dc0aba3 desktop/scope-extension/resources/nodu_device_worker.py
// — do_prepareFirmware/do_backupDevice/do_flashFirmware and their helpers
// (_preserve_before_probe, _receive_backup, _receive_snapshot,
// _backup_inventory, remote hash readers, preservation-cache reuse).
//! Flash orchestration: session state, port locking and serial ownership
//! live here (the worker); protocol, framing and ZIP/JSON byte formats live
//! in `nodu-kflash` — the same split as the Python modules. Error classes
//! follow the Python worker: `FirmwareError`/`ProbeError` surface as device
//! errors at the JSON boundary; a `ProtocolError` keeps its class so the
//! stream-poisoned recovery path in `handle()` still applies.

use std::collections::VecDeque;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use nodu_kflash::error::FlashError;
use nodu_kflash::firmware::{
    self, BackupReceiver, CHUNK_BYTES, FLASH_BYTES, MAX_USER_FILE, WRITE_BYTES,
};
use nodu_kflash::{backup, probe};
use nodu_protocol::{DevicePhase, LogStream, ProgressInfo};
use nodu_repl::ReplError;
use nodu_repl::pyrepr::PyValue;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::{
    ConnMode, Event, SubmitState, Worker, err_device, now_millis, py_quote_str, remote_path,
};

type Result<T> = std::result::Result<T, ReplError>;

fn fw_into(e: FlashError) -> ReplError {
    e.into_repl()
}

fn fw_err(message: impl Into<String>) -> ReplError {
    FlashError::firmware(message).into_repl()
}

/// Worker-local session/nonce token; Python uses `uuid.uuid4().hex`.
pub(crate) fn new_token() -> String {
    format!(
        "{:016x}{:016x}",
        firmware::unique_suffix(),
        firmware::unique_suffix()
    )
}

/// `curl` download stream for `firmware::prepare` (Python `urlopen`).
/// `--speed-time/--speed-limit` bound per-read stalls like urlopen's
/// per-socket `timeout=20`; `--max-time` bounds the whole transfer.
struct CurlBody {
    child: Child,
    stdout: ChildStdout,
}

impl Read for CurlBody {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.stdout.read(buf)
    }
}

impl Drop for CurlBody {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn firmware_download() -> nodu_kflash::Result<Box<dyn Read>> {
    let mut child = Command::new("curl")
        .args([
            "-fsSL",
            "--connect-timeout",
            "20",
            "--speed-time",
            "20",
            "--speed-limit",
            "1",
            "--max-time",
            "300",
            firmware::URL,
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| FlashError::device(format!("curl download failed to start: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| FlashError::device("curl stdout unavailable"))?;
    Ok(Box::new(CurlBody { child, stdout }))
}

/// Emit a `state` event carrying a new `progress` field without borrowing
/// the whole worker (used inside transport-borrowed callback contexts —
/// mirrors Python `update(progress=...)` which emits a full snapshot).
struct ProgressSink {
    shared: Arc<SubmitState>,
    state: nodu_protocol::DeviceState,
    pub last: Option<ProgressInfo>,
}

impl ProgressSink {
    fn report(&mut self, stage: &str, completed: u64, total: u64) {
        let percent = if total != 0 {
            (completed.saturating_mul(100) / total).min(100) as u32
        } else {
            100
        };
        let info = ProgressInfo {
            stage: stage.to_string(),
            completed,
            total,
            percent,
        };
        let mut snapshot = self.state.clone();
        snapshot.progress = Some(info.clone());
        self.shared
            .emit(&serde_json::to_value(Event::State(snapshot)).unwrap_or_default());
        self.last = Some(info);
    }
}

/// Diagnostics/operation context accumulated by the backup pump; only
/// bounded protocol metadata is ever stored (never raw Base64, stderr text
/// or user bytes — same rule as Python).
struct PumpCtx {
    /// Framing stage — Python `stage = 'stdout'` then `'stderr'` after EOF.
    stage: &'static str,
    trace: VecDeque<Value>,
    last_line: Option<Value>,
    line_buffer: Vec<u8>,
    error_buffer: Vec<u8>,
    error_type: Option<&'static str>,
    cause_type: Option<&'static str>,
}

impl Default for PumpCtx {
    fn default() -> Self {
        Self {
            stage: "stdout",
            trace: VecDeque::new(),
            last_line: None,
            line_buffer: Vec::new(),
            error_buffer: Vec::new(),
            error_type: None,
            cause_type: None,
        }
    }
}

impl PumpCtx {
    fn trace_push(&mut self, entry: Value) {
        if self.trace.len() >= 32 {
            self.trace.pop_front();
        }
        self.trace.push_back(entry);
    }

    fn mark_error(&mut self, e: &FlashError) {
        self.error_type = Some(e.kind().type_name());
        self.cause_type = e.cause();
    }
}

impl Worker {
    /// `_progress(stage, completed, total)` direct-call variant.
    fn fw_progress(&mut self, stage: &str, completed: u64, total: u64) {
        let percent = if total != 0 {
            (completed.saturating_mul(100) / total).min(100) as u32
        } else {
            100
        };
        self.update(|s| {
            s.progress = Some(ProgressInfo {
                stage: stage.to_string(),
                completed,
                total,
                percent,
            });
        });
    }

    /// `self.check` reshaped for `nodu-kflash` callbacks (`FlashError`).
    /// Owned closure — does not borrow `self`.
    fn fw_check(&self) -> impl FnMut() -> nodu_kflash::Result<()> + use<> {
        let active = self.active_generation;
        let deadline = self.deadline;
        let shared = Arc::clone(&self.shared);
        move || {
            let result = if active != shared.generation.load(Ordering::SeqCst)
                || shared.input_closed.load(Ordering::SeqCst)
            {
                Err(ReplError::cancelled())
            } else if deadline.is_some_and(|d| Instant::now() > d) {
                Err(err_device("Device operation timed out."))
            } else {
                Ok(())
            };
            result.map_err(FlashError::from_repl)
        }
    }

    /// `self.log` as an owned `FnMut(&str)` for `nodu-kflash` callbacks.
    fn fw_log(&self) -> impl FnMut(&str) + use<> {
        let shared = Arc::clone(&self.shared);
        move |text: &str| {
            if !text.is_empty() {
                shared.emit(
                    &serde_json::to_value(Event::Log(nodu_protocol::DeviceLog {
                        text: text.to_string(),
                        stream: LogStream::Stdout,
                        time: now_millis(),
                    }))
                    .unwrap_or_default(),
                );
            }
        }
    }

    fn progress_sink(&self) -> ProgressSink {
        ProgressSink {
            shared: Arc::clone(&self.shared),
            state: self.state.clone(),
            last: None,
        }
    }

    /// `do_prepareFirmware`: verify/fetch the pinned image, keep its path.
    pub(crate) fn do_prepare_firmware(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.fw_progress("prepare", 0, firmware::SIZE);
        let cache_dir = args
            .get("cacheDir")
            .and_then(Value::as_str)
            .map(str::to_string);
        let source_file = args
            .get("sourceFile")
            .and_then(Value::as_str)
            .map(str::to_string);
        let mut check = self.fw_check();
        let mut log = self.fw_log();
        let prepared = firmware::prepare(
            cache_dir.as_deref(),
            source_file.as_deref(),
            &mut check,
            &mut log,
            firmware_download,
        )
        .map_err(fw_into)?;
        self.prepared_firmware = Some(prepared);
        self.fw_progress("prepare", firmware::SIZE, firmware::SIZE);
        Ok(firmware::plan())
    }

    /// `_start_raw`: upload `code` at the raw REPL prompt.
    fn start_raw(&mut self, code: &str) -> Result<()> {
        let result = self.session().exec_raw_no_follow(code.as_bytes());
        result.map_err(|e| match e {
            ReplError::Cancelled(_) => e,
            ReplError::Protocol(_) => {
                self.update(|s| s.phase = DevicePhase::Error);
                e
            }
            other => {
                self.update(|s| s.phase = DevicePhase::Error);
                let m = other.to_string();
                ReplError::protocol(if m.is_empty() {
                    "Serial code upload failed.".to_string()
                } else {
                    m
                })
            }
        })
    }

    /// `_receive_backup(destination, size, code, progress)` — stream the
    /// bounded `NODU_*` framing into a `BackupReceiver`; on failure write
    /// `<destination>.diagnostics.json` with bounded protocol metadata.
    fn receive_backup(
        &mut self,
        destination: &Path,
        size: u64,
        code: &str,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<String> {
        let mut receiver = BackupReceiver::new(destination, size).map_err(fw_into)?;
        let mut ctx = PumpCtx::default();
        let outcome = self.receive_backup_body(&mut receiver, &mut ctx, size, code, progress);
        // Python records receiver.received in diagnostics; capture before
        // `finish` consumes the receiver.
        let received = receiver.received();
        let outcome = outcome.and_then(|()| receiver.finish(progress).map_err(fw_into));
        if let Err(e) = &outcome
            && !e.is_cancelled()
        {
            let mut diag = Map::new();
            diag.insert("version".to_string(), json!(1));
            diag.insert("time".to_string(), json!(now_millis()));
            diag.insert("session".to_string(), json!(self.session_id));
            diag.insert("stage".to_string(), json!(ctx.stage));
            diag.insert("received".to_string(), json!(received));
            diag.insert("expected".to_string(), json!(size));
            diag.insert("baud".to_string(), json!(self.baud));
            diag.insert(
                "errorType".to_string(),
                json!(ctx.error_type.unwrap_or_else(|| repl_type_name(e))),
            );
            diag.insert(
                "causeType".to_string(),
                ctx.cause_type.map_or(Value::Null, |c| json!(c)),
            );
            diag.insert(
                "lastLine".to_string(),
                ctx.last_line.take().unwrap_or(Value::Null),
            );
            let buffered = if ctx.line_buffer.is_empty() {
                Value::Null
            } else {
                backup::frame_metadata(
                    &ctx.line_buffer,
                    (CHUNK_BYTES as u64).min(size.saturating_sub(received)) as usize,
                )
            };
            diag.insert("bufferedLine".to_string(), buffered);
            diag.insert("stderrBytes".to_string(), json!(ctx.error_buffer.len()));
            diag.insert(
                "trace".to_string(),
                Value::Array(ctx.trace.into_iter().collect()),
            );
            let side = PathBuf::from(format!("{}.diagnostics.json", destination.display()));
            let _ = firmware::write_json(&side, &Value::Object(diag));
        }
        outcome
    }

    /// The framed pump; returns Ok(()) once stdout EOF saw an empty stderr
    /// stream (Python `return receiver.finish()` — finish runs outside).
    fn receive_backup_body(
        &mut self,
        receiver: &mut BackupReceiver,
        ctx: &mut PumpCtx,
        size: u64,
        code: &str,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<()> {
        if self.mode == ConnMode::Ide {
            // IDE exec returns the whole stdout in one transaction; the
            // line-by-line framing/verification contract is unchanged.
            self.check()?;
            let out = match self.exec(code, false, Duration::from_secs(120)) {
                Ok(out) => out,
                // Python propagates cancellation and transport/protocol
                // failures unchanged; only device-side errors become
                // FirmwareError so desync still tears down the port.
                Err(e) if e.is_cancelled() || e.is_protocol() => return Err(e),
                Err(e) => return Err(fw_err(format!("Device backup failed: {e}"))),
            };
            for line in out.split('\n') {
                self.check()?;
                let stripped = line.strip_suffix('\r').unwrap_or(line);
                if stripped.is_empty() {
                    continue;
                }
                self.backup_line(receiver, ctx, stripped.as_bytes(), size, progress)?;
            }
            ctx.stage = "stderr";
            return Ok(());
        }
        self.check()?;
        self.start_raw(code)?;
        let mut last_data = Instant::now();
        loop {
            self.check()?;
            let data: Vec<u8> = {
                let serial = self
                    .transport
                    .as_mut()
                    .ok_or_else(|| err_device("Connect a K210 first."))?;
                let waiting = serial.in_waiting().map_err(|e| err_device(e.to_string()))?;
                let mut buf = vec![0u8; waiting.max(1).min(65536)];
                let n = serial
                    .read(&mut buf)
                    .map_err(|e| err_device(e.to_string()))?;
                buf.truncate(n);
                buf
            };
            if data.is_empty() {
                if last_data.elapsed() > Duration::from_secs(20) {
                    return Err(ReplError::protocol(
                        "Backup transfer timed out; incomplete data was retained and flashing is blocked.",
                    ));
                }
                continue;
            }
            last_data = Instant::now();
            ctx.trace_push(json!({
                "kind": "read",
                "bytes": data.len(),
                "lf": data.iter().filter(|&&b| b == b'\n').count(),
                "cr": data.iter().filter(|&&b| b == b'\r').count(),
                "eof": data.iter().filter(|&&b| b == 0x04).count(),
                "interrupt": data.iter().filter(|&&b| b == 0x03).count(),
            }));
            let mut rest: &[u8] = &data;
            while !rest.is_empty() {
                let (before, marker, after) = match rest.iter().position(|&b| b == 0x04) {
                    Some(i) => (&rest[..i], true, &rest[i + 1..]),
                    None => (rest, false, &rest[0..0]),
                };
                if ctx.stage == "stdout" {
                    ctx.line_buffer.extend_from_slice(before);
                    while let Some(pos) = ctx.line_buffer.iter().position(|&b| b == b'\n') {
                        let line: Vec<u8> = ctx.line_buffer.drain(..=pos).collect();
                        let line = &line[..line.len() - 1];
                        let stripped_len =
                            line.len() - line.iter().rev().take_while(|&&b| b == b'\r').count();
                        let stripped = &line[..stripped_len];
                        if !stripped.is_empty() {
                            let mut meta = backup::frame_metadata(
                                stripped,
                                (CHUNK_BYTES as u64).min(size.saturating_sub(receiver.received()))
                                    as usize,
                            );
                            meta.as_object_mut().unwrap().insert(
                                "trailingCR".to_string(),
                                json!(line.len() - stripped.len()),
                            );
                            ctx.last_line = Some(meta.clone());
                            ctx.trace_push(json!({
                                "kind": "line",
                                "bytes": line.len(),
                                "frameKind": meta.get("kind").cloned().unwrap_or(Value::Null),
                                "offset": meta.get("offset").cloned().unwrap_or(Value::Null),
                            }));
                            receiver.line(stripped, progress).map_err(|e| {
                                ctx.mark_error(&e);
                                fw_into(e)
                            })?;
                        }
                    }
                    if ctx.line_buffer.len() > 4200 {
                        return Err(fw_err("Backup line exceeded the bounded protocol size."));
                    }
                    if marker {
                        if !ctx.line_buffer.iter().all(|b| b.is_ascii_whitespace()) {
                            return Err(fw_err("Incomplete backup line before raw REPL EOF."));
                        }
                        ctx.stage = "stderr";
                    }
                } else {
                    ctx.error_buffer.extend_from_slice(before);
                    if ctx.error_buffer.len() > 8192 {
                        return Err(fw_err("Backup program failed with excessive diagnostics."));
                    }
                    if marker {
                        if let Some(serial) = self.transport.as_mut() {
                            serial.unread(after);
                        }
                        if !ctx.error_buffer.is_empty() {
                            let text = String::from_utf8_lossy(&ctx.error_buffer)
                                .trim()
                                .to_string();
                            return Err(fw_err(format!("Device backup failed: {text}")));
                        }
                        return Ok(());
                    }
                }
                if !marker {
                    break;
                }
                rest = after;
            }
        }
    }

    /// One stripped backup line through metadata + receiver (IDE path).
    fn backup_line(
        &mut self,
        receiver: &mut BackupReceiver,
        ctx: &mut PumpCtx,
        line: &[u8],
        size: u64,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<()> {
        let meta = backup::frame_metadata(
            line,
            (CHUNK_BYTES as u64).min(size.saturating_sub(receiver.received())) as usize,
        );
        ctx.last_line = Some(meta.clone());
        ctx.trace_push(json!({
            "kind": "line",
            "bytes": line.len(),
            "frameKind": meta.get("kind").cloned().unwrap_or(Value::Null),
            "offset": meta.get("offset").cloned().unwrap_or(Value::Null),
        }));
        receiver.line(line, progress).map_err(|e| {
            ctx.mark_error(&e);
            fw_into(e)
        })
    }

    /// `_fast_backup_serial` — keep the established REPL rate, then always
    /// restore baud + re-enter the raw REPL (bounded, never cancelled).
    fn with_fast_backup_serial<T>(
        &mut self,
        body: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        let original_baud = self.baud.max(1);
        self.log(
            &format!(
                "Backup keeps ordinary raw REPL at {original_baud} baud; bounded fill frames reduce uniform-block traffic."
            ),
            LogStream::Stdout,
        );
        let result = body(self);
        // Python `finally`: even cancellation must not prevent returning the
        // endpoint to the original baud and a fresh raw REPL.
        let old_deadline = self.deadline;
        self.deadline = Some(Instant::now() + Duration::from_secs(20));
        self.restoring_io = true;
        let mut restored = false;
        if self.mode == ConnMode::Raw && self.transport.is_some() {
            for _ in 0..3 {
                let attempt = (|this: &mut Self| -> Result<()> {
                    {
                        let serial = this.transport.as_mut().expect("transport");
                        serial
                            .set_baud_rate(original_baud)
                            .map_err(|e| err_device(e.to_string()))?;
                        serial
                            .reset_input_buffer()
                            .map_err(|e| err_device(e.to_string()))?;
                    }
                    this.baud = original_baud;
                    this.session().enter_raw_repl(Duration::from_secs(5))
                })(self);
                if attempt.is_ok() {
                    restored = true;
                    self.log(
                        &format!("Backup serial baud restored to {original_baud}."),
                        LogStream::Stdout,
                    );
                    break;
                }
            }
        } else {
            restored = true;
        }
        self.restoring_io = false;
        self.deadline = old_deadline;
        if !restored {
            self.update(|s| s.phase = DevicePhase::Error);
            return Err(err_device(
                "Backup stopped, but REPL baud recovery failed. Reconnect at 115200 or power-cycle; no flash was written.",
            ));
        }
        result
    }

    /// `_receive_snapshot(destination, size, remote_path, progress)` —
    /// assemble verified 64 KiB ranges, then independently hash the source.
    fn receive_snapshot(
        &mut self,
        destination: &Path,
        size: u64,
        remote: Option<&str>,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<String> {
        // Validate the complete range before creating any local output.
        firmware::dump_script(size, remote, 0).map_err(fw_into)?;
        let ranges = firmware::private_directory(
            &format!(
                "{}.ranges-{:016x}",
                destination.display(),
                firmware::unique_suffix()
            ),
            true,
        )
        .map_err(fw_into)?;
        let mut digest = Sha256::new();
        let mut failures = 0u32;
        let mut assembled = firmware::private_file(destination, true).map_err(fw_into)?;
        let total = size.max(1);
        for offset in (0..total).step_by(64 * 1024) {
            self.check()?;
            let length = (64 * 1024u64).min(size - offset);
            let code = firmware::dump_script(length, remote, offset).map_err(fw_into)?;
            let mut part_digest = None;
            let mut part = PathBuf::new();
            for attempt in 0..3u32 {
                self.check()?;
                part = ranges.join(format!("{offset:08x}-{attempt}.part"));
                match self.receive_backup(&part, length, &code, &mut |_, _| {}) {
                    Ok(d) => {
                        part_digest = Some(d);
                        break;
                    }
                    Err(e) if e.is_cancelled() => return Err(e),
                    Err(e) => {
                        failures += 1;
                        self.check()?;
                        if attempt == 2 || failures >= 12 {
                            return Err(e);
                        }
                        self.log(
                            &format!(
                                "Snapshot range 0x{offset:08x} failed verification; retry {}/2. Failed local bytes were retained.",
                                attempt + 1
                            ),
                            LogStream::Stdout,
                        );
                        if self.mode == ConnMode::Raw {
                            let serial = self
                                .transport
                                .as_mut()
                                .ok_or_else(|| err_device("Connect a K210 first."))?;
                            serial
                                .reset_input_buffer()
                                .map_err(|e| err_device(e.to_string()))?;
                            self.session().enter_raw_repl(Duration::from_secs(5))?;
                        }
                        self.check()?;
                        self.update(|s| s.phase = DevicePhase::Connected);
                    }
                }
            }
            let part_digest = part_digest.expect("part digest");
            let data = std::fs::read(&part).map_err(|e| err_device(e.to_string()))?;
            if data.len() as u64 != length || hex(&Sha256::digest(&data)) != part_digest {
                return Err(fw_err(
                    "Verified snapshot range changed locally; flashing is blocked.",
                ));
            }
            use std::io::Write;
            assembled
                .write_all(&data)
                .map_err(|e| err_device(e.to_string()))?;
            digest.update(&data);
            let _ = std::fs::remove_file(&part);
            progress(offset + length, size);
        }
        {
            use std::io::Write;
            assembled
                .flush()
                .and_then(|()| assembled.sync_all())
                .map_err(|e| err_device(e.to_string()))?;
        }
        drop(assembled);
        let expected = hex(&digest.finalize());
        let dest_size = std::fs::metadata(destination).map(|m| m.len()).unwrap_or(0);
        if dest_size != size || firmware::file_sha256(destination).map_err(fw_into)? != expected {
            return Err(fw_err(
                "Assembled snapshot local SHA256 verification failed.",
            ));
        }
        self.check()?;
        let remote_digest = match remote {
            None => self.remote_flash_hash(size, 0)?,
            Some(path) => {
                let (remote_size, digest) = self.remote_file_hash(path, size)?;
                if remote_size != size {
                    return Err(fw_err(
                        "Source file size changed during segmented backup; flashing is blocked.",
                    ));
                }
                digest
            }
        };
        if remote_digest != expected {
            return Err(fw_err(
                "Source SHA256 changed during segmented backup; flashing is blocked.",
            ));
        }
        // Retain failed attempt files when a retry succeeded; remove the
        // ranges dir only when nothing remains (Python `if not any(...)`).
        if std::fs::read_dir(&ranges)
            .map(|mut d| d.next().is_none())
            .unwrap_or(false)
        {
            let _ = std::fs::remove_dir(&ranges);
        }
        Ok(expected)
    }

    /// `_remote_flash_hash(size, offset=0)` — device-side SHA256 of a flash
    /// range via `Maix.utils.flash_read`.
    fn remote_flash_hash(&mut self, size: u64, offset: u64) -> Result<String> {
        let code = format!(
            "import uhashlib, ubinascii\nfrom Maix import utils\n_nodu_verify_hash=uhashlib.sha256()\nfor _nodu_verify_offset in range({offset},{end},8192):\n _nodu_verify_hash.update(utils.flash_read(_nodu_verify_offset,min(8192,{end}-_nodu_verify_offset)))\nprint(ubinascii.hexlify(_nodu_verify_hash.digest()).decode())",
            offset = offset,
            end = offset + size,
        );
        let digest = self
            .exec(&code, false, Duration::from_secs(20))?
            .trim()
            .to_string();
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(err_device("Device returned an invalid flash SHA256."));
        }
        Ok(digest)
    }

    /// `_remote_file_hash(path, expected_size)` → `(size, sha256)`.
    fn remote_file_hash(&mut self, path: &str, expected_size: u64) -> Result<(u64, String)> {
        let p = py_quote_str(path);
        let code = format!(
            "import uhashlib,ubinascii\n_nodu_verify_hash=uhashlib.sha256()\n_nodu_verify_size=0\n_nodu_verify_file=open({p},\"rb\")\ntry:\n while True:\n  _nodu_verify_chunk=_nodu_verify_file.read(8192)\n  if not _nodu_verify_chunk: break\n  _nodu_verify_hash.update(_nodu_verify_chunk)\n  _nodu_verify_size+=len(_nodu_verify_chunk)\nfinally:\n _nodu_verify_file.close()\nprint(repr((_nodu_verify_size,ubinascii.hexlify(_nodu_verify_hash.digest()).decode())))"
        );
        let budget = (expected_size as f64 / (256.0 * 1024.0) + 10.0).clamp(20.0, 300.0);
        let text = self.exec(&code, false, Duration::from_secs_f64(budget))?;
        let value = pyrepr_parse(text.trim())?;
        let pair = match &value {
            PyValue::Tuple(t) | PyValue::List(t) => t.as_slice(),
            _ => {
                return Err(err_device("Invalid device file SHA256 response."));
            }
        };
        let size = pair.first().and_then(PyValue::as_int).unwrap_or(-1);
        let digest = match pair.get(1) {
            Some(PyValue::Str(s)) => s.clone(),
            _ => String::new(),
        };
        if size < 0
            || digest.len() != 64
            || !digest
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(err_device("Invalid device file SHA256 response."));
        }
        Ok((size as u64, digest))
    }

    /// `_remote_file_range_hash(path, offset, length)`.
    fn remote_file_range_hash(&mut self, path: &str, offset: u64, length: u64) -> Result<String> {
        firmware::dump_script(length, Some(path), offset).map_err(fw_into)?;
        let p = py_quote_str(path);
        let code = format!(
            "import uhashlib,ubinascii\n_nodu_range_hash=uhashlib.sha256()\n_nodu_range_left={length}\n_nodu_range_file=open({p},\"rb\")\ntry:\n _nodu_range_file.seek({offset})\n while _nodu_range_left:\n  _nodu_range_chunk=_nodu_range_file.read(min(8192,_nodu_range_left))\n  if not _nodu_range_chunk: raise Exception(\"Unexpected range EOF\")\n  _nodu_range_hash.update(_nodu_range_chunk)\n  _nodu_range_left-=len(_nodu_range_chunk)\nfinally:\n _nodu_range_file.close()\nprint(ubinascii.hexlify(_nodu_range_hash.digest()).decode())"
        );
        let digest = self
            .exec(&code, false, Duration::from_secs(20))?
            .trim()
            .to_string();
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(err_device("Invalid device range SHA256 response."));
        }
        Ok(digest)
    }

    /// `_backup_inventory()` — walk `/flash` + `/sd`, bounded depth/count.
    fn backup_inventory(&mut self) -> Result<Vec<Value>> {
        let mut entries: Vec<Value> = Vec::new();
        for mount in ["/flash", "/sd"] {
            let stat = self.stat_remote(mount)?;
            if stat.is_some() {
                self.inventory_visit(mount, 0, &mut entries)?;
            }
        }
        Ok(entries)
    }

    fn inventory_visit(&mut self, path: &str, depth: u32, entries: &mut Vec<Value>) -> Result<()> {
        if depth > 32 || entries.len() > 5000 {
            return Err(fw_err(
                "Device file tree exceeds safe backup bounds; flashing is blocked.",
            ));
        }
        let list = self.do_list_files(&json!({"path": path}).as_object().unwrap().clone())?;
        for entry in list.as_array().cloned().unwrap_or_default() {
            self.check()?;
            let mut entry = entry;
            if entry.get("directory").and_then(Value::as_bool) == Some(true) {
                entry
                    .as_object_mut()
                    .unwrap()
                    .insert("status".to_string(), json!("directory"));
                let sub = entry
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                entries.push(entry);
                self.inventory_visit(&sub, depth + 1, entries)?;
            } else {
                let (eligible, reason) = firmware::eligible_file();
                let size = entry.get("size").and_then(Value::as_u64).unwrap_or(0);
                if eligible && size > MAX_USER_FILE {
                    return Err(fw_err(
                        "A program/model file exceeds the 128 MiB backup limit; flashing is blocked.",
                    ));
                }
                let obj = entry.as_object_mut().unwrap();
                obj.insert(
                    "status".to_string(),
                    json!(if eligible { "pending" } else { "excluded" }),
                );
                obj.insert(
                    "reason".to_string(),
                    reason.map_or(Value::Null, |r| json!(r)),
                );
                entries.push(entry);
            }
        }
        Ok(())
    }

    /// `_verify_preserved_files(manifest)` — post-op file size/SHA256 pass.
    fn verify_preserved_files(&mut self, manifest: &Value) -> Result<u64> {
        let files: Vec<Value> = manifest
            .get("files")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|e| e.get("status").and_then(Value::as_str) == Some("verified"))
            .collect();
        self.fw_progress("verify-preserved-files", 0, files.len() as u64);
        for (index, entry) in files.iter().enumerate() {
            self.check()?;
            let path = remote_path(entry.get("path"), false)?;
            let stat = self.stat_remote(&path)?;
            let is_dir = stat
                .as_ref()
                .map(|s| (self.stat_field(s, 0) & 0x4000) != 0)
                .unwrap_or(false);
            let stat_size = stat.as_ref().map(|s| self.stat_field(s, 6)).unwrap_or(-1);
            let want_size = entry.get("size").and_then(Value::as_i64).unwrap_or(-1);
            if stat.is_none() || is_dir || stat_size != want_size {
                return Err(err_device(format!(
                    "Post-flash file is missing or changed size: {path}"
                )));
            }
            let (size, digest) = self.remote_file_hash(&path, want_size.max(0) as u64)?;
            if size as i64 != want_size
                || digest != entry.get("sha256").and_then(Value::as_str).unwrap_or("")
            {
                return Err(err_device(format!(
                    "Post-flash file SHA256 changed: {path}"
                )));
            }
            self.fw_progress(
                "verify-preserved-files",
                index as u64 + 1,
                files.len() as u64,
            );
        }
        self.log(
            &format!(
                "All {} backed-up files verified unchanged by size and device SHA256.",
                files.len()
            ),
            LogStream::Stdout,
        );
        Ok(files.len() as u64)
    }

    /// `_verify_inventory_unchanged(manifest)`.
    fn verify_inventory_unchanged(&mut self, manifest: &Value) -> Result<()> {
        fn shape(entries: &[Value]) -> Vec<(String, bool, u64)> {
            let mut v: Vec<(String, bool, u64)> = entries
                .iter()
                .map(|e| {
                    (
                        e.get("path")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        e.get("directory").and_then(Value::as_bool).unwrap_or(false),
                        e.get("size").and_then(Value::as_u64).unwrap_or(0),
                    )
                })
                .collect();
            v.sort();
            v
        }
        let current = self.backup_inventory()?;
        let old = manifest
            .get("files")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if shape(&current) != shape(&old) {
            return Err(err_device(
                "Device file inventory changed during the operation; automatic continuation is blocked.",
            ));
        }
        Ok(())
    }
}

impl Worker {
    /// `_transfer_preflight_plan(directory, pending)` — use a prior failed
    /// offset only as a *hint* for a fresh bounded read. No historical bytes
    /// or verification flags are imported.
    fn transfer_preflight_plan(&mut self, directory: &Path, pending: &[Value]) -> Option<Value> {
        let mut current: std::collections::HashMap<String, &Value> =
            std::collections::HashMap::new();
        for e in pending {
            if let Some(p) = e.get("path").and_then(Value::as_str) {
                current.insert(p.to_string(), e);
            }
        }
        let parent = directory.parent()?;
        let mut parents: Vec<PathBuf> = std::fs::read_dir(parent)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().ends_with(".pre-probe"))
            })
            .collect();
        parents.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        parents.truncate(32);
        for previous in parents {
            if previous == *directory || previous.symlink_metadata().is_ok_and(|m| m.is_symlink()) {
                continue;
            }
            let metadata = previous.join("manifest.json");
            let raw = (|| -> Option<Vec<u8>> {
                if metadata.symlink_metadata().is_ok_and(|m| m.is_symlink())
                    || !metadata.is_file()
                    || metadata.metadata().ok()?.len() > 2 * 1024 * 1024
                {
                    return None;
                }
                let raw = std::fs::read(&metadata).ok()?;
                if raw.len() > 2 * 1024 * 1024 {
                    return None;
                }
                Some(raw)
            })();
            let Some(raw) = raw else { continue };
            let Ok(old) = serde_json::from_slice::<Value>(&raw) else {
                continue;
            };
            let allowed_errors = [
                "Malformed backup chunk.",
                "Malformed bounded fill chunk.",
                "Backup offset/chunk size mismatch; flashing is blocked.",
            ];
            if !old.is_object()
                || old.get("port").and_then(Value::as_str) != self.state.port.as_deref()
                || old.get("stateSaved") != Some(&Value::Bool(false))
                || !old
                    .get("error")
                    .and_then(Value::as_str)
                    .is_some_and(|e| allowed_errors.contains(&e))
            {
                continue;
            }
            let files = match old.get("files").and_then(Value::as_array) {
                Some(f) if f.len() <= 5000 => f,
                _ => continue,
            };
            for entry in files {
                if entry.get("status").and_then(Value::as_str) != Some("pending") {
                    continue;
                }
                let Some(path) = entry.get("path").and_then(Value::as_str) else {
                    continue;
                };
                let Some(cur) = current.get(path) else {
                    continue;
                };
                if entry.get("size") != cur.get("size") {
                    continue;
                }
                let source_size = cur.get("size").and_then(Value::as_u64).unwrap_or(0);
                let partial = previous.join("files").join(path.trim_start_matches('/'));
                let resolved_partial = partial.canonicalize().unwrap_or_default();
                let resolved_prev = previous.canonicalize().unwrap_or_default();
                if partial.symlink_metadata().is_ok_and(|m| m.is_symlink())
                    || !resolved_partial.starts_with(&resolved_prev)
                    || !partial.is_file()
                {
                    continue;
                }
                let offset = partial.metadata().map(|m| m.len()).unwrap_or(0);
                if offset >= source_size {
                    continue;
                }
                return Some(json!({
                    "path": path,
                    "sourceBytes": source_size,
                    "offset": offset,
                    "length": 65536u64.min(source_size - offset),
                    "sourceFailureManifest": metadata,
                    "sourceFailureManifestSha256": hex(&Sha256::digest(&raw)),
                    "verified": false,
                    "hintOnly": true,
                }));
            }
        }
        None
    }

    /// `_verify_transfer_preflight(directory, plan)` — one range, no retry.
    fn verify_transfer_preflight(&mut self, directory: &Path, plan: &Value) -> Result<Value> {
        let path_raw = plan.get("path").and_then(Value::as_str).unwrap_or("");
        let path = remote_path(Some(&json!(path_raw)), false)?;
        let offset = plan.get("offset").and_then(Value::as_u64).unwrap_or(0);
        let length = plan.get("length").and_then(Value::as_u64).unwrap_or(0);
        let source_size = plan.get("sourceBytes").and_then(Value::as_u64).unwrap_or(0);
        if length == 0 || length > 65536 {
            return Err(err_device("Transfer preflight exceeds its 64 KiB bound."));
        }
        let code = firmware::dump_script(length, Some(&path), offset).map_err(fw_into)?;
        let before = self.stat_remote(&path)?;
        let before_size = before.as_ref().map(|s| self.stat_field(s, 6)).unwrap_or(-1);
        if before.is_none() || before_size != source_size as i64 || offset + length > source_size {
            return Err(err_device("Transfer preflight source size changed."));
        }
        let target = directory.join("transfer-preflight.raw.bin");
        let digest = self.receive_backup(&target, length, &code, &mut |_, _| {})?;
        if self.remote_file_range_hash(&path, offset, length)? != digest {
            return Err(err_device(
                "Transfer preflight source range changed; RAM probing is blocked.",
            ));
        }
        let after = self.stat_remote(&path)?;
        let after_size = after.as_ref().map(|s| self.stat_field(s, 6)).unwrap_or(-1);
        if after.is_none() || after_size != source_size as i64 {
            return Err(err_device("Transfer preflight source size changed."));
        }
        self.check()?;
        Ok(json!({
            "verified": true,
            "session": self.session_id,
            "rangeSha256": digest,
            "file": target.file_name().map(|n| n.to_string_lossy().into_owned()),
            "verifiedAt": now_millis(),
            "capacityEvidence": false,
            "completeBackup": false,
        }))
    }

    /// `_preservation_cache(directory)` — locate opaque bytes for
    /// revalidation, never a capacity certificate.
    fn preservation_cache(&mut self, directory: &Path) -> Option<Value> {
        let parent = directory.parent()?;
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(parent)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().ends_with(".pre-probe"))
            })
            .collect();
        dirs.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        dirs.truncate(32);
        let mut candidates: Vec<(i64, Value)> = Vec::new();
        for previous in dirs {
            if previous == *directory || previous.symlink_metadata().is_ok_and(|m| m.is_symlink()) {
                continue;
            }
            let source = previous.join("manifest.json");
            let Ok(meta) = source.symlink_metadata() else {
                continue;
            };
            if meta.is_symlink() || !meta.is_file() || meta.len() > 2 * 1024 * 1024 {
                continue;
            }
            let Ok(raw) = std::fs::read(&source) else {
                continue;
            };
            if raw.len() > 2 * 1024 * 1024 {
                continue;
            }
            let Ok(old) = serde_json::from_slice::<Value>(&raw) else {
                continue;
            };
            let files_len = old
                .get("files")
                .and_then(Value::as_array)
                .map(|f| f.len())
                .unwrap_or(usize::MAX);
            if !old.is_object()
                || old.get("version") != Some(&json!(1))
                || old.get("stateSaved") != Some(&Value::Bool(true))
                || old.get("scope").and_then(Value::as_str)
                    != Some("user-files-current-boot-and-unverified-flash-prefix")
                || old.get("port").and_then(Value::as_str) != self.state.port.as_deref()
                || old.get("firmware") != Some(&firmware_state_json(&self.state.firmware))
                || old.get("candidateFlashBytes").and_then(Value::as_u64) != Some(FLASH_BYTES)
                || old.get("completeFlashBackup") != Some(&Value::Bool(false))
                || old.get("flashCapacityVerified") != Some(&Value::Bool(false))
                || !old.get("createdAt").is_some_and(Value::is_i64)
                || files_len > 5000
            {
                continue;
            }
            let created = old.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
            candidates.push((
                created,
                json!({
                    "directory": previous,
                    "manifest": old,
                    "manifestSha256": hex(&Sha256::digest(&raw)),
                }),
            ));
        }
        candidates
            .into_iter()
            .max_by_key(|(c, _)| *c)
            .map(|(_, v)| v)
    }

    /// `_cached_preservation_source(cache, relative, size, digest)`.
    fn cached_preservation_source(
        &mut self,
        cache: Option<&Value>,
        relative: &str,
        size: u64,
        digest: Option<&str>,
    ) -> Option<PathBuf> {
        let cache = cache?;
        let digest = digest?;
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_lowercase() || c.is_ascii_digit())
        {
            return None;
        }
        let root = PathBuf::from(cache.get("directory")?.as_str()?);
        let relative_path = Path::new(relative);
        if relative_path.is_absolute()
            || relative_path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return None;
        }
        let source = root.join(relative_path);
        let mut component = root.clone();
        for part in relative_path.components() {
            component = component.join(part.as_os_str());
            if component.symlink_metadata().is_ok_and(|m| m.is_symlink()) {
                return None;
            }
        }
        let resolved = source.canonicalize().unwrap_or_default();
        let root_resolved = root.canonicalize().unwrap_or_default();
        if !resolved.starts_with(&root_resolved)
            || !source.is_file()
            || source.metadata().map(|m| m.len()).unwrap_or(u64::MAX) != size
            || firmware::file_sha256(&source).ok()? != digest
        {
            return None;
        }
        Some(source)
    }

    /// `_copy_revalidated_preservation(source, destination, size, digest)`.
    fn copy_revalidated_preservation(
        &mut self,
        source: &Path,
        destination: &Path,
        size: u64,
        digest: &str,
    ) -> Result<()> {
        let mut remaining = size;
        let mut original = std::fs::File::open(source).map_err(|e| err_device(e.to_string()))?;
        let mut copied = firmware::private_file(destination, true).map_err(fw_into)?;
        use std::io::Write;
        while remaining > 0 {
            self.check()?;
            let mut buf = vec![0u8; (1024 * 1024usize).min(remaining as usize)];
            let n = original
                .read(&mut buf)
                .map_err(|e| err_device(e.to_string()))?;
            if n == 0 {
                return Err(err_device("Revalidated preservation source was truncated."));
            }
            copied
                .write_all(&buf[..n])
                .map_err(|e| err_device(e.to_string()))?;
            remaining -= n as u64;
        }
        if original
            .read(&mut [0u8; 1])
            .map_err(|e| err_device(e.to_string()))?
            != 0
        {
            return Err(err_device("Revalidated preservation source changed size."));
        }
        copied
            .flush()
            .and_then(|()| copied.sync_all())
            .map_err(|e| err_device(e.to_string()))?;
        drop(copied);
        if firmware::file_sha256(destination).map_err(fw_into)? != digest {
            return Err(err_device("Revalidated preservation copy changed locally."));
        }
        Ok(())
    }
}

impl Worker {
    /// `_preserve_before_probe(backup_directory)` — save recoverable files
    /// and boot bytes before a RAM loader ends Python. Deliberately NOT a
    /// complete flash or capacity certificate.
    fn preserve_before_probe(&mut self, backup_directory: Option<&str>) -> Result<Value> {
        let Some(dir_str) = backup_directory else {
            return Err(err_device(
                "An absolute managed backup directory is required before RAM probing.",
            ));
        };
        if !Path::new(dir_str).is_absolute() {
            return Err(err_device(
                "An absolute managed backup directory is required before RAM probing.",
            ));
        }
        let directory =
            firmware::private_directory(&format!("{dir_str}.pre-probe"), true).map_err(fw_into)?;
        let manifest_path = directory.join("manifest.json");
        let mut manifest = Map::new();
        manifest.insert("version".to_string(), json!(1));
        manifest.insert("createdAt".to_string(), json!(now_millis()));
        manifest.insert("port".to_string(), json!(self.state.port));
        manifest.insert("sessionBeforeProbe".to_string(), json!(self.session_id));
        manifest.insert("firmware".to_string(), json!(self.state.firmware));
        manifest.insert(
            "scope".to_string(),
            json!("user-files-current-boot-and-unverified-flash-prefix"),
        );
        manifest.insert("completeFlashBackup".to_string(), json!(false));
        manifest.insert("flashCapacityVerified".to_string(), json!(false));
        manifest.insert("stateSaved".to_string(), json!(false));
        manifest.insert("files".to_string(), json!([]));
        firmware::write_json(&manifest_path, &Value::Object(manifest.clone())).map_err(fw_into)?;

        let result = (|this: &mut Self| -> Result<Value> {
            let header_text = this
                .exec(
                    "from Maix import utils\nprint(repr(utils.flash_read(0,5)))",
                    false,
                    Duration::from_secs(20),
                )?
                .trim()
                .to_string();
            let header = match pyrepr_parse(&header_text)? {
                PyValue::Bytes(b) => b,
                _ => Vec::new(),
            };
            if header.len() != 5 || !matches!(header[0], 0 | 2) {
                return Err(err_device(
                    "Current boot header is unsupported; RAM probing is blocked.",
                ));
            }
            let payload_size = u32::from_le_bytes(header[1..5].try_into().unwrap()) as u64;
            if payload_size == 0 || payload_size > 8 * 1024 * 1024 {
                return Err(err_device(
                    "Current boot length exceeds the preservation bound; RAM probing is blocked.",
                ));
            }
            let boot_size = payload_size + 37;
            let files = this.backup_inventory()?;
            manifest.insert("files".to_string(), Value::Array(files.clone()));
            let pending: Vec<Value> = files
                .iter()
                .filter(|e| e.get("status").and_then(Value::as_str) == Some("pending"))
                .cloned()
                .collect();
            let cache = this.preservation_cache(&directory);
            let mut cached_files: std::collections::HashMap<String, Value> =
                std::collections::HashMap::new();
            if let Some(cache) = &cache {
                if let Some(old_files) = cache
                    .get("manifest")
                    .and_then(|m| m.get("files"))
                    .and_then(Value::as_array)
                {
                    for old_entry in old_files {
                        if old_entry.get("status").and_then(Value::as_str) == Some("verified")
                            && let Some(p) = old_entry.get("path").and_then(Value::as_str)
                        {
                            cached_files.insert(p.to_string(), old_entry.clone());
                        }
                    }
                }
                manifest.insert(
                    "reuseSource".to_string(),
                    json!({
                        "directory": cache.get("directory"),
                        "manifestSha256": cache.get("manifestSha256"),
                        "session": this.session_id,
                        "capacityEvidence": false,
                    }),
                );
            }
            let total = FLASH_BYTES
                + pending
                    .iter()
                    .map(|e| e.get("size").and_then(Value::as_u64).unwrap_or(0))
                    .sum::<u64>();
            firmware::ensure_space(&directory, total).map_err(fw_into)?;
            firmware::write_json(&manifest_path, &Value::Object(manifest.clone()))
                .map_err(fw_into)?;
            let completed = std::cell::Cell::new(0u64);
            let last_percent = std::cell::Cell::new(-1i64);
            let mut sink = this.progress_sink();
            let mut progress = |received: u64, _expected: u64| {
                let percent = if total != 0 {
                    ((completed.get() + received) * 100 / total) as i64
                } else {
                    100
                };
                if percent != last_percent.get() {
                    last_percent.set(percent);
                    sink.report("preserve-before-probe", completed.get() + received, total);
                }
            };

            this.log(
                "Preserving user files, current boot bytes and an unverified 16 MiB flash-prefix candidate before the RAM reader. The prefix length does not prove chip capacity or complete coverage.",
                LogStream::Stdout,
            );
            this.with_fast_backup_serial(|this| {
                let preflight = this.transfer_preflight_plan(&directory, &pending);
                if let Some(mut pf) = preflight {
                    manifest.insert("transferPreflight".to_string(), pf.clone());
                    firmware::write_json(&manifest_path, &Value::Object(manifest.clone()))
                        .map_err(fw_into)?;
                    let verified = this.verify_transfer_preflight(&directory, &pf)?;
                    if let Some(obj) = pf.as_object_mut() {
                        for (k, v) in verified.as_object().unwrap() {
                            obj.insert(k.clone(), v.clone());
                        }
                    }
                    manifest.insert("transferPreflight".to_string(), pf);
                    firmware::write_json(&manifest_path, &Value::Object(manifest.clone()))
                        .map_err(fw_into)?;
                }
                for entry in pending.iter() {
                    this.check()?;
                    let remote = remote_path(entry.get("path"), false)?;
                    let local = directory.join("files").join(remote.trim_start_matches('/'));
                    if let Some(parent) = local.parent() {
                        firmware::private_directory(parent.to_str().unwrap_or(""), false)
                            .map_err(fw_into)?;
                    }
                    let old_entry = cached_files.get(&remote);
                    let old_digest = old_entry
                        .and_then(|e| e.get("sha256"))
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    let entry_size =
                        entry.get("size").and_then(Value::as_u64).unwrap_or(0);
                    let old_size = old_entry
                        .and_then(|e| e.get("size"))
                        .and_then(Value::as_u64);
                    let source = if old_size == Some(entry_size) {
                        this.cached_preservation_source(
                            cache.as_ref(),
                            &format!("files/{}", remote.trim_start_matches('/')),
                            entry_size,
                            old_digest.as_deref(),
                        )
                    } else {
                        None
                    };
                    let mut digest = old_digest.clone().unwrap_or_default();
                    let mut reused = false;
                    if let (Some(src), Some(dg)) = (source, old_digest.as_deref()) {
                        if this.remote_file_hash(&remote, entry_size)? == (entry_size, dg.to_string())
                        {
                            this.copy_revalidated_preservation(&src, &local, entry_size, dg)?;
                            reused = true;
                            progress(entry_size, entry_size);
                        }
                    }
                    if !reused {
                        digest = this.receive_snapshot(&local, entry_size, Some(&remote), &mut progress)?;
                    }
                    // entry.update(status='verified', sha256=digest, local=...)
                    let rel = local
                        .strip_prefix(&directory)
                        .unwrap_or(&local)
                        .to_string_lossy()
                        .into_owned();
                    if let Some(f) = manifest
                        .get_mut("files")
                        .and_then(Value::as_array_mut)
                        .and_then(|arr| {
                            arr.iter_mut().find(|e| {
                                e.get("path").and_then(Value::as_str)
                                    == entry.get("path").and_then(Value::as_str)
                            })
                        })
                    {
                        let obj = f.as_object_mut().unwrap();
                        obj.insert("status".to_string(), json!("verified"));
                        obj.insert("sha256".to_string(), json!(digest));
                        obj.insert("local".to_string(), json!(rel));
                        if reused {
                            obj.insert(
                                "copySource".to_string(),
                                json!({
                                    "directory": cache.as_ref().and_then(|c| c.get("directory")).cloned(),
                                    "manifestSha256": cache.as_ref().and_then(|c| c.get("manifestSha256")).cloned(),
                                    "session": this.session_id,
                                    "remoteSha256RecheckedAt": now_millis(),
                                }),
                            );
                        }
                    }
                    completed.set(completed.get() + entry_size);
                    firmware::write_json(&manifest_path, &Value::Object(manifest.clone()))
                        .map_err(fw_into)?;
                }
                let candidate_path = directory.join("flash-prefix-candidate.raw.bin");
                let candidate_digest_cache = cache
                    .as_ref()
                    .and_then(|c| c.get("manifest"))
                    .and_then(|m| m.get("candidateFlashSha256"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let source = this.cached_preservation_source(
                    cache.as_ref(),
                    "flash-prefix-candidate.raw.bin",
                    FLASH_BYTES,
                    candidate_digest_cache.as_deref(),
                );
                let candidate_digest: String;
                if let (Some(src), Some(dg)) = (source, candidate_digest_cache.clone()) {
                    if this.remote_flash_hash(FLASH_BYTES, 0)? == dg {
                        this.copy_revalidated_preservation(&src, &candidate_path, FLASH_BYTES, &dg)?;
                        manifest.insert(
                            "prefixCopySource".to_string(),
                            json!({
                                "directory": cache.as_ref().and_then(|c| c.get("directory")).cloned(),
                                "manifestSha256": cache.as_ref().and_then(|c| c.get("manifestSha256")).cloned(),
                                "session": this.session_id,
                                "remoteSha256RecheckedAt": now_millis(),
                                "capacityEvidence": false,
                            }),
                        );
                        progress(FLASH_BYTES, FLASH_BYTES);
                        candidate_digest = dg;
                    } else {
                        candidate_digest = this.receive_snapshot(
                            &candidate_path,
                            FLASH_BYTES,
                            None,
                            &mut progress,
                        )?;
                    }
                } else {
                    candidate_digest = this.receive_snapshot(
                        &candidate_path,
                        FLASH_BYTES,
                        None,
                        &mut progress,
                    )?;
                }
                let image = std::fs::read(&candidate_path)
                    .map_err(|e| err_device(e.to_string()))?;
                let (metadata, original_boot) =
                    firmware::boot_region(&image).map_err(fw_into)?;
                if metadata.get("bootBytes").and_then(Value::as_u64) != Some(boot_size)
                    || original_boot[..5] != header[..]
                {
                    return Err(err_device(
                        "Boot header changed while preserving state; RAM probing is blocked.",
                    ));
                }
                let boot_path = directory.join("original-boot-region.raw.bin");
                {
                    let mut stream =
                        firmware::private_file(&boot_path, true).map_err(fw_into)?;
                    use std::io::Write;
                    stream
                        .write_all(&original_boot)
                        .and_then(|()| stream.sync_all())
                        .map_err(|e| FlashError::device(e.to_string()))
                        .map_err(fw_into)?;
                }
                manifest.insert("candidateFlashBytes".to_string(), json!(FLASH_BYTES));
                manifest.insert("candidateFlashSha256".to_string(), json!(candidate_digest));
                manifest.insert(
                    "candidateFlashFile".to_string(),
                    json!(candidate_path.file_name().map(|n| n.to_string_lossy().into_owned())),
                );
                for (k, v) in metadata.iter() {
                    manifest.insert(k.clone(), v.clone());
                }
                if this.remote_flash_hash(FLASH_BYTES, 0)?
                    != manifest
                        .get("candidateFlashSha256")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                {
                    return Err(err_device(
                        "Flash prefix changed while preserving state; RAM probing is blocked.",
                    ));
                }
                if this.remote_flash_hash(boot_size, 0)?
                    != manifest
                        .get("bootSha256")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                {
                    return Err(err_device(
                        "Boot bytes changed while preserving state; RAM probing is blocked.",
                    ));
                }
                this.verify_preserved_files(&Value::Object(manifest.clone()))?;
                this.verify_inventory_unchanged(&Value::Object(manifest.clone()))?;
                Ok(())
            })?;
            manifest.insert("stateSaved".to_string(), json!(true));
            manifest.insert(
                "bootRestore".to_string(),
                json!({
                    "file": "original-boot-region.raw.bin",
                    "address": 0,
                    "sha256Prefix": false,
                    "bytes": boot_size,
                    "sha256": manifest.get("bootSha256").cloned().unwrap_or(Value::Null),
                }),
            );
            firmware::write_json(&manifest_path, &Value::Object(manifest.clone()))
                .map_err(fw_into)?;
            this.fw_progress("preserve-before-probe", total, total);
            this.log(
                "User-file and boot preservation verified locally. RAM loading will end the current Python runtime; restarting the installed firmware may run user startup code.",
                LogStream::Stdout,
            );
            Ok(json!({
                "directory": directory,
                "manifest": Value::Object(manifest.clone()),
            }))
        })(self);
        match result {
            Ok(v) => Ok(v),
            Err(e) => {
                manifest.insert("stateSaved".to_string(), json!(false));
                manifest.insert("error".to_string(), json!(e.to_string()));
                let _ = firmware::write_json(&manifest_path, &Value::Object(manifest));
                self.log(
                    &format!(
                        "State preservation failed; no RAM reader will be loaded. Partial local copies remain at {}",
                        directory.display()
                    ),
                    LogStream::Stderr,
                );
                Err(e)
            }
        }
    }
}

impl Worker {
    /// `_ensure_flash_capacity(backup_directory)` — prove physical JEDEC
    /// capacity via the reviewed RAM reader, with preservation first.
    fn ensure_flash_capacity(&mut self, backup_directory: Option<&str>) -> Result<()> {
        if self.state.flash_capacity_verified
            && self
                .flash_capacity_proof
                .as_ref()
                .and_then(|p| p.get("capacityBytes"))
                .and_then(Value::as_u64)
                == Some(FLASH_BYTES)
        {
            return Ok(());
        }
        let image = probe::stub_image().map_err(fw_into)?;
        self.check()?;
        let preserved = self.preserve_before_probe(backup_directory)?;
        self.check()?;
        let port = self.state.port.clone().unwrap_or_default();
        let session_before_probe = self.session_id.clone().unwrap_or_default();
        let request_nonce = new_token();
        self.state.flash_capacity_verified = false;
        self.flash_capacity_proof = None;
        self.backup_record = None;
        self.update(|s| {
            s.preview = false;
            s.flash_capacity_verified = false;
        });
        self.fw_progress("probe-flash-capacity", 0, 1);
        self.log(
            "Loading the source-built RAM identity reader. Its command set reads flash identity only; the return reboot can run installed user startup code.",
            LogStream::Stdout,
        );
        // Python: transport, self.transport = self.transport, None; close —
        // the PortLock stays held while the probe owns the serial port.
        drop(self.transport.take());
        let probe_result: nodu_kflash::Result<Value> = {
            let factory = self.transport_factory.clone();
            let open = move |p: &str| -> std::io::Result<Box<dyn nodu_serial::Transport>> {
                factory(p, 115200).map_err(|e| std::io::Error::other(e.to_string()))
            };
            let mut check = self.fw_check();
            let mut log = self.fw_log();
            probe::probe(
                open,
                &port,
                image,
                &mut check,
                &mut log,
                Some(&request_nonce),
                Some(session_before_probe.as_str()),
            )
        };
        // `finally`: the probe resets back to the installed firmware; recover
        // the ordinary REPL even when a user cancels this read-only
        // operation. A reconnect failure replaces the probe result.
        self.probe_reconnect().map_err(|e| {
            err_device(format!(
                "Read-only capacity probe finished, but reconnecting the installed firmware failed: {e}"
            ))
        })?;
        self.check()?;
        let proof = probe_result.map_err(fw_into)?;
        if !proof.is_object() || proof.get("verified") != Some(&Value::Bool(true)) {
            return Err(err_device(
                "Physical JEDEC capacity was not verified; flashing remains blocked.",
            ));
        }
        if proof.get("probePort").and_then(Value::as_str) != Some(port.as_str())
            || proof.get("sessionBeforeProbe").and_then(Value::as_str)
                != Some(session_before_probe.as_str())
            || proof.get("requestNonce").and_then(Value::as_str) != Some(request_nonce.as_str())
            || proof.get("stubSha256").and_then(Value::as_str) != Some(probe::STUB_SHA256)
        {
            return Err(err_device(
                "Flash identity proof does not match this request, port, session and reviewed reader; flashing remains blocked.",
            ));
        }
        self.flash_capacity_proof = Some(proof.clone());
        if proof.get("capacityBytes").and_then(Value::as_u64) != Some(FLASH_BYTES) {
            return Err(err_device(format!(
                "Physical JEDEC reports {} bytes. This backup workflow currently supports only 16777216-byte chips; flashing is blocked.",
                proof.get("capacityBytes").cloned().unwrap_or(Value::Null)
            )));
        }
        // Any startup-induced change stops automatic continuation.
        let manifest = preserved.get("manifest").cloned().unwrap_or(Value::Null);
        self.verify_preserved_files(&manifest)?;
        self.verify_inventory_unchanged(&manifest)?;
        if self.remote_flash_hash(
            manifest
                .get("bootBytes")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            0,
        )? != manifest
            .get("bootSha256")
            .and_then(Value::as_str)
            .unwrap_or("")
        {
            return Err(err_device(
                "Installed boot bytes changed after the RAM reader; flashing is blocked.",
            ));
        }
        if manifest.get("candidateFlashBytes").and_then(Value::as_u64)
            != proof.get("capacityBytes").and_then(Value::as_u64)
            || self.remote_flash_hash(
                proof
                    .get("capacityBytes")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                0,
            )? != manifest
                .get("candidateFlashSha256")
                .and_then(Value::as_str)
                .unwrap_or("")
        {
            return Err(err_device(
                "Flash contents differ from the pre-probe candidate; automatic flashing is blocked. Preserve both states for review.",
            ));
        }
        self.pre_probe_record = Some(preserved);
        self.state.flash_capacity_verified = true;
        self.update(|s| s.flash_capacity_verified = true);
        self.fw_progress("probe-flash-capacity", 1, 1);
        self.log(
            &format!(
                "Physical JEDEC {} verified: {} bytes.",
                proof.get("jedecId").cloned().unwrap_or(Value::Null),
                proof.get("capacityBytes").cloned().unwrap_or(Value::Null)
            ),
            LogStream::Stdout,
        );
        Ok(())
    }

    /// Post-probe/flash reconnect at 115200 raw REPL (Python
    /// `transport_factory(port, 115200)` + `enter_raw_repl(soft_reset=False)`).
    fn probe_reconnect(&mut self) -> Result<()> {
        let port = self.state.port.clone().unwrap_or_default();
        let old_deadline = self.deadline;
        self.deadline = Some(Instant::now() + Duration::from_secs(25));
        self.restoring_io = true;
        let result = (|this: &mut Self| -> Result<()> {
            this.transport = Some((this.transport_factory)(&port, 115200)?);
            this.baud = 115200;
            this.mode = ConnMode::Raw;
            this.session().enter_raw_repl(Duration::from_secs(10))?;
            this.raw_stage = None;
            this.session_id = Some(new_token());
            this.update(|s| {
                s.phase = DevicePhase::Connected;
                s.running = false;
                s.flash_capacity_verified = false;
            });
            Ok(())
        })(self);
        self.restoring_io = false;
        self.deadline = old_deadline;
        if result.is_err() {
            self.update(|s| {
                s.phase = DevicePhase::Error;
                s.running = false;
                s.flash_capacity_verified = false;
            });
        }
        result
    }

    /// `do_backupDevice` — full 16 MiB flash + all regular /flash,/sd files
    /// into a private directory with manifest + restore packages.
    pub(crate) fn do_backup_device(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.require(true)?;
        let backup_dir = args.get("backupDir").and_then(Value::as_str);
        self.ensure_flash_capacity(backup_dir)?;
        let directory =
            firmware::private_directory(backup_dir.unwrap_or(""), true).map_err(fw_into)?;
        self.backup_record = None;
        self.update(|s| s.preview = false);
        let created = now_millis();
        let mut manifest = Map::new();
        manifest.insert("version".to_string(), json!(1));
        manifest.insert("verified".to_string(), json!(false));
        manifest.insert("createdAt".to_string(), json!(created));
        manifest.insert("port".to_string(), json!(self.state.port));
        manifest.insert("boardProfile".to_string(), json!(self.state.board_profile));
        manifest.insert("firmware".to_string(), json!(self.state.firmware));
        manifest.insert("architecture".to_string(), json!(self.state.architecture));
        manifest.insert("session".to_string(), json!(self.session_id));
        manifest.insert("flashBytes".to_string(), json!(FLASH_BYTES));
        manifest.insert(
            "flashCapacityVerified".to_string(),
            json!(self.state.flash_capacity_verified),
        );
        manifest.insert(
            "flashCapacityProof".to_string(),
            self.flash_capacity_proof.clone().unwrap_or(Value::Null),
        );
        manifest.insert(
            "preProbePreservation".to_string(),
            self.pre_probe_record.clone().unwrap_or(Value::Null),
        );
        manifest.insert("files".to_string(), json!([]));
        manifest.insert(
            "note".to_string(),
            json!("Complete Flash plus all regular /flash and /sd files are private opaque recovery copies. Contents may include user data; no file content is decoded, logged, or transmitted off this computer."),
        );
        let manifest_path = directory.join("manifest.json");
        firmware::write_json(&manifest_path, &Value::Object(manifest.clone())).map_err(fw_into)?;

        let result = (|this: &mut Self| -> Result<Value> {
            this.log(
                "Preparing complete 16 MiB flash and opaque copies of all regular /flash and /sd files; no board files will be modified.",
                LogStream::Stdout,
            );
            let files = this.backup_inventory()?;
            manifest.insert("files".to_string(), Value::Array(files.clone()));
            let pending: Vec<Value> = files
                .into_iter()
                .filter(|e| e.get("status").and_then(Value::as_str) == Some("pending"))
                .collect();
            let user_bytes: u64 = pending
                .iter()
                .map(|e| e.get("size").and_then(Value::as_u64).unwrap_or(0))
                .sum();
            firmware::ensure_space(&directory, user_bytes).map_err(fw_into)?;
            let total = FLASH_BYTES + user_bytes;
            firmware::write_json(&manifest_path, &Value::Object(manifest.clone()))
                .map_err(fw_into)?;
            this.exec(
                "import uhashlib,ubinascii\nfrom Maix import utils\nprint(ubinascii.hexlify(uhashlib.sha256(b\"test\").digest()).decode())",
                false,
                Duration::from_secs(20),
            )?;
            let completed = std::cell::Cell::new(0u64);
            let last_percent = std::cell::Cell::new(-1i64);
            let mut sink = this.progress_sink();
            let mut progress = |received: u64, _expected: u64| {
                let percent = if total != 0 {
                    ((completed.get() + received) * 100 / total) as i64
                } else {
                    100
                };
                if percent != last_percent.get() {
                    last_percent.set(percent);
                    sink.report("backup", completed.get() + received, total);
                }
            };
            let full_path = directory.join("full-flash.raw.bin");
            let (_full_path, original_boot) = this.with_fast_backup_serial(|this| {
                let digest = this.receive_snapshot(&full_path, FLASH_BYTES, None, &mut progress)?;
                manifest.insert("flashSha256".to_string(), json!(digest));
                completed.set(completed.get() + FLASH_BYTES);
                let image = std::fs::read(&full_path).map_err(|e| err_device(e.to_string()))?;
                let (metadata, original_boot) = firmware::boot_region(&image).map_err(fw_into)?;
                for (k, v) in &metadata {
                    manifest.insert(k.clone(), v.clone());
                }
                this.log(
                    "Full flash SHA256 and original K210 boot header verified.",
                    LogStream::Stdout,
                );
                for entry in pending.iter() {
                    this.check()?;
                    let remote = remote_path(entry.get("path"), false)?;
                    let local = directory.join("files").join(remote.trim_start_matches('/'));
                    if let Some(parent) = local.parent() {
                        firmware::private_directory(parent.to_str().unwrap_or(""), false)
                            .map_err(fw_into)?;
                    }
                    let entry_size = entry.get("size").and_then(Value::as_u64).unwrap_or(0);
                    let digest =
                        this.receive_snapshot(&local, entry_size, Some(&remote), &mut progress)?;
                    let rel = local
                        .strip_prefix(&directory)
                        .unwrap_or(&local)
                        .to_string_lossy()
                        .into_owned();
                    if let Some(f) = manifest
                        .get_mut("files")
                        .and_then(Value::as_array_mut)
                        .and_then(|arr| {
                            arr.iter_mut().find(|e| {
                                e.get("path").and_then(Value::as_str)
                                    == entry.get("path").and_then(Value::as_str)
                            })
                        })
                    {
                        let obj = f.as_object_mut().unwrap();
                        obj.insert("status".to_string(), json!("verified"));
                        obj.insert("sha256".to_string(), json!(digest));
                        obj.insert("local".to_string(), json!(rel));
                    }
                    completed.set(completed.get() + entry_size);
                    firmware::write_json(&manifest_path, &Value::Object(manifest.clone()))
                        .map_err(fw_into)?;
                }
                if this.remote_flash_hash(FLASH_BYTES, 0)?
                    != manifest
                        .get("flashSha256")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                {
                    return Err(err_device(
                        "Device flash contents changed during backup; flashing is blocked.",
                    ));
                }
                let boot_bytes = manifest
                    .get("bootBytes")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                if this.remote_flash_hash(boot_bytes, 0)?
                    != manifest
                        .get("bootSha256")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                {
                    return Err(err_device(
                        "Device boot bytes changed during backup; flashing is blocked.",
                    ));
                }
                this.verify_preserved_files(&Value::Object(manifest.clone()))?;
                this.verify_inventory_unchanged(&Value::Object(manifest.clone()))?;
                manifest.insert(
                    "snapshotVerification".to_string(),
                    json!({
                        "fullFlashSecondReadSha256": manifest.get("flashSha256"),
                        "filesVerified": pending.len(),
                        "inventoryUnchanged": true,
                        "verifiedAt": now_millis(),
                    }),
                );
                Ok::<(PathBuf, Vec<u8>), ReplError>((full_path.clone(), original_boot))
            })?;
            this.fw_progress("verify-backup", 0, 1);
            if !this.state.flash_capacity_verified || this.flash_capacity_proof.is_none() {
                manifest.insert("candidateSnapshot".to_string(), json!(true));
                manifest.insert("flashCapacityVerified".to_string(), json!(false));
                let note = manifest
                    .get("note")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
                    + " The 16 MiB read-back is only a candidate snapshot until physical JEDEC capacity is verified; smaller chips can wrap addresses.";
                manifest.insert("note".to_string(), json!(note));
                return Err(err_device(format!(
                    "Physical flash capacity has not been verified by JEDEC. The 16 MiB candidate snapshot may wrap and cannot authorize flashing. Candidate files remain at {}",
                    directory.display()
                )));
            }
            let mut check = this.fw_check();
            firmware::make_restore_packages(&directory, &full_path, &original_boot, &mut check)
                .map_err(fw_into)?;
            manifest.insert(
                "restore".to_string(),
                json!({
                    "boot": ["python3", "-m", "kflash", "-p", this.state.port, "-b", "1500000", directory.join("boot-restore.kfpkg")],
                    "full": ["python3", "-m", "kflash", "-p", this.state.port, "-b", "1500000", directory.join("full-flash-restore.kfpkg")],
                    "sha256Prefix": false,
                    "address": 0,
                }),
            );
            manifest.insert("verified".to_string(), json!(true));
            firmware::write_json(&manifest_path, &Value::Object(manifest.clone()))
                .map_err(fw_into)?;
            this.backup_record = Some(json!({
                "directory": directory,
                "manifest": Value::Object(manifest.clone()),
                "fullPath": full_path,
                "session": this.session_id,
            }));
            this.fw_progress("backup-complete", total, total);
            this.log(
                "Complete backup verified; restore packages and manifest saved privately on this computer.",
                LogStream::Stdout,
            );
            Ok(json!({
                "directory": directory,
                "flashSha256": manifest.get("flashSha256"),
                "flashBytes": FLASH_BYTES,
                "verified": true,
                "flashCapacityVerified": true,
                "flashJedecId": this
                    .flash_capacity_proof
                    .as_ref()
                    .and_then(|p| p.get("jedecId"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "createdAt": created,
                "files": pending.len(),
            }))
        })(self);

        match result {
            Ok(v) => Ok(v),
            Err(e) => {
                manifest.insert("verified".to_string(), json!(false));
                manifest.insert("error".to_string(), json!(e.to_string()));
                let _ = firmware::write_json(&manifest_path, &Value::Object(manifest));
                self.backup_record = None;
                self.log(
                    &format!(
                        "Backup incomplete; flashing is blocked. Partial backup remains at {}",
                        directory.display()
                    ),
                    LogStream::Stderr,
                );
                Err(e)
            }
        }
    }
}

impl Worker {
    /// `do_flashFirmware` — the only destructive path. Every destructive
    /// precondition is re-verified against the *current* board state;
    /// `flash_in_progress` blocks stop/disconnect until verification ends.
    pub(crate) fn do_flash_firmware(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.require(true)?;
        if !self.state.flash_capacity_verified
            || self
                .flash_capacity_proof
                .as_ref()
                .and_then(|p| p.get("capacityBytes"))
                .and_then(Value::as_u64)
                != Some(FLASH_BYTES)
        {
            return Err(err_device(
                "Flashing is blocked until the actual flash JEDEC capacity is verified; a 16 MiB read-back alone is not proof.",
            ));
        }
        let Some(prepared) = self.prepared_firmware.clone() else {
            return Err(err_device(
                "Prepare and verify the pinned official firmware before flashing.",
            ));
        };
        firmware::validate_image(&prepared).map_err(fw_into)?;
        let Some(record) = self.backup_record.clone() else {
            return Err(err_device(
                "A complete verified backup of the current connection is required before flashing.",
            ));
        };
        if args.get("backupDir").and_then(Value::as_str)
            != record.get("directory").and_then(Value::as_str)
            || record.get("session").and_then(Value::as_str) != self.session_id.as_deref()
            || record.get("manifest").and_then(|m| m.get("verified")) != Some(&Value::Bool(true))
        {
            return Err(err_device(
                "A complete verified backup of the current connection is required before flashing.",
            ));
        }
        let manifest = record.get("manifest").cloned().unwrap_or(Value::Null);
        if manifest.get("flashCapacityVerified") != Some(&Value::Bool(true))
            || manifest.get("flashCapacityProof") != self.flash_capacity_proof.as_ref()
        {
            return Err(err_device(
                "This backup has no matching hardware flash-capacity proof; take a new verified backup.",
            ));
        }
        self.fw_progress("verify-backup", 0, 3);
        let record_dir = record
            .get("directory")
            .and_then(Value::as_str)
            .unwrap_or("");
        let mut sink = self.progress_sink();
        let mut check = self.fw_check();
        // Python `lambda c, t: (self.check(), self._progress(...))` lets
        // check() abort mid-validate; the infallible Rust callback records
        // the first failure and we propagate it right after the call.
        let mut progress_err: Option<ReplError> = None;
        let validated =
            firmware::validate_backup(Path::new(record_dir), &manifest, |completed, total| {
                if progress_err.is_none() {
                    match check() {
                        Ok(()) => sink.report("verify-local-recovery-files", completed, total),
                        Err(e) => progress_err = Some(fw_into(e)),
                    }
                }
            });
        if let Some(e) = progress_err {
            return Err(e);
        }
        let (full_path, _metadata) = validated.map_err(fw_into)?;
        let expected_full = Path::new(record.get("fullPath").and_then(Value::as_str).unwrap_or(""))
            .canonicalize()
            .unwrap_or_else(|_| {
                PathBuf::from(record.get("fullPath").and_then(Value::as_str).unwrap_or(""))
            });
        if full_path != expected_full {
            return Err(err_device(
                "Full-flash recovery path no longer matches this backup.",
            ));
        }
        self.fw_progress("verify-backup", 1, 3);
        let boot_bytes = manifest
            .get("bootBytes")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if self.remote_flash_hash(boot_bytes, 0)?
            != manifest
                .get("bootSha256")
                .and_then(Value::as_str)
                .unwrap_or("")
        {
            self.backup_record = None;
            return Err(err_device(
                "Current device boot bytes do not match the verified backup; take a fresh backup.",
            ));
        }
        if self.remote_flash_hash(FLASH_BYTES, 0)?
            != manifest
                .get("flashSha256")
                .and_then(Value::as_str)
                .unwrap_or("")
        {
            self.backup_record = None;
            return Err(err_device(
                "Current device flash contents do not match the verified backup; take a fresh backup.",
            ));
        }
        self.verify_preserved_files(&manifest)?;
        self.verify_inventory_unchanged(&manifest)?;
        self.fw_progress("verify-backup", 3, 3);
        let port = self.state.port.clone().unwrap_or_default();
        let profile = self.state.board_profile.clone();
        let original_baud = if self.baud > 0 { self.baud } else { 115200 };
        self.check()?;
        self.shared.flash_in_progress.store(true, Ordering::SeqCst);
        self.update(|s| {
            s.preview = false;
            s.running = false;
        });
        self.log(
            "Writing the pinned official BIN at address 0 with its K210 SHA256 prefix; full-chip erase is disabled. Stop is unavailable until verification completes.",
            LogStream::Stdout,
        );
        let mut manifest = manifest;
        let result = (|this: &mut Self| -> Result<Value> {
            // Keep the process PortLock while kflash owns the physical FD.
            drop(this.transport.take());
            let factory = this.transport_factory.clone();
            let open = move |p: &str| -> std::io::Result<Box<dyn nodu_serial::Transport>> {
                factory(p, 115200).map_err(|e| std::io::Error::other(e.to_string()))
            };
            let mut sink = this.progress_sink();
            let mut log = this.fw_log();
            firmware::flash_image(&prepared, &port, open, &mut log, &mut |stage, c, t| {
                sink.report(stage, c, t)
            })
            .map_err(fw_into)?;
            this.fw_progress("reconnect", 0, 1);
            this.transport = Some((this.transport_factory)(&port, original_baud)?);
            this.baud = original_baud;
            this.mode = ConnMode::Raw;
            this.session().enter_raw_repl(Duration::from_secs(15))?;
            let info = this
                .exec(
                    "import os\nprint(repr(tuple(os.uname())))",
                    false,
                    Duration::from_secs(20),
                )?
                .trim()
                .to_string();
            let uname = pyrepr_parse(&info)?;
            let parts = match &uname {
                PyValue::Tuple(t) | PyValue::List(t) => t.clone(),
                _ => Vec::new(),
            };
            let str_at = |i: usize| match parts.get(i) {
                Some(PyValue::Str(s)) => s.clone(),
                _ => String::new(),
            };
            let identity = format!("{} {} ({})", str_at(0), str_at(2), str_at(3));
            let architecture = str_at(4);
            this.update(|s| {
                s.phase = DevicePhase::Connected;
                s.port = Some(port.clone());
                s.board_profile = profile.clone();
                s.firmware = Some(identity.clone());
                s.architecture = Some(architecture);
            });
            this.fw_progress("verify-written-flash", 0, WRITE_BYTES);
            this.exec("from Maix import utils", false, Duration::from_secs(20))?;
            let header = match this.eval("utils.flash_read(0,5)")? {
                PyValue::Bytes(b) => b,
                _ => Vec::new(),
            };
            let header_len_ok = header.len() == 5
                && matches!(header[0], 0 | 2)
                && u32::from_le_bytes(header[1..5].try_into().unwrap()) as u64 == firmware::SIZE;
            if !header_len_ok {
                return Err(err_device(
                    "Written firmware boot header does not match the pinned image.",
                ));
            }
            let payload_digest = this.remote_flash_hash(firmware::SIZE, 5)?;
            if payload_digest != firmware::SHA256 {
                return Err(err_device(
                    "Read-back firmware payload SHA256 does not match the official image.",
                ));
            }
            let image = std::fs::read(&prepared).map_err(|e| err_device(e.to_string()))?;
            let mut hasher = Sha256::new();
            hasher.update(&header);
            hasher.update(&image);
            let prefix = hasher.finalize_reset();
            hasher.update(&header);
            hasher.update(&image);
            hasher.update(prefix);
            let expected_boot_digest = hex(&hasher.finalize());
            if this.remote_flash_hash(WRITE_BYTES, 0)? != expected_boot_digest {
                return Err(err_device(
                    "Read-back firmware boot-region SHA256 verification failed.",
                ));
            }
            let preserved_files = this.verify_preserved_files(&manifest)?;
            this.verify_inventory_unchanged(&manifest)?;
            manifest.as_object_mut().unwrap().insert(
                "flashVerification".to_string(),
                json!({
                    "verified": true,
                    "payloadSha256": payload_digest,
                    "bootSha256": expected_boot_digest,
                    "preservedFiles": preserved_files,
                    "verifiedAt": now_millis(),
                }),
            );
            firmware::write_json(&Path::new(record_dir).join("manifest.json"), &manifest)
                .map_err(fw_into)?;
            this.backup_record = None;
            this.session_id = Some(new_token());
            this.fw_progress("flash-verified", WRITE_BYTES, WRITE_BYTES);
            this.log(
                "Firmware boot-region/payload SHA256 and all backed-up user files verified; user startup files were not written.",
                LogStream::Stdout,
            );
            Ok(json!({
                "verified": true,
                "firmware": identity,
                "backupDirectory": record.get("directory"),
                "sha256": payload_digest,
            }))
        })(self);
        let outcome = match result {
            Ok(v) => Ok(v),
            Err(e) => {
                self.update(|s| {
                    s.phase = DevicePhase::Error;
                    s.running = false;
                    s.preview = false;
                });
                manifest.as_object_mut().unwrap().insert(
                    "flashVerification".to_string(),
                    json!({
                        "verified": false,
                        "error": e.to_string(),
                        "verifiedAt": now_millis(),
                    }),
                );
                if firmware::write_json(&Path::new(record_dir).join("manifest.json"), &manifest)
                    .is_err()
                {
                    self.log(
                        "Could not update verification metadata; original backup files remain in the recovery directory.",
                        LogStream::Stderr,
                    );
                }
                self.log(
                    &format!(
                        "Firmware operation failed. The verified backup and restore packages remain at {record_dir}"
                    ),
                    LogStream::Stderr,
                );
                Err(err_device(format!(
                    "{e} Recovery backup: {record_dir}; use boot-restore.kfpkg (address 0, sha256Prefix=false), without erase."
                )))
            }
        };
        self.shared.flash_in_progress.store(false, Ordering::SeqCst);
        outcome
    }
}

fn firmware_state_json(firmware: &Option<String>) -> Value {
    firmware.as_ref().map_or(Value::Null, |f| json!(f))
}

fn repl_type_name(e: &ReplError) -> &'static str {
    match e {
        ReplError::Cancelled(_) => "Cancelled",
        ReplError::Protocol(_) => "ProtocolError",
        ReplError::Timeout(_) => "TimeoutError",
        ReplError::Device(_) => "DeviceError",
    }
}

fn pyrepr_parse(text: &str) -> Result<PyValue> {
    nodu_repl::pyrepr::parse(text).map_err(|e| err_device(format!("device response: {e}")))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
