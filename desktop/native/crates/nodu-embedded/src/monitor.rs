// SPDX-License-Identifier: MIT
//! Serial monitor (FUNCTIONAL-DESIGN §8): bytes are batched every 40 ms or
//! 4 KiB and sent base64-encoded; the frontend decodes (UTF-8 or GBK). A
//! vanished port is retried every second and output is kept (M6). Serial
//! ISP on the same port borrows the lock in-process, so no other program can
//! grab the port between monitor and download (§9).

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};

use crate::locks::{ResourceLock, canonical_port, lock_port};
use crate::proto::{Failure, Outcome, Output};

type Port = Box<dyn serialport::SerialPort>;

#[derive(Debug)]
struct Running {
    port: String,
    baud: u32,
    stop: Arc<AtomicBool>,
    writer: Arc<Mutex<Option<Port>>>,
    thread: JoinHandle<ResourceLock>,
}

#[derive(Debug, Default)]
pub struct Monitor {
    running: Option<Running>,
}

fn open(port: &str, baud: u32) -> serialport::Result<Port> {
    let mut handle = serialport::new(port, baud)
        .timeout(Duration::from_millis(40))
        .dtr_on_open(false)
        .open()?;
    // Leave the auto-download transistors of F103 boards untouched (§8).
    let _ = handle.write_request_to_send(false);
    Ok(handle)
}

fn state(out: &Output, port: &str, baud: u32, value: &str, message: Option<&str>) {
    out.event("monitor.state", json!({"port": port, "baud": baud, "state": value, "message": message}));
}

impl Monitor {
    pub fn status(&self) -> Value {
        match &self.running {
            Some(r) => json!({"open": true, "port": r.port, "baud": r.baud}),
            None => json!({"open": false}),
        }
    }

    pub fn is_on(&self, port: &str) -> bool {
        self.running.as_ref().is_some_and(|r| canonical_port(&r.port) == canonical_port(port))
    }

    pub fn open(&mut self, out: &Arc<Output>, port: &str, baud: u32) -> Outcome<Value> {
        if !(1200..=4_000_000).contains(&baud) {
            return Err(Failure::new("badRequest", "波特率应在 1200–4000000 之间。"));
        }
        if self.running.as_ref().is_some_and(|r| r.port == port && r.baud == baud) {
            return Ok(self.status());
        }
        let lock = match self.suspend() {
            Some((old, lock)) if canonical_port(&old) == canonical_port(port) => lock,
            _ => lock_port(port, "STM32 串口监视器")?,
        };
        // Report a wrong path now; a port that later disappears is retried.
        let first = open(port, baud).map_err(|e| Failure::new("portOpen", format!("无法打开串口 {port}：{e}")))?;
        self.start(out, port, baud, lock, Some(first));
        Ok(self.status())
    }

    fn start(&mut self, out: &Arc<Output>, port: &str, baud: u32, lock: ResourceLock, first: Option<Port>) {
        let stop = Arc::new(AtomicBool::new(false));
        let writer: Arc<Mutex<Option<Port>>> = Arc::new(Mutex::new(None));
        let (thread_stop, thread_writer, thread_out) = (Arc::clone(&stop), Arc::clone(&writer), Arc::clone(out));
        let name = port.to_string();
        let thread = thread::spawn(move || {
            run(&thread_out, &name, baud, &thread_stop, &thread_writer, first);
            lock
        });
        self.running = Some(Running { port: port.to_string(), baud, stop, writer, thread });
    }

    /// Stop reading and hand back the port lock (closing, or lending to ISP).
    pub fn suspend(&mut self) -> Option<(String, ResourceLock)> {
        let running = self.running.take()?;
        running.stop.store(true, Ordering::Relaxed);
        if let Ok(mut writer) = running.writer.lock() {
            writer.take();
        }
        let lock = running.thread.join().ok()?;
        Some((running.port, lock))
    }

    pub fn resume(&mut self, out: &Arc<Output>, port: &str, baud: u32, lock: ResourceLock) {
        self.start(out, port, baud, lock, None);
    }

    pub fn close(&mut self, out: &Output) {
        if let Some((port, _lock)) = self.suspend() {
            state(out, &port, 0, "closed", None);
        }
    }

    pub fn write(&self, data: &[u8]) -> Outcome<()> {
        let running = self.running.as_ref().ok_or_else(|| Failure::new("notOpen", "串口监视器没有打开。"))?;
        let mut guard = running.writer.lock().map_err(|_| Failure::new("io", "串口不可用"))?;
        let writer = guard.as_mut().ok_or_else(|| Failure::new("disconnected", "开发板已断开，等待重新连接。"))?;
        writer.write_all(data).map_err(|e| Failure::io("发送到串口", &e))
    }
}

fn run(out: &Output, port: &str, baud: u32, stop: &AtomicBool, writer: &Mutex<Option<Port>>, mut first: Option<Port>) {
    let mut announced_missing = false;
    while !stop.load(Ordering::Relaxed) {
        let handle = match first.take().map_or_else(|| open(port, baud), Ok) {
            Ok(handle) => handle,
            Err(e) => {
                if !announced_missing {
                    state(out, port, baud, "disconnected", Some(&format!("开发板已断开（{e}）。重新插上后会自动连接。")));
                    announced_missing = true;
                }
                for _ in 0..10 {
                    if stop.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                continue;
            }
        };
        let mut reader = handle;
        if let (Ok(clone), Ok(mut slot)) = (reader.try_clone(), writer.lock()) {
            *slot = Some(clone);
        }
        state(out, port, baud, "open", None);
        let mut pending: Vec<u8> = Vec::new();
        let mut last_flush = Instant::now();
        let mut buffer = [0u8; 4096];
        loop {
            if stop.load(Ordering::Relaxed) {
                flush(out, port, &mut pending);
                return;
            }
            match reader.read(&mut buffer) {
                Ok(n) if n > 0 => pending.extend_from_slice(&buffer[..n]),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(e) => {
                    flush(out, port, &mut pending);
                    if let Ok(mut slot) = writer.lock() {
                        slot.take();
                    }
                    state(out, port, baud, "disconnected", Some(&format!("开发板已断开（{e}）。重新插上后会自动连接。")));
                    announced_missing = true;
                    break;
                }
            }
            if pending.len() >= 4096 || (!pending.is_empty() && last_flush.elapsed() >= Duration::from_millis(40)) {
                flush(out, port, &mut pending);
                last_flush = Instant::now();
            }
        }
    }
}

fn flush(out: &Output, port: &str, pending: &mut Vec<u8>) {
    if !pending.is_empty() {
        out.event("monitor.data", json!({"port": port, "data": B64.encode(&pending[..])}));
        pending.clear();
    }
}
