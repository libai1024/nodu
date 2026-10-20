// SPDX-License-Identifier: MIT
// Ported from mpremote@1.25.0:mpremote/transport_serial.py (MIT) and
// k210-studio nodu_device_worker.py:K210Transport (MIT).
// Source: mpremote 1.25.0 mpremote/transport_serial.py (read_until,
// exec_raw_no_follow, enter_raw_repl, follow, exec_raw)
// Source: k210-studio dc0aba3 desktop/scope-extension/resources/nodu_device_worker.py (K210Transport)
//! Raw-REPL session over a `nodu_serial::Transport`.
//!
//! Mirrors the Python worker exactly: K210 enter sequence (`\r\x03\x02\r`
//! every 50 ms until `>>>`), mpremote raw handshake (`\r\x03`, flush, `\r\x01`,
//! wait for `raw REPL; CTRL-B to exit`), 256-byte paced upload ending in
//! `\x04`, `OK` ack, two-stage `follow` (`\x04` stdout, `\x04` stderr), and
//! the 4 MiB output bound.

pub mod pyrepr;

use std::fmt;
use std::io;
use std::time::{Duration, Instant};

use nodu_serial::Transport;

pub const OPERATION_TIMEOUT: Duration = Duration::from_secs(20);
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;

/// Failure classes matching the Python worker's `DeviceError`/`Cancelled`/
/// `ProtocolError` split; `Protocol` triggers `phase: error` host-side.
#[derive(Debug)]
pub enum ReplError {
    Device(String),
    Cancelled(String),
    Protocol(String),
    /// A caller-supplied deadline or cancellation fired before any bytes
    /// were written for this operation. It is not evidence that the device
    /// is merely busy; the safe response is to close and reconnect.
    Timeout(String),
}

impl ReplError {
    pub fn device(message: impl Into<String>) -> Self {
        Self::Device(message.into())
    }
    pub fn cancelled() -> Self {
        Self::Cancelled("Operation cancelled by stop, disconnect, or worker shutdown.".into())
    }
    pub fn protocol(message: impl Into<String>) -> Self {
        Self::Protocol(message.into())
    }
    pub fn is_protocol(&self) -> bool {
        matches!(self, Self::Protocol(_))
    }
    pub fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled(_))
    }
    pub fn is_timeout(&self) -> bool {
        matches!(self, Self::Timeout(_))
    }
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::Timeout(message.into())
    }
}

impl fmt::Display for ReplError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Device(m) | Self::Cancelled(m) | Self::Protocol(m) | Self::Timeout(m) => {
                f.write_str(m)
            }
        }
    }
}

impl std::error::Error for ReplError {}

impl From<io::Error> for ReplError {
    fn from(e: io::Error) -> Self {
        Self::Device(if e.to_string().is_empty() {
            "serial I/O failed".into()
        } else {
            e.to_string()
        })
    }
}

/// Periodic cancellation/deadline probe supplied by the caller; returns
/// `Err(ReplError::Cancelled)` or a timeout `Device` error to abort.
pub type Check = std::sync::Arc<dyn Fn() -> Result<(), ReplError> + Send + Sync>;

/// `check()` callback usable when cancellation is impossible.
pub fn never_cancel() -> Check {
    std::sync::Arc::new(|| Ok(()))
}

/// A raw-REPL session bound to one transport.
#[allow(missing_debug_implementations)]
pub struct Session<'t> {
    pub transport: &'t mut dyn Transport,
    /// Clamps `read_until` overall timeouts (mpremote `operation_timeout`).
    pub operation_timeout: Duration,
    check: Check,
}

impl<'t> Session<'t> {
    pub fn new(transport: &'t mut dyn Transport, check: Check) -> Self {
        Self {
            transport,
            operation_timeout: OPERATION_TIMEOUT,
            check,
        }
    }

    pub fn check(&self) -> Result<(), ReplError> {
        (self.check)()
    }

    /// Read until `ending` appears; bytes past it are pushed back and the
    /// ending itself is stripped, exactly like the Python `read_until`.
    /// `data_consumer` receives all bytes except a trailing
    /// `len(ending)`-byte holdback.
    #[allow(clippy::type_complexity)]
    pub fn read_until(
        &mut self,
        ending: &[u8],
        timeout: Option<Duration>,
        mut data_consumer: Option<&mut dyn FnMut(&[u8])>,
        timeout_overall: Option<Duration>,
    ) -> Result<Vec<u8>, ReplError> {
        let mut output: Vec<u8> = Vec::new();
        let started = Instant::now();
        let mut last = started;
        let overall = timeout_overall
            .unwrap_or(self.operation_timeout)
            .min(self.operation_timeout);
        while !output.ends_with(ending) {
            self.check()?;
            let now = Instant::now();
            if now.duration_since(started) > overall
                || timeout.is_some_and(|t| now.duration_since(last) > t)
            {
                break;
            }
            let waiting = self.transport.in_waiting()?;
            if waiting > 0 {
                let mut buf = vec![0u8; waiting.min(4096)];
                let n = self.transport.read(&mut buf)?;
                buf.truncate(n);
                if !buf.is_empty() {
                    last = now;
                    output.extend_from_slice(&buf);
                    let index = find(&output, ending);
                    if let Some(index) = index {
                        let tail = index + ending.len();
                        let rest = output.split_off(tail);
                        self.transport.unread(&rest);
                    }
                    if let Some(consumer) = data_consumer.as_mut()
                        && (index.is_some() || output.len() > ending.len())
                    {
                        let count = if index.is_some() {
                            output.len()
                        } else {
                            output.len() - ending.len()
                        };
                        consumer(&output[..count]);
                        output.drain(..count);
                        if index.is_some() {
                            return Ok(ending.to_vec());
                        }
                    }
                    if output.len() > MAX_OUTPUT_BYTES {
                        return Err(ReplError::protocol(
                            "Device response exceeds the 4 MiB output limit; press Stop to recover the REPL.",
                        ));
                    }
                }
            } else {
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        Ok(output)
    }

    /// Upload `command` and wait for `OK`; output follows via `follow`.
    /// Ported from mpremote `exec_raw_no_follow` (256-byte chunks, 10 ms pace).
    pub fn exec_raw_no_follow(&mut self, command: &[u8]) -> Result<(), ReplError> {
        let prompt = self.read_until(b">", Some(Duration::from_secs(10)), None, None)?;
        if !prompt.ends_with(b">") {
            return Err(ReplError::protocol(
                "Timed out waiting for the raw REPL prompt.",
            ));
        }
        for chunk in command.chunks(256) {
            self.check()?;
            self.transport.write_all(chunk)?;
            std::thread::sleep(Duration::from_millis(10));
        }
        self.check()?;
        self.transport.write_all(b"\x04")?;
        let mut reply = Vec::with_capacity(2);
        let end = Instant::now() + Duration::from_secs(3);
        while reply.len() < 2 && Instant::now() < end {
            self.check()?;
            let mut b = [0u8; 2];
            let n = self.transport.read(&mut b[..2 - reply.len()])?;
            reply.extend_from_slice(&b[..n]);
        }
        if reply != b"OK" {
            return Err(ReplError::protocol(format!(
                "Raw REPL rejected code: {reply:?}"
            )));
        }
        Ok(())
    }

    /// mpremote `enter_raw_repl(soft_reset=False)` — the worker overrides the
    /// open with a K210-friendly loop: `\r\x03\x02\r` every 50 ms until `>>>`
    /// (the CH340 may still be booting; a second Ctrl-C can cancel a pending
    /// interrupt, so only one is sent per interval), then `\r\x03` + input
    /// flush + `\r\x01` + wait for the raw banner.
    pub fn enter_raw_repl(&mut self, timeout_overall: Duration) -> Result<(), ReplError> {
        let deadline = Instant::now() + timeout_overall;
        let mut received: Vec<u8> = Vec::new();
        loop {
            if Instant::now() >= deadline {
                return Err(ReplError::device(
                    "Timed out waiting for the K210 REPL; close other serial apps and check the baud rate.",
                ));
            }
            self.check()?;
            self.transport.write_all(b"\r\x03\x02\r")?;
            let mut seen = false;
            for _ in 0..5 {
                self.check()?;
                std::thread::sleep(Duration::from_millis(10));
                let waiting = self.transport.in_waiting()?;
                if waiting > 0 {
                    let mut buf = vec![0u8; waiting.min(4096)];
                    let n = self.transport.read(&mut buf)?;
                    received.extend_from_slice(&buf[..n]);
                    if find(&received, b">>>").is_none() {
                        // Only the tail can still complete ">>>"; bound the buffer.
                        received.drain(..received.len().saturating_sub(2));
                    }
                }
                if find(&received, b">>>").is_some() {
                    seen = true;
                    break;
                }
            }
            if seen {
                break;
            }
        }
        self.transport.reset_input_buffer()?;
        // mpremote SerialTransport.enter_raw_repl(soft_reset=False).
        self.transport.write_all(b"\r\x03")?;
        self.transport.flush()?;
        self.transport.reset_input_buffer()?;
        self.transport.write_all(b"\r\x01")?;
        self.transport.flush()?;
        let banner = self.read_until(
            b"raw REPL; CTRL-B to exit\r\n",
            Some(Duration::from_secs(10)),
            None,
            Some(timeout_overall),
        )?;
        if !banner.ends_with(b"raw REPL; CTRL-B to exit\r\n") {
            return Err(ReplError::protocol(
                "Timed out waiting for the raw REPL banner.",
            ));
        }
        Ok(())
    }

    /// Two-stage `follow`: stdout ends at `\x04`, stderr at `\x04`, prompt `>`.
    pub fn follow(&mut self, timeout: Duration) -> Result<(Vec<u8>, Vec<u8>), ReplError> {
        let output = self.read_until(b"\x04", Some(timeout), None, None)?;
        if !output.ends_with(b"\x04") {
            return Err(ReplError::protocol(
                "Timed out waiting for stdout to finish.",
            ));
        }
        let error = self.read_until(b"\x04", Some(timeout), None, None)?;
        if !error.ends_with(b"\x04") {
            return Err(ReplError::protocol(
                "Timed out waiting for stderr to finish.",
            ));
        }
        // mpremote parity: the trailing `>` prompt is left pending for the
        // next `exec_raw_no_follow` to consume; follow() drops only the \x04
        // terminators (data[:-1] on both streams).
        let output = &output[..output.len() - 1];
        let error = &error[..error.len() - 1];
        Ok((output.to_vec(), error.to_vec()))
    }

    /// `exec_raw`: upload then follow both streams.
    pub fn exec_raw(
        &mut self,
        command: &str,
        timeout: Duration,
    ) -> Result<(Vec<u8>, Vec<u8>), ReplError> {
        // Python parity: the transport-level operation_timeout is replaced
        // outright for the duration of the transaction, then restored.
        let previous = self.operation_timeout;
        self.operation_timeout = timeout;
        let result = (|| {
            self.exec_raw_no_follow(command.as_bytes())?;
            self.follow(timeout)
        })();
        self.operation_timeout = previous;
        result
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pyrepr::PyValue;
    use nodu_serial::MemoryTransport;

    #[test]
    fn read_until_pushes_back_tail() {
        let mut t = MemoryTransport::new();
        t.feed(b"hello>>>rest");
        let mut s = Session::new(&mut t, never_cancel());
        let out = s
            .read_until(b">>>", Some(Duration::from_secs(1)), None, None)
            .unwrap();
        assert_eq!(out, b"hello>>>");
        assert_eq!(t.in_waiting().unwrap(), 4);
    }

    #[test]
    fn read_until_streams_consumer() {
        let mut t = MemoryTransport::new();
        t.feed(b"abc\x04");
        let mut seen = Vec::new();
        let mut s = Session::new(&mut t, never_cancel());
        let out = s
            .read_until(
                b"\x04",
                Some(Duration::from_secs(1)),
                Some(&mut |d: &[u8]| seen.extend_from_slice(d)),
                None,
            )
            .unwrap();
        assert_eq!(out, b"\x04");
        assert_eq!(seen, b"abc\x04");
    }

    #[test]
    fn pyrepr_parses_nested() {
        let v = pyrepr::parse("[(b'a\\x00b', (0x8000, 0, 0, 0, 0, 0, 3)), 42, True]").unwrap_err();
        // ints are decimal only — repr emits decimal anyway
        let _ = v;
        let v = pyrepr::parse("[(b'a\\x00b', (32768, 0, 0, 0, 0, 0, 3)), 42, True]").unwrap();
        match v {
            PyValue::List(items) => {
                assert_eq!(items.len(), 3);
                assert_eq!(items[2], PyValue::Bool(true));
            }
            _ => panic!("expected list"),
        }
    }

    #[test]
    fn pyrepr_rejects_garbage() {
        assert!(pyrepr::parse("os.system('x')").is_err());
        assert!(pyrepr::parse("(1,").is_err());
        assert!(pyrepr::parse("").is_err());
    }
}

#[cfg(test)]
mod follow_tests {
    use super::*;
    use nodu_serial::MemoryTransport;

    #[test]
    fn follow_strips_only_markers() {
        let mut t = MemoryTransport::new();
        t.feed(b"out\x04Traceback\x04>");
        let mut s = Session::new(&mut t, never_cancel());
        let (out, err) = s.follow(Duration::from_secs(1)).unwrap();
        assert_eq!(out, b"out");
        assert_eq!(err, b"Traceback");
        // `>` remains for the next exec_raw_no_follow.
        let mut one = [0u8; 1];
        assert_eq!(t.read(&mut one).unwrap(), 1);
        assert_eq!(&one, b">");
    }

    #[test]
    fn follow_single_byte_stderr() {
        let mut t = MemoryTransport::new();
        t.feed(b"\x04X\x04>");
        let mut s = Session::new(&mut t, never_cancel());
        let (out, err) = s.follow(Duration::from_secs(1)).unwrap();
        assert_eq!(out, b"");
        assert_eq!(err, b"X");
    }

    /// Transport that emits `>>>` then a malformed raw banner.
    #[test]
    fn enter_raw_repl_rejects_bad_banner() {
        let mut t = MemoryTransport::new();
        t.feed(b">>> ");
        std::thread::spawn({
            let t = t.clone();
            move || {
                std::thread::sleep(Duration::from_millis(20));
                t.feed(b"garbage banner\r\n>");
            }
        });
        let mut s = Session::new(&mut t, never_cancel());
        s.operation_timeout = Duration::from_millis(500);
        let result = s.enter_raw_repl(Duration::from_millis(500));
        assert!(result.is_err(), "malformed banner must fail: {result:?}");
    }
}
