// SPDX-License-Identifier: MIT
//! Manual serial sessions. Bytes are batched every 40 ms / 4 KiB; disconnects
//! release the port and never retry. ISP may take the lock only with consent.

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
use crate::util::new_id;

type Port = Box<dyn serialport::SerialPort>;

#[derive(Debug)]
struct Running {
    port: String,
    baud: u32,
    session: String,
    owner: String,
    stop: Arc<AtomicBool>,
    writer: Arc<Mutex<Option<Port>>>,
    thread: JoinHandle<Option<ResourceLock>>,
}

#[derive(Debug, Default)]
pub struct Monitor {
    running: Option<Running>,
}

fn open(port: &str, baud: u32) -> serialport::Result<Port> {
    let mut handle =
        serialport::new(port, baud).timeout(Duration::from_millis(40)).dtr_on_open(false).open()?;
    let _ = handle.write_request_to_send(false);
    Ok(handle)
}

fn state(
    out: &Output,
    port: &str,
    baud: u32,
    session: &str,
    owner: &str,
    value: &str,
    message: Option<&str>,
) {
    out.event("monitor.state", json!({"port": port, "baud": baud, "session": session, "owner": owner, "state": value, "message": message}));
}

impl Monitor {
    pub fn status(&self) -> Value {
        match &self.running {
            Some(r) => {
                let open = !r.thread.is_finished()
                    && r.writer.lock().map(|w| w.is_some()).unwrap_or(false);
                json!({"open": open, "state": if open { "open" } else { "disconnected" }, "port": r.port, "baud": r.baud, "session": r.session, "owner": r.owner})
            }
            None => json!({"open": false, "state": "closed", "port": "", "baud": 115200}),
        }
    }

    pub fn is_on(&self, port: &str) -> bool {
        self.running.as_ref().is_some_and(|r| {
            !r.thread.is_finished() && canonical_port(&r.port) == canonical_port(port)
        })
    }

    pub fn open(
        &mut self,
        out: &Arc<Output>,
        port: &str,
        baud: u32,
        owner: &str,
    ) -> Outcome<Value> {
        if !(1200..=4_000_000).contains(&baud) {
            return Err(Failure::new("badRequest", "波特率应在 1200–4000000 之间。"));
        }
        if self.status()["open"] == true {
            if self
                .running
                .as_ref()
                .is_some_and(|r| r.port == port && r.baud == baud && r.owner == owner)
            {
                return Ok(self.status());
            }
            return Err(Failure::new("monitorBusy", "请先断开当前串口，再选择端口和波特率。"));
        }
        self.suspend(); // Reap a completed reader. This never opens a device.
        let lock = lock_port(port, "STM32 串口监视器")?;
        let reader = open(port, baud)
            .map_err(|e| Failure::new("portOpen", format!("无法打开串口 {port}：{e}")))?;
        self.start(out, port, baud, owner, lock, reader)
    }

    fn start(
        &mut self,
        out: &Arc<Output>,
        port: &str,
        baud: u32,
        owner: &str,
        lock: ResourceLock,
        reader: Port,
    ) -> Outcome<Value> {
        let writer_port = reader
            .try_clone()
            .map_err(|e| Failure::new("portOpen", format!("串口无法发送：{e}")))?;
        let stop = Arc::new(AtomicBool::new(false));
        let writer = Arc::new(Mutex::new(Some(writer_port)));
        let (thread_stop, thread_writer, thread_out) =
            (Arc::clone(&stop), Arc::clone(&writer), Arc::clone(out));
        let name = port.to_string();
        let session = new_id("monitor");
        let thread_session = session.clone();
        let thread_owner = owner.to_string();
        state(out, port, baud, &session, owner, "open", None);
        let thread = thread::spawn(move || {
            let stopped = run(
                &thread_out,
                &name,
                baud,
                &thread_session,
                &thread_owner,
                &thread_stop,
                &thread_writer,
                reader,
            );
            // On loss, drop the lock inside the reader, rather than retaining it in JoinHandle.
            if stopped { Some(lock) } else { None }
        });
        self.running = Some(Running {
            port: port.to_string(),
            baud,
            session,
            owner: owner.to_string(),
            stop,
            writer,
            thread,
        });
        Ok(self.status())
    }

    /// Stop reading; an authorized ISP operation can keep the same resource lock.
    pub fn suspend(&mut self) -> Option<(String, ResourceLock)> {
        let running = self.running.take()?;
        running.stop.store(true, Ordering::Relaxed);
        if let Ok(mut writer) = running.writer.lock() {
            writer.take();
        }
        let lock = running.thread.join().ok()??;
        Some((running.port, lock))
    }

    pub fn close(&mut self, out: &Output) {
        if let Some(running) = &self.running {
            let (port, baud, session, owner) = (
                running.port.clone(),
                running.baud,
                running.session.clone(),
                running.owner.clone(),
            );
            self.suspend();
            state(
                out,
                &port,
                baud,
                &session,
                &owner,
                "closed",
                Some("串口已断开。再次使用请手动连接。"),
            );
        }
    }

    pub fn check_owner(&self, owner: &str, session: &str) -> Outcome<()> {
        let running =
            self.running.as_ref().ok_or_else(|| Failure::new("notOpen", "串口监视器没有连接。"))?;
        if running.owner != owner || running.session != session {
            return Err(Failure::new(
                "staleSession",
                "串口被其他窗口占用，或会话已改变。请确认当前连接。",
            ));
        }
        Ok(())
    }

    pub fn write(&mut self, out: &Output, data: &[u8], owner: &str, session: &str) -> Outcome<()> {
        let running =
            self.running.as_ref().ok_or_else(|| Failure::new("notOpen", "串口监视器没有连接。"))?;
        self.check_owner(owner, session)?;
        let result = {
            let mut guard = running.writer.lock().map_err(|_| Failure::new("io", "串口不可用"))?;
            let writer = guard
                .as_mut()
                .ok_or_else(|| Failure::new("disconnected", "开发板已断开，请手动重新连接。"))?;
            writer.write_all(data).map_err(|e| Failure::io("发送到串口", &e))
        };
        if result.is_err() {
            self.close(out);
        }
        result
    }
}

/// Returns true only for an explicit stop, allowing the caller to transfer its lock.
fn run(
    out: &Output,
    port: &str,
    baud: u32,
    session: &str,
    owner: &str,
    stop: &AtomicBool,
    writer: &Mutex<Option<Port>>,
    mut reader: Port,
) -> bool {
    let mut pending = Vec::new();
    let mut last_flush = Instant::now();
    let mut buffer = [0u8; 4096];
    loop {
        if stop.load(Ordering::Relaxed) {
            flush(out, port, session, &mut pending);
            return true;
        }
        match reader.read(&mut buffer) {
            Ok(n) if n > 0 => pending.extend_from_slice(&buffer[..n]),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => {
                flush(out, port, session, &mut pending);
                if let Ok(mut slot) = writer.lock() {
                    slot.take();
                }
                state(
                    out,
                    port,
                    baud,
                    session,
                    owner,
                    "disconnected",
                    Some(&format!("串口已断开（{e}）。请检查设备后手动连接。")),
                );
                return false;
            }
        }
        if pending.len() >= 4096
            || (!pending.is_empty() && last_flush.elapsed() >= Duration::from_millis(40))
        {
            flush(out, port, session, &mut pending);
            last_flush = Instant::now();
        }
    }
}

fn flush(out: &Output, port: &str, session: &str, pending: &mut Vec<u8>) {
    if !pending.is_empty() {
        out.event(
            "monitor.data",
            json!({"port": port, "session": session, "data": B64.encode(&pending[..])}),
        );
        pending.clear();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serialport::SerialPort;

    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl Write for Capture {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn captured(capture: &Capture) -> Vec<Value> {
        String::from_utf8(capture.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }
    fn wait_until(mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !predicate() {
            assert!(Instant::now() < deadline, "serial test timed out");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn pty_preserves_raw_rx_tx_and_rejects_stale_send() {
        let (mut device, slave) = serialport::TTYPort::pair().unwrap();
        let port = slave.name().unwrap();
        device.set_timeout(Duration::from_secs(1)).unwrap();
        let capture = Capture(Arc::new(Mutex::new(Vec::new())));
        let out = Arc::new(Output::new(Box::new(capture.clone())));
        let mut monitor = Monitor::default();
        // macOS PTYs do not implement the DTR/baud ioctls used to open real hardware.
        // Inject an already-open PTY into the same production session lifecycle.
        let status = monitor
            .start(
                &out,
                &port,
                115200,
                "test-owner",
                lock_port(&port, "monitor test").unwrap(),
                Box::new(slave),
            )
            .unwrap();
        let raw = [0, 0xff, 0x80, b'\n'];
        device.write_all(&raw).unwrap();
        wait_until(|| captured(&capture).iter().any(|event| event["event"] == "monitor.data"));
        let events = captured(&capture);
        let data = events.iter().find(|event| event["event"] == "monitor.data").unwrap();
        assert_eq!(B64.decode(data["data"]["data"].as_str().unwrap()).unwrap(), raw);
        assert_eq!(data["data"]["session"], status["session"]);
        assert_eq!(
            monitor.write(&out, &raw, "test-owner", "old-session").unwrap_err().code,
            "staleSession"
        );
        assert_eq!(
            monitor
                .check_owner("other-window", status["session"].as_str().unwrap())
                .unwrap_err()
                .code,
            "staleSession"
        );
        monitor.write(&out, &raw, "test-owner", status["session"].as_str().unwrap()).unwrap();
        let mut received = [0u8; 4];
        device.read_exact(&mut received).unwrap();
        assert_eq!(received, raw);
        monitor.close(&out);
        assert_eq!(monitor.status()["open"], false);
        assert!(lock_port(&port, "test download").is_ok());
    }

    #[test]
    fn unplug_releases_lock_and_same_path_requires_manual_reconnect() {
        let (device, slave) = serialport::TTYPort::pair().unwrap();
        let original = slave.name().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let alias = dir.path().join("manual-port");
        std::os::unix::fs::symlink(&original, &alias).unwrap();
        let port = alias.to_str().unwrap();
        let capture = Capture(Arc::new(Mutex::new(Vec::new())));
        let out = Arc::new(Output::new(Box::new(capture.clone())));
        let mut monitor = Monitor::default();
        let first = monitor
            .start(
                &out,
                port,
                115200,
                "test-owner",
                lock_port(port, "monitor test").unwrap(),
                Box::new(slave),
            )
            .unwrap();
        drop(device);
        wait_until(|| monitor.running.as_ref().is_some_and(|r| r.thread.is_finished()));
        assert_eq!(monitor.status()["open"], false);
        assert!(lock_port(&original, "test released lock").is_ok());
        let (replacement, replacement_slave) = serialport::TTYPort::pair().unwrap();
        let replacement_name = replacement_slave.name().unwrap();
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&replacement_name, &alias).unwrap();
        thread::sleep(Duration::from_millis(150));
        assert_eq!(monitor.status()["open"], false);
        assert_eq!(
            captured(&capture).iter().filter(|event| event["data"]["state"] == "open").count(),
            1
        );
        monitor.suspend();
        let second = monitor
            .start(
                &out,
                port,
                115200,
                "test-owner",
                lock_port(port, "monitor test").unwrap(),
                Box::new(replacement_slave),
            )
            .unwrap();
        assert_eq!(second["open"], true);
        assert_ne!(first["session"], second["session"]);
        monitor.close(&out);
        drop(replacement);
    }
}
