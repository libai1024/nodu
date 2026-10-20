// SPDX-License-Identifier: MIT
//! Loopback integration tests for the `nodu-terminal` binary: exact bytes
//! through the process's stdin/stdout pipes against in-test TCP/UDP peers.
//! No serial hardware is touched; serial coverage is parse-only.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_nodu-terminal");

fn spawn_terminal(args: &[&str]) -> Child {
    Command::new(BIN)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn nodu-terminal")
}

/// Read until `buf` holds exactly `n` bytes or the deadline passes.
fn read_exact_deadline(reader: &mut impl Read, buf: &mut [u8], deadline: Duration) -> usize {
    let end = Instant::now() + deadline;
    let mut got = 0;
    while got < buf.len() && Instant::now() < end {
        match reader.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break,
        }
    }
    got
}

/// Child stdout drained on a thread: blocking pipe reads cannot honour a
/// deadline, so tests poll this shared buffer instead.
struct OutCollector {
    bytes: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
}

impl OutCollector {
    fn from(mut reader: impl Read + Send + 'static) -> Self {
        let bytes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = std::sync::Arc::clone(&bytes);
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => sink.lock().unwrap().extend_from_slice(&buf[..n]),
                }
            }
        });
        Self { bytes }
    }

    fn new(child: &mut Child) -> Self {
        Self::from(child.stdout.take().expect("stdout"))
    }

    /// Collected bytes so far (diagnostics only).
    fn snapshot(&self) -> Vec<u8> {
        self.bytes.lock().unwrap().clone()
    }

    /// Wait until `want` appears at the start of the stream, then consume it.
    fn expect(&self, want: &[u8], deadline: Duration) {
        let end = Instant::now() + deadline;
        while Instant::now() < end {
            {
                let mut b = self.bytes.lock().unwrap();
                if b.len() >= want.len() {
                    let got = b[..want.len()].to_vec();
                    b.drain(..want.len());
                    assert_eq!(got, want, "stdout bytes differ");
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!(
            "expected {want:?} on child stdout, got {:?}",
            self.bytes.lock().unwrap()
        );
    }
}

fn wait_exit(child: &mut Child, deadline: Duration) -> Option<i32> {
    let end = Instant::now() + deadline;
    while Instant::now() < end {
        if let Ok(Some(status)) = child.try_wait() {
            return status.code();
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    None
}

/// Wait for the `Listening on ...` stderr line (bounded via the collector
/// thread — a direct `read_line` could block forever on a silent child).
fn stderr_line(child: &mut Child) -> String {
    let err = OutCollector::from(child.stderr.take().expect("stderr"));
    let end = Instant::now() + Duration::from_secs(10);
    while Instant::now() < end {
        let text = String::from_utf8_lossy(&err.snapshot()).into_owned();
        if let Some(line) = text.lines().next() {
            return line.to_string();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    String::new()
}

/// Wait until `needle` has appeared `count` times in collected stderr.
fn stderr_seen(err: &OutCollector, needle: &str, count: usize, deadline: Duration) -> bool {
    let end = Instant::now() + deadline;
    while Instant::now() < end {
        let text = String::from_utf8_lossy(&err.snapshot()).into_owned();
        if text.matches(needle).count() >= count {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

/// Bound port from the first `Listening on <addr>:<port>` status line.
fn bound_port(err: &OutCollector) -> u16 {
    assert!(
        stderr_seen(err, "Listening on", 1, Duration::from_secs(10)),
        "no bound-port line in stderr"
    );
    let text = String::from_utf8_lossy(&err.snapshot()).into_owned();
    let line = text
        .lines()
        .find(|l| l.contains("Listening on"))
        .unwrap_or_default();
    line.trim()
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(|| panic!("no bound port reported: {text:?}"))
}

#[test]
fn cli_rejects_missing_and_conflicting_flags() {
    let out = Command::new(BIN).output().expect("no args");
    assert_eq!(out.status.code(), Some(2));
    let out = Command::new(BIN)
        .args([
            "-open_tcp_client_terminal",
            "127.0.0.1:1",
            "-open_udp_client_terminal",
            "127.0.0.1:1",
        ])
        .output()
        .expect("conflict");
    assert_eq!(out.status.code(), Some(2));
    let out = Command::new(BIN)
        .args(["-open_tcp_server_terminal", "abc"])
        .output()
        .expect("bad port");
    assert_eq!(out.status.code(), Some(2));
    let out = Command::new(BIN).args(["--help"]).output().expect("help");
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("Ctrl-]"));
}

#[test]
fn device_binary_rejects_bad_timeout_flags_before_any_port() {
    // `-override_read_timeout` validation fails before a port could be opened.
    for args in [
        vec!["-override_read_timeout", "abc"],
        vec!["-override_read_timeout", "0"],
        vec!["-override_read_stall_timeout", "60001"],
        vec!["-override_read_timeout"],
        vec!["--bogus"],
    ] {
        let out = Command::new(env!("CARGO_BIN_EXE_nodu-device"))
            .args(&args)
            .output()
            .expect("device spawn");
        assert_eq!(out.status.code(), Some(2), "args {args:?}");
    }
    // Valid flags: stdin EOF ends the worker loop cleanly.
    let mut child = Command::new(env!("CARGO_BIN_EXE_nodu-device"))
        .args([
            "-override_read_timeout",
            "5000",
            "-override_read_stall_timeout",
            "1000",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("device spawn");
    assert_eq!(wait_exit(&mut child, Duration::from_secs(10)), Some(0));
}

#[test]
fn tcp_client_forwards_binary_both_ways_and_ctrl_bracket_exits() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().unwrap().port();
    let mut child = spawn_terminal(&[
        "-open_tcp_client_terminal",
        &format!("127.0.0.1:{port}"),
        "--connect-timeout-ms",
        "5000",
    ]);
    let (mut peer, _) = listener.accept().expect("accept");
    peer.set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    // keyboard -> socket: exact bytes including Ctrl-R (0x12).
    let payload = b"abc\x12def\x05g";
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(payload)
        .expect("stdin write");
    let mut got = [0u8; 64];
    let n = read_exact_deadline(&mut peer, &mut got, Duration::from_secs(5));
    assert_eq!(&got[..n], payload);
    // socket -> stdout: same treatment, no UTF-8 or line processing.
    let reply = [0x00, 0xff, b'\x12', b'Z'];
    peer.write_all(&reply).expect("reply");
    let out = OutCollector::new(&mut child);
    out.expect(&reply, Duration::from_secs(5));
    // Ctrl-] exits locally and drops the socket.
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"more\x1d")
        .unwrap();
    assert_eq!(wait_exit(&mut child, Duration::from_secs(10)), Some(0));
}

#[test]
fn stdin_eof_exits_cleanly() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().unwrap().port();
    let mut child = spawn_terminal(&[
        "-open_tcp_client_terminal",
        &format!("127.0.0.1:{port}"),
        "--connect-timeout-ms",
        "5000",
    ]);
    listener.accept().expect("accept");
    drop(child.stdin.take());
    assert_eq!(wait_exit(&mut child, Duration::from_secs(10)), Some(0));
}

#[test]
fn tcp_server_reports_port_and_echoes_then_relistens() {
    let mut child = spawn_terminal(&[
        "-open_tcp_server_terminal",
        "0",
        "--bind",
        "127.0.0.1",
        "--io-timeout-ms",
        "5000",
    ]);
    let line = stderr_line(&mut child);
    let port: u16 = line
        .trim()
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(|| panic!("no bound port reported: {line:?}"));
    assert!(line.contains("Listening on 127.0.0.1"), "{line}");
    assert_ne!(port, 0);
    // Peer 1: both directions.
    let mut peer = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    peer.set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(b"hi\x12").unwrap();
    let mut buf = [0u8; 16];
    let n = read_exact_deadline(&mut peer, &mut buf, Duration::from_secs(5));
    assert_eq!(&buf[..n], b"hi\x12");
    peer.write_all(b"back").unwrap();
    let out = OutCollector::new(&mut child);
    out.expect(b"back", Duration::from_secs(5));
    drop(peer); // peer EOF: server returns to accept() for the next peer.
    let mut peer2 = TcpStream::connect(("127.0.0.1", port)).expect("reconnect");
    peer2
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    child.stdin.as_mut().unwrap().write_all(b"two").unwrap();
    let n = read_exact_deadline(&mut peer2, &mut buf, Duration::from_secs(5));
    assert_eq!(&buf[..n], b"two");
    child.stdin.as_mut().unwrap().write_all(b"\x1d").unwrap();
    assert_eq!(wait_exit(&mut child, Duration::from_secs(10)), Some(0));
}

/// A peer that vanishes with RST (not FIN) must end the session like a
/// normal disconnect: the server reports it and accepts the next peer.
#[test]
fn tcp_server_recovers_from_peer_reset() {
    let mut child = spawn_terminal(&["-open_tcp_server_terminal", "0", "--bind", "127.0.0.1"]);
    let err = OutCollector::from(child.stderr.take().expect("stderr"));
    let port = bound_port(&err);

    // A peer that resets an *established* session: connect first (a RST on
    // a still-queued connection is silently dropped by the kernel and would
    // never reach the session), wait for the accept, then SO_LINGER(1,0) +
    // close sends RST. std cannot set linger, so a python one-liner does it
    // (loopback only).
    let mut rst = Command::new("python3")
        .args([
            "-c",
            "import socket,struct,sys,time;\
s=socket.socket();s.connect(('127.0.0.1',int(sys.argv[1])));\
time.sleep(float(sys.argv[2]));\
s.setsockopt(socket.SOL_SOCKET,socket.SO_LINGER,struct.pack('ii',1,0));\
s.close()",
            &port.to_string(),
            "0.5",
        ])
        .spawn()
        .expect("python3 for RST");
    assert!(
        stderr_seen(&err, "Peer connected:", 1, Duration::from_secs(10)),
        "RST peer was never accepted"
    );
    assert!(
        rst.wait().expect("rst client").success(),
        "python RST client failed"
    );
    // The reset session ends like a normal disconnect and the listener
    // comes back up.
    assert!(
        stderr_seen(
            &err,
            "Peer closed; listening again.",
            1,
            Duration::from_secs(10)
        ),
        "reset peer did not end the session"
    );
    let mut peer = TcpStream::connect(("127.0.0.1", port)).expect("reconnect after RST");
    peer.set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    // Wait for the accept before typing: input typed while no peer is
    // attached is deliberately dropped.
    assert!(
        stderr_seen(&err, "Peer connected:", 2, Duration::from_secs(10)),
        "server did not re-accept after RST"
    );
    child.stdin.as_mut().unwrap().write_all(b"live").unwrap();
    let mut buf = [0u8; 16];
    let n = read_exact_deadline(&mut peer, &mut buf, Duration::from_secs(5));
    assert_eq!(&buf[..n], b"live");
    child.stdin.as_mut().unwrap().write_all(b"\x1d").unwrap();
    assert_eq!(wait_exit(&mut child, Duration::from_secs(10)), Some(0));
}

/// The UDP client must reach an IPv6 peer: without --bind it has to pick an
/// IPv6 ANY source, not the IPv4 127.0.0.1 default. Skipped where the host
/// has no IPv6 loopback.
#[test]
fn udp_ipv6_loopback() {
    if UdpSocket::bind(("::1", 0)).is_err() {
        eprintln!("udp_ipv6_loopback: no IPv6 loopback, skipping");
        return;
    }
    // UDP client -> ::1 server, auto-selected bind.
    let socket = UdpSocket::bind(("::1", 0)).expect("v6 bind");
    socket
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let port = socket.local_addr().unwrap().port();
    let mut child = spawn_terminal(&[
        "-open_udp_client_terminal",
        &format!("[::1]:{port}"),
        "--connect-timeout-ms",
        "5000",
    ]);
    child.stdin.as_mut().unwrap().write_all(b"v6").unwrap();
    let mut buf = [0u8; 16];
    let end = Instant::now() + Duration::from_secs(5);
    let (n, from) = loop {
        match socket.recv_from(&mut buf) {
            Ok(v) => break v,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                assert!(Instant::now() < end, "no IPv6 datagram from client");
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => panic!("recv: {e}"),
        }
    };
    assert_eq!(&buf[..n], b"v6");
    assert!(from.is_ipv6(), "peer came from {from}");
    socket.send_to(b"ok", from).unwrap();
    let out = OutCollector::new(&mut child);
    out.expect(b"ok", Duration::from_secs(5));
    child.stdin.as_mut().unwrap().write_all(b"\x1d").unwrap();
    assert_eq!(wait_exit(&mut child, Duration::from_secs(10)), Some(0));

    // UDP server bound to ::1 replies to the IPv6 sender.
    let mut server = spawn_terminal(&["-open_udp_server_terminal", "0", "--bind", "::1"]);
    let line = stderr_line(&mut server);
    let port: u16 = line
        .trim()
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(|| panic!("no bound port reported: {line:?}"));
    socket.send_to(b"q6", ("::1", port)).unwrap();
    let out = OutCollector::new(&mut server);
    out.expect(b"q6", Duration::from_secs(5));
    server.stdin.as_mut().unwrap().write_all(b"\x1d").unwrap();
    assert_eq!(wait_exit(&mut server, Duration::from_secs(10)), Some(0));
}

/// Real PTY run (python3 pty module): proves the crossterm raw-mode path
/// forwards Ctrl-C/Ctrl-R as bytes, Ctrl-] exits, and termios is restored.
#[test]
fn pty_raw_mode_forwards_control_bytes() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("pty_raw_mode.py");
    let out = match Command::new("python3").arg(&script).arg(BIN).output() {
        Ok(out) => out,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("pty_raw_mode_forwards_control_bytes: python3 missing, skipping");
            return;
        }
        Err(e) => panic!("python3: {e}"),
    };
    assert!(
        out.status.success(),
        "pty test failed: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn udp_client_connected_peer_only() {
    let socket = UdpSocket::bind(("127.0.0.1", 0)).expect("bind");
    socket
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    let port = socket.local_addr().unwrap().port();
    let mut child = spawn_terminal(&[
        "-open_udp_client_terminal",
        &format!("127.0.0.1:{port}"),
        "--connect-timeout-ms",
        "5000",
    ]);
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"ping\x12")
        .unwrap();
    let mut buf = [0u8; 64];
    let end = Instant::now() + Duration::from_secs(5);
    // The child's UDP source port is only known once its datagram arrives.
    let (n, child_addr) = loop {
        match socket.recv_from(&mut buf) {
            Ok(v) => break v,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                assert!(Instant::now() < end, "udp client datagram never arrived");
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => panic!("recv: {e}"),
        }
    };
    assert_eq!(&buf[..n], b"ping\x12");
    socket.send_to(b"pong", child_addr).expect("reply");
    let out = OutCollector::new(&mut child);
    out.expect(b"pong", Duration::from_secs(5));
    child.stdin.as_mut().unwrap().write_all(b"\x1d").unwrap();
    assert_eq!(wait_exit(&mut child, Duration::from_secs(10)), Some(0));
}

#[test]
fn udp_server_replies_to_last_sender() {
    let mut child = spawn_terminal(&["-open_udp_server_terminal", "0", "--bind", "127.0.0.1"]);
    let line = stderr_line(&mut child);
    let port: u16 = line
        .trim()
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or_else(|| panic!("no bound port reported: {line:?}"));
    let socket = UdpSocket::bind(("127.0.0.1", 0)).expect("bind");
    socket
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();
    socket.send_to(b"question", ("127.0.0.1", port)).unwrap();
    let out = OutCollector::new(&mut child);
    out.expect(b"question", Duration::from_secs(5));
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"answer\x05")
        .unwrap();
    let mut buf = [0u8; 32];
    let end = Instant::now() + Duration::from_secs(5);
    let n = loop {
        match socket.recv(&mut buf) {
            Ok(v) => break v,
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                assert!(Instant::now() < end, "udp server reply never arrived");
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => panic!("recv: {e}"),
        }
    };
    assert_eq!(&buf[..n], b"answer\x05");
    child.stdin.as_mut().unwrap().write_all(b"\x1d").unwrap();
    assert_eq!(wait_exit(&mut child, Duration::from_secs(10)), Some(0));
}
