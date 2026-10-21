// SPDX-License-Identifier: MIT
// Ported from k210-studio nodu_device_worker.py (MIT).
// Source: k210-studio dc0aba3 desktop/scope-extension/resources/nodu_device_worker.py
//! Library half of the `nodu-device` binary so integration tests can drive
//! `Worker` in-process with a `MemoryTransport`/`MockBoard`.
//!
//! Contract (identical to the Python worker): requests `{id, method, args}`;
//! replies `{id, result}` / `{id, error}`; events
//! `{event: 'state'|'log'|'frame', data}`; `stop`/`disconnect` jump the queue
//! and bump a generation that cancels in-flight work; per-method deadlines;
//! `busy/operation/lastError/progress` updates; 4 MiB JSON-line limit;
//! duplicate pending-id rejection.

pub mod script;
pub mod terminal;

use std::collections::{BinaryHeap, HashSet};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use nodu_maix_ide::IdeSession;
use nodu_media::Recorder;
use nodu_protocol::{
    DeviceCapabilities, DevicePhase, DeviceState, Event, LogStream, MAX_LINE_BYTES, METHODS,
    RecordingStatus, RequestId, UNIMPLEMENTED_MESSAGE,
};
use nodu_repl::pyrepr::{self, PyValue};
use nodu_repl::{Check, MAX_FILE_BYTES, OPERATION_TIMEOUT, ReplError, Session};
use nodu_serial::Transport;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

mod flash;

pub const MAX_CODE_BYTES: usize = 256 * 1024;

fn err_device(message: impl Into<String>) -> ReplError {
    ReplError::device(message)
}

/// Validate a `/flash|/sd` device path (`remote_path` in the Python worker).
pub fn remote_path(value: Option<&Value>, writing: bool) -> Result<String, ReplError> {
    let Some(raw) = value.and_then(Value::as_str) else {
        return Err(err_device("Expected a nonempty POSIX device path."));
    };
    if raw.is_empty() || raw.contains('\0') || raw.contains('\\') {
        return Err(err_device("Expected a nonempty POSIX device path."));
    }
    if raw.len() > 512 {
        return Err(err_device("Device path is too long."));
    }
    if raw.split('/').any(|seg| seg == "..") {
        return Err(err_device(
            "Parent traversal is not allowed in device paths.",
        ));
    }
    let prefixed = if raw.starts_with('/') {
        raw.to_string()
    } else {
        format!("/flash/{raw}")
    };
    // posixpath.normpath
    let mut parts: Vec<&str> = Vec::new();
    for seg in prefixed.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    let path = format!("/{}", parts.join("/"));
    if writing {
        let base = parts.last().copied().unwrap_or("");
        if base.eq_ignore_ascii_case("boot.py") || base.eq_ignore_ascii_case("main.py") {
            return Err(err_device(
                "Writing boot.py or main.py is disabled in this version.",
            ));
        }
        if path == "/" {
            return Err(err_device("A file path is required."));
        }
    }
    Ok(path)
}

/// Decode the base64 `data` arg of writeFile with the Python limits.
pub fn decode_file(value: Option<&Value>) -> Result<Vec<u8>, ReplError> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| err_device("File data must be a base64 string."))?;
    if text.len() > (MAX_FILE_BYTES + 2) / 3 * 4 {
        return Err(err_device("File exceeds the 2 MiB transfer limit."));
    }
    let data = B64
        .decode(text)
        .map_err(|_| err_device("File data must be valid base64."))?;
    if data.len() > MAX_FILE_BYTES {
        return Err(err_device("File exceeds the 2 MiB transfer limit."));
    }
    Ok(data)
}

/// Python `repr` for embedding a board path literal into generated code.
fn py_quote_str(text: &str) -> String {
    let mut s = String::from("'");
    for c in text.chars() {
        match c {
            '\\' => s.push_str("\\\\"),
            '\'' => s.push_str("\\'"),
            '\n' => s.push_str("\\n"),
            '\r' => s.push_str("\\r"),
            '\t' => s.push_str("\\t"),
            c if (c as u32) < 0x20 || (c as u32) == 0x7f => {
                s.push_str(&format!("\\x{:02x}", c as u32));
            }
            c => s.push(c),
        }
    }
    s.push('\'');
    s
}

/// Python `repr` for embedding a chunk literal into generated code.
fn py_quote_bytes(data: &[u8]) -> String {
    let mut s = String::from("b'");
    for &b in data {
        match b {
            b'\\' => s.push_str("\\\\"),
            b'\'' => s.push_str("\\'"),
            b'\n' => s.push_str("\\n"),
            b'\r' => s.push_str("\\r"),
            b'\t' => s.push_str("\\t"),
            0x20..=0x7e => s.push(b as char),
            b => s.push_str(&format!("\\x{b:02x}")),
        }
    }
    s.push('\'');
    s
}

/// Advisory single-owner port lock (Python `PortLock`): `$TMPDIR/
/// nodu-device-locks/<sha256-32>.lock`, flock on unix.
#[derive(Debug)]
pub struct PortLock {
    file: std::fs::File,
}

impl PortLock {
    pub fn acquire(port: &str) -> std::result::Result<Self, ReplError> {
        use fs2::FileExt;
        let canonical = std::fs::canonicalize(port)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| port.to_string())
            .replace("/dev/tty.", "/dev/cu.");
        let digest = hex(&Sha256::digest(canonical.as_bytes()))[..32].to_string();
        let root = std::env::temp_dir().join("nodu-device-locks");
        std::fs::create_dir_all(&root)
            .map_err(|e| err_device(format!("cannot create lock dir: {e}")))?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(format!("{digest}.lock")))
            .map_err(|e| err_device(format!("cannot open lock file: {e}")))?;
        file.try_lock_exclusive()
            .map_err(|_| err_device("Serial port is owned by another Nodu process."))?;
        Ok(Self { file })
    }
}

impl Drop for PortLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Incremental UTF-8 decoder with replacement semantics.
#[derive(Debug, Default)]
pub struct Utf8Incremental {
    tail: Vec<u8>,
}

impl Utf8Incremental {
    pub fn decode(&mut self, chunk: &[u8], final_chunk: bool) -> String {
        let mut data = std::mem::take(&mut self.tail);
        data.extend_from_slice(chunk);
        let mut out = String::new();
        let mut rest = data.as_slice();
        while !rest.is_empty() {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(std::str::from_utf8(&rest[..valid]).unwrap_or_default());
                    match e.error_len() {
                        Some(len) => {
                            out.push('\u{fffd}');
                            rest = &rest[valid + len..];
                        }
                        None => {
                            let leftover = rest[valid..].to_vec();
                            if final_chunk {
                                out.push('\u{fffd}');
                            } else {
                                self.tail = leftover;
                            }
                            return out;
                        }
                    }
                }
            }
        }
        out
    }
}

/// One queued request.
#[derive(Debug)]
struct Queued {
    priority: u8,
    sequence: u64,
    generation: u64,
    id: RequestId,
    method: String,
    args: Map<String, Value>,
}

impl PartialEq for Queued {
    fn eq(&self, other: &Self) -> bool {
        self.sequence == other.sequence
    }
}
impl Eq for Queued {}
impl PartialOrd for Queued {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Queued {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // BinaryHeap is a max-heap; invert so lowest priority+sequence pops first.
        other
            .priority
            .cmp(&self.priority)
            .then(other.sequence.cmp(&self.sequence))
    }
}

/// Submission-side state shared between the stdin reader thread and the
/// worker loop, kept outside the worker mutex so `stop`/`disconnect` bumps
/// the cancellation generation even while a long request is in flight.
#[allow(missing_debug_implementations)]
pub struct SubmitState {
    out: Mutex<Box<dyn Write + Send>>,
    pub generation: AtomicU64,
    pub input_closed: AtomicBool,
    pub input_eof: AtomicBool,
    pending: Mutex<HashSet<String>>,
    sequence: Mutex<u64>,
    queue: Mutex<BinaryHeap<Queued>>,
    condvar: Condvar,
    /// Python `flash_in_progress` — always false in Phase 1 (firmware ops are
    /// rejected earlier), kept so the priority rule stays in place.
    pub flash_in_progress: AtomicBool,
}

impl SubmitState {
    pub fn new(out: Box<dyn Write + Send>) -> Self {
        Self {
            out: Mutex::new(out),
            generation: AtomicU64::new(0),
            input_closed: AtomicBool::new(false),
            input_eof: AtomicBool::new(false),
            pending: Mutex::new(HashSet::new()),
            sequence: Mutex::new(0),
            queue: Mutex::new(BinaryHeap::new()),
            condvar: Condvar::new(),
            flash_in_progress: AtomicBool::new(false),
        }
    }

    fn emit(&self, value: &Value) {
        if let Ok(mut out) = self.out.lock() {
            let mut line = serde_json::to_vec(value).unwrap_or_default();
            line.push(b'\n');
            if out.write_all(&line).is_ok() {
                let _ = out.flush();
            }
        }
    }

    /// Validate + enqueue a request (Python `submit`); callable from the
    /// reader thread while the worker loop is busy.
    pub fn submit(&self, value: Value) {
        let (id, method, args) = match validate_request(&value) {
            Ok(v) => v,
            Err(e) => {
                let id = request_id_of(&value).unwrap_or(Value::Null);
                self.emit(&json!({"id": id, "error": e.to_string()}));
                return;
            }
        };
        if self.flash_in_progress.load(Ordering::SeqCst)
            && matches!(method.as_str(), "stop" | "disconnect" | "connect")
        {
            self.emit(&json!({"id": id, "error": "Firmware writing is in progress; wait for verification before stopping or disconnecting."}));
            return;
        }
        let key = serde_json::to_string(&id).unwrap_or_default();
        {
            let mut pending = self.pending.lock().expect("pending poisoned");
            if pending.contains(&key) {
                self.emit(&json!({"id": id, "error": "Duplicate pending request id."}));
                return;
            }
            pending.insert(key);
        }
        if matches!(method.as_str(), "stop" | "disconnect") {
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
        let sequence = {
            let mut s = self.sequence.lock().expect("sequence poisoned");
            *s += 1;
            *s
        };
        self.queue.lock().expect("queue poisoned").push(Queued {
            priority: u8::from(!matches!(method.as_str(), "stop" | "disconnect")),
            sequence,
            generation: self.generation.load(Ordering::SeqCst),
            id,
            method,
            args,
        });
        self.condvar.notify_all();
    }

    fn pop(&self, wait: Duration) -> Option<Queued> {
        let mut q = self.queue.lock().expect("queue poisoned");
        if q.is_empty() {
            let (guard, _) = self
                .condvar
                .wait_timeout(q, wait)
                .unwrap_or_else(|e| e.into_inner());
            q = guard;
        }
        q.pop()
    }

    fn queue_is_empty(&self) -> bool {
        self.queue.lock().expect("queue poisoned").is_empty()
    }

    fn finish(&self, id: &RequestId) {
        self.pending
            .lock()
            .expect("pending poisoned")
            .remove(&serde_json::to_string(id).unwrap_or_default());
    }

    /// stdin reader loop: parse JSON lines, submit, then flag EOF.
    pub fn read_requests(&self, mut reader: impl BufRead) {
        loop {
            let mut line: Vec<u8> = Vec::new();
            match read_line_capped(&mut reader, &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if line.len() > MAX_LINE_BYTES {
                self.emit(
                    &json!({"id": null, "error": "Request exceeds the 4 MiB JSON-line limit."}),
                );
                continue;
            }
            let text = String::from_utf8_lossy(&line);
            match serde_json::from_str::<Value>(text.trim_end_matches(['\n', '\r'])) {
                Ok(v) => self.submit(v),
                Err(e) => self.emit(&json!({"id": null, "error": format!("{e}")})),
            }
        }
        self.input_eof.store(true, Ordering::SeqCst);
        self.condvar.notify_all();
    }
}

/// Transport factory so tests (and `--mock`) can inject non-serial transports.
pub type TransportFactory =
    Arc<dyn Fn(&str, u32) -> Result<Box<dyn Transport>, ReplError> + Send + Sync>;

type Result<T, E = ReplError> = std::result::Result<T, E>;

/// Connection protocol selected at `connect` time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnMode {
    /// Original raw-REPL path, kept as the differential-test oracle.
    Raw,
    /// MaixPy IDE binary protocol at 1.5 Mbps.
    Ide,
}

/// The worker: one JSON-lines stdio protocol engine.
#[allow(missing_debug_implementations)]
pub struct Worker {
    pub shared: Arc<SubmitState>,
    pub state: DeviceState,
    transport: Option<Box<dyn Transport>>,
    port_lock: Option<PortLock>,
    transport_factory: TransportFactory,
    active_generation: u64,
    deadline: Option<Instant>,
    raw_stage: Option<LogStream>,
    stdout_decoder: Utf8Incremental,
    stderr_decoder: Utf8Incremental,
    baud: u32,
    restoring_io: bool,
    connecting_started: bool,
    /// `--mock`: listPorts advertises a virtual `mock` port.
    pub mock: bool,
    /// Connection protocol: raw REPL (test oracle) or the IDE binary protocol.
    mode: ConnMode,
    /// Original board id 0–8 selecting the reset sequence.
    board_id: u8,
    /// IDE stdout/stderr line classifier state.
    ide_line_buf: String,
    /// Buffered traceback text awaiting its terminal exception line.
    ide_tb: String,
    ide_in_traceback: bool,
    ide_stderr_seen: bool,
    /// Aggregate IDE TX bytes classified during the current execution.
    ide_out_bytes: usize,
    /// Trailing IDE text held back un-emitted (the last complete line plus
    /// any partial line) so the firmware's terminal banner/prompt can still
    /// be stripped at end-of-stream.
    ide_holdback: String,
    /// When the current IDE script was sent; `running` polls that report
    /// `false` inside a short grace window are the firmware's flag lag,
    /// not a finished script.
    ide_run_started: Option<Instant>,
    frame_sequence: u64,
    last_frame_at: Option<Instant>,
    /// Active `.bin` ImageWriter recorder; frames append in `poll_ide`.
    recorder: Option<Recorder>,
    /// `-override_read_timeout`: per-reply wait for IDE protocol reads;
    /// `None` keeps each call site's default.
    read_timeout: Option<Duration>,
    /// `-override_read_stall_timeout`: replaces the 1 s default budget
    /// inside a partially received IDE reply; on stall a mid-reply
    /// `SCRIPT_RUNNING` recovery write goes out (original-plugin behaviour).
    read_stall_timeout: Option<Duration>,
    /// Python `session_id` (uuid4().hex): per-connection nonce, renewed
    /// after probe/flash reconnects, cleared on disconnect.
    session_id: Option<String>,
    /// Pinned official firmware path from `prepareFirmware`.
    prepared_firmware: Option<std::path::PathBuf>,
    /// Verified backup of THIS connection required before flashing.
    backup_record: Option<Value>,
    /// JEDEC capacity proof emitted by the reviewed RAM reader.
    flash_capacity_proof: Option<Value>,
    /// Pre-probe preservation manifest + directory for post-op checks.
    pre_probe_record: Option<Value>,
}

impl Worker {
    pub fn new(shared: Arc<SubmitState>, transport_factory: TransportFactory) -> Self {
        Self {
            shared,
            state: DeviceState::default(),
            transport: None,
            port_lock: None,
            transport_factory,
            active_generation: 0,
            deadline: None,
            raw_stage: None,
            stdout_decoder: Utf8Incremental::default(),
            stderr_decoder: Utf8Incremental::default(),
            baud: 115200,
            restoring_io: false,
            connecting_started: false,
            mock: false,
            mode: ConnMode::Raw,
            board_id: 2,
            ide_line_buf: String::new(),
            ide_tb: String::new(),
            ide_in_traceback: false,
            ide_stderr_seen: false,
            ide_out_bytes: 0,
            ide_holdback: String::new(),
            ide_run_started: None,
            frame_sequence: 0,
            last_frame_at: None,
            recorder: None,
            read_timeout: None,
            read_stall_timeout: Some(Duration::from_secs(1)),
            session_id: None,
            prepared_firmware: None,
            backup_record: None,
            flash_capacity_proof: None,
            pre_probe_record: None,
        }
    }

    /// `-override_read_timeout` / `-override_read_stall_timeout` launch
    /// flags: apply to every IDE session built from now on; `None` leaves
    /// the existing value (call-site timeout / 1 s stall-recovery budget).
    /// Set before `main_loop`.
    pub fn set_read_timeouts(&mut self, read: Option<Duration>, stall: Option<Duration>) {
        if let Some(read) = read {
            self.read_timeout = Some(read);
        }
        if let Some(stall) = stall {
            self.read_stall_timeout = Some(stall);
        }
    }

    /// Per-reply read wait for IDE sessions: the configured override wins,
    /// otherwise the call site's own bound.
    fn ide_read_timeout(&self, default: Duration) -> Duration {
        self.read_timeout.unwrap_or(default)
    }

    /// Factory that opens real serial ports.
    pub fn serial_factory() -> TransportFactory {
        Arc::new(|path, baud| {
            nodu_serial::SerialTransport::open(path, baud)
                .map(|t| Box::new(t) as Box<dyn Transport>)
                .map_err(|e| err_device(e.to_string()))
        })
    }

    pub fn emit(&self, value: &Value) {
        self.shared.emit(value);
    }

    fn emit_event(&self, event: &Event) {
        self.emit(&serde_json::to_value(event).unwrap_or_default());
    }

    pub fn log(&self, text: &str, stream: LogStream) {
        if !text.is_empty() {
            self.emit_event(&Event::Log(nodu_protocol::DeviceLog {
                text: text.to_string(),
                stream,
                time: now_millis(),
            }));
        }
    }

    /// Apply changes then emit a `state` event (Python `update`).
    fn update(&mut self, f: impl FnOnce(&mut DeviceState)) -> DeviceState {
        f(&mut self.state);
        self.emit_event(&Event::State(self.state.clone()));
        self.state.clone()
    }

    pub fn snapshot(&self) -> Value {
        serde_json::to_value(&self.state).unwrap_or_default()
    }

    fn check(&self) -> Result<()> {
        if !self.restoring_io
            && (self.active_generation != self.shared.generation.load(Ordering::SeqCst)
                || self.shared.input_closed.load(Ordering::SeqCst))
        {
            return Err(ReplError::cancelled());
        }
        if let Some(d) = self.deadline
            && Instant::now() > d
        {
            return Err(err_device("Device operation timed out."));
        }
        Ok(())
    }

    fn session(&mut self) -> Session<'_> {
        let active = self.active_generation;
        let deadline = self.deadline;
        let restoring = self.restoring_io;
        let shared = Arc::clone(&self.shared);
        let check = move || {
            if !restoring
                && (active != shared.generation.load(Ordering::SeqCst)
                    || shared.input_closed.load(Ordering::SeqCst))
            {
                return Err(ReplError::cancelled());
            }
            if let Some(d) = deadline
                && Instant::now() > d
            {
                return Err(err_device("Device operation timed out."));
            }
            Ok(())
        };
        Session::new(
            self.transport.as_mut().expect("transport").as_mut(),
            std::sync::Arc::new(check),
        )
    }

    /// IDE-protocol session on the same transport, sharing the worker's
    /// generation/deadline cancellation check.
    fn ide_session(&mut self) -> IdeSession<'_> {
        let active = self.active_generation;
        let deadline = self.deadline;
        let restoring = self.restoring_io;
        let shared = Arc::clone(&self.shared);
        let check: Check = std::sync::Arc::new(move || {
            if !restoring
                && (active != shared.generation.load(Ordering::SeqCst)
                    || shared.input_closed.load(Ordering::SeqCst))
            {
                return Err(ReplError::cancelled());
            }
            if let Some(d) = deadline
                && Instant::now() > d
            {
                return Err(err_device("Device operation timed out."));
            }
            Ok(())
        });
        let read = self.read_timeout.unwrap_or(OPERATION_TIMEOUT);
        let stall = self.read_stall_timeout;
        IdeSession::new(
            self.transport.as_mut().expect("transport").as_mut(),
            check,
            read,
        )
        .with_stall_timeout(stall)
    }

    /// Worker loop (Python `serve`): pop requests, poll streamed output.
    /// With `wait=false`, `step` returns immediately when the queue is empty.
    pub fn main_loop(&mut self) {
        self.update(|_| {});
        loop {
            if self.shared.input_closed.load(Ordering::SeqCst) {
                break;
            }
            if self.shared.input_eof.load(Ordering::SeqCst) && self.shared.queue_is_empty() {
                break;
            }
            match self.shared.pop(Duration::from_millis(40)) {
                Some(item) => self.handle(item),
                None => {
                    self.active_generation = self.shared.generation.load(Ordering::SeqCst);
                    self.deadline = Some(Instant::now() + OPERATION_TIMEOUT);
                    match self.poll() {
                        Ok(()) | Err(ReplError::Cancelled(_)) => {}
                        Err(e) => self.lost(&e),
                    }
                    self.deadline = None;
                }
            }
        }
        self.shared.input_closed.store(true, Ordering::SeqCst);
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
        if self.state.running
            && let Some(t) = self.transport.as_mut()
        {
            // Raw mode interrupts with Ctrl-C; in IDE mode only a complete
            // stop command may go on the wire — and only on a stream that
            // has not desynced (a desynced one was already closed).
            if self.mode == ConnMode::Ide {
                let _ = t.write_all(&[0x30, 0x06, 0, 0, 0, 0]);
            } else {
                let _ = t.write_all(b"\x03");
            }
        }
        self.close_transport();
    }

    /// One queue/pop iteration; returns true when a request was handled.
    /// Public so integration tests can drive the worker deterministically.
    pub fn step(&mut self, wait: Duration) -> bool {
        match self.shared.pop(wait) {
            Some(item) => {
                self.handle(item);
                true
            }
            None => {
                self.active_generation = self.shared.generation.load(Ordering::SeqCst);
                self.deadline = Some(Instant::now() + OPERATION_TIMEOUT);
                match self.poll() {
                    Ok(()) | Err(ReplError::Cancelled(_)) => {}
                    Err(e) => self.lost(&e),
                }
                self.deadline = None;
                false
            }
        }
    }

    /// Handle one queued request (Python `handle`).
    fn handle(&mut self, item: Queued) {
        self.active_generation = item.generation;
        let timeout = match item.method.as_str() {
            "connect" => 40,
            "readFile" | "writeFile" => 900,
            "prepareFirmware" => 180,
            "backupDevice" => 3600,
            "flashFirmware" => 900,
            "saveFile" => 600,
            "startCamera" => 60,
            "convertVideo" | "playVideo" => 900,
            "execute" | "runScript" => {
                let secs = item
                    .args
                    .get("code")
                    .and_then(Value::as_str)
                    .map(|c| self.upload_seconds(c).min(120.0))
                    .unwrap_or(0.0);
                (secs as u64) + OPERATION_TIMEOUT.as_secs()
            }
            _ => OPERATION_TIMEOUT.as_secs(),
        };
        self.deadline = Some(Instant::now() + Duration::from_secs(timeout));
        // formatScript is pure local work; it never marks the device busy.
        let active = !matches!(
            item.method.as_str(),
            "getState" | "listPorts" | "formatScript"
        );
        let mut finished = false;
        self.connecting_started = false;
        let result = (|this: &mut Self| -> Result<Value> {
            if !matches!(item.method.as_str(), "stop" | "disconnect") {
                this.check()?;
            }
            if active {
                this.update(|s| {
                    s.busy = true;
                    s.operation = Some(item.method.clone());
                    s.last_error = None;
                    s.progress = None;
                });
            }
            let r = this.dispatch(&item.method, &item.args);
            if active {
                this.update(|s| {
                    s.busy = false;
                    s.operation = None;
                });
            }
            finished = true;
            r
        })(self);
        match result {
            Ok(mut result) => {
                if item.method == "connect" {
                    result = self.snapshot();
                }
                self.emit(&json!({"id": item.id, "result": result}));
            }
            Err(e) => {
                let text = e.to_string();
                self.emit(&json!({"id": item.id, "error": text}));
                if active {
                    self.update(|s| s.last_error = Some(text.clone()));
                }
                if item.method == "connect" && self.connecting_started {
                    self.close_transport();
                    self.update(|s| {
                        s.phase = DevicePhase::Error;
                        s.running = false;
                        s.preview = false;
                        s.capabilities = DeviceCapabilities::default();
                    });
                } else if self.transport.is_some() && !e.is_cancelled() {
                    // A timed out raw transaction has unknown parser position.
                    if e.is_protocol()
                        || text.to_lowercase().contains("timed out")
                        || text.to_lowercase().contains("timeout")
                    {
                        self.update(|s| s.phase = DevicePhase::Error);
                    }
                    // IDE desync: the byte stream position is unknown, so the
                    // port is poisoned — close it so a queued stop can never
                    // write into the middle of a partial payload.
                    if self.mode == ConnMode::Ide && e.is_protocol() {
                        self.close_transport();
                        self.update(|s| {
                            s.running = false;
                            s.preview = false;
                            s.capabilities = DeviceCapabilities::default();
                        });
                    }
                }
            }
        }
        if active && !finished {
            self.update(|s| {
                s.busy = false;
                s.operation = None;
            });
        }
        self.deadline = None;
        self.shared.finish(&item.id);
    }

    fn dispatch(&mut self, method: &str, args: &Map<String, Value>) -> Result<Value> {
        match method {
            "getState" => Ok(self.snapshot()),
            "listPorts" => self.do_list_ports(),
            "connect" => self.do_connect(args),
            "disconnect" => self.do_disconnect(),
            "execute" => self.do_execute(args),
            "runScript" => self.do_run_script(args),
            "stop" => self.do_stop(),
            "listFiles" => self.do_list_files(args),
            "readFile" => self.do_read_file(args),
            "writeFile" => self.do_write_file(args),
            "setPreview" => self.do_set_preview(args),
            "startCamera" => self.do_start_camera(),
            "saveFile" => self.do_save_file(args),
            "formatScript" => do_format_script(args),
            "resetDevice" => self.do_reset_device(),
            "startRecording" => self.do_start_recording(args),
            "stopRecording" => self.do_stop_recording(),
            "convertVideo" => self.do_convert_video(args),
            "playVideo" => self.do_play_video(args),
            "prepareFirmware" => self.do_prepare_firmware(args),
            "backupDevice" => self.do_backup_device(args),
            "flashFirmware" => self.do_flash_firmware(args),
            _ => Err(err_device("Unknown device method.")),
        }
    }

    fn upload_seconds(&self, code: &str) -> f64 {
        let size = code.len() as f64;
        5.0 + size * 10.0 / f64::from(self.baud.max(1))
            + ((size as usize).div_ceil(256)) as f64 * 0.01
    }

    fn require(&self, idle: bool) -> Result<()> {
        if self.transport.is_none() {
            return Err(err_device("Connect a K210 first."));
        }
        if idle && self.state.running {
            return Err(err_device("Stop the running script before this operation."));
        }
        if idle && self.state.phase == DevicePhase::Error {
            return Err(err_device(
                "Device needs recovery; press Stop or reconnect.",
            ));
        }
        Ok(())
    }

    fn valid_code<'a>(&self, args: &'a Map<String, Value>) -> Result<&'a str> {
        let code = args.get("code").and_then(Value::as_str);
        let Some(code) = code.filter(|c| !c.trim().is_empty()) else {
            return Err(err_device("Code must be a nonempty string."));
        };
        if code.len() > MAX_CODE_BYTES {
            return Err(err_device("Code exceeds the 256 KiB RAM execution limit."));
        }
        if self.upload_seconds(code) > 120.0 {
            return Err(err_device(
                "Code upload would exceed 120 seconds at this baud; increase the baud rate or reduce the script.",
            ));
        }
        Ok(code)
    }

    /// `_exec`: run code to completion, returning decoded stdout.
    fn exec(&mut self, code: &str, log: bool, timeout: Duration) -> Result<String> {
        if self.mode == ConnMode::Ide {
            let _ = timeout;
            return self.exec_ide(code.as_bytes(), log);
        }
        self.check()?;
        let (output, error) = {
            let mut session = self.session();
            session.exec_raw(code, timeout)
        }
        .map_err(|e| match e {
            ReplError::Cancelled(_) => e,
            ReplError::Protocol(_) => {
                self.update(|s| s.phase = DevicePhase::Error);
                e
            }
            ReplError::Device(m) | ReplError::Timeout(m) => {
                self.update(|s| s.phase = DevicePhase::Error);
                ReplError::protocol(if m.is_empty() {
                    "Serial transaction failed.".into()
                } else {
                    m
                })
            }
        })?;
        self.check()?;
        let text = String::from_utf8_lossy(&output).into_owned();
        let err_text = String::from_utf8_lossy(&error).into_owned();
        if log {
            self.log(&text, LogStream::Stdout);
            self.log(&err_text, LogStream::Stderr);
        }
        if !error.is_empty() {
            return Err(err_device(err_text.trim().to_string()));
        }
        Ok(text)
    }

    /// `_eval`: `print(repr(expr))` parsed through the repr subset.
    fn eval(&mut self, expression: &str) -> Result<PyValue> {
        // IDE firmware runs each EXEC_SCRIPT in a fresh `<stdin>` scope, so a
        // self-contained script needs its own `import os`.
        let prelude = if self.mode == ConnMode::Ide && expression.contains("os.") {
            "import os
"
        } else {
            ""
        };
        let text = self.exec(
            &format!("{prelude}print(repr({expression}))"),
            false,
            OPERATION_TIMEOUT,
        )?;
        // `>`/0x04 prompt residue can prefix the first TX bytes after the
        // raw REPL hands over; never valid at the start of a repr.
        let cleaned =
            Self::ide_strip_tail(&text).trim_start_matches(['\x04', '>', ' ', '\r', '\n']);
        pyrepr::parse(cleaned.trim()).map_err(|e| err_device(format!("device response: {e}")))
    }

    /// `_stat`: `os.stat` result tuple or `None` on ENOENT.
    fn stat_remote(&mut self, path: &str) -> Result<Option<Vec<PyValue>>> {
        let p = py_quote_str(path);
        let code = format!(
            "import os\ntry:\n print(repr(tuple(os.stat({p}))))\nexcept OSError as e:\n print('ERR', e.args[0])"
        );
        let text = self
            .exec(&code, false, OPERATION_TIMEOUT)?
            .trim()
            .to_string();
        if let Some(err) = text.strip_prefix("ERR ") {
            if err == "2" {
                return Ok(None);
            }
            return Err(err_device(format!("Device stat failed: {text}")));
        }
        match pyrepr::parse(
            Self::ide_strip_tail(&text)
                .trim_start_matches(['\x04', '>', ' ', '\r', '\n'])
                .trim(),
        ) {
            Ok(PyValue::Tuple(t)) => Ok(Some(t)),
            Ok(PyValue::List(t)) => Ok(Some(t)),
            _ => Err(err_device("Device stat returned malformed data.")),
        }
    }

    fn stat_field(&self, stat: &[PyValue], index: usize) -> i64 {
        stat.get(index).and_then(PyValue::as_int).unwrap_or(0)
    }

    fn do_list_ports(&self) -> Result<Value> {
        let mut ports = nodu_serial::list_ports();
        if self.mock && !ports.iter().any(|p| p.path == "mock") {
            ports.push(nodu_protocol::SerialPortInfo {
                path: "mock".into(),
                description: "Nodu mock board".into(),
                vid: None,
                pid: None,
                serial_number: None,
            });
        }
        ports.sort_by(|a, b| a.path.cmp(&b.path));
        let out: Vec<Value> = ports
            .into_iter()
            .map(|p| {
                let mut o = json!({"path": p.path, "description": p.description});
                if let Some(v) = p.vid {
                    o["vid"] = json!(v);
                }
                if let Some(v) = p.pid {
                    o["pid"] = json!(v);
                }
                if let Some(v) = p.serial_number {
                    o["serialNumber"] = json!(v);
                }
                o
            })
            .collect();
        Ok(Value::Array(out))
    }

    fn do_connect(&mut self, args: &Map<String, Value>) -> Result<Value> {
        let port = args.get("port").and_then(Value::as_str).unwrap_or("");
        if port.is_empty() || port.len() > 512 {
            return Err(err_device("A serial port is required."));
        }
        if port.contains("://") {
            return Err(err_device("Only local serial ports are supported."));
        }
        let profile = args
            .get("boardProfile")
            .and_then(Value::as_str)
            .unwrap_or("embedfire-cam-gc2145");
        if !matches!(profile, "embedfire-cam-gc2145" | "generic-k210") {
            return Err(err_device("Unknown physical board profile."));
        }
        let protocol = match args.get("protocol") {
            None | Some(Value::Null) => "ide",
            Some(Value::String(p)) => match p.as_str() {
                "ide" | "raw" => p.as_str(),
                _ => return Err(err_device("Protocol must be 'ide' or 'raw'.")),
            },
            Some(_) => return Err(err_device("Protocol must be 'ide' or 'raw'.")),
        };
        let board_id = match args.get("boardId") {
            None | Some(Value::Null) => 2u8,
            Some(Value::Number(n)) => n
                .as_u64()
                .and_then(|v| u8::try_from(v).ok())
                .filter(|v| *v <= 8)
                .ok_or_else(|| err_device("boardId must be an integer from 0 to 8."))?,
            _ => return Err(err_device("boardId must be an integer from 0 to 8.")),
        };
        let baud = match args.get("baud") {
            None | Some(Value::Null) => 115200u32,
            Some(Value::Number(n)) if n.as_u64().is_some() => {
                let b = n.as_u64().unwrap_or(0);
                if !(9600..=3_000_000).contains(&b) {
                    return Err(err_device("Baud must be an integer from 9600 to 3000000."));
                }
                b as u32
            }
            _ => return Err(err_device("Baud must be an integer from 9600 to 3000000.")),
        };
        // IDE mode negotiates its own 1.5 M link; compare the effective baud
        // so a repeated identical connect is a no-op, not a port reset.
        let effective_baud = if protocol == "ide" {
            nodu_maix_ide::BAUD
        } else {
            baud
        };
        if self.transport.is_some()
            && self.state.port.as_deref() == Some(port)
            && self.state.board_profile.as_deref() == Some(profile)
            && self.baud == effective_baud
            && self.state.protocol.as_deref() == Some(protocol)
            && self.state.board_id == Some(board_id)
            && self.state.phase != DevicePhase::Error
        {
            return Ok(self.snapshot());
        }
        self.connecting_started = true;
        self.close_transport();
        self.update(|s| {
            s.phase = DevicePhase::Connecting;
            s.port = Some(port.to_string());
            s.board_profile = Some(profile.to_string());
            s.board_id = Some(board_id);
            s.protocol = Some(protocol.to_string());
            s.running = false;
            s.preview = false;
            s.firmware = None;
            s.architecture = None;
            s.flash_capacity_verified = false;
        });
        self.port_lock = Some(PortLock::acquire(port)?);
        self.board_id = board_id;
        if protocol == "ide" {
            // IDE flow opens at 115200 and reconfigures the link itself.
            let transport = (self.transport_factory)(port, 115200)?;
            self.transport = Some(transport);
            self.baud = nodu_maix_ide::BAUD;
            self.session_id = Some(flash::new_token());
            self.backup_record = None;
            self.flash_capacity_proof = None;
            self.pre_probe_record = None;
            return self.connect_ide(board_id);
        }
        let transport = (self.transport_factory)(port, baud)?;
        self.transport = Some(transport);
        self.baud = baud;
        self.session_id = Some(flash::new_token());
        self.backup_record = None;
        self.flash_capacity_proof = None;
        self.pre_probe_record = None;
        {
            let mut session = self.session();
            session.enter_raw_repl(Duration::from_secs(10))?;
        }
        let info = self.exec(
            "import sys, os\nprint(repr(sys.version))\nprint(repr(tuple(os.uname())))",
            false,
            OPERATION_TIMEOUT,
        )?;
        let mut lines = info.lines();
        let interpreter = lines
            .next()
            .and_then(|l| pyrepr::parse(l).ok())
            .map(|v| match v {
                PyValue::Str(s) => s,
                other => format!("{other:?}"),
            })
            .unwrap_or_else(|| "version unavailable".into());
        let uname = lines
            .next()
            .and_then(|l| pyrepr::parse(l).ok())
            .and_then(|v| v.as_tuple().map(<[PyValue]>::to_vec))
            .unwrap_or_default();
        let firmware = if uname.len() > 3 {
            format!(
                "{} {} ({})",
                py_str(&uname[0]),
                py_str(&uname[2]),
                py_str(&uname[3])
            )
        } else {
            format!("MicroPython {interpreter}")
        };
        let architecture = if uname.len() > 4 {
            py_str(&uname[4])
        } else {
            format!("{uname:?}")
        };
        Ok(serde_json::to_value(self.update(|s| {
            s.phase = DevicePhase::Connected;
            s.firmware = Some(firmware);
            s.architecture = Some(architecture);
            s.capabilities = DeviceCapabilities {
                repl: true,
                files: true,
                framebuffer: false,
                script: true,
                firmware: true,
            };
        }))
        .unwrap_or_default())
    }

    fn close_transport(&mut self) {
        // Finalize any active recording so a disconnect/shutdown never
        // leaves truncated buffers behind; the file stays for recovery.
        if let Some(recorder) = self.recorder.take() {
            if let Err(e) = recorder.finish() {
                self.log(&format!("录像收尾失败：{e}"), LogStream::Stderr);
            }
        }
        self.state.recording = None;
        self.transport = None;
        self.port_lock = None;
        self.raw_stage = None;
        self.baud = 115200;
        self.mode = ConnMode::Raw;
        self.last_frame_at = None;
        self.ide_run_started = None;
        self.ide_line_buf.clear();
        self.ide_tb.clear();
        self.ide_in_traceback = false;
        self.ide_stderr_seen = false;
        self.ide_out_bytes = 0;
        self.ide_holdback.clear();
        self.session_id = None;
        self.backup_record = None;
        self.pre_probe_record = None;
        self.flash_capacity_proof = None;
        self.state.flash_capacity_verified = false;
    }

    /// Reset the IDE line classifier + UTF-8 decoder before each execution.
    fn ide_reset_classifier(&mut self) {
        self.ide_line_buf.clear();
        self.ide_tb.clear();
        self.ide_in_traceback = false;
        self.ide_stderr_seen = false;
        self.ide_out_bytes = 0;
        self.ide_holdback.clear();
        self.stdout_decoder = Utf8Incremental::default();
    }

    /// IDE connect: reset sequence -> raw REPL -> `repl.init(ide=True)` ->
    /// 1.5 Mbps query handshake -> version/arch -> framebuffer on.
    fn connect_ide(&mut self, board_id: u8) -> Result<Value> {
        let check = self.connect_check();
        {
            let t = self.transport.as_mut().expect("transport");
            nodu_maix_connect::connect(
                t.as_mut(),
                &check,
                board_id,
                Duration::from_secs(40),
                self.read_timeout,
                self.read_stall_timeout,
            )?;
        }
        let (version, architecture) = {
            let mut ide = self.ide_session();
            // FW_VERSION also makes the firmware delete /flash/ide_mode.conf.
            (ide.version()?, ide.architecture()?)
        };
        {
            let mut ide = self.ide_session();
            ide.framebuffer(true)?;
        }
        self.mode = ConnMode::Ide;
        self.ide_reset_classifier();
        self.last_frame_at = None;
        self.update(|s| {
            s.phase = DevicePhase::Connected;
            // Firmware framebuffer is enabled, so preview is live; frames
            // arrive whenever the running script calls sensor.snapshot().
            s.preview = true;
            s.fps = None;
            s.firmware = Some(format!(
                "MaixPy {}.{}.{}",
                version[0], version[1], version[2]
            ));
            s.architecture = Some(architecture);
            s.capabilities = DeviceCapabilities {
                repl: true,
                files: true,
                framebuffer: true,
                script: true,
                firmware: true,
            };
        });
        Ok(self.snapshot())
    }

    /// Build the cancellation check shared by IDE sessions.
    fn connect_check(&self) -> Check {
        let active = self.active_generation;
        let deadline = self.deadline;
        let shared = Arc::clone(&self.shared);
        std::sync::Arc::new(move || {
            if active != shared.generation.load(Ordering::SeqCst)
                || shared.input_closed.load(Ordering::SeqCst)
            {
                return Err(ReplError::cancelled());
            }
            if let Some(d) = deadline
                && Instant::now() > d
            {
                return Err(ReplError::timeout("Device operation timed out."));
            }
            Ok(())
        })
    }

    /// Feed decoded IDE TX text through the line classifier. Stderr
    /// classification is a heuristic on a single-byte TX channel: a line
    /// starting with `Traceback` buffers the whole block until its terminal
    /// (non-indented) exception line, so a host stop can drop its own
    /// `Exception: IDE interrupt` traceback atomically — a user
    /// `print('IDE interrupt')` outside a traceback survives untouched.
    fn ide_feed(&mut self, text: &str, log: bool, collect: &mut String) -> Result<()> {
        self.ide_out_bytes = self.ide_out_bytes.saturating_add(text.len());
        if self.ide_out_bytes > 4 * 1024 * 1024 {
            return Err(err_device("IDE output exceeded the 4 MiB limit."));
        }
        self.ide_line_buf.push_str(text);
        while let Some(nl) = self.ide_line_buf.find('\n') {
            let line = self.ide_line_buf[..=nl].to_string();
            self.ide_line_buf.drain(..=nl);
            self.ide_line(line, log, collect);
        }
        // Bound pending output: flush over-long lines incrementally at a
        // 32 KiB stride (and never let a buffered traceback grow past it).
        while self.ide_line_buf.len() > 32 * 1024 {
            let cut = self.ide_line_buf.floor_char_boundary(32 * 1024);
            let chunk: String = self.ide_line_buf.drain(..cut).collect();
            if self.ide_in_traceback {
                self.ide_tb.push_str(&chunk);
            } else {
                collect.push_str(&chunk);
                if log {
                    self.log(&chunk, LogStream::Stdout);
                }
            }
        }
        if self.ide_tb.len() > 32 * 1024 {
            let cut = self.ide_tb.floor_char_boundary(32 * 1024);
            let chunk: String = self.ide_tb.drain(..cut).collect();
            self.ide_stderr_seen = true;
            if log {
                self.log(&chunk, LogStream::Stderr);
            }
        }
        Ok(())
    }

    /// Classify one completed line (`\n` included).
    fn ide_line(&mut self, line: String, log: bool, collect: &mut String) {
        let body = line.trim_end_matches(['\r', '\n']);
        if self.ide_in_traceback {
            if body == "Exception: IDE interrupt" {
                // Firmware's own stop artifact: drop the whole buffered
                // traceback without marking stderr.
                self.ide_tb.clear();
                self.ide_in_traceback = false;
                return;
            }
            self.ide_tb.push_str(&line);
            if !body.starts_with(' ') && !body.starts_with('\t') {
                // Terminal exception line reached: emit the buffered block.
                self.ide_stderr_seen = true;
                if log {
                    self.log(&self.ide_tb.clone(), LogStream::Stderr);
                }
                self.ide_tb.clear();
                self.ide_in_traceback = false;
            }
            return;
        }
        if body.starts_with("Traceback") {
            self.ide_in_traceback = true;
            self.ide_tb.push_str(&line);
            return;
        }
        collect.push_str(&line);
        if log {
            self.log(&line, LogStream::Stdout);
        }
    }

    /// Strip the firmware's known terminal noise from the *final* decoded
    /// text of an execution: the `raw REPL; CTRL-B to exit` banner and the
    /// bare `>` prompt. Only applied to stream tails — mid-run occurrences
    /// of identical text are user output and pass through untouched.
    fn ide_strip_tail(text: &str) -> &str {
        text.strip_suffix("raw REPL; CTRL-B to exit\r\n>")
            .or_else(|| text.strip_suffix("raw REPL; CTRL-B to exit\n>"))
            .unwrap_or(text)
    }

    /// Emit decoded IDE text holding back the last two lines (complete or
    /// partial): the firmware tail is the `raw REPL; CTRL-B to exit` line
    /// followed by a `>` prompt line, so keeping both lets
    /// `ide_finalize`'s `ide_strip_tail` strip them without stalling
    /// normal lines.
    fn ide_emit(&mut self, text: &str, log: bool, collect: &mut String) -> Result<()> {
        if text.is_empty() {
            return self.ide_idle(log, collect);
        }
        self.ide_holdback.push_str(text);
        // The firmware tail is the `raw REPL; CTRL-B to exit` line plus a
        // `>` prompt line, so keep the last two lines held: emit through
        // the third-to-last newline.
        let buf = &self.ide_holdback;
        let mut boundary = buf.len();
        for _ in 0..2 {
            let Some(i) = buf[..boundary].rfind('\n') else {
                boundary = 0;
                break;
            };
            boundary = i;
        }
        let emit_len = if boundary == 0 { 0 } else { boundary + 1 };
        let out: String = self.ide_holdback.drain(..emit_len).collect();
        self.ide_feed(&out, log, collect)?;
        // A never-ending line without newlines must not grow the holdback
        // without bound: feed prefixes so only the tail stays buffered.
        while self.ide_holdback.len() > 64 * 1024 {
            let cut = self
                .ide_holdback
                .floor_char_boundary(self.ide_holdback.len() - 32 * 1024);
            let prefix: String = self.ide_holdback.drain(..cut).collect();
            self.ide_feed(&prefix, log, collect)?;
        }
        Ok(())
    }

    /// A poll/loop cycle that produced no new text: flush the held-back
    /// line immediately unless it could still grow into the firmware's
    /// terminal banner/prompt — only text that is a prefix of the known
    /// tail ever waits.
    fn ide_idle(&mut self, log: bool, collect: &mut String) -> Result<()> {
        if self.ide_holdback.is_empty() || Self::could_be_fw_tail(&self.ide_holdback) {
            return Ok(());
        }
        let out = std::mem::take(&mut self.ide_holdback);
        self.ide_feed(&out, log, collect)
    }

    /// True when `held`'s last line is a prefix of the firmware tail
    /// (`raw REPL; CTRL-B to exit` then `>`): holding it longer may still
    /// let `ide_strip_tail` strip it at end-of-stream. Any other last line
    /// is certainly user output and must not stall.
    fn could_be_fw_tail(held: &str) -> bool {
        const BANNER: &str = "raw REPL; CTRL-B to exit";
        let last = held.trim_end_matches(['\r', '\n']);
        let last_line = last.rsplit('\n').next().unwrap_or(last);
        // `>` alone, or a prefix/exact banner line — possibly still growing.
        last_line == ">" || BANNER.starts_with(last_line.trim_end_matches('\r'))
    }

    /// End-of-execution flush: emit the incomplete trailing line minus the
    /// known firmware banner/prompt the board emits after a script ends
    /// (`raw REPL; CTRL-B to exit` and the bare `>` prompt). Filtering only
    /// happens here — never mid-stream, so identical user output survives.
    fn ide_finalize(&mut self, log: bool, collect: &mut String) -> Result<()> {
        let held = std::mem::take(&mut self.ide_holdback);
        self.ide_feed(Self::ide_strip_tail(&held), log, collect)?;
        let rest = std::mem::take(&mut self.ide_line_buf);
        let mut rest = rest.as_str();
        while !rest.is_empty() {
            let (line, remain) = match rest.find('\n') {
                Some(i) => (&rest[..=i], &rest[i + 1..]),
                None => (rest, ""),
            };
            self.ide_line(line.to_string(), log, collect);
            rest = remain;
        }
        // An unterminated buffered traceback still counts as stderr.
        if !self.ide_tb.is_empty() {
            self.ide_stderr_seen = true;
            if log {
                self.log(&self.ide_tb.clone(), LogStream::Stderr);
            }
            self.ide_tb.clear();
        }
        self.ide_in_traceback = false;
        Ok(())
    }

    /// Run `f` with the serial transport temporarily taken out of `self`,
    /// so the IDE session can coexist with worker state/logging. The
    /// transport is always put back, even on error.
    fn with_transport<R>(
        &mut self,
        f: impl FnOnce(&mut Self, &mut dyn Transport) -> Result<R>,
    ) -> Result<R> {
        let mut t = self
            .transport
            .take()
            .ok_or_else(|| err_device("Connect a K210 first."))?;
        let r = f(self, t.as_mut());
        self.transport = Some(t);
        r
    }

    /// Wait until the firmware has re-entered the REPL after a script:
    /// `ide_dbg_init` flushes the RX buffer, so a command sent while the
    /// board is still unwinding is silently dropped. Drain TX until the
    /// `>` prompt appears in the held tail, output goes quiet for
    /// ~300 ms, or the bound expires.
    fn ide_wait_ready(&mut self, ide: &mut IdeSession<'_>) -> Result<()> {
        let until = Instant::now() + Duration::from_secs(3);
        let mut quiet = 0u32;
        let mut sink = String::new();
        while Instant::now() < until {
            if self.ide_holdback.trim_end().ends_with('>') {
                return Ok(());
            }
            let chunk = ide.output()?;
            let text = self.stdout_decoder.decode(&chunk, false);
            if text.is_empty() {
                quiet += 1;
                if quiet >= 15 {
                    return Ok(());
                }
            } else {
                quiet = 0;
            }
            self.ide_emit(&text, true, &mut sink)?;
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }

    /// `execute` over the IDE protocol: drain stale TX, send the script,
    /// stream TX output until `running` goes false, then a final drain.
    /// Returns the stdout-classified text; Traceback output is an error.
    fn exec_ide(&mut self, code: &[u8], log: bool) -> Result<String> {
        self.check()?;
        let mut stdout = String::new();
        self.ide_reset_classifier();
        let check = self.connect_check();
        self.with_transport(|this, t| {
            let mut ide =
                IdeSession::new(t, check.clone(), this.ide_read_timeout(OPERATION_TIMEOUT))
                    .with_stall_timeout(this.read_stall_timeout);
            this.ide_wait_ready(&mut ide)?;
            ide.execute(code)?;
            // The firmware's running flag lags EXEC_SCRIPT: an early
            // `false` does not yet prove the script finished.
            let started = Instant::now();
            let mut saw_running = false;
            let mut out_seen = false;
            let mut quiet = 0u32;
            let mut idle_spins = 0u32;
            loop {
                this.check()?;
                let chunk = ide.output()?;
                if chunk.is_empty() {
                    quiet = quiet.saturating_add(1);
                } else {
                    quiet = 0;
                    out_seen = true;
                }
                let text = this.stdout_decoder.decode(&chunk, false);
                let mut sink = String::new();
                this.ide_emit(&text, log, &mut sink)?;
                stdout.push_str(&sink);
                let running = ide.running()?;
                if running {
                    saw_running = true;
                }
                // `false` is conclusive once the flag was seen true, once
                // the `>` prompt appeared, once output arrived and went
                // quiet, or once the flag-lag grace expired.
                let finished = !running
                    && (saw_running
                        || this.ide_holdback.trim_end().ends_with('>')
                        || (out_seen && quiet >= 10)
                        || started.elapsed() > Duration::from_secs(3));
                if finished {
                    let tail = ide.output()?;
                    let text = this.stdout_decoder.decode(&tail, true);
                    let mut sink = String::new();
                    this.ide_emit(&text, log, &mut sink)?;
                    this.ide_finalize(log, &mut sink)?;
                    stdout.push_str(&sink);
                    break;
                }
                idle_spins = idle_spins.saturating_add(1);
                if chunk.is_empty() {
                    std::thread::sleep(Duration::from_millis(if idle_spins < 40 { 5 } else { 20 }));
                }
            }
            Ok(())
        })?;
        if self.ide_stderr_seen {
            return Err(err_device(
                "执行失败：脚本产生了 Traceback（详情见控制台 stderr）。",
            ));
        }
        Ok(stdout)
    }

    fn do_disconnect(&mut self) -> Result<Value> {
        self.active_generation = self.shared.generation.load(Ordering::SeqCst);
        if self.transport.is_some() {
            if self.mode == ConnMode::Ide {
                // Firmware FW_VERSION handling removes ide_mode.conf, so a
                // SYS_RESET here leaves the board in normal REPL on reboot.
                self.restoring_io = true;
                {
                    let mut ide = self.ide_session();
                    let _ = ide.stop();
                    let _ = ide.framebuffer(false);
                    let _ = ide.reset();
                }
                self.restoring_io = false;
            } else if let Err(e) = self.do_stop() {
                self.log(&format!("Disconnect recovery: {e}"), LogStream::System);
            }
        }
        self.close_transport();
        self.update(|s| {
            s.phase = DevicePhase::Disconnected;
            s.port = None;
            s.running = false;
            s.preview = false;
            s.fps = None;
            s.flash_capacity_verified = false;
            s.capabilities = DeviceCapabilities::default();
        });
        Ok(Value::Null)
    }

    fn do_execute(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.require(true)?;
        let code = self.valid_code(args)?.to_string();
        // Any code execution can change flash/files; the prior verified
        // backup no longer authorizes flashing (Python parity).
        self.backup_record = None;
        let out = self.exec(&code, true, OPERATION_TIMEOUT)?;
        Ok(Value::String(out))
    }

    fn do_run_script(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.require(true)?;
        let code = self.valid_code(args)?.to_string();
        self.backup_record = None;
        self.check()?;
        if self.mode == ConnMode::Ide {
            let check = self.connect_check();
            self.with_transport(|this, t| {
                let mut ide = IdeSession::new(t, check, this.ide_read_timeout(OPERATION_TIMEOUT))
                    .with_stall_timeout(this.read_stall_timeout);
                this.ide_wait_ready(&mut ide)?;
                ide.execute(code.as_bytes())
            })?;
            self.ide_reset_classifier();
            self.ide_run_started = Some(Instant::now());
            self.update(|s| {
                s.phase = DevicePhase::Running;
                s.running = true;
            });
            return Ok(Value::Null);
        }
        {
            let mut session = self.session();
            session
                .exec_raw_no_follow(code.as_bytes())
                .map_err(|e| match e {
                    ReplError::Cancelled(_) => e,
                    ReplError::Protocol(_) => {
                        self.update(|s| s.phase = DevicePhase::Error);
                        e
                    }
                    ReplError::Device(m) | ReplError::Timeout(m) => {
                        self.update(|s| s.phase = DevicePhase::Error);
                        ReplError::protocol(if m.is_empty() {
                            "Serial code upload failed.".into()
                        } else {
                            m
                        })
                    }
                })?;
        }
        self.raw_stage = Some(LogStream::Stdout);
        self.stdout_decoder = Utf8Incremental::default();
        self.stderr_decoder = Utf8Incremental::default();
        self.update(|s| {
            s.phase = DevicePhase::Running;
            s.running = true;
        });
        Ok(Value::Null)
    }

    fn do_stop(&mut self) -> Result<Value> {
        self.active_generation = self.shared.generation.load(Ordering::SeqCst);
        if self.transport.is_none() {
            return Ok(Value::Null);
        }
        self.deadline = Some(Instant::now() + Duration::from_secs(8));
        self.raw_stage = None;
        if self.mode == ConnMode::Ide {
            let check = self.connect_check();
            self.with_transport(|this, t| {
                let mut ide = IdeSession::new(t, check, this.ide_read_timeout(OPERATION_TIMEOUT))
                    .with_stall_timeout(this.read_stall_timeout);
                ide.stop()?;
                // Drain TX while the script unwinds; preview stays enabled.
                let deadline = Instant::now() + Duration::from_secs(8);
                let mut stopped = false;
                while Instant::now() < deadline {
                    let chunk = ide.output()?;
                    let text = this.stdout_decoder.decode(&chunk, false);
                    let mut sink = String::new();
                    this.ide_emit(&text, true, &mut sink)?;
                    if !ide.running()? {
                        this.ide_wait_ready(&mut ide)?;
                        let mut sink = String::new();
                        this.ide_finalize(true, &mut sink)?;
                        stopped = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                if !stopped {
                    return Err(err_device(
                        "Board did not stop the running script within the deadline.",
                    ));
                }
                Ok(())
            })?;
            self.last_frame_at = None;
            self.update(|s| {
                s.phase = DevicePhase::Connected;
                s.running = false;
                s.fps = None;
            });
            return Ok(Value::Null);
        }
        {
            let mut session = self.session();
            session.enter_raw_repl(Duration::from_secs(5))?;
        }
        self.last_frame_at = None;
        self.update(|s| {
            s.phase = DevicePhase::Connected;
            s.running = false;
            s.preview = false;
            s.fps = None;
        });
        Ok(Value::Null)
    }

    /// `setPreview` (IDE only): toggle the firmware framebuffer channel.
    fn do_set_preview(&mut self, args: &Map<String, Value>) -> Result<Value> {
        if self.mode != ConnMode::Ide {
            return Err(err_device(UNIMPLEMENTED_MESSAGE));
        }
        let enabled = match args.get("enabled") {
            Some(Value::Bool(b)) => *b,
            _ => return Err(err_device("enabled must be a boolean.")),
        };
        self.require(false)?;
        let check = self.connect_check();
        self.with_transport(|this, t| {
            IdeSession::new(t, check, this.ide_read_timeout(OPERATION_TIMEOUT))
                .with_stall_timeout(this.read_stall_timeout)
                .framebuffer(enabled)
        })?;
        // Restart fps measurement so pausing/resuming does not report a
        // stale frame interval.
        self.last_frame_at = None;
        self.update(|s| {
            s.preview = enabled;
            s.fps = None;
        });
        Ok(Value::Null)
    }

    /// `startCamera` (IDE only): stop any running script, then start the
    /// profile's capture loop; frames arrive over the firmware framebuffer.
    fn do_start_camera(&mut self) -> Result<Value> {
        if self.mode != ConnMode::Ide {
            return Err(err_device(UNIMPLEMENTED_MESSAGE));
        }
        self.require(false)?;
        if self.state.running {
            self.do_stop()?;
        }
        let script = match self.state.board_profile.as_deref() {
            Some("embedfire-cam-gc2145") => {
                // Same contract as the Python worker: a preinstalled
                // /flash/gc2145_board.py (<=64 KiB) must define init_camera().
                let stat = self.stat_remote("/flash/gc2145_board.py")?;
                match stat {
                    Some(st)
                        if self.stat_field(&st, 6) <= 65536
                            && (self.stat_field(&st, 0) & 0x4000) == 0 => {}
                    Some(_) => {
                        return Err(err_device(
                            "Existing /flash/gc2145_board.py has an invalid size (maximum 64 KiB).",
                        ));
                    }
                    None => {
                        return Err(err_device(
                            "Required /flash/gc2145_board.py is missing; install the board helper explicitly first.",
                        ));
                    }
                }
                concat!(
                    "import sensor\n",
                    "_nodu_camera_ns={'__name__':'gc2145_board'}\n",
                    "_nodu_helper_file=open('/flash/gc2145_board.py','r')\n",
                    "try:\n _nodu_helper_source=_nodu_helper_file.read(65537)\n",
                    "finally:\n _nodu_helper_file.close()\n",
                    "if len(_nodu_helper_source)>65536: raise Exception('Board helper grew beyond 64 KiB')\n",
                    "exec(_nodu_helper_source,_nodu_camera_ns)\n",
                    "del _nodu_helper_source\n",
                    "_nodu_camera_ns['init_camera']()\n",
                    "sensor.skip_frames(time=1000)\n",
                    "while True:\n sensor.snapshot()\n"
                )
                .to_string()
            }
            _ => concat!(
                "import sensor\n",
                "sensor.reset()\n",
                "sensor.set_pixformat(sensor.RGB565)\n",
                "sensor.set_framesize(sensor.QVGA)\n",
                "sensor.skip_frames(30)\n",
                "while True:\n sensor.snapshot()\n"
            )
            .to_string(),
        };
        // Re-enable the framebuffer channel even when the user paused
        // preview, then go through the common runScript path so readiness
        // waiting, classifier reset, and the run-start timestamp all match.
        let mut pv = Map::new();
        pv.insert("enabled".to_string(), Value::Bool(true));
        self.do_set_preview(&pv)?;
        let mut run_args = Map::new();
        run_args.insert("code".to_string(), Value::String(script));
        self.do_run_script(&run_args)
    }

    /// `saveFile`: IDE FILE_SAVE (SHA-256 verified firmware write path).
    /// `boot.py`/`main.py` additionally require `confirmedStartup: true`.
    fn do_save_file(&mut self, args: &Map<String, Value>) -> Result<Value> {
        if self.mode != ConnMode::Ide {
            return Err(err_device(UNIMPLEMENTED_MESSAGE));
        }
        self.require(false)?;
        let name = args
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let base = name.rsplit('/').next().unwrap_or(&name);
        if base.eq_ignore_ascii_case("boot.py") || base.eq_ignore_ascii_case("main.py") {
            let confirmed = args.get("confirmedStartup") == Some(&Value::Bool(true));
            if !confirmed {
                return Err(err_device(
                    "Refusing to write boot.py/main.py without confirmedStartup.",
                ));
            }
        }
        let data = decode_file(args.get("data"))?;
        let check = self.connect_check();
        let result = self.with_transport(|this, t| {
            IdeSession::new(t, check, this.ide_read_timeout(Duration::from_secs(60)))
                .with_stall_timeout(this.read_stall_timeout)
                .save_file(&name, &data)
        });
        // FILE_SAVE stops the running script first; reflect that regardless
        // of the save outcome so no phantom `running` state survives.
        self.ide_line_buf.clear();
        self.ide_tb.clear();
        self.ide_in_traceback = false;
        self.ide_stderr_seen = false;
        if self.transport.is_some() {
            self.update(|s| {
                s.running = false;
                if s.phase == DevicePhase::Running {
                    s.phase = DevicePhase::Connected;
                }
            });
        }
        result?;
        Ok(Value::Null)
    }

    /// `resetDevice`: SYS_RESET then release the port (post-FW_VERSION the
    /// board boots back into normal REPL since ide_mode.conf was removed).
    fn do_reset_device(&mut self) -> Result<Value> {
        if self.mode != ConnMode::Ide {
            return Err(err_device(UNIMPLEMENTED_MESSAGE));
        }
        if self.transport.is_none() {
            return Ok(Value::Null);
        }
        let check = self.connect_check();
        if let Err(e) = self.with_transport(|this, t| {
            IdeSession::new(t, check, this.ide_read_timeout(Duration::from_secs(5)))
                .with_stall_timeout(this.read_stall_timeout)
                .reset()
        }) {
            // A reset that never reached the wire leaves a broken stream;
            // surface the failure and drop the transport so the next connect
            // performs the hardware reset sequence.
            self.close_transport();
            self.update(|s| {
                s.phase = DevicePhase::Error;
                s.running = false;
                s.preview = false;
                s.capabilities = DeviceCapabilities::default();
            });
            return Err(e);
        }
        self.close_transport();
        self.update(|s| {
            s.phase = DevicePhase::Disconnected;
            s.port = None;
            s.running = false;
            s.preview = false;
            s.fps = None;
            s.flash_capacity_verified = false;
            s.capabilities = DeviceCapabilities::default();
        });
        Ok(Value::Null)
    }

    /// `startRecording`: begin an ImageWriter `.bin` recording. Requires an
    /// IDE connection with framebuffer preview capability; frames captured
    /// in `poll_ide` are appended before each frame event goes out.
    fn do_start_recording(&mut self, args: &Map<String, Value>) -> Result<Value> {
        if self.mode != ConnMode::Ide || self.transport.is_none() {
            return Err(err_device("请先以 IDE 协议连接 K210，再开始录像。"));
        }
        if !self.state.capabilities.framebuffer {
            return Err(err_device("录像需要设备帧缓冲能力。"));
        }
        if !self.state.preview {
            return Err(err_device("请先开启帧缓冲预览，再开始录像。"));
        }
        if self.recorder.is_some() {
            return Err(err_device("已有进行中的录像。"));
        }
        let path = media_path(args.get("path"))?;
        let recorder = Recorder::create(&path)?;
        let status = recording_status(&recorder.summary(), true);
        self.recorder = Some(recorder);
        let status_value = serde_json::to_value(&status).unwrap_or_default();
        self.update(|s| s.recording = Some(status));
        Ok(status_value)
    }

    /// `stopRecording`: finalize the `.bin` (flush + fsync) and return the
    /// final counters; the raw file is kept for conversion or recovery.
    fn do_stop_recording(&mut self) -> Result<Value> {
        let Some(recorder) = self.recorder.take() else {
            return Err(err_device("没有进行中的录像。"));
        };
        // Clear the UI flag before finalizing: a failed flush must never
        // leave a phantom "recording" badge behind. The raw file remains.
        self.update(|s| s.recording = None);
        let summary = recorder.finish().map_err(|e| {
            self.log(
                &format!("录像文件收尾失败（原始文件仍保留）：{e}"),
                LogStream::Stderr,
            );
            e
        })?;
        Ok(serde_json::to_value(recording_status(&summary, false)).unwrap_or_default())
    }

    /// Media conversion/playback is local host work: it is only refused
    /// while a recording or a script is in flight. The board may stay
    /// connected; no serial command is issued by these operations.
    fn require_media_idle(&self) -> Result<()> {
        if self.recorder.is_some() || self.state.running {
            return Err(err_device("请先结束录像或停止脚本，再进行媒体操作。"));
        }
        Ok(())
    }

    fn do_convert_video(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.require_media_idle()?;
        let input = media_path(args.get("input"))?;
        let output = media_path(args.get("output"))?;
        let tools = media_tools_dir()?;
        let check = self.connect_check();
        nodu_media::convert(&input, &output, &tools, &check)?;
        Ok(Value::Null)
    }

    fn do_play_video(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.require_media_idle()?;
        let input = media_path(args.get("input"))?;
        let tools = media_tools_dir()?;
        let check = self.connect_check();
        nodu_media::play(&input, &tools, &check)?;
        Ok(Value::Null)
    }

    fn do_list_files(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.require(true)?;
        let path = remote_path(args.get("path").or(Some(&json!("/flash"))), false)?;
        let p = py_quote_str(&path);
        let value = self.eval(&format!(
            "[(n, tuple(os.stat({p} + '/' + n))) for n in os.listdir({p})]"
        ))?;
        let items = match value {
            PyValue::List(items) => items,
            _ => {
                return Err(err_device(
                    "Device directory listing returned malformed data.",
                ));
            }
        };
        let mut result = Vec::new();
        for item in items {
            let fields = match &item {
                PyValue::Tuple(t) | PyValue::List(t) => t.as_slice(),
                _ => continue,
            };
            let name = match fields.first() {
                Some(PyValue::Str(s)) => s.clone(),
                _ => continue,
            };
            if name.contains('/') || name == "." || name == ".." {
                continue;
            }
            let stat = fields.get(1).and_then(PyValue::as_tuple);
            let Some(stat) = stat else { continue };
            let size = self.stat_field(stat, 6).max(0) as u64;
            let directory = (self.stat_field(stat, 0) & 0x4000) != 0;
            result.push(json!({
                "name": name,
                "path": format!("{}/{}", path.trim_end_matches('/'), name),
                "size": size,
                "directory": directory,
            }));
        }
        result.sort_by(|a, b| {
            let da = a["directory"].as_bool().unwrap_or(false);
            let db = b["directory"].as_bool().unwrap_or(false);
            (da != true).cmp(&(db != true)).then_with(|| {
                a["name"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["name"].as_str().unwrap_or(""))
            })
        });
        Ok(Value::Array(result))
    }

    fn do_read_file(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.require(true)?;
        let path = remote_path(args.get("path"), false)?;
        let stat = self.stat_remote(&path)?;
        let Some(stat) = stat else {
            return Err(err_device(format!("Device file does not exist: {path}")));
        };
        if (self.stat_field(&stat, 0) & 0x4000) != 0 {
            return Err(err_device("Cannot read a directory as a file."));
        }
        if self.stat_field(&stat, 6) > MAX_FILE_BYTES as i64 {
            return Err(err_device("File exceeds the 2 MiB transfer limit."));
        }
        let mut result = Vec::new();
        let p = py_quote_str(&path);
        if self.mode == ConnMode::Ide {
            // Fresh `<stdin>` scope per EXEC_SCRIPT: open/seek/read/close in
            // one self-contained script per chunk.
            let size = self.stat_field(&stat, 6).max(0) as usize;
            while result.len() < size {
                self.check()?;
                let text = self.exec(
                    &format!(
                        "import os\n_nodu_file=open({p},\"rb\")\n_nodu_file.seek({})\nprint(repr(_nodu_file.read(512)))\n_nodu_file.close()",
                        result.len()
                    ),
                    false,
                    OPERATION_TIMEOUT,
                )?;
                let chunk = pyrepr::parse(
                    Self::ide_strip_tail(&text)
                        .trim_start_matches(['\x04', '>', ' ', '\r', '\n'])
                        .trim(),
                )
                .map_err(|e| err_device(format!("device response: {e}")))?;
                let PyValue::Bytes(chunk) = chunk else {
                    return Err(err_device("Invalid file response from device."));
                };
                if chunk.is_empty() {
                    // An early EOF means the device file shrank mid-read;
                    // returning a prefix would be a silent truncation.
                    return Err(err_device(
                        "Device file returned fewer bytes than its size.",
                    ));
                }
                result.extend_from_slice(&chunk);
                if result.len() > MAX_FILE_BYTES || result.len() > size {
                    return Err(err_device("Device file returned more bytes than its size."));
                }
            }
            // The file must not have changed size during the transfer.
            let after = self.stat_remote(&path)?;
            match after {
                Some(s) if self.stat_field(&s, 6) == size as i64 => {}
                _ => {
                    return Err(err_device("Device file size changed during transfer."));
                }
            }
        } else {
            self.exec(
                &format!("_nodu_file=open({p},\"rb\")"),
                false,
                OPERATION_TIMEOUT,
            )?;
            let read_result = (|this: &mut Self| -> Result<()> {
                loop {
                    this.check()?;
                    let chunk = this.eval("_nodu_file.read(512)")?;
                    let PyValue::Bytes(chunk) = chunk else {
                        return Err(err_device("Invalid file response from device."));
                    };
                    if chunk.is_empty() {
                        break;
                    }
                    result.extend_from_slice(&chunk);
                    if result.len() > MAX_FILE_BYTES {
                        return Err(err_device("File grew beyond the 2 MiB transfer limit."));
                    }
                }
                Ok(())
            })(self);
            let close_result = self.close_remote_file();
            read_result.and(close_result)?;
        }
        Ok(json!({
            "data": B64.encode(&result),
            "size": result.len(),
        }))
    }

    fn close_remote_file(&mut self) -> Result<()> {
        if self.mode == ConnMode::Ide {
            return Ok(());
        }
        if self.active_generation == self.shared.generation.load(Ordering::SeqCst)
            && !self.shared.input_closed.load(Ordering::SeqCst)
            && self.state.phase != DevicePhase::Error
        {
            self.exec(
                "_nodu_file.close()\ndel _nodu_file",
                false,
                OPERATION_TIMEOUT,
            )?;
        }
        Ok(())
    }

    fn do_write_file(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.require(true)?;
        // Normalize only: the startup gate below consults confirmedStartup,
        // so remote_path's unconditional writing rejection is not used here.
        let path = remote_path(args.get("path"), false)?;
        if !(path.starts_with("/flash/") || path.starts_with("/sd/")) {
            return Err(err_device("Expected a file path under /flash or /sd."));
        }
        let base = path.rsplit('/').next().unwrap_or("");
        if base.eq_ignore_ascii_case("boot.py") || base.eq_ignore_ascii_case("main.py") {
            match args.get("confirmedStartup") {
                Some(Value::Bool(true)) => {}
                Some(Value::Bool(false) | Value::Null) | None => {
                    return Err(err_device(
                        "保护：写入 boot.py/main.py 启动文件需要显式确认。",
                    ));
                }
                Some(_) => {
                    return Err(err_device("confirmedStartup must be a boolean."));
                }
            }
        }
        let data = decode_file(args.get("data"))?;
        let overwrite = match args.get("overwrite") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            _ => return Err(err_device("overwrite must be a boolean.")),
        };
        self.backup_record = None;
        let stat = self.stat_remote(&path)?;
        if stat
            .as_ref()
            .is_some_and(|s| (self.stat_field(s, 0) & 0x4000) != 0)
        {
            return Err(err_device("Cannot overwrite a directory."));
        }
        if stat.is_some() && !overwrite {
            return Err(err_device(
                "Device file already exists; explicit overwrite is required.",
            ));
        }
        let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or("/");
        let temporary = format!("{}/{}", dir.trim_end_matches('/'), temp_name());
        if self.stat_remote(&temporary)?.is_some() {
            return Err(err_device(
                "Transfer temporary path unexpectedly exists; retry.",
            ));
        }
        let tp = py_quote_str(&temporary);
        let ide = self.mode == ConnMode::Ide;
        let mut opened = false;
        let result = (|this: &mut Self| -> Result<()> {
            if ide {
                // Fresh `<stdin>` scope per EXEC_SCRIPT: create the file in
                // "wb" first so empty data still produces a real file, then
                // append each chunk with the device-verified write count.
                this.exec(
                    &format!("import os\n_nodu_file=open({tp},\"wb\")\n_nodu_file.close()"),
                    false,
                    OPERATION_TIMEOUT,
                )?;
                for chunk in data.chunks(512) {
                    let lit = py_quote_bytes(chunk);
                    let text = this.exec(
                        &format!(
                            "import os\n_nodu_file=open({tp},\"ab\")\ntry:\n print(_nodu_file.write({lit}))\nfinally:\n _nodu_file.close()"
                        ),
                        false,
                        OPERATION_TIMEOUT,
                    )?;
                    let cleaned = Self::ide_strip_tail(&text)
                        .trim_start_matches(['\x04', '>', ' ', '\r', '\n']);
                    let count = cleaned
                        .lines()
                        .next()
                        .and_then(|l| l.trim().parse::<i64>().ok())
                        .ok_or_else(|| err_device("Device write returned malformed data."))?;
                    if count != chunk.len() as i64 {
                        return Err(err_device("Device reported a short file write."));
                    }
                }
            } else {
                this.exec(
                    &format!("_nodu_file=open({tp},\"wb\")"),
                    false,
                    OPERATION_TIMEOUT,
                )?;
                opened = true;
                for chunk in data.chunks(512) {
                    let lit = py_quote_bytes(chunk);
                    let count = this.eval(&format!("_nodu_file.write({lit})"))?;
                    if count.as_int() != Some(chunk.len() as i64) {
                        return Err(err_device("Device reported a short file write."));
                    }
                }
                this.close_remote_file()?;
                opened = false;
            }
            let written = this.stat_remote(&temporary)?;
            match written {
                Some(s) if this.stat_field(&s, 6) == data.len() as i64 => {}
                _ => return Err(err_device("Device transfer size verification failed.")),
            }
            // Content verification: read the temporary back through the same
            // device path and compare digests before anything is renamed onto
            // the real target.
            let mut read_args = Map::new();
            read_args.insert("path".to_string(), json!(temporary));
            let read = this.do_read_file(&read_args)?;
            let read_back = decode_file(read.get("data"))?;
            if Sha256::digest(&read_back) != Sha256::digest(&data) {
                return Err(err_device(
                    "Device file integrity checksum mismatch after transfer.",
                ));
            }
            if !overwrite && this.stat_remote(&path)?.is_some() {
                return Err(err_device(
                    "Target appeared during transfer; refusing to overwrite.",
                ));
            }
            let pp = py_quote_str(&path);
            let prelude = if this.mode == ConnMode::Ide {
                "import os\n"
            } else {
                ""
            };
            this.exec(
                &format!("{prelude}os.rename({tp},{pp})"),
                false,
                OPERATION_TIMEOUT,
            )?;
            Ok(())
        })(self);
        if let Err(e) = result {
            if opened {
                let _ = self.close_remote_file();
            }
            let kind = if e.is_protocol() || e.is_cancelled() {
                e
            } else {
                err_device(e.to_string())
            };
            return Err(match kind {
                ReplError::Protocol(m) => ReplError::protocol(format!(
                    "{m} Transfer may remain at {temporary}; no user file was deleted."
                )),
                ReplError::Cancelled(m) => ReplError::Cancelled(format!(
                    "{m} Transfer may remain at {temporary}; no user file was deleted."
                )),
                ReplError::Device(m) | ReplError::Timeout(m) => err_device(format!(
                    "{m} Transfer may remain at {temporary}; no user file was deleted."
                )),
            });
        }
        Ok(Value::Null)
    }

    /// Idle-time poll: stream runScript output (raw_stage) like `_poll_raw`.
    fn poll(&mut self) -> Result<()> {
        if self.transport.is_none() || self.state.phase == DevicePhase::Error {
            return Ok(());
        }
        if self.mode == ConnMode::Ide {
            return self.poll_ide();
        }
        let Some(stage) = self.raw_stage else {
            return Ok(());
        };
        let Some(t) = self.transport.as_mut() else {
            return Ok(());
        };
        let waiting = t.in_waiting().map_err(|e| err_device(e.to_string()))?;
        if waiting == 0 {
            return Ok(());
        }
        let mut chunk = vec![0u8; waiting.min(32768)];
        let n = t.read(&mut chunk).map_err(|e| err_device(e.to_string()))?;
        chunk.truncate(n);
        let mut stage = stage;
        while !chunk.is_empty() {
            let pos = chunk.iter().position(|&b| b == 0x04);
            let (before, after) = match pos {
                Some(i) => (chunk[..i].to_vec(), Some(chunk[i + 1..].to_vec())),
                None => (chunk.clone(), None),
            };
            let text = if stage == LogStream::Stdout {
                self.stdout_decoder.decode(&before, pos.is_some())
            } else {
                self.stderr_decoder.decode(&before, pos.is_some())
            };
            self.log(&text, stage);
            let Some(after) = after else { return Ok(()) };
            if stage == LogStream::Stdout {
                stage = LogStream::Stderr;
                self.raw_stage = Some(LogStream::Stderr);
            } else {
                self.raw_stage = None;
                if let Some(t) = self.transport.as_mut() {
                    t.unread(&after);
                }
                self.update(|s| {
                    s.phase = DevicePhase::Connected;
                    s.running = false;
                });
                return Ok(());
            }
            chunk = after;
        }
        self.raw_stage = Some(stage);
        Ok(())
    }

    /// Finish bounded idle-poll transactions before servicing queued
    /// stop/disconnect requests. Cancelling a reply after its header has
    /// been sent would poison the IDE stream. Shutdown and deadlines still
    /// fail closed; request handlers retain generation cancellation.
    fn poll_ide_check(&self) -> Check {
        let deadline = self.deadline;
        let shared = Arc::clone(&self.shared);
        Arc::new(move || {
            if shared.input_closed.load(Ordering::SeqCst) {
                return Err(ReplError::cancelled());
            }
            if let Some(deadline) = deadline
                && Instant::now() > deadline
            {
                return Err(ReplError::timeout("Device operation timed out."));
            }
            Ok(())
        })
    }

    /// Idle-time poll for IDE connections: drain TX, track `running`, and
    /// pull a framebuffer frame whenever preview is on — including frames a
    /// user's own `sensor.snapshot()` produces while no script runs.
    fn poll_ide(&mut self) -> Result<()> {
        let preview = self.state.preview;
        let check = self.poll_ide_check();
        self.with_transport(|this, t| {
            // IDE replies have no transaction framing, so any timeout or
            // read error is a desync: propagate and let the caller close
            // the transport instead of skipping a cycle.
            let mut ide = IdeSession::new(t, check, this.ide_read_timeout(OPERATION_TIMEOUT))
                .with_stall_timeout(this.read_stall_timeout);
            let chunk = ide.output()?;
            let text = this.stdout_decoder.decode(&chunk, false);
            let mut sink = String::new();
            this.ide_emit(&text, true, &mut sink)?;
            if this.state.running {
                // The firmware's running flag lags script start: only treat
                // an early `false` as conclusive once the `>` prompt or a
                // grace window proves the script really ended.
                let grace = this
                    .ide_run_started
                    .is_some_and(|t| t.elapsed() < Duration::from_secs(3))
                    && !this.ide_holdback.trim_end().ends_with('>');
                if !ide.running()? && !grace {
                    // Script finished: flush the decoder and emit the
                    // trailing chunk minus firmware noise.
                    let tail = ide.output()?;
                    let text = this.stdout_decoder.decode(&tail, true);
                    let mut sink = String::new();
                    this.ide_emit(&text, true, &mut sink)?;
                    this.ide_finalize(true, &mut sink)?;
                    this.last_frame_at = None;
                    this.update(|s| {
                        s.phase = DevicePhase::Connected;
                        s.running = false;
                        s.fps = None;
                    });
                }
            }
            if preview {
                match ide.frame() {
                    Ok(Some(frame)) => {
                        // Append to the active recording before the frame
                        // event leaves; a write failure ends recording but
                        // never tears down the camera stream.
                        if let Some(recorder) = this.recorder.as_mut() {
                            match recorder.append(frame.width, frame.height, &frame.jpeg) {
                                Ok(_) => {
                                    let status = recording_status(&recorder.summary(), true);
                                    this.update(|s| s.recording = Some(status));
                                }
                                Err(e) => {
                                    let recorder = this.recorder.take().expect("recorder");
                                    let summary = recorder
                                        .finish()
                                        .unwrap_or_else(|_| recorder_summary_lost());
                                    let text = e.to_string();
                                    this.update(|s| {
                                        s.recording = Some(recording_status(&summary, false));
                                    });
                                    this.log(
                                        &format!("录像写入失败，已停止录像：{text}"),
                                        LogStream::Stderr,
                                    );
                                }
                            }
                        }
                        this.frame_sequence += 1;
                        let now = Instant::now();
                        let fps = this
                            .last_frame_at
                            .replace(now)
                            .map(|prev| 1.0 / (now - prev).as_secs_f64())
                            .filter(|f| f.is_finite() && *f > 0.0);
                        if fps.is_some() && this.state.fps != fps {
                            this.update(|s| s.fps = fps);
                        }
                        this.emit_event(&nodu_protocol::Event::Frame(nodu_protocol::DeviceFrame {
                            mime: "image/jpeg".into(),
                            data: B64.encode(&frame.jpeg),
                            width: frame.width,
                            height: frame.height,
                            sequence: this.frame_sequence,
                            time: now_millis(),
                        }));
                    }
                    Ok(None) => {}
                    Err(e) => return Err(e),
                }
            }
            Ok(())
        })
    }

    /// Serial-read failure outside a request: mark error and close (Python `_lost`).
    fn lost(&mut self, exc: &ReplError) {
        let text = exc.to_string();
        self.close_transport();
        self.update(|s| {
            s.phase = DevicePhase::Error;
            s.running = false;
            s.preview = false;
            s.capabilities = DeviceCapabilities::default();
            s.last_error = Some(text.clone());
        });
        self.log(&text, LogStream::Stderr);
    }
}

/// Status view of an in-flight or finished `Recorder` summary.
fn recording_status(summary: &nodu_media::RecordingSummary, active: bool) -> RecordingStatus {
    RecordingStatus {
        active,
        path: summary.path.clone(),
        frames: summary.frames,
        bytes: summary.bytes,
        elapsed_ms: summary.elapsed_ms,
    }
}

/// Placeholder counters when a failed recording cannot even be finalized.
fn recorder_summary_lost() -> nodu_media::RecordingSummary {
    nodu_media::RecordingSummary {
        path: String::new(),
        frames: 0,
        bytes: 0,
        elapsed_ms: 0,
    }
}

/// Absolute local media path argument: 1..4096 bytes, no NUL.
fn media_path(value: Option<&Value>) -> Result<std::path::PathBuf> {
    let raw = value.and_then(Value::as_str).unwrap_or("");
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\0') {
        return Err(err_device("Expected a valid absolute local file path."));
    }
    let path = std::path::PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(err_device("Expected an absolute local file path."));
    }
    Ok(path)
}

/// Bundled ffmpeg/ffplay directory: the sidecar's own directory, or the
/// dev-only `NODU_MEDIA_DIR` override (never a request parameter).
fn media_tools_dir() -> Result<std::path::PathBuf> {
    if let Ok(dir) = std::env::var("NODU_MEDIA_DIR")
        && !dir.is_empty()
    {
        return Ok(std::path::PathBuf::from(dir));
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(std::path::Path::to_path_buf))
        .ok_or_else(|| err_device("Cannot locate the bundled media tools."))
}

fn temp_name() -> String {
    format!(".nodu-transfer-{:016x}.tmp", unique_suffix())
}

fn unique_suffix() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ (u64::from(std::process::id()) << 16) ^ COUNTER.fetch_add(1, Ordering::SeqCst)
}

fn py_str(v: &PyValue) -> String {
    match v {
        PyValue::Str(s) => s.clone(),
        other => format!("{other:?}"),
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `readline`-equivalent with the Python line cap: a full line is consumed
/// regardless of length; the caller rejects when it exceeds 4 MiB.
fn read_line_capped(reader: &mut impl BufRead, out: &mut Vec<u8>) -> std::io::Result<usize> {
    out.clear();
    loop {
        let buf = reader.fill_buf()?;
        if buf.is_empty() {
            return Ok(out.len());
        }
        let consumed = buf
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buf.len(), |i| i + 1);
        let ended = buf[consumed - 1] == b'\n';
        let retain = consumed.min((MAX_LINE_BYTES + 1).saturating_sub(out.len()));
        out.extend_from_slice(&buf[..retain]);
        reader.consume(consumed);
        if ended {
            return Ok(out.len());
        }
    }
}

/// `validate_request`: returns (id, method, args) or an error.
fn validate_request(value: &Value) -> Result<(RequestId, String, Map<String, Value>)> {
    let Value::Object(obj) = value else {
        return Err(err_device("Request must be an object."));
    };
    let id = match obj.get("id") {
        Some(Value::String(s)) if !s.is_empty() && s.len() <= 128 => RequestId::Str(s.clone()),
        Some(Value::String(_)) => {
            return Err(err_device("Request id must have 1–128 characters."));
        }
        Some(Value::Number(n)) if n.as_i64().is_some() => {
            RequestId::Int(n.as_i64().unwrap_or_default())
        }
        _ => return Err(err_device("Request id must be a string or integer.")),
    };
    let method = match obj.get("method").and_then(Value::as_str) {
        Some(m) if METHODS.contains(&m) => m.to_string(),
        _ => return Err(err_device("Unknown device method.")),
    };
    let args = match obj.get("args") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(o)) => o.clone(),
        _ => return Err(err_device("Request args must be an object.")),
    };
    Ok((id, method, args))
}

/// `formatScript`: device-free comment stripping / indentation conversion.
fn do_format_script(args: &Map<String, Value>) -> Result<Value> {
    let Some(code) = args.get("code").and_then(Value::as_str) else {
        return Err(err_device("formatScript requires a string code argument."));
    };
    let strip = match args.get("stripComments") {
        Some(Value::Bool(b)) => *b,
        _ => return Err(err_device("stripComments must be a boolean.")),
    };
    let tabs = match args.get("spacesToTabs") {
        Some(Value::Bool(b)) => *b,
        _ => return Err(err_device("spacesToTabs must be a boolean.")),
    };
    script::format(code, strip, tabs)
        .map(Value::String)
        .map_err(err_device)
}

fn request_id_of(value: &Value) -> Option<Value> {
    match value.get("id") {
        Some(Value::String(s)) => Some(Value::String(s.clone())),
        Some(Value::Number(n)) => Some(Value::Number(n.clone())),
        _ => None,
    }
}
