// SPDX-License-Identifier: MIT
//! Serial transport for the nodu device service.
//!
//! `Transport` is the byte-level contract `nodu-repl` works against; tests plug
//! `MemoryTransport` (or `nodu-mockboard`) in behind it. `SerialTransport`
//! adapts a `serialport` handle and mirrors the Python worker's
//! `BufferedSerial` (an `unread` byte that is returned before real reads).

use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nodu_protocol::SerialPortInfo;

/// Byte-level serial contract used by `nodu-repl`.
pub trait Transport: Send {
    /// Bytes currently buffered without blocking.
    fn in_waiting(&mut self) -> io::Result<usize>;
    /// Read up to `buf.len()` bytes; may return fewer, never blocks past the
    /// transport timeout.
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize>;
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()>;
    fn flush(&mut self) -> io::Result<()>;
    /// Drop any buffered input (used after Ctrl-C so the raw-REPL banner is
    /// found cleanly).
    fn reset_input_buffer(&mut self) -> io::Result<()>;
    fn set_baud_rate(&mut self, baud: u32) -> io::Result<()>;
    /// Push `data` back so the next reads return it first (used to put back
    /// bytes consumed past an end marker).
    fn unread(&mut self, data: &[u8]);
    /// DTR/RTS primitives; board reset sequences are layered on top later.
    fn set_dtr(&mut self, level: bool) -> io::Result<()>;
    fn set_rts(&mut self, level: bool) -> io::Result<()>;
}

/// `serialport`-backed transport with an `unread` pushback buffer.
#[derive(Debug)]
pub struct SerialTransport {
    inner: Box<dyn serialport::SerialPort>,
    pushback: VecDeque<u8>,
}

impl SerialTransport {
    /// Open `path` at `baud` with exclusive access (POSIX) and a short read
    /// timeout; REPL code layers its own deadlines on top.
    pub fn open(path: &str, baud: u32) -> io::Result<Self> {
        let port = serialport::new(path, baud)
            .timeout(Duration::from_millis(50))
            .open()
            .map_err(io::Error::other)?;
        Ok(Self {
            inner: port,
            pushback: VecDeque::new(),
        })
    }

    pub fn into_inner(self) -> Box<dyn serialport::SerialPort> {
        self.inner
    }
}

impl Transport for SerialTransport {
    fn in_waiting(&mut self) -> io::Result<usize> {
        Ok(self.pushback.len() + self.inner.bytes_to_read().map_err(io::Error::other)? as usize)
    }

    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        if !self.pushback.is_empty() {
            let n = buf.len().min(self.pushback.len());
            for slot in &mut buf[..n] {
                *slot = self.pushback.pop_front().unwrap_or_default();
            }
            return Ok(n);
        }
        match self.inner.read(buf) {
            // pyserial parity: a read timeout yields 0 bytes, not an error.
            Err(e) if e.kind() == io::ErrorKind::TimedOut => Ok(0),
            other => other,
        }
    }

    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        self.inner.write_all(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }

    fn reset_input_buffer(&mut self) -> io::Result<()> {
        self.pushback.clear();
        self.inner
            .clear(serialport::ClearBuffer::Input)
            .map_err(io::Error::other)
    }

    fn set_baud_rate(&mut self, baud: u32) -> io::Result<()> {
        self.inner.set_baud_rate(baud).map_err(io::Error::other)
    }

    fn unread(&mut self, data: &[u8]) {
        for &b in data.iter().rev() {
            self.pushback.push_front(b);
        }
    }

    fn set_dtr(&mut self, level: bool) -> io::Result<()> {
        self.inner
            .write_data_terminal_ready(level)
            .map_err(io::Error::other)
    }

    fn set_rts(&mut self, level: bool) -> io::Result<()> {
        self.inner
            .write_request_to_send(level)
            .map_err(io::Error::other)
    }
}

/// List serial ports with USB VID/PID/serial where the OS reports them.
pub fn list_ports() -> Vec<SerialPortInfo> {
    serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            let (description, vid, pid, serial_number) = match &p.port_type {
                serialport::SerialPortType::UsbPort(usb) => (
                    usb.product.clone().unwrap_or_else(|| p.port_name.clone()),
                    Some(usb.vid),
                    Some(usb.pid),
                    usb.serial_number.clone(),
                ),
                other => (format!("{other:?}"), None, None, None),
            };
            SerialPortInfo {
                path: p.port_name,
                description,
                vid,
                pid,
                serial_number,
            }
        })
        .collect()
}

/// In-memory transport for tests: a script of chunks fed to reads, writes
/// recorded for inspection.
#[derive(Debug, Default, Clone)]
pub struct MemoryTransport {
    inner: Arc<Mutex<MemoryState>>,
}

#[derive(Debug, Default)]
struct MemoryState {
    rx: VecDeque<u8>,
    tx: Vec<u8>,
    pushback: VecDeque<u8>,
    closed: bool,
}

impl MemoryTransport {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue bytes the next reads will return.
    pub fn feed(&self, data: &[u8]) {
        self.inner
            .lock()
            .expect("memory transport poisoned")
            .rx
            .extend(data.iter().copied());
    }

    /// Bytes the peer wrote so far.
    pub fn written(&self) -> Vec<u8> {
        self.inner
            .lock()
            .expect("memory transport poisoned")
            .tx
            .clone()
    }

    /// Drop everything written so far.
    pub fn clear_written(&self) {
        self.inner
            .lock()
            .expect("memory transport poisoned")
            .tx
            .clear();
    }
}

impl Transport for MemoryTransport {
    fn in_waiting(&mut self) -> io::Result<usize> {
        let s = self.inner.lock().expect("memory transport poisoned");
        Ok(s.pushback.len() + s.rx.len())
    }

    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut s = self.inner.lock().expect("memory transport poisoned");
        if s.closed {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"));
        }
        let mut n = 0;
        while n < buf.len() {
            if let Some(b) = s.pushback.pop_front().or_else(|| s.rx.pop_front()) {
                buf[n] = b;
                n += 1;
            } else {
                break;
            }
        }
        Ok(n)
    }

    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        let mut s = self.inner.lock().expect("memory transport poisoned");
        if s.closed {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"));
        }
        s.tx.extend_from_slice(buf);
        Ok(())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }

    fn reset_input_buffer(&mut self) -> io::Result<()> {
        let mut s = self.inner.lock().expect("memory transport poisoned");
        s.pushback.clear();
        s.rx.clear();
        Ok(())
    }

    fn set_baud_rate(&mut self, _baud: u32) -> io::Result<()> {
        Ok(())
    }

    fn unread(&mut self, data: &[u8]) {
        let mut s = self.inner.lock().expect("memory transport poisoned");
        for &b in data.iter().rev() {
            s.pushback.push_front(b);
        }
    }

    fn set_dtr(&mut self, _level: bool) -> io::Result<()> {
        Ok(())
    }

    fn set_rts(&mut self, _level: bool) -> io::Result<()> {
        Ok(())
    }
}
