// SPDX-License-Identifier: MIT
// Session-level differential replay: tools/diff/flash_sessions.py drives the
// Python probe() / KFlash().process() through a scripted serial port; this
// test replays the same scripted transport through the Rust implementations.
// Transcripts (every write, pin toggle, baud change, buffer reset) plus log
// lines and final results must match exactly.
use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nodu_kflash::{codec, crc32::crc32, kflash, probe};
use nodu_serial::Transport;
use serde_json::{Value, json};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn jedec_response() -> Vec<u8> {
    let mut body = vec![0u8; 8];
    body.extend_from_slice(&[0xEF, 0x40, 0x18]);
    body.extend_from_slice(&[1, 2, 3, 4, 5, 6, 7, 8]);
    let mut out = Vec::new();
    out.extend_from_slice(&0xDEu16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&crc32(&body).to_le_bytes());
    out.extend_from_slice(&body);
    out
}

type Events = Arc<Mutex<Vec<Value>>>;

/// Mirrors tools/diff/flash_sessions.py `ScriptedSerial`.
struct ScriptedTransport {
    events: Events,
    rx: VecDeque<u8>,
    write_buf: Vec<u8>,
}

impl ScriptedTransport {
    fn new(events: Events) -> Self {
        Self {
            events,
            rx: VecDeque::new(),
            write_buf: Vec::new(),
        }
    }

    fn emit(&self, event: Value) {
        self.events.lock().unwrap().push(event);
    }

    fn respond(&mut self) {
        loop {
            let Some(start) = self.write_buf.iter().position(|&b| b == 0xC0) else {
                self.write_buf.clear();
                return;
            };
            let Some(end) = self.write_buf[start + 1..]
                .iter()
                .position(|&b| b == 0xC0)
                .map(|p| p + start + 1)
            else {
                self.write_buf.drain(..start);
                return;
            };
            let frame = self.write_buf[start + 1..end].to_vec();
            self.write_buf.drain(..=end);
            let mut payload = Vec::new();
            let mut i = 0;
            while i < frame.len() {
                let b = frame[i];
                if b == 0xDB && i + 1 < frame.len() {
                    payload.push(match frame[i + 1] {
                        0xDC => 0xC0,
                        _ => 0xDB,
                    });
                    i += 2;
                } else {
                    payload.push(b);
                    i += 1;
                }
            }
            if payload.is_empty() {
                continue;
            }
            let response = if payload[0] == 0xDE {
                jedec_response()
            } else {
                vec![payload[0], 0xE0]
            };
            let framed = codec::slip_encode(&response).unwrap();
            self.rx.extend(framed);
        }
    }
}

impl Transport for ScriptedTransport {
    fn in_waiting(&mut self) -> io::Result<usize> {
        Ok(self.rx.len())
    }
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = buf.len().min(self.rx.len());
        for b in &mut buf[..n] {
            *b = self.rx.pop_front().unwrap();
        }
        Ok(n)
    }
    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        self.write_buf.extend_from_slice(buf);
        self.emit(json!(["write", hex(buf)]));
        self.respond();
        Ok(())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.emit(json!(["flush_out"]));
        Ok(())
    }
    fn reset_input_buffer(&mut self) -> io::Result<()> {
        self.rx.clear();
        self.emit(json!(["reset_in"]));
        Ok(())
    }
    fn set_baud_rate(&mut self, baud: u32) -> io::Result<()> {
        self.emit(json!(["baudrate", baud]));
        Ok(())
    }
    fn unread(&mut self, data: &[u8]) {
        for &b in data.iter().rev() {
            self.rx.push_front(b);
        }
    }
    fn set_dtr(&mut self, level: bool) -> io::Result<()> {
        self.emit(json!(["dtr", level]));
        Ok(())
    }
    fn set_rts(&mut self, level: bool) -> io::Result<()> {
        self.emit(json!(["rts", level]));
        Ok(())
    }
}

fn fixtures() -> Value {
    serde_json::from_str(include_str!("fixtures/session-expected.json")).unwrap()
}

fn diff_transcript(name: &str, got: &[Value], want: &Value) {
    let want_events = want["transcript"].as_array().unwrap();
    // Skip the ctor event (Python records constructor kwargs the Rust side
    // does not model) and the 'open'/'close' events: Rust probe opens via
    // open_port closure and drops the transport rather than close().
    let filtered: Vec<&Value> = want_events
        .iter()
        .filter(|e| !matches!(e[0].as_str().unwrap(), "ctor" | "open" | "close"))
        .collect();
    let got_f: Vec<&Value> = got
        .iter()
        .filter(|e| !matches!(e[0].as_str().unwrap(), "ctor" | "open" | "close"))
        .collect();
    assert_eq!(got_f.len(), filtered.len(), "{name}: transcript length");
    for (i, (g, w)) in got_f.iter().zip(filtered.iter()).enumerate() {
        assert_eq!(g, w, "{name}: transcript event {i}");
    }
}

fn diff_logs(name: &str, got: &[String], want: &Value) {
    let want_logs: Vec<&str> = want["logs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(got, &want_logs, "{name}: logs");
}

fn normalize_result(v: &Value) -> Value {
    let mut m = v.clone();
    if let Some(obj) = m.as_object_mut() {
        obj.remove("readAt");
    }
    m
}

#[test]
fn probe_happy() {
    let session = &fixtures()["probe_happy"];
    let image = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../scope-extension/resources/flash-probe/probe.bin"
    ))
    .expect("probe.bin");

    let events: Events = Arc::new(Mutex::new(vec![json!(["ctor", {}])]));
    let port_events = events.clone();
    let opener_events = events.clone();
    let mut logs: Vec<String> = Vec::new();
    let result = probe::probe(
        move |_: &str| -> io::Result<Box<dyn Transport>> {
            opener_events.lock().unwrap().push(json!(["open"]));
            Ok(Box::new(ScriptedTransport::new(port_events)))
        },
        "FAKE0",
        image,
        &mut || Ok(()),
        &mut |s| logs.push(s.to_string()),
        Some(&"a".repeat(32)),
        Some("session-1"),
    )
    .expect("probe should succeed");

    diff_transcript("probe", &events.lock().unwrap(), session);
    diff_logs("probe", &logs, session);
    assert_eq!(
        normalize_result(&result),
        normalize_result(&session["result"])
    );
}

#[test]
fn flash_happy() {
    let session = &fixtures()["flash_happy"];
    let dir = tempfile::tempdir().unwrap();
    let image_path = dir.path().join("firmware.bin");
    std::fs::write(&image_path, unhex(session["image"].as_str().unwrap())).unwrap();

    let events: Events = Arc::new(Mutex::new(vec![json!(["ctor", {}])]));
    let port_events = events.clone();
    let opener_events = events.clone();
    let mut logs: Vec<String> = Vec::new();
    let mut progress: Vec<(String, u64, u64)> = Vec::new();
    let kill = std::sync::atomic::AtomicBool::new(false);
    let result = kflash::process(
        move |_: &str| -> io::Result<Box<dyn Transport>> {
            opener_events.lock().unwrap().push(json!(["open"]));
            Ok(Box::new(ScriptedTransport::new(port_events)))
        },
        "FAKE0",
        &image_path,
        &mut |kind, i, t, _suffix| progress.push((kind.to_string(), i, t)),
        &mut |s| logs.push(s.to_string()),
        &kill,
        Some(Instant::now() + Duration::from_secs(60)),
    );

    match result {
        Ok(()) => assert_eq!(session["result"], json!({"ok": true}), "result"),
        Err(e) => panic!("expected ok, got {}: {}", e.kind().type_name(), e.message()),
    }
    diff_transcript("flash", &events.lock().unwrap(), session);
    diff_logs("flash", &logs, session);
}

fn hex(data: &[u8]) -> String {
    data.iter().map(|b| format!("{b:02x}")).collect()
}
