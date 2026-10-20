// SPDX-License-Identifier: MIT
//! End-to-end tests driving `Worker` against `MockBoard` over the exact
//! JSON-lines contract, plus protocol edge cases (oversized lines, duplicate
//! ids, unknown methods, cancellation) and a proptest fuzz over the raw-REPL
//! parser feeding garbage.

use std::io::BufReader;
use std::sync::atomic::{AtomicBool, Ordering};
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
            "args": {"port": port, "boardProfile": "generic-k210",
                     "protocol": "raw"}}));
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
    assert_eq!(st["capabilities"]["firmware"], json!(true));

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
fn firmware_methods_validate_before_device_io() {
    let mut h = Harness::new();
    h.submit(json!({"id": 100, "method": "prepareFirmware", "args": {}}));
    let r = h.run_until_reply(&json!(100), 500);
    assert_eq!(
        r["error"],
        json!("Backup/cache directory must be an absolute backend-managed path.")
    );
    for (i, m) in ["backupDevice", "flashFirmware"].iter().enumerate() {
        h.submit(json!({"id": 101 + i, "method": m, "args": {}}));
        let r = h.run_until_reply(&json!(101 + i), 500);
        assert_eq!(r["error"], json!("Connect a K210 first."), "{m}");
    }
    h.submit(json!({"id": 200, "method": "unknownThing", "args": {}}));
    let r = h.run_until_reply(&json!(200), 500);
    assert_eq!(r["error"], json!("Unknown device method."));
}

#[test]
fn flash_gates_block_before_any_write() {
    let mut h = Harness::new();
    h.connect();
    // Unverified capacity: flashFirmware must stop at the JEDEC gate.
    h.submit(json!({"id": 10, "method": "flashFirmware", "args": {"backupDir": "/tmp/x"}}));
    let r = h.run_until_reply(&json!(10), 500);
    assert_eq!(
        r["error"],
        json!(
            "Flashing is blocked until the actual flash JEDEC capacity is verified; a 16 MiB read-back alone is not proof."
        )
    );
    // backupDevice without a backupDir stops before RAM probing.
    h.submit(json!({"id": 11, "method": "backupDevice", "args": {}}));
    let r = h.run_until_reply(&json!(11), 2000);
    assert_eq!(
        r["error"],
        json!("An absolute managed backup directory is required before RAM probing.")
    );
    // prepareFirmware rejects a non-pinned source image offline.
    let tmp_root = std::env::temp_dir().join(format!("nodu-fw-test-{}", std::process::id()));
    let tmp_cache = tmp_root.join("cache");
    std::fs::create_dir_all(&tmp_cache).unwrap();
    let tmp = tmp_root.join("bad-fw.bin");
    std::fs::write(&tmp, b"bad").unwrap();
    h.submit(json!({"id": 12, "method": "prepareFirmware", "args": {
        "cacheDir": tmp_cache.to_string_lossy(),
        "sourceFile": tmp.to_string_lossy()}}));
    let r = h.run_until_reply(&json!(12), 2000);
    assert_eq!(
        r["error"],
        json!("Official firmware image size is not the pinned 2116288 bytes.")
    );
    let _ = std::fs::remove_dir_all(&tmp_root);
    // The session must still be healthy after all three blocked attempts.
    h.submit(json!({"id": 13, "method": "execute", "args": {"code": "print(7)"}}));
    let r = h.run_until_reply(&json!(13), 2000);
    assert_eq!(r["result"], json!("7\n"));
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

// ---------- IDE protocol end-to-end (firmware-side mock dispatch) ----------

struct IdeHarness {
    worker: Worker,
    lines: Arc<Mutex<Vec<Value>>>,
    board: MockBoard,
    port: String,
}

impl IdeHarness {
    fn new() -> Self {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let shared = Arc::new(SubmitState::new(Box::new(SinkWriter(lines.clone()))));
        let board = MockBoard::new();
        let board2 = board.clone();
        let port = format!("mock-ide-{}", std::thread::current().name().unwrap_or("t"));
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

    fn frames(&self) -> Vec<Value> {
        self.lines
            .lock()
            .unwrap()
            .iter()
            .filter(|l| l.get("event") == Some(&json!("frame")))
            .map(|l| l["data"].clone())
            .collect()
    }

    fn connect(&mut self) {
        let port = self.port.clone();
        self.submit(json!({"id": 1, "method": "connect",
            "args": {"port": port, "boardProfile": "generic-k210", "boardId": 2}}));
        let r = self.run_until_reply(&json!(1), 8000);
        assert!(r.get("result").is_some(), "ide connect failed: {r}");
    }
}

#[test]
fn ide_connect_executes_and_recovers() {
    let mut h = IdeHarness::new();
    h.connect();
    let st = h.last_state();
    assert_eq!(st["phase"], json!("connected"));
    assert_eq!(st["protocol"], json!("ide"));
    assert_eq!(st["boardId"], json!(2));
    assert_eq!(st["firmware"], json!("MaixPy 0.6.3"));
    assert_eq!(st["capabilities"]["framebuffer"], json!(true));

    // REPL execute streams stdout via TX.
    h.submit(json!({"id": 2, "method": "execute", "args": {"code": "print(42)"}}));
    let r = h.run_until_reply(&json!(2), 3000);
    assert_eq!(
        r["result"],
        json!("42\n"),
        "reply: {r} logs: {:?}",
        h.logs("stdout")
    );

    // User exception: error reply, Traceback on stderr, phase stays connected.
    h.submit(json!({"id": 3, "method": "execute", "args": {"code": "1/0"}}));
    let r = h.run_until_reply(&json!(3), 3000);
    assert!(r["error"].is_string(), "{r}");
    assert!(h.logs("stderr").iter().any(|l| l.starts_with("Traceback")));
    assert_eq!(h.last_state()["phase"], json!("connected"));

    // Long-running script + stop + recovery.
    h.submit(json!({"id": 4, "method": "runScript",
        "args": {"code": "while True:\n print('x')"}}));
    assert!(h.run_until_reply(&json!(4), 2000).get("result").is_some());
    h.drain(30);
    assert!(h.logs("stdout").iter().any(|l| l.contains("tick")));
    h.submit(json!({"id": 5, "method": "stop", "args": {}}));
    assert!(h.run_until_reply(&json!(5), 3000).get("result").is_some());
    assert_eq!(h.last_state()["running"], json!(false));
    // "Exception: IDE interrupt" must be suppressed from the console.
    assert!(
        !h.logs("stdout")
            .iter()
            .chain(h.logs("stderr").iter())
            .any(|l| l.contains("Exception: IDE interrupt"))
    );
    h.submit(json!({"id": 6, "method": "execute", "args": {"code": "print(7)"}}));
    let r6 = h.run_until_reply(&json!(6), 3000);
    assert_eq!(r6["result"], json!("7\n"), "reply: {r6}");
}

#[test]
fn ide_preview_frames_and_save_file() {
    let mut h = IdeHarness::new();
    h.connect();
    // Preview on → frames flow even without a running script? The mock only
    // produces frames while a snapshot script runs; start the camera path.
    h.submit(json!({"id": 2, "method": "setPreview", "args": {"enabled": true}}));
    assert!(h.run_until_reply(&json!(2), 1000).get("result").is_some());
    h.submit(json!({"id": 3, "method": "startCamera", "args": {}}));
    assert!(h.run_until_reply(&json!(3), 3000).get("result").is_some());
    h.drain(60);
    let frames = h.frames();
    assert!(!frames.is_empty(), "expected frame events");
    let f = &frames[0];
    assert_eq!(
        (f["width"].as_u64(), f["height"].as_u64()),
        (Some(320), Some(240))
    );
    let jpeg = base64_decode(f["data"].as_str().unwrap());
    assert!(jpeg.starts_with(&[0xff, 0xd8]) && jpeg.ends_with(&[0xff, 0xd9]));

    // FILE_SAVE: arbitrary file lands in the mock VFS.
    let payload = b"ide-file-check".repeat(100);
    h.submit(json!({"id": 4, "method": "saveFile",
        "args": {"name": "saved_test.bin", "data": base64_encode(&payload)}}));
    assert!(h.run_until_reply(&json!(4), 3000).get("result").is_some());
    assert_eq!(
        h.board.file("saved_test.bin").as_deref(),
        Some(payload.as_slice())
    );

    // boot.py rejected without confirmedStartup.
    h.submit(json!({"id": 5, "method": "saveFile",
        "args": {"name": "boot.py", "data": "eA=="}}));
    assert!(h.run_until_reply(&json!(5), 1000)["error"].is_string());
    h.submit(json!({"id": 6, "method": "saveFile",
        "args": {"name": "boot.py", "data": "eA==", "confirmedStartup": true}}));
    assert!(h.run_until_reply(&json!(6), 3000).get("result").is_some());
    assert_eq!(h.board.file("boot.py").as_deref(), Some(b"x".as_slice()));
}

#[test]
fn ide_recording_captures_frames_and_finalizes() {
    let mut h = IdeHarness::new();
    h.connect();
    // Recording requires the framebuffer preview channel: refuse it while
    // the user has preview paused.
    h.submit(json!({"id": 1, "method": "setPreview", "args": {"enabled": false}}));
    let rr = h.run_until_reply(&json!(1), 1000);
    assert!(rr.get("result").is_some(), "setPreview failed: {rr}");
    let early_path =
        std::env::temp_dir().join(format!("nodu-rec-early-{}.bin", std::process::id()));
    let _ = std::fs::remove_file(&early_path);
    h.submit(json!({"id": 10, "method": "startRecording",
        "args": {"path": early_path.to_string_lossy()}}));
    assert!(h.run_until_reply(&json!(10), 500)["error"].is_string());
    assert!(!early_path.exists());
    // Recordings only make sense while frames actually flow; the mock's
    // camera loop produces one JPEG per poll tick.
    h.submit(json!({"id": 2, "method": "startCamera", "args": {}}));
    assert!(h.run_until_reply(&json!(2), 4000).get("result").is_some());
    let path = std::env::temp_dir().join(format!(
        "nodu-rec-test-{}-{}.bin",
        std::process::id(),
        std::thread::current().name().unwrap_or("t")
    ));
    let _ = std::fs::remove_file(&path);
    // Guards: recording needs a unique absolute .bin path and a connection.
    h.submit(json!({"id": 3, "method": "startRecording",
        "args": {"path": "relative.bin"}}));
    assert!(h.run_until_reply(&json!(3), 500)["error"].is_string());
    h.submit(json!({"id": 4, "method": "startRecording",
        "args": {"path": path.to_string_lossy()}}));
    let r = h.run_until_reply(&json!(4), 1000);
    assert_eq!(r["result"]["active"], json!(true), "{r}");
    h.drain(30);
    // Conversion is refused while a recording is still in flight.
    h.submit(json!({"id": 5, "method": "convertVideo",
        "args": {"input": path.to_string_lossy(),
                 "output": path.with_extension("mp4").to_string_lossy()}}));
    assert!(h.run_until_reply(&json!(5), 1000)["error"].is_string());
    h.submit(json!({"id": 6, "method": "stopRecording", "args": {}}));
    let r = h.run_until_reply(&json!(6), 1000);
    let status = &r["result"];
    assert_eq!(status["active"], json!(false), "{r}");
    assert!(status["frames"].as_u64().unwrap_or(0) > 0, "{r}");
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[..16], b"OMV IMG STR V1.0");
    assert!(bytes.len() > 32);
    // Once the script has been stopped, conversion is local host work and
    // stays allowed while connected — it fails only because this test
    // binary has no bundled tools directory, proving it passed the gate.
    h.submit(json!({"id": 7, "method": "stop", "args": {}}));
    let _ = h.run_until_reply(&json!(7), 4000);
    h.submit(json!({"id": 8, "method": "convertVideo",
        "args": {"input": path.to_string_lossy(),
                 "output": path.with_extension("mp4").to_string_lossy()}}));
    let r = h.run_until_reply(&json!(8), 4000);
    let e = r["error"].as_str().unwrap_or_default().to_string();
    assert!(e.contains("ffmpeg") || e.contains("Bundled"), "{e}");
    let _ = std::fs::remove_file(&path);
}

#[test]
fn ide_recording_finalizes_on_disconnect() {
    let mut h = IdeHarness::new();
    h.connect();
    h.submit(json!({"id": 2, "method": "startCamera", "args": {}}));
    assert!(h.run_until_reply(&json!(2), 4000).get("result").is_some());
    let path = std::env::temp_dir().join(format!(
        "nodu-rec-disc-{}-{}.bin",
        std::process::id(),
        std::thread::current().name().unwrap_or("t")
    ));
    let _ = std::fs::remove_file(&path);
    h.submit(json!({"id": 3, "method": "startRecording",
        "args": {"path": path.to_string_lossy()}}));
    assert!(h.run_until_reply(&json!(3), 1000).get("result").is_some());
    h.drain(20);
    // Disconnect finalizes the recorder instead of truncating buffers.
    h.submit(json!({"id": 4, "method": "disconnect", "args": {}}));
    assert!(h.run_until_reply(&json!(4), 4000).get("result").is_some());
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[..16], b"OMV IMG STR V1.0");
    assert!(bytes.len() > 32);
    assert_eq!(h.last_state()["recording"], serde_json::Value::Null);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn ide_execute_no_newline_and_split_utf8() {
    let mut h = IdeHarness::new();
    h.connect();
    // A print without trailing newline: finalize emits the incomplete line.
    h.submit(json!({"id": 2, "method": "execute",
        "args": {"code": "import sys\nsys.stdout.write('no-newline-tail')"}}));
    let r = h.run_until_reply(&json!(2), 3000);
    assert_eq!(r["result"], json!("no-newline-tail"), "{r}");
    // Split UTF-8 '中' (e4 b8 ad) across two TX polls decodes as one char.
    h.board.push_tx("前置".as_bytes());
    h.board.push_tx(&[0xe4, 0xb8]); // first two bytes of 中
    h.drain(4);
    h.board.push_tx(&[0xad, b'\n']); // final byte + newline
    h.drain(4);
    let out = h.logs("stdout").join("");
    assert!(out.contains('中'), "{out}");
}

#[test]
fn ide_user_ide_interrupt_text_survives() {
    let mut h = IdeHarness::new();
    h.connect();
    // A user's own print of the magic stop line must NOT be suppressed.
    h.submit(json!({"id": 2, "method": "execute",
        "args": {"code": "print('Exception: IDE interrupt')"}}));
    let r = h.run_until_reply(&json!(2), 3000);
    assert_eq!(r["result"], json!("Exception: IDE interrupt\n"), "{r}");
    // A normal error then success: classifier must not leak across runs.
    h.submit(json!({"id": 3, "method": "execute", "args": {"code": "1/0"}}));
    assert!(h.run_until_reply(&json!(3), 3000)["error"].is_string());
    h.submit(json!({"id": 4, "method": "execute", "args": {"code": "print(5)"}}));
    assert_eq!(h.run_until_reply(&json!(4), 3000)["result"], json!("5\n"));
}

#[test]
fn ide_empty_and_truncated_file_ops() {
    let mut h = IdeHarness::new();
    h.connect();
    // Empty writeFile must create a real empty file.
    h.submit(json!({"id": 2, "method": "writeFile",
        "args": {"path": "/flash/empty.bin", "data": "", "overwrite": true}}));
    assert!(h.run_until_reply(&json!(2), 3000).get("result").is_some());
    assert_eq!(h.board.file("/flash/empty.bin"), Some(Vec::new()));
    h.submit(json!({"id": 3, "method": "readFile", "args": {"path": "/flash/empty.bin"}}));
    let r = h.run_until_reply(&json!(3), 3000);
    assert_eq!(r["result"]["size"], json!(0));
    // Nonempty round-trip through the IDE append/seek path.
    let blob: Vec<u8> = (0..1200).map(|i| (i * 7) as u8).collect();
    h.submit(json!({"id": 4, "method": "writeFile",
        "args": {"path": "/flash/rt.bin", "data": base64_encode(&blob), "overwrite": true}}));
    assert!(h.run_until_reply(&json!(4), 4000).get("result").is_some());
    h.submit(json!({"id": 5, "method": "readFile", "args": {"path": "/flash/rt.bin"}}));
    let r = h.run_until_reply(&json!(5), 4000);
    assert_eq!(
        base64_decode(r["result"]["data"].as_str().unwrap()),
        blob,
        "{r}"
    );
    // Mid-read shrink must error, never silently truncate.
    h.board.plant("/flash/shrink.bin", &vec![9u8; 900]);
    h.board.set_truncate_reads(true);
    h.submit(json!({"id": 6, "method": "readFile", "args": {"path": "/flash/shrink.bin"}}));
    let r = h.run_until_reply(&json!(6), 4000);
    assert!(r["error"].is_string(), "{r}");
    h.board.set_truncate_reads(false);
}

#[test]
fn ide_desync_closes_port_and_recovers() {
    let mut h = IdeHarness::new();
    h.connect();
    // Fail during the FILE_SAVE payload upload (writes: stop hdr, running
    // hdr, FILE_SAVE hdr, then payload) -> protocol desync.
    h.board.fail_writes_after(4);
    let payload = vec![0xabu8; 4096];
    h.submit(json!({"id": 2, "method": "saveFile",
        "args": {"name": "x.bin", "data": base64_encode(&payload)}}));
    let r = h.run_until_reply(&json!(2), 4000);
    assert!(r["error"].is_string(), "{r}");
    assert_eq!(h.last_state()["phase"], json!("error"));
    assert_eq!(h.last_state()["capabilities"]["framebuffer"], json!(false));
    // Port is released; a fresh connect performs the reset sequence again.
    h.board.fail_writes_after(usize::MAX); // disarm the fault
    h.submit(json!({"id": 3, "method": "connect",
        "args": {"port": h.port.clone(), "boardProfile": "generic-k210", "boardId": 2}}));
    assert!(h.run_until_reply(&json!(3), 8000).get("result").is_some());
    assert_eq!(h.last_state()["phase"], json!("connected"));
}

#[test]
fn ide_reset_device_disconnects() {
    let mut h = IdeHarness::new();
    h.connect();
    h.submit(json!({"id": 2, "method": "resetDevice", "args": {}}));
    assert!(h.run_until_reply(&json!(2), 2000).get("result").is_some());
    assert_eq!(h.last_state()["phase"], json!("disconnected"));
    // Reconnect works after a reset.
    h.submit(json!({"id": 3, "method": "connect",
        "args": {"port": h.port.clone(), "boardProfile": "generic-k210", "boardId": 2}}));
    assert!(h.run_until_reply(&json!(3), 8000).get("result").is_some());
    assert_eq!(h.last_state()["phase"], json!("connected"));
}

#[test]
fn ide_large_cjk_output_bounded_and_tail_stripped_once() {
    // >64 KiB of multi-byte text with no newline must stream through the
    // bounded holdback without splitting a UTF-8 boundary or panicking.
    // Trailing bytes hold back in the line buffer until the run ends; the
    // firmware tail is then stripped exactly once.
    let mut h = IdeHarness::new();
    h.connect();
    let body = "微".repeat(40_000); // 120,000 bytes, 3 per char
    h.board.push_tx(body.as_bytes());
    // The execute path drains the pushed bytes through ide_wait_ready
    // (logged), then prints 42 and ends with the real firmware tail.
    h.submit(json!({"id": 2, "method": "execute", "args": {"code": "print(42)"}}));
    let r = h.run_until_reply(&json!(2), 8000);
    // Prior-TX bytes drained during wait_ready are still delivered exactly:
    // the console log holds the whole 120 KiB run plus the script's 42.
    let result = r["result"].as_str().unwrap_or("");
    assert!(result.ends_with("42\n"), "{r}");
    assert!(!result.contains("CTRL-B"), "{r}");
    let out = h.logs("stdout").join("");
    assert_eq!(out, format!("{body}42\n"), "log len {}", out.len());
}

#[test]
fn ide_huge_output_errors_instead_of_unbounded() {
    // Continuous no-newline output beyond the 4 MiB per-execution cap must
    // surface a controlled error (and close the link) — never grow the
    // holdback without bound.
    let mut h = IdeHarness::new();
    h.connect();
    // Pushed in chunks under the 2 MiB per-reply bound so the aggregate
    // cap — not the single-reply bound — is what trips.
    let chunk = vec![b'x'; 900 * 1024];
    for _ in 0..6 {
        h.board.push_tx(&chunk);
        h.drain(3);
        if h.last_state()["phase"] == json!("error") {
            break;
        }
    }
    assert_eq!(
        h.last_state()["phase"],
        json!("error"),
        "logs: {:?}",
        h.logs("stderr")
    );
    assert!(
        h.logs("stderr").iter().any(|l| l.contains("4 MiB")),
        "{:?}",
        h.logs("stderr")
    );
}

#[test]
fn ide_user_banner_lines_before_real_tail_survive() {
    // A user printing the banner text or a bare `>` mid-stream must not be
    // filtered; only the firmware's terminal suffix is stripped.
    let mut h = IdeHarness::new();
    h.connect();
    h.board
        .push_tx(b"raw REPL; CTRL-B to exit\r\n>\r\nstill-user\r\n");
    h.drain(6);
    let out = h.logs("stdout").join("");
    assert!(out.contains("raw REPL; CTRL-B to exit"), "{out}");
    assert!(out.contains('>'), "{out}");
    assert!(out.contains("still-user"), "{out}");
    // A real terminal suffix afterwards stays held/stripped — the user
    // copy above remains the only banner in the log.
    h.board.push_tx(b"raw REPL; CTRL-B to exit\r\n>");
    h.drain(6);
    let out2 = h.logs("stdout").join("");
    assert_eq!(
        out2.matches("raw REPL; CTRL-B to exit").count(),
        1,
        "{out2}"
    );
}

#[test]
fn ide_start_camera_shares_run_path() {
    // startCamera must go through the common runScript machinery: running
    // flag + run timestamp set, framebuffer re-enabled even after a pause,
    // frames flow, and stop clears fps.
    let mut h = IdeHarness::new();
    h.connect();
    h.submit(json!({"id": 2, "method": "setPreview", "args": {"enabled": false}}));
    assert!(h.run_until_reply(&json!(2), 1000).get("result").is_some());
    assert_eq!(h.last_state()["preview"], json!(false));
    h.submit(json!({"id": 3, "method": "startCamera", "args": {}}));
    let r = h.run_until_reply(&json!(3), 4000);
    assert!(r.get("result").is_some(), "{r}");
    let st = h.last_state();
    assert_eq!(st["running"], json!(true));
    assert_eq!(st["phase"], json!("running"));
    assert_eq!(st["preview"], json!(true));
    h.drain(80);
    assert!(
        !h.frames().is_empty(),
        "expected frame events while running"
    );
    h.submit(json!({"id": 4, "method": "stop", "args": {}}));
    assert!(h.run_until_reply(&json!(4), 4000).get("result").is_some());
    let st = h.last_state();
    assert_eq!(st["running"], json!(false));
    assert_eq!(st["fps"], serde_json::Value::Null);
}

#[test]
fn format_script_needs_no_device() {
    // Pure local work: no connect, answers directly.
    let mut h = Harness::new();
    h.submit(json!({"id": 1, "method": "formatScript",
        "args": {"code": "x = 1  # gone\n    y = 2\n",
                 "stripComments": true, "spacesToTabs": true}}));
    let r = h.run_until_reply(&json!(1), 500);
    assert_eq!(r["result"], json!("x = 1\n\ty = 2\n"));
    // '#' inside a string literal is not a comment.
    h.submit(json!({"id": 2, "method": "formatScript",
        "args": {"code": "s = '#k'\n", "stripComments": true, "spacesToTabs": false}}));
    let r = h.run_until_reply(&json!(2), 500);
    assert_eq!(r["result"], json!("s = '#k'\n"));
    // Strict boolean validation on both flags.
    h.submit(json!({"id": 3, "method": "formatScript",
        "args": {"code": "x=1", "stripComments": 1, "spacesToTabs": false}}));
    assert!(h.run_until_reply(&json!(3), 500).get("error").is_some());
    h.submit(json!({"id": 4, "method": "formatScript",
        "args": {"code": "x=1", "stripComments": false}}));
    assert!(h.run_until_reply(&json!(4), 500).get("error").is_some());
}

#[test]
fn write_file_startup_requires_explicit_confirm() {
    let mut h = Harness::new();
    h.connect();
    h.board.plant("/flash/boot.py", b"old = 1\n");
    // Missing, false and non-boolean confirmations reject before any write.
    let rejected = [
        json!({"path": "/flash/boot.py", "data": "eA==", "overwrite": true}),
        json!({"path": "/flash/boot.py", "data": "eA==", "overwrite": true, "confirmedStartup": false}),
        json!({"path": "/flash/boot.py", "data": "eA==", "overwrite": true, "confirmedStartup": 1}),
    ];
    for (i, args) in rejected.iter().enumerate() {
        let id = json!(10 + i as i64);
        h.submit(json!({"id": id, "method": "writeFile", "args": args}));
        let r = h.run_until_reply(&id, 1000);
        assert!(r.get("error").is_some(), "startup write must reject: {r}");
        assert_eq!(
            h.board.file("/flash/boot.py").as_deref(),
            Some(b"old = 1\n".as_slice())
        );
    }
    h.submit(json!({"id": 20, "method": "writeFile",
        "args": {"path": "/flash/boot.py", "data": "eA==", "overwrite": true,
                 "confirmedStartup": true}}));
    let r = h.run_until_reply(&json!(20), 4000);
    assert!(
        r.get("result").is_some(),
        "confirmed startup write failed: {r}"
    );
    assert_eq!(
        h.board.file("/flash/boot.py").as_deref(),
        Some(b"x".as_slice())
    );
}

#[test]
fn write_file_readback_checksum_blocks_rename() {
    let mut h = Harness::new();
    h.connect();
    h.board.plant("/flash/keep.bin", b"original");
    h.board.set_corrupt_writes(true);
    h.submit(json!({"id": 2, "method": "writeFile",
        "args": {"path": "/flash/keep.bin", "data": base64_encode(b"replacement"),
                 "overwrite": true}}));
    let r = h.run_until_reply(&json!(2), 4000);
    assert!(
        r["error"].as_str().unwrap_or("").contains("checksum"),
        "{r}"
    );
    assert_eq!(
        h.board.file("/flash/keep.bin").as_deref(),
        Some(b"original".as_slice())
    );
    h.board.set_corrupt_writes(false);
    h.submit(json!({"id": 3, "method": "writeFile",
        "args": {"path": "/flash/keep.bin", "data": base64_encode(b"replacement"),
                 "overwrite": true}}));
    let r = h.run_until_reply(&json!(3), 4000);
    assert!(
        r.get("result").is_some(),
        "clean write after corruption failed: {r}"
    );
    assert_eq!(
        h.board.file("/flash/keep.bin").as_deref(),
        Some(b"replacement".as_slice())
    );
}

#[test]
fn write_file_empty_readback_sha_passes() {
    let mut h = Harness::new();
    h.connect();
    h.submit(json!({"id": 2, "method": "writeFile",
        "args": {"path": "/flash/empty.bin", "data": "", "overwrite": true}}));
    let r = h.run_until_reply(&json!(2), 4000);
    assert!(r.get("result").is_some(), "{r}");
    assert_eq!(h.board.file("/flash/empty.bin"), Some(Vec::new()));
}

// ---------- queued stop/disconnect during an in-flight frame reply ----------

/// Wraps `MockBoard` and injects a queued request while a frame reply is
/// still being read: the 6-byte `[0x30, 0x82, len LE]` dump header sets the
/// owed payload length, the first armed payload read returns a single byte,
/// then the request is submitted through the real `SubmitState` — the exact
/// generation bump a queued stop/disconnect performs on hardware. Any write
/// while payload bytes remain owed is a mid-reply write and is recorded.
struct FrameRequestTransport {
    board: MockBoard,
    shared: Arc<SubmitState>,
    request: Value,
    armed: Arc<AtomicBool>,
    fired: Arc<AtomicBool>,
    wrote_mid_reply: Arc<AtomicBool>,
    remaining: usize,
    stall_after_first_byte: bool,
}

impl Transport for FrameRequestTransport {
    fn in_waiting(&mut self) -> std::io::Result<usize> {
        self.board.in_waiting()
    }

    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.remaining == 0 {
            return self.board.read(buf);
        }
        let armed = self.armed.load(Ordering::SeqCst);
        let fired = self.fired.load(Ordering::SeqCst);
        if armed && fired && self.stall_after_first_byte {
            // A truncated real reply: no more bytes ever arrive.
            return Ok(0);
        }
        // The first armed payload read is limited to one byte so the
        // injection provably lands mid-reply; later reads drain normally.
        let first_armed = armed && !fired;
        let cap = if first_armed { 1 } else { self.remaining }.min(buf.len());
        let n = self.board.read(&mut buf[..cap])?;
        self.remaining = self.remaining.saturating_sub(n);
        if first_armed && n > 0 {
            self.fired.store(true, Ordering::SeqCst);
            self.shared.submit(self.request.clone());
        }
        Ok(n)
    }

    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        if self.remaining > 0 {
            self.wrote_mid_reply.store(true, Ordering::SeqCst);
        }
        if buf.len() == 6 && buf[0] == 0x30 && buf[1] == 0x82 {
            self.remaining = u32::from_le_bytes([buf[2], buf[3], buf[4], buf[5]]) as usize;
        }
        self.board.write_all(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.board.flush()
    }

    fn reset_input_buffer(&mut self) -> std::io::Result<()> {
        self.board.reset_input_buffer()
    }

    fn set_baud_rate(&mut self, baud: u32) -> std::io::Result<()> {
        self.board.set_baud_rate(baud)
    }

    fn unread(&mut self, data: &[u8]) {
        self.board.unread(data);
    }

    fn set_dtr(&mut self, level: bool) -> std::io::Result<()> {
        self.board.set_dtr(level)
    }

    fn set_rts(&mut self, level: bool) -> std::io::Result<()> {
        self.board.set_rts(level)
    }
}

/// Same MockBoard/shared/lines construction as `IdeHarness`, but the
/// transport factory wraps the board in `FrameRequestTransport` and returns
/// the atomic controls. `request` is injected once, mid-frame-reply.
fn ide_frame_harness(
    request: Value,
    stall_after_first_byte: bool,
) -> (
    IdeHarness,
    Arc<AtomicBool>,
    Arc<AtomicBool>,
    Arc<AtomicBool>,
) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::new(SubmitState::new(Box::new(SinkWriter(lines.clone()))));
    let board = MockBoard::new();
    let armed = Arc::new(AtomicBool::new(false));
    let fired = Arc::new(AtomicBool::new(false));
    let wrote_mid_reply = Arc::new(AtomicBool::new(false));
    let port = format!(
        "mock-ide-frame-{}",
        std::thread::current().name().unwrap_or("t")
    );
    let (board2, shared2, request2) = (board.clone(), shared.clone(), request.clone());
    let (a2, f2, w2) = (armed.clone(), fired.clone(), wrote_mid_reply.clone());
    let factory: nodu_device::TransportFactory = Arc::new(move |_, _| {
        Ok(Box::new(FrameRequestTransport {
            board: board2.clone(),
            shared: shared2.clone(),
            request: request2.clone(),
            armed: a2.clone(),
            fired: f2.clone(),
            wrote_mid_reply: w2.clone(),
            remaining: 0,
            stall_after_first_byte,
        }) as Box<dyn Transport>)
    });
    (
        IdeHarness {
            worker: Worker::new(shared, factory),
            lines,
            board,
            port,
        },
        armed,
        fired,
        wrote_mid_reply,
    )
}

#[test]
fn ide_queued_stop_drains_inflight_frame() {
    let (mut h, armed, fired, wrote_mid_reply) =
        ide_frame_harness(json!({"id": 90, "method": "stop", "args": {}}), false);
    h.connect();
    h.submit(json!({"id": 2, "method": "startCamera", "args": {}}));
    assert!(h.run_until_reply(&json!(2), 4000).get("result").is_some());
    h.drain(20);
    let frames_before = h.frames().len();
    // Arm only after connect + camera replies so the injection lands inside
    // a pending frame read, not between worker steps.
    armed.store(true, Ordering::SeqCst);
    h.worker.step(Duration::from_millis(2));
    assert!(
        fired.load(Ordering::SeqCst),
        "request was not injected mid-reply"
    );
    let r = h.run_until_reply(&json!(90), 4000);
    assert!(r.get("result").is_some(), "stop failed: {r}");
    assert!(
        !wrote_mid_reply.load(Ordering::SeqCst),
        "a write hit the wire while reply bytes were still owed"
    );
    assert!(
        h.frames().len() > frames_before,
        "the in-flight frame never became an event"
    );
    let st = h.last_state();
    assert_eq!(st["phase"], json!("connected"), "{st}");
    assert_eq!(st["running"], json!(false));
    assert!(
        !h.logs("stderr").iter().any(|l| l.contains("desynchroniz")),
        "stderr: {:?}",
        h.logs("stderr")
    );
    // The link survived: a fresh request works without reconnecting.
    h.submit(json!({"id": 3, "method": "execute", "args": {"code": "print(7)"}}));
    let r3 = h.run_until_reply(&json!(3), 3000);
    assert_eq!(r3["result"], json!("7\n"), "{r3}");
}

#[test]
fn ide_queued_disconnect_drains_inflight_frame() {
    let (mut h, armed, fired, wrote_mid_reply) =
        ide_frame_harness(json!({"id": 90, "method": "disconnect", "args": {}}), false);
    h.connect();
    h.submit(json!({"id": 2, "method": "startCamera", "args": {}}));
    assert!(h.run_until_reply(&json!(2), 4000).get("result").is_some());
    h.drain(20);
    let frames_before = h.frames().len();
    armed.store(true, Ordering::SeqCst);
    h.worker.step(Duration::from_millis(2));
    assert!(
        fired.load(Ordering::SeqCst),
        "request was not injected mid-reply"
    );
    let r = h.run_until_reply(&json!(90), 4000);
    assert!(r.get("result").is_some(), "disconnect failed: {r}");
    assert!(
        !wrote_mid_reply.load(Ordering::SeqCst),
        "a write hit the wire while reply bytes were still owed"
    );
    assert!(
        h.frames().len() > frames_before,
        "the in-flight frame never became an event"
    );
    assert_eq!(h.last_state()["phase"], json!("disconnected"));
    assert!(
        !h.logs("stderr").iter().any(|l| l.contains("desynchroniz")),
        "stderr: {:?}",
        h.logs("stderr")
    );
    // Reconnect with a fresh id (the connect id1 reply is already in lines).
    h.submit(json!({"id": 3, "method": "connect",
        "args": {"port": h.port.clone(), "boardProfile": "generic-k210", "boardId": 2}}));
    let r3 = h.run_until_reply(&json!(3), 8000);
    assert!(r3.get("result").is_some(), "reconnect failed: {r3}");
    assert_eq!(h.last_state()["protocol"], json!("ide"));
}

#[test]
fn ide_queued_stop_stalled_frame_still_fails_closed() {
    let (mut h, armed, fired, wrote_mid_reply) =
        ide_frame_harness(json!({"id": 90, "method": "stop", "args": {}}), true);
    h.connect();
    h.submit(json!({"id": 2, "method": "startCamera", "args": {}}));
    assert!(h.run_until_reply(&json!(2), 4000).get("result").is_some());
    h.drain(20);
    let frames_before = h.frames().len();
    // Tight timeouts model a reply that starts then stops progressing.
    h.worker.set_read_timeouts(
        Some(Duration::from_millis(120)),
        Some(Duration::from_millis(30)),
    );
    armed.store(true, Ordering::SeqCst);
    h.worker.step(Duration::from_millis(2));
    assert!(
        fired.load(Ordering::SeqCst),
        "request was not injected mid-reply"
    );
    // The stalled reply desyncs the stream; the queued stop then gets a
    // reply without ever writing onto the poisoned transport.
    let r = h.run_until_reply(&json!(90), 4000);
    assert!(r.get("id") == Some(&json!(90)), "{r}");
    assert!(
        !wrote_mid_reply.load(Ordering::SeqCst),
        "queued stop wrote onto a mid-reply/poisoned transport"
    );
    assert_eq!(
        h.frames().len(),
        frames_before,
        "a truncated frame must not become an event"
    );
    let st = h.last_state();
    assert_eq!(st["phase"], json!("error"), "{st}");
    assert_eq!(st["capabilities"]["framebuffer"], json!(false));
    assert!(
        h.logs("stderr").iter().any(|l| l.contains("stalled")),
        "stderr: {:?}",
        h.logs("stderr")
    );
}
