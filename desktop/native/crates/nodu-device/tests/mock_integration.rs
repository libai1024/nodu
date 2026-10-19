// SPDX-License-Identifier: MIT
//! End-to-end tests driving `Worker` against `MockBoard` over the exact
//! JSON-lines contract, plus protocol edge cases (oversized lines, duplicate
//! ids, unknown methods, cancellation) and a proptest fuzz over the raw-REPL
//! parser feeding garbage.

use std::io::BufReader;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nodu_device::{SubmitState, Worker};
use nodu_mockboard::MockBoard;
use nodu_repl::pyrepr;
use nodu_serial::Transport;
use serde_json::{Value, json};

struct SinkWriter(Arc<Mutex<Vec<Value>>>);

impl std::io::Write for SinkWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        for part in buf.split(|&b| b == b'\n') {
            let s = String::from_utf8_lossy(part).trim().to_string();
            if s.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str(&s) {
                self.0.lock().unwrap().push(v);
            }
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct Harness {
    worker: Worker,
    lines: Arc<Mutex<Vec<Value>>>,
    board: MockBoard,
    port: String,
}

impl Harness {
    fn new() -> Self {
        Self::named(std::thread::current().name().unwrap_or("test"))
    }

    fn named(tag: &str) -> Self {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::new(SubmitState::new(Box::new(SinkWriter(lines.clone()))));
        let board = MockBoard::new();
        let board2 = board.clone();
        let port = format!("mock-{tag}");
        let factory: nodu_device::TransportFactory =
            Arc::new(move |_, _| Ok(Box::new(board2.clone()) as Box<dyn Transport>));
        Self {
            worker: Worker::new(shared, factory),
            lines,
            board,
            port,
        }
    }

    fn submit(&mut self, req: Value) {
        self.worker.shared.submit(req);
    }

    /// Run until `id` got a reply or `n` steps elapsed.
    fn run_until_reply(&mut self, id: &Value, n: usize) -> Value {
        for _ in 0..n {
            if let Some(v) = self
                .lines
                .lock()
                .unwrap()
                .iter()
                .find(|l| l.get("id") == Some(id))
            {
                return v.clone();
            }
            self.worker.step(Duration::from_millis(2));
        }
        panic!("no reply for {id}");
    }

    fn drain(&mut self, n: usize) {
        for _ in 0..n {
            self.worker.step(Duration::from_millis(2));
        }
    }

    fn logs(&self, stream: &str) -> Vec<String> {
        self.lines
            .lock()
            .unwrap()
            .iter()
            .filter(|l| l.get("event") == Some(&json!("log")))
            .filter(|l| l["data"]["stream"] == json!(stream))
            .map(|l| l["data"]["text"].as_str().unwrap_or("").to_string())
            .collect()
    }

    fn last_state(&self) -> Value {
        self.lines
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|l| l.get("event") == Some(&json!("state")))
            .map(|l| l["data"].clone())
            .unwrap_or_default()
    }

    fn connect(&mut self) {
        let port = self.port.clone();
        self.submit(json!({"id": 1, "method": "connect",
            "args": {"port": port, "boardProfile": "generic-k210"}}));
        let r = self.run_until_reply(&json!(1), 4000);
        assert!(r.get("result").is_some(), "connect failed: {r}");
    }
}

#[test]
fn connect_then_execute() {
    let mut h = Harness::new();
    h.connect();
    let st = h.last_state();
    assert_eq!(st["phase"], json!("connected"));
    assert_eq!(st["capabilities"]["repl"], json!(true));
    assert_eq!(st["capabilities"]["framebuffer"], json!(false));
    assert_eq!(st["capabilities"]["firmware"], json!(false));

    h.submit(json!({"id": 2, "method": "execute", "args": {"code": "print(42)"}}));
    let r = h.run_until_reply(&json!(2), 2000);
    assert_eq!(r["result"], json!("42\n"));
    assert!(h.logs("stdout").iter().any(|l| l.contains("42")));
}

#[test]
fn execute_user_error_is_device_error_reply_not_phase_error() {
    let mut h = Harness::new();
    h.connect();
    h.submit(json!({"id": 2, "method": "execute", "args": {"code": "1/0"}}));
    let r = h.run_until_reply(&json!(2), 2000);
    assert!(r["error"].as_str().unwrap().starts_with("Traceback"));
    assert!(r["error"].as_str().unwrap().contains("ZeroDivisionError"));
    assert!(h.logs("stderr").iter().any(|l| l.starts_with("Traceback")));
    // lastError is set but phase stays connected — user-code failure.
    let st = h.last_state();
    assert_eq!(st["phase"], json!("connected"));
}

#[test]
fn run_script_streams_and_stop_recovers() {
    let mut h = Harness::new();
    h.connect();
    h.submit(json!({"id": 2, "method": "runScript",
        "args": {"code": "while True:\n print('x')"}}));
    let r = h.run_until_reply(&json!(2), 500);
    assert!(r.get("result").is_some());
    h.drain(20);
    assert!(h.logs("stdout").iter().any(|l| l.contains("tick")));
    h.submit(json!({"id": 3, "method": "stop", "args": {}}));
    let r = h.run_until_reply(&json!(3), 2000);
    assert!(r.get("result").is_some(), "stop failed: {r}");
    let st = h.last_state();
    assert_eq!(st["running"], json!(false));
    // REPL usable again.
    h.submit(json!({"id": 4, "method": "execute", "args": {"code": "print(7)"}}));
    let r = h.run_until_reply(&json!(4), 2000);
    assert_eq!(r["result"], json!("7\n"));
}

#[test]
fn file_round_trip_integrity() {
    let mut h = Harness::new();
    h.connect();
    let data: Vec<u8> = (0..3000u32).map(|i| (i % 256) as u8).collect();
    let b64 = base64_encode(&data);
    h.submit(json!({"id": 2, "method": "writeFile",
        "args": {"path": "/flash/nodu_test.bin", "data": b64, "overwrite": false}}));
    let r = h.run_until_reply(&json!(2), 3000);
    assert!(r.get("result").is_some(), "write failed: {r}");

    h.submit(json!({"id": 3, "method": "readFile", "args": {"path": "/flash/nodu_test.bin"}}));
    let r = h.run_until_reply(&json!(3), 3000);
    assert_eq!(r["result"]["size"], json!(data.len()));
    assert_eq!(base64_decode(r["result"]["data"].as_str().unwrap()), data);

    // No-overwrite default refused.
    h.submit(json!({"id": 4, "method": "writeFile",
        "args": {"path": "/flash/nodu_test.bin", "data": b64, "overwrite": false}}));
    let r = h.run_until_reply(&json!(4), 2000);
    assert!(r["error"].as_str().unwrap().contains("already exists"));

    // boot.py/main.py protection.
    h.submit(json!({"id": 5, "method": "writeFile",
        "args": {"path": "/flash/boot.py", "data": "eA==", "overwrite": true}}));
    let r = h.run_until_reply(&json!(5), 100);
    assert!(r["error"].as_str().unwrap().contains("boot.py"));

    // listFiles shows the file.
    h.submit(json!({"id": 6, "method": "listFiles", "args": {"path": "/flash"}}));
    let r = h.run_until_reply(&json!(6), 2000);
    let files = r["result"].as_array().unwrap();
    assert!(files.iter().any(|f| f["name"] == json!("nodu_test.bin")));

    // remove via REPL.
    h.submit(json!({"id": 7, "method": "execute",
        "args": {"code": "import os; os.remove('/flash/nodu_test.bin')"}}));
    let r = h.run_until_reply(&json!(7), 2000);
    assert!(r.get("result").is_some());
    assert!(h.board.file("/flash/nodu_test.bin").is_none());
}

#[test]
fn disconnect_cancels_in_flight() {
    let mut h = Harness::new();
    h.connect();
    // runScript occupies; disconnect jumps the queue and closes.
    h.submit(json!({"id": 2, "method": "runScript",
        "args": {"code": "while True:\n print('x')"}}));
    h.run_until_reply(&json!(2), 500);
    h.submit(json!({"id": 3, "method": "disconnect", "args": {}}));
    let r = h.run_until_reply(&json!(3), 2000);
    assert!(r.get("result").is_some());
    assert_eq!(h.last_state()["phase"], json!("disconnected"));
}

#[test]
fn malformed_and_duplicate_and_unknown_rejected() {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::new(SubmitState::new(Box::new(SinkWriter(lines.clone()))));
    // Malformed JSON line through the reader.
    shared.read_requests(BufReader::new(b"not-json\n".as_slice()));
    assert!(
        lines
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.get("error").is_some())
    );

    // Unknown method.
    shared.submit(json!({"id": 1, "method": "nope", "args": {}}));
    assert!(lines.lock().unwrap().iter().any(|l| {
        l["error"]
            .as_str()
            .is_some_and(|e| e.contains("Unknown device method"))
    }));

    // Duplicate pending id (both queued before handling).
    shared.submit(json!({"id": 2, "method": "getState", "args": {}}));
    shared.submit(json!({"id": 2, "method": "getState", "args": {}}));
    assert!(
        lines
            .lock()
            .unwrap()
            .iter()
            .any(|l| l["error"].as_str().is_some_and(|e| e.contains("Duplicate")))
    );

    // Bool id rejected.
    shared.submit(json!({"id": true, "method": "getState", "args": {}}));
    assert!(
        lines
            .lock()
            .unwrap()
            .iter()
            .any(|l| l["error"].as_str().is_some_and(|e| e.contains("id")))
    );

    // Oversized line through reader.
    let mut big = b"{\"id\":9,\"method\":\"getState\",\"args\":{\"x\":\"".to_vec();
    big.extend(std::iter::repeat_n(b'a', 4 * 1024 * 1024 + 16));
    big.extend(b"\"}}\n".iter().copied());
    big.extend(b"{\"id\":8,\"method\":\"nope\"}\n".iter().copied());
    let lines2 = Arc::new(Mutex::new(Vec::new()));
    let shared2 = Arc::new(SubmitState::new(Box::new(SinkWriter(lines2.clone()))));
    shared2.read_requests(BufReader::new(big.as_slice()));
    let log2 = lines2.lock().unwrap();
    assert!(
        log2.iter()
            .any(|l| l["error"].as_str().is_some_and(|e| e.contains("4 MiB")))
    );
    // The oversized line is discarded without stalling the reader: the next
    // valid request still gets a reply.
    assert!(log2.iter().any(|l| {
        l["id"] == json!(8)
            && l["error"]
                .as_str()
                .is_some_and(|e| e.contains("Unknown device method"))
    }));
}

#[test]
fn unimplemented_methods_reply_chinese_message() {
    let mut h = Harness::new();
    for (i, m) in [
        "setPreview",
        "startCamera",
        "prepareFirmware",
        "backupDevice",
        "flashFirmware",
    ]
    .iter()
    .enumerate()
    {
        h.submit(json!({"id": 100 + i, "method": m, "args": {"enabled": true}}));
        let r = h.run_until_reply(&json!(100 + i), 500);
        assert_eq!(
            r["error"],
            json!("此功能将在后续阶段由新设备服务提供。"),
            "{m}"
        );
    }
}

#[test]
fn path_validation_matches_python() {
    assert!(nodu_device::remote_path(Some(&json!("/flash/x.txt")), false).is_ok());
    assert!(nodu_device::remote_path(Some(&json!("/flash/../x")), false).is_err());
    assert!(nodu_device::remote_path(Some(&json!("a\\b")), false).is_err());
    assert_eq!(
        nodu_device::remote_path(Some(&json!("rel.txt")), false).unwrap(),
        "/flash/rel.txt"
    );
    assert!(nodu_device::remote_path(Some(&json!("/sd/main.py")), true).is_err());
    assert!(nodu_device::remote_path(Some(&json!("/flash/BOOT.PY")), true).is_err());
}

fn base64_encode(d: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(d)
}
fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}

proptest::proptest! {
    /// Garbage bytes into the repr parser must never panic.
    #[test]
    fn pyrepr_never_panics(input in proptest::collection::vec(0u8..=255, 0..256)) {
        let text = String::from_utf8_lossy(&input);
        let _ = pyrepr::parse(&text);
    }

    /// Garbage device output through read_until must terminate without panic.
    #[test]
    fn read_until_garbage(input in proptest::collection::vec(0u8..=255, 0..2048)) {
        let mut t = nodu_serial::MemoryTransport::new();
        t.feed(&input);
        let mut s = nodu_repl::Session::new(
            &mut t,
            nodu_repl::never_cancel(),
        );
        let _ = s.read_until(b"\x04", Some(Duration::from_millis(1)), None, None);
    }
}

#[test]
fn write_file_rejects_non_string_data() {
    let mut h = Harness::new();
    h.connect();
    // Seed the file so we can prove a rejected write leaves it unchanged.
    h.submit(json!({"id": 2, "method": "writeFile",
        "args": {"path": "/flash/keep.bin", "data": "eA==", "overwrite": true}}));
    assert!(h.run_until_reply(&json!(2), 2000).get("result").is_some());

    for (i, data) in [Value::Null, json!(123), json!({}), json!([1])]
        .iter()
        .enumerate()
    {
        let mut args = json!({"path": "/flash/keep.bin", "overwrite": true});
        args["data"] = data.clone();
        h.submit(json!({"id": 10 + i, "method": "writeFile", "args": args}));
        let r = h.run_until_reply(&json!(10 + i), 2000);
        assert!(
            r["error"]
                .as_str()
                .is_some_and(|e| e.contains("base64 string")),
            "data={data}: {r}"
        );
        // Missing `data` key.
        let mut args2 = json!({"path": "/flash/keep.bin", "overwrite": true});
        args2.as_object_mut().unwrap().remove("data");
        h.submit(json!({"id": 20 + i, "method": "writeFile", "args": args2}));
        let r = h.run_until_reply(&json!(20 + i), 2000);
        assert!(
            r["error"]
                .as_str()
                .is_some_and(|e| e.contains("base64 string"))
        );
    }
    assert_eq!(
        h.board.file("/flash/keep.bin").as_deref(),
        Some(b"x".as_slice())
    );
}

#[test]
fn oversized_u64_id_rejected_but_echoed() {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::new(SubmitState::new(Box::new(SinkWriter(lines.clone()))));
    let big_id = json!(18446744073709551615u64);
    shared.submit(json!({"id": big_id, "method": "getState", "args": {}}));
    let log = lines.lock().unwrap();
    let reply = log
        .iter()
        .find(|l| l["id"] == big_id)
        .expect("reply must echo original id");
    assert!(reply["error"].as_str().is_some_and(|e| e.contains("id")));
}
