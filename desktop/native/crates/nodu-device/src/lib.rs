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

use std::collections::{BinaryHeap, HashSet};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use nodu_protocol::{
    DeviceCapabilities, DevicePhase, DeviceState, Event, LogStream, MAX_LINE_BYTES, METHODS,
    RequestId, UNIMPLEMENTED_MESSAGE,
};
use nodu_repl::pyrepr::{self, PyValue};
use nodu_repl::{MAX_FILE_BYTES, OPERATION_TIMEOUT, ReplError, Session};
use nodu_serial::Transport;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

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
        }
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
        let shared = Arc::clone(&self.shared);
        let check = move || {
            if active != shared.generation.load(Ordering::SeqCst)
                || shared.input_closed.load(Ordering::SeqCst)
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
            Box::new(check),
        )
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
                    self.deadline = Some(Instant::now() + Duration::from_secs(5));
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
            let _ = t.write_all(b"\x03");
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
                self.deadline = Some(Instant::now() + Duration::from_secs(5));
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
        let active = !matches!(item.method.as_str(), "getState" | "listPorts");
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
            "setPreview" | "startCamera" | "prepareFirmware" | "backupDevice" | "flashFirmware" => {
                Err(err_device(UNIMPLEMENTED_MESSAGE))
            }
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
            ReplError::Device(m) => {
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
        let text = self.exec(
            &format!("print(repr({expression}))"),
            false,
            OPERATION_TIMEOUT,
        )?;
        pyrepr::parse(text.trim()).map_err(|e| err_device(format!("device response: {e}")))
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
        match pyrepr::parse(&text) {
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
        if self.transport.is_some()
            && self.state.port.as_deref() == Some(port)
            && self.state.board_profile.as_deref() == Some(profile)
            && self.baud == baud
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
            s.running = false;
            s.preview = false;
            s.firmware = None;
            s.architecture = None;
        });
        self.port_lock = Some(PortLock::acquire(port)?);
        let transport = (self.transport_factory)(port, baud)?;
        self.transport = Some(transport);
        self.baud = baud;
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
                firmware: false,
            };
        }))
        .unwrap_or_default())
    }

    fn close_transport(&mut self) {
        self.transport = None;
        self.port_lock = None;
        self.raw_stage = None;
        self.baud = 115200;
    }

    fn do_disconnect(&mut self) -> Result<Value> {
        self.active_generation = self.shared.generation.load(Ordering::SeqCst);
        if self.transport.is_some() {
            if let Err(e) = self.do_stop() {
                self.log(&format!("Disconnect recovery: {e}"), LogStream::System);
            }
        }
        self.close_transport();
        self.update(|s| {
            s.phase = DevicePhase::Disconnected;
            s.port = None;
            s.running = false;
            s.preview = false;
            s.capabilities = DeviceCapabilities::default();
        });
        Ok(Value::Null)
    }

    fn do_execute(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.require(true)?;
        let code = self.valid_code(args)?.to_string();
        let out = self.exec(&code, true, OPERATION_TIMEOUT)?;
        Ok(Value::String(out))
    }

    fn do_run_script(&mut self, args: &Map<String, Value>) -> Result<Value> {
        self.require(true)?;
        let code = self.valid_code(args)?.to_string();
        self.check()?;
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
                    ReplError::Device(m) => {
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
        {
            let mut session = self.session();
            session.enter_raw_repl(Duration::from_secs(5))?;
        }
        self.update(|s| {
            s.phase = DevicePhase::Connected;
            s.running = false;
            s.preview = false;
        });
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
        Ok(json!({
            "data": B64.encode(&result),
            "size": result.len(),
        }))
    }

    fn close_remote_file(&mut self) -> Result<()> {
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
        let path = remote_path(args.get("path"), true)?;
        let data = decode_file(args.get("data"))?;
        let overwrite = match args.get("overwrite") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            _ => return Err(err_device("overwrite must be a boolean.")),
        };
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
        let mut opened = false;
        let result = (|this: &mut Self| -> Result<()> {
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
            let written = this.stat_remote(&temporary)?;
            match written {
                Some(s) if this.stat_field(&s, 6) == data.len() as i64 => {}
                _ => return Err(err_device("Device transfer size verification failed.")),
            }
            if !overwrite && this.stat_remote(&path)?.is_some() {
                return Err(err_device(
                    "Target appeared during transfer; refusing to overwrite.",
                ));
            }
            let pp = py_quote_str(&path);
            this.exec(&format!("os.rename({tp},{pp})"), false, OPERATION_TIMEOUT)?;
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
                ReplError::Device(m) => err_device(format!(
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

    /// Serial-read failure outside a request: mark error and close (Python `_lost`).
    fn lost(&mut self, exc: &ReplError) {
        let text = exc.to_string();
        self.close_transport();
        self.update(|s| {
            s.phase = DevicePhase::Error;
            s.running = false;
            s.preview = false;
            s.last_error = Some(text.clone());
        });
        self.log(&text, LogStream::Stderr);
    }
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

fn request_id_of(value: &Value) -> Option<Value> {
    match value.get("id") {
        Some(Value::String(s)) => Some(Value::String(s.clone())),
        Some(Value::Number(n)) => Some(Value::Number(n.clone())),
        _ => None,
    }
}
