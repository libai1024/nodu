// SPDX-License-Identifier: MIT
//! In-memory MaixPy 0.6.3 raw-REPL simulator for tests.
//!
//! Implements the byte-level contract `nodu-repl` speaks: normal mode with a
//! `>>> ` prompt, `\x03` → `KeyboardInterrupt`, `\x01` → raw banner, raw mode
//! where code ends at `\x04` and replies `OK` + `stdout\x04stderr\x04>`, and
//! Ctrl-C interruption of a running program.
//!
//! The evaluator only understands the exact command shapes `nodu-device`
//! issues (stat/listdir/open/read/write/close/rename/remove, uname/version)
//! plus a small user-code subset: `print` of ints/strings/int arithmetic,
//! `1/0` → ZeroDivisionError traceback, `import os; os.remove(...)`, and a
//! `while True:` print loop that runs until interrupted.

use std::collections::{HashMap, VecDeque};
use std::fmt::Write as _;
use std::io;
use std::sync::{Arc, Mutex};

use nodu_repl::pyrepr::{self, PyValue};
use nodu_serial::Transport;
use sha2::{Digest, Sha256};

const VERSION_REPR: &str = "'3.4.0; MaixPy with F481GC support\\n[MaixPy] v0.6.3'";
const UNAME_REPR: &str = "('MaixPy', 'K210', '0.6.3', 'v0.6.3-0', 'k210')";

#[derive(Debug, Clone, PartialEq)]
enum Entry {
    File(Vec<u8>),
    Dir,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Normal,
    Raw,
    /// Raw mode with an uploaded program still "running"; output is produced
    /// on read calls until a `\x03` interrupts it.
    Running,
    /// IDE binary protocol (`repl.init(..., ide=True)` executed).
    Ide,
}

#[derive(Debug)]
struct Board {
    mode: Mode,
    rx: VecDeque<u8>,
    pushback: VecDeque<u8>,
    /// Raw-mode code accumulator (between `\x01` entry and `\x04` end).
    code: Vec<u8>,
    vfs: HashMap<String, Entry>,
    open_file: Option<(String, Vec<u8>, usize, bool)>, // path, data, pos, writable
    tick: u64,
    /// IDE-protocol inbound command accumulator.
    ide_in: Vec<u8>,
    /// IDE TX buffer: script stdout the host polls via TX_LEN/TX_BUF.
    tx_buf: VecDeque<u8>,
    /// A script is running under the IDE protocol.
    ide_running: bool,
    fb_enabled: bool,
    /// Firmware keeps one framebuffer pending until FRAME_DUMP.
    frame_pending: bool,
    /// FILE_SAVE status reported through 0x88.
    fs_status: u32,
    /// Test hook: mid-read truncation — an IDE seek>0 chunk returns b''.
    truncate_reads: bool,
    /// Test hook: write counter; Some(n) fails host writes >= n.
    write_fail_at: Option<usize>,
    write_count: usize,
    /// Test hook: flip one stored byte of each written file while preserving
    /// the reported write count and stored size.
    corrupt_writes: bool,
}

impl Board {
    fn new() -> Self {
        let mut vfs = HashMap::new();
        vfs.insert("/flash".to_string(), Entry::Dir);
        vfs.insert("/sd".to_string(), Entry::Dir);
        vfs.insert(
            "/flash/main.py".to_string(),
            Entry::File(b"print('mock board')\n".to_vec()),
        );
        Self {
            mode: Mode::Normal,
            rx: VecDeque::new(),
            pushback: VecDeque::new(),
            code: Vec::new(),
            vfs,
            open_file: None,
            tick: 0,
            ide_in: Vec::new(),
            tx_buf: VecDeque::new(),
            ide_running: false,
            fb_enabled: false,
            frame_pending: false,
            fs_status: 0,
            truncate_reads: false,
            write_fail_at: None,
            write_count: 0,
            corrupt_writes: false,
        }
    }

    /// Reboot into normal mode and print the boot banner (DTR/RTS reset).
    fn reboot(&mut self) {
        self.mode = Mode::Normal;
        self.code.clear();
        self.ide_in.clear();
        self.tx_buf.clear();
        self.ide_running = false;
        self.frame_pending = false;
        self.out(b"\r\n[MaixPy] init end\r\n>>> ");
    }

    fn out(&mut self, data: &[u8]) {
        self.rx.extend(data.iter().copied());
    }

    fn stat(&self, path: &str) -> Option<(u32, u64)> {
        match self.vfs.get(path)? {
            Entry::Dir => Some((0o40755, 0)),
            Entry::File(d) => Some((0o100644, d.len() as u64)),
        }
    }

    /// Run one uploaded raw-REPL program; returns (stdout, stderr, still_running).
    fn execute(&mut self, code: &[u8]) -> (Vec<u8>, Vec<u8>, bool) {
        let text = String::from_utf8_lossy(code).replace("\r\n", "\n");
        let trimmed = text.trim();
        let mut stdout = Vec::new();
        let stderr = Vec::new();

        // `repl.init(..., ide=True)` switches the board to the IDE binary
        // protocol the moment the command completes (firmware-side).
        if trimmed.contains("ide=True") {
            self.mode = Mode::Ide;
            return (stdout, stderr, false);
        }

        // --- commands the device service issues ---
        if trimmed.contains("tuple(os.uname())") {
            stdout.extend_from_slice(format!("{VERSION_REPR}\n{UNAME_REPR}\n").as_bytes());
            return (stdout, stderr, false);
        }
        if trimmed.contains("except OSError")
            && let Some(arg) = between(trimmed, "tuple(os.stat(", ")")
            && let Some(PyValue::Str(path)) = parse_py_arg(arg)
        {
            match self.stat(&path) {
                Some((mode, size)) => stdout.extend_from_slice(stat_repr(mode, size).as_bytes()),
                None => stdout.extend_from_slice(b"ERR 2\n"),
            }
            return (stdout, stderr, false);
        }
        let listdir_probe = trimmed.strip_prefix("import os\n").unwrap_or(trimmed);
        if listdir_probe.starts_with("print(repr([(n, tuple(os.stat(") {
            #[allow(clippy::collapsible_if)]
            if let Some(dir) = between(listdir_probe, "for n in os.listdir(", ")")
                && let Some(PyValue::Str(dir)) = parse_py_arg(dir.trim_end())
            {
                if matches!(self.vfs.get(&dir), Some(Entry::Dir)) {
                    let mut parts = Vec::new();
                    let prefix = format!("{dir}/");
                    let mut names: Vec<String> = self
                        .vfs
                        .keys()
                        .filter(|k| k.starts_with(&prefix))
                        .filter_map(|k| {
                            let rest = &k[prefix.len()..];
                            (!rest.contains('/') && !rest.is_empty()).then(|| rest.to_string())
                        })
                        .collect();
                    names.sort();
                    for name in names {
                        let p = format!("{prefix}{name}");
                        let (mode, size) = self.stat(&p).unwrap_or((0o100644, 0));
                        parts.push(format!("({name:?}, {})", stat_tuple(mode, size)));
                    }
                    stdout.extend_from_slice(format!("[{}]\n", parts.join(", ")).as_bytes());
                } else {
                    stdout.extend_from_slice(b"[]\n");
                }
                return (stdout, stderr, false);
            }
        }
        // --- IDE self-contained file scripts (fresh <stdin> scope) ---
        if let Some(rest) = trimmed.strip_prefix("import os\n_nodu_file=open(")
            && let Some(path_lit) = between(rest, "", ",")
            && let Some(PyValue::Str(path)) = parse_py_arg(path_lit)
        {
            if rest.contains("\"wb\"") {
                self.vfs.insert(path, Entry::File(Vec::new()));
                return (stdout, stderr, false);
            }
            if rest.contains("\"ab\"") {
                // `try: print(_nodu_file.write(LIT)) finally: _nodu_file.close()`
                let Some(lit) = between(trimmed, "_nodu_file.write(", "))\nfinally") else {
                    return (stdout, traceback("SyntaxError", "invalid syntax"), false);
                };
                let Ok(PyValue::Bytes(chunk)) = pyrepr::parse(lit) else {
                    return (stdout, traceback("SyntaxError", "invalid syntax"), false);
                };
                if let Some(Entry::File(d)) = self.vfs.get_mut(&path) {
                    let first = d.is_empty();
                    d.extend_from_slice(&chunk);
                    if self.corrupt_writes && first && !chunk.is_empty() {
                        d[0] ^= 0xFF;
                    }
                    let count = chunk.len();
                    stdout.extend_from_slice(format!("{count}\n").as_bytes());
                } else {
                    return (stdout, traceback("OSError", "no such file"), false);
                }
                return (stdout, stderr, false);
            }
            if rest.contains("\"rb\"") {
                // `_nodu_file.seek(N); print(repr(_nodu_file.read(512))); close`
                let off: usize = between(trimmed, "_nodu_file.seek(", ")")
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
                match self.vfs.get(&path) {
                    Some(Entry::File(d)) => {
                        let bytes = if self.truncate_reads && off > 0 {
                            // Simulate a device file shrinking mid-transfer.
                            Vec::new()
                        } else {
                            d[off.min(d.len())..(off + 512).min(d.len())].to_vec()
                        };
                        stdout.extend_from_slice(bytes_repr(&bytes).as_bytes());
                        stdout.push(b'\n');
                    }
                    _ => return (stdout, traceback("OSError", "no such file"), false),
                }
                return (stdout, stderr, false);
            }
            return (stdout, traceback("OSError", "bad mode"), false);
        }
        if let Some(rest) = trimmed.strip_prefix("_nodu_file=open(") {
            // `_nodu_file=open('P',"rb")` or `"wb"`
            let writable = rest.contains("\"wb\"") || rest.contains("'wb'");
            if let Some(path_lit) = between(rest, "", ",")
                && let Some(PyValue::Str(path)) = parse_py_arg(path_lit)
            {
                let data = if writable {
                    Vec::new()
                } else {
                    match self.vfs.get(&path) {
                        Some(Entry::File(d)) => d.clone(),
                        _ => {
                            return (stdout, traceback("OSError", "no such file"), false);
                        }
                    }
                };
                self.open_file = Some((path, data, 0, writable));
            }
            return (stdout, stderr, false);
        }
        if trimmed == "_nodu_file.close()\ndel _nodu_file" || trimmed == "_nodu_file.close()" {
            if let Some((path, data, _, true)) = self.open_file.take() {
                self.vfs.insert(path, Entry::File(data));
            } else {
                self.open_file = None;
            }
            return (stdout, stderr, false);
        }
        if let Some(inner) = trimmed.strip_prefix("print(repr(_nodu_file.read(")
            && let Some((_, data, pos, _)) = &self.open_file
        {
            let n: usize = inner.trim_end_matches(')').trim().parse().unwrap_or(0);
            let end = (*pos + n).min(data.len());
            stdout.extend_from_slice(bytes_repr(&data[*pos..end]).as_bytes());
            stdout.push(b'\n');
            if let Some((_, _, pos, _)) = &mut self.open_file {
                *pos = end;
            }
            return (stdout, stderr, false);
        }
        if let Some(inner) = trimmed.strip_prefix("print(repr(_nodu_file.write(") {
            let lit = inner.trim_end_matches(')').trim();
            if let Ok(PyValue::Bytes(chunk)) = pyrepr::parse(lit) {
                let count = chunk.len();
                if let Some((_, data, pos, true)) = &mut self.open_file {
                    data.truncate(*pos);
                    let first = data.is_empty();
                    data.extend_from_slice(&chunk);
                    if self.corrupt_writes && first && !chunk.is_empty() {
                        data[0] ^= 0xFF;
                    }
                    *pos += count;
                }
                stdout.extend_from_slice(format!("{count}\n").as_bytes());
                return (stdout, stderr, false);
            }
        }
        if let Some(rest) = trimmed
            .strip_prefix("os.rename(")
            .or_else(|| trimmed.strip_prefix("import os\nos.rename("))
        {
            let inner = rest.trim_end_matches(')');
            if let Some((a, b)) = inner.split_once(',')
                && let Some(PyValue::Str(from)) = parse_py_arg(a.trim())
                && let Some(PyValue::Str(to)) = parse_py_arg(b.trim())
            {
                if let Some(entry) = self.vfs.remove(&from) {
                    self.vfs.insert(to, entry);
                } else {
                    return (stdout, traceback("OSError", "no such file"), false);
                }
            }
            return (stdout, stderr, false);
        }
        if let Some(rest) = trimmed
            .strip_prefix("import os; os.remove(")
            .or_else(|| trimmed.strip_prefix("import os\nos.remove("))
            .or_else(|| trimmed.strip_prefix("os.remove("))
        {
            let inner = rest.trim_end_matches(')');
            if let Some(PyValue::Str(path)) = parse_py_arg(inner.trim())
                && self.vfs.remove(&path).is_none()
            {
                return (stdout, traceback("OSError", "no such file"), false);
            }
            return (stdout, stderr, false);
        }

        // --- user-code subset for tests ---
        if trimmed == "1/0" {
            return (
                stdout,
                traceback("ZeroDivisionError", "divide by zero"),
                false,
            );
        }
        if trimmed.starts_with("while True:") || trimmed.contains("while True:") {
            // Runs until the host interrupts with \x03.
            return (stdout, stderr, true);
        }
        if let Some(expr) = trimmed
            .strip_prefix("import sys\nsys.stdout.write(")
            .and_then(|s| s.strip_suffix(')'))
        {
            match eval_print_arg(expr.trim()) {
                Ok(line) => stdout.extend_from_slice(line.as_bytes()), // no newline
                Err(msg) => return (stdout, traceback("SyntaxError", &msg), false),
            }
            return (stdout, stderr, false);
        }
        if let Some(expr) = trimmed
            .strip_prefix("print(")
            .and_then(|s| s.strip_suffix(')'))
        {
            match eval_print_arg(expr.trim()) {
                Ok(line) => {
                    stdout.extend_from_slice(line.as_bytes());
                    stdout.push(b'\n');
                }
                Err(msg) => return (stdout, traceback("SyntaxError", &msg), false),
            }
            return (stdout, stderr, false);
        }
        if trimmed.starts_with("print ") || trimmed.is_empty() || trimmed.starts_with("import ") {
            return (stdout, stderr, false);
        }
        (stdout, traceback("SyntaxError", "invalid syntax"), false)
    }
}

fn stat_tuple(mode: u32, size: u64) -> String {
    format!("({mode}, 0, 0, 0, 0, 0, {size}, 0, 0, 0)")
}

fn stat_repr(mode: u32, size: u64) -> String {
    format!("{}\n", stat_tuple(mode, size))
}

fn traceback(kind: &str, msg: &str) -> Vec<u8> {
    format!(
        "Traceback (most recent call last):\r\n  File \"<stdin>\", line 1, in <module>\r\n{kind}: {msg}\r\n"
    )
    .into_bytes()
}

/// repr() of a byte string: `b'...'` with Python-style escapes.
fn bytes_repr(data: &[u8]) -> String {
    let mut s = String::from("b'");
    for &b in data {
        match b {
            b'\\' => s.push_str("\\\\"),
            b'\'' => s.push_str("\\'"),
            b'\n' => s.push_str("\\n"),
            b'\r' => s.push_str("\\r"),
            b'\t' => s.push_str("\\t"),
            0x20..=0x7e => s.push(b as char),
            b => {
                let _ = write!(s, "\\x{b:02x}");
            }
        }
    }
    s.push('\'');
    s
}

/// Extract the substring between the first `start` marker and the next `end`.
fn between<'a>(hay: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let from = if start.is_empty() {
        0
    } else {
        hay.find(start)? + start.len()
    };
    let rest = &hay[from..];
    Some(&rest[..rest.find(end)?])
}

/// Parse a `repr`-style literal argument (string or bytes or int).
fn parse_py_arg(text: &str) -> Option<PyValue> {
    pyrepr::parse(text.trim()).ok()
}

/// Tiny evaluator for `print(<expr>)` user statements in tests.
fn eval_print_arg(expr: &str) -> Result<String, String> {
    if let Ok(v) = pyrepr::parse(expr) {
        return Ok(match v {
            PyValue::Str(s) => s,
            PyValue::Int(i) => i.to_string(),
            PyValue::Bool(b) => if b { "True" } else { "False" }.to_string(),
            PyValue::None => "None".to_string(),
            other => format!("{other:?}"),
        });
    }
    // Simple int arithmetic: `a <op> b` for + - * //.
    for op in ["//", "+", "-", "*"] {
        if let Some((a, b)) = expr.split_once(op)
            && let (Ok(a), Ok(b)) = (a.trim().parse::<i64>(), b.trim().parse::<i64>())
        {
            let r = match op {
                "+" => a + b,
                "-" => a - b,
                "*" => a * b,
                _ => {
                    if b == 0 {
                        return Err("divide by zero".into());
                    }
                    a.div_euclid(b)
                }
            };
            return Ok(r.to_string());
        }
    }
    Err(format!("cannot evaluate {expr:?}"))
}

/// A `Transport` whose peer is an in-memory mock board.
#[derive(Debug, Clone)]
pub struct MockBoard {
    inner: Arc<Mutex<Board>>,
}

impl Default for MockBoard {
    fn default() -> Self {
        Self::new()
    }
}

impl MockBoard {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Board::new())),
        }
    }

    /// Test hook: current VFS contents.
    pub fn file(&self, path: &str) -> Option<Vec<u8>> {
        match self.inner.lock().ok()?.vfs.get(path) {
            Some(Entry::File(d)) => Some(d.clone()),
            _ => None,
        }
    }

    /// Test hook: push raw bytes into the IDE TX buffer (split-decoder tests).
    pub fn push_tx(&self, data: &[u8]) {
        if let Ok(mut b) = self.inner.lock() {
            b.tx_buf.extend(data.iter().copied());
        }
    }

    /// Test hook: fail the Nth and later host->board writes (desync test).
    pub fn fail_writes_after(&self, n: usize) {
        if let Ok(mut b) = self.inner.lock() {
            b.write_fail_at = Some(b.write_count.saturating_add(n));
        }
    }

    /// Test hook: corrupt exactly one stored byte per file write while the
    /// acknowledged write count and stored size stay correct.
    pub fn set_corrupt_writes(&self, on: bool) {
        if let Ok(mut b) = self.inner.lock() {
            b.corrupt_writes = on;
        }
    }

    /// Test hook: an IDE read chunk at offset >0 returns empty once enabled.
    pub fn set_truncate_reads(&self, on: bool) {
        if let Ok(mut b) = self.inner.lock() {
            b.truncate_reads = on;
        }
    }

    /// Test hook: plant a file in the fake VFS.
    pub fn plant(&self, path: &str, data: &[u8]) {
        if let Ok(mut b) = self.inner.lock() {
            b.vfs.insert(path.to_string(), Entry::File(data.to_vec()));
        }
    }
}

impl Transport for MockBoard {
    fn in_waiting(&mut self) -> io::Result<usize> {
        let mut b = self.inner.lock().expect("mock board poisoned");
        if b.mode == Mode::Running {
            // A running program produces stdout on poll.
            b.tick += 1;
            let line = format!("tick{}\n", b.tick);
            b.rx.extend(line.as_bytes().iter().copied());
        }
        if b.mode == Mode::Ide && b.ide_running {
            b.tick += 1;
            let line = format!("tick{}\n", b.tick);
            b.tx_buf.extend(line.as_bytes().iter().copied());
            if b.fb_enabled {
                b.frame_pending = true;
            }
        }
        Ok(b.pushback.len() + b.rx.len())
    }

    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut b = self.inner.lock().expect("mock board poisoned");
        let mut n = 0;
        while n < buf.len() {
            if let Some(c) = b.pushback.pop_front().or_else(|| b.rx.pop_front()) {
                buf[n] = c;
                n += 1;
            } else {
                break;
            }
        }
        Ok(n)
    }

    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        let mut b = self.inner.lock().expect("mock board poisoned");
        b.write_count += 1;
        if b.write_fail_at.is_some_and(|n| b.write_count >= n) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "mock write failure",
            ));
        }
        for &c in buf {
            match b.mode {
                Mode::Normal => match c {
                    0x03 => b.out(b"\r\nKeyboardInterrupt\r\n>>> "),
                    0x01 => {
                        b.mode = Mode::Raw;
                        b.code.clear();
                        b.out(b"raw REPL; CTRL-B to exit\r\n>");
                    }
                    _ => {}
                },
                Mode::Raw => match c {
                    0x04 => {
                        let code = std::mem::take(&mut b.code);
                        b.out(b"OK");
                        let (stdout, stderr, running) = b.execute(&code);
                        if running {
                            b.mode = Mode::Running;
                        } else {
                            b.out(&stdout);
                            b.out(b"\x04");
                            b.out(&stderr);
                            b.out(b"\x04>");
                        }
                    }
                    0x03 => b.out(b"KeyboardInterrupt\r\n"),
                    0x02 => {
                        b.mode = Mode::Normal;
                        b.out(b"normal REPL; CTRL-D to exit\r\n>>> ");
                    }
                    c => b.code.push(c),
                },
                Mode::Running => {
                    if c == 0x03 {
                        // Interrupt the running program; emit end markers.
                        b.mode = Mode::Raw;
                        b.out(b"\x04");
                        b.out(&traceback("KeyboardInterrupt", ""));
                        b.out(b"\x04>");
                    }
                }
                Mode::Ide => {
                    b.ide_in.push(c);
                    b.dispatch_ide();
                }
            }
        }
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn reset_input_buffer(&mut self) -> io::Result<()> {
        let mut b = self.inner.lock().expect("mock board poisoned");
        b.pushback.clear();
        b.rx.clear();
        Ok(())
    }

    fn set_baud_rate(&mut self, _baud: u32) -> io::Result<()> {
        Ok(())
    }

    fn unread(&mut self, data: &[u8]) {
        if let Ok(mut b) = self.inner.lock() {
            for &c in data.iter().rev() {
                b.pushback.push_front(c);
            }
        }
    }

    fn set_dtr(&mut self, level: bool) -> io::Result<()> {
        // Original reset sequences start from (0,0): model that as a reboot.
        if !level && let Ok(mut b) = self.inner.lock() {
            b.reboot();
        }
        Ok(())
    }

    fn set_rts(&mut self, _level: bool) -> io::Result<()> {
        Ok(())
    }
}

/// Deterministic real 320x240 JPEG fixture (gradient render, sips-encoded);
/// the host validates SOF dimensions against the frame header.
fn jpeg_fixture() -> Vec<u8> {
    include_bytes!("../tests/fixtures/frame-320x240.jpg").to_vec()
}

impl Board {
    /// Firmware-side IDE command dispatch: consume `ide_in`, emit replies on
    /// `rx`. Header is 6 bytes `[0x30, cmd, len:u32 LE]`; write commands then
    /// carry payload (`FB_ENABLE` reads a bare i16 outside its zero length).
    fn dispatch_ide(&mut self) {
        loop {
            // Resync to the command marker.
            while !self.ide_in.is_empty() && self.ide_in[0] != 0x30 {
                self.ide_in.remove(0);
            }
            if self.ide_in.len() < 6 {
                return;
            }
            let cmd = self.ide_in[1];
            let len = u32::from_le_bytes([
                self.ide_in[2],
                self.ide_in[3],
                self.ide_in[4],
                self.ide_in[5],
            ]) as usize;
            let payload_len = match cmd {
                0x05 | 0x07 => len,
                0x0d => 2, // i16 outside the declared length
                _ => 0,
            };
            if self.ide_in.len() < 6 + payload_len {
                return;
            }
            let payload: Vec<u8> = self.ide_in.drain(6..6 + payload_len).collect();
            self.ide_in.drain(..6);
            match cmd {
                // USBDBG_QUERY_STATUS
                0x8d => self.out(&[0xAA, 0xBB, 0xEE, 0xFF]),
                // USBDBG_FW_VERSION → 0.6.3
                0x80 => {
                    let mut r = Vec::with_capacity(12);
                    for v in [0u32, 6, 3] {
                        r.extend_from_slice(&v.to_le_bytes());
                    }
                    self.out(&r);
                }
                // USBDBG_ARCH_STR → 64-byte padded
                0x83 => {
                    let mut r = b"Sipeed_M1 with kendryte-k210".to_vec();
                    r.resize(64, 0);
                    self.out(&r);
                }
                // USBDBG_SCRIPT_RUNNING
                0x87 => {
                    let v = u32::from(self.ide_running);
                    self.out(&v.to_le_bytes());
                }
                // USBDBG_TX_BUF_LEN — a running script keeps producing output.
                0x8e => {
                    if self.ide_running {
                        self.tick += 1;
                        let line = format!("tick{}\n", self.tick);
                        self.tx_buf.extend(line.as_bytes().iter().copied());
                        if self.fb_enabled {
                            self.frame_pending = true;
                        }
                    }
                    let v = self.tx_buf.len() as u32;
                    self.out(&v.to_le_bytes());
                }
                // USBDBG_TX_BUF
                0x8f => {
                    let n = len.min(self.tx_buf.len());
                    let data: Vec<u8> = self.tx_buf.drain(..n).collect();
                    self.rx.extend(data.iter().copied());
                    self.rx.extend(std::iter::repeat_n(0, len - n));
                }
                // USBDBG_FRAME_SIZE → w,h,jpegBytes (w=0 when nothing pending)
                0x81 => {
                    let mut r = Vec::with_capacity(12);
                    if self.frame_pending {
                        for v in [320u32, 240, jpeg_fixture().len() as u32] {
                            r.extend_from_slice(&v.to_le_bytes());
                        }
                    } else {
                        for v in [0u32, 240, 12345] {
                            r.extend_from_slice(&v.to_le_bytes());
                        }
                    }
                    self.out(&r);
                }
                // USBDBG_FRAME_DUMP
                0x82 => {
                    self.frame_pending = false;
                    let mut data = jpeg_fixture();
                    data.truncate(len);
                    self.out(&data);
                }
                // USBDBG_SCRIPT_EXEC
                0x05 => {
                    let (stdout, stderr, running) = self.execute(&payload);
                    self.tx_buf.extend(stdout.iter().copied());
                    self.tx_buf.extend(stderr.iter().copied());
                    self.ide_running = running;
                    if !running {
                        // Real firmware re-enters the raw REPL after each
                        // script and emits this tail over TX.
                        self.tx_buf.extend(
                            b"raw REPL; CTRL-B to exit
>"
                            .iter()
                            .copied(),
                        );
                    }
                }
                // USBDBG_SCRIPT_STOP
                0x06 => {
                    if self.ide_running {
                        self.ide_running = false;
                        self.tx_buf.extend(
                            b"Traceback (most recent call last):\r\nException: IDE interrupt\r\n"
                                .iter()
                                .copied(),
                        );
                    }
                }
                // USBDBG_FB_ENABLE (i16 payload past a zero length header)
                0x0d => {
                    self.fb_enabled = payload.first().copied().unwrap_or(0) != 0;
                    if self.fb_enabled && self.ide_running {
                        self.frame_pending = true;
                    }
                }
                // USBDBG_SYS_RESET → back to normal REPL with boot banner
                0x0c => self.reboot(),
                // USBDBG_FILE_SAVE
                0x07 => {
                    self.fs_status = self.file_save(&payload);
                }
                // USBDBG_FILE_SAVE_STATUS
                0x88 => {
                    let v = self.fs_status;
                    self.out(&v.to_le_bytes());
                }
                _ => {}
            }
        }
    }

    /// Verify `[sha256][name NUL pad4][data]` and write into the VFS.
    fn file_save(&mut self, payload: &[u8]) -> u32 {
        if payload.len() < 36 {
            return 6; // checksum parse failure
        }
        let (hash, rest) = payload.split_at(32);
        if Sha256::digest(rest).as_slice() != hash {
            return 6;
        }
        let nul = rest.iter().position(|b| *b == 0);
        let Some(nul) = nul.filter(|n| *n < rest.len()) else {
            return 3;
        };
        let name_len = (nul + 4) & !3;
        let Ok(name) = std::str::from_utf8(&rest[..nul]) else {
            return 3;
        };
        let data = &rest[name_len.min(rest.len())..];
        let mut stored = data.to_vec();
        if self.corrupt_writes && !stored.is_empty() {
            stored[0] ^= 0xFF;
        }
        self.vfs.insert(name.to_string(), Entry::File(stored));
        0
    }
}
