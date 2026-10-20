// SPDX-License-Identifier: MIT
// Integration tests for the `nodu-resources` sidecar: loopback HTTP only,
// no devices involved.

use std::fs;
use std::io::{BufRead, BufReader, Cursor, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use nodu_resources as lib;
use nodu_resources::Version;
use sha2::Digest;

const BIN: &str = env!("CARGO_BIN_EXE_nodu-resources");

struct Http {
    base: String,
    stop: Arc<AtomicBool>,
    listener: Option<thread::JoinHandle<()>>,
}

/// One route -> (status, headers, body); `chunked` streams the body without
/// Content-Length (covers `total: null` progress) and `slow` spreads chunks
/// over time so cancellation can interrupt mid-download.
struct Route {
    status: &'static str,
    body: Vec<u8>,
    chunked: bool,
    slow: bool,
    endless: bool,
}

impl Route {
    fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: "200 OK",
            body: body.into(),
            chunked: false,
            slow: false,
            endless: false,
        }
    }
    fn chunked(mut self) -> Self {
        self.chunked = true;
        self
    }
    fn slow(mut self) -> Self {
        self.slow = true;
        self.chunked = true;
        self.endless = true;
        self
    }
}

fn serve(routes: Vec<(&'static str, Route)>) -> Http {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    let handle = thread::spawn(move || {
        let routes = Arc::new(routes);
        while !flag.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let routes = Arc::clone(&routes);
                    thread::spawn(move || {
                        stream.set_nonblocking(false).unwrap();
                        let mut head = Vec::new();
                        let mut byte = [0u8; 1];
                        while !head.ends_with(b"\r\n\r\n") && head.len() < 8192 {
                            if stream.read(&mut byte).unwrap_or(0) == 0 {
                                return;
                            }
                            head.push(byte[0]);
                        }
                        let request = String::from_utf8_lossy(&head);
                        let path = request
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or("/")
                            .split('?')
                            .next()
                            .unwrap_or("/")
                            .to_string();
                        let Some((_, route)) = routes.iter().find(|(p, _)| *p == path) else {
                            let _ = stream
                                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                            return;
                        };
                        if route.chunked {
                            let _ = stream.write_all(
                                format!(
                                    "HTTP/1.1 {}\r\nTransfer-Encoding: chunked\r\n\r\n",
                                    route.status
                                )
                                .as_bytes(),
                            );
                            let mut send = |data: &[u8]| {
                                stream
                                    .write_all(format!("{:x}\r\n", data.len()).as_bytes())
                                    .and_then(|()| stream.write_all(data))
                                    .and_then(|()| stream.write_all(b"\r\n"))
                            };
                            if route.endless {
                                let mut first = true;
                                while send(if first { &route.body } else { &[0u8; 16_384] }).is_ok()
                                {
                                    first = false;
                                    if route.slow {
                                        thread::sleep(Duration::from_millis(25));
                                    }
                                }
                                return;
                            }
                            if send(&route.body).is_err() {
                                return;
                            }
                            let _ = stream.write_all(b"0\r\n\r\n");
                        } else {
                            let _ = stream.write_all(
                                format!(
                                    "HTTP/1.1 {}\r\nContent-Length: {}\r\n\r\n",
                                    route.status,
                                    route.body.len()
                                )
                                .as_bytes(),
                            );
                            let _ = stream.write_all(&route.body);
                        }
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });
    Http {
        base: format!("http://127.0.0.1:{port}"),
        stop,
        listener: Some(handle),
    }
}

impl Drop for Http {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.listener.take() {
            let _ = h.join();
        }
    }
}

fn tmpdir(name: &str) -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix(&format!("nodu-res-{name}-"))
        .tempdir()
        .unwrap()
}

/// Spawn the sidecar with stdin held open (a null stdin is immediate EOF ==
/// cancel by contract). Stdout is drained on a thread so a chatty download
/// cannot deadlock on a full pipe.
fn spawn_bin(args: &[&str]) -> Child {
    Command::new(BIN)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap()
}

fn wait_collect(mut child: Child) -> std::process::Output {
    // `Child::wait()` closes `child.stdin` before waiting; take it so the
    // write end stays open for the whole run — a held-open stdin means "no
    // cancel", matching how the Node caller spawns the sidecar.
    let stdin = child.stdin.take().unwrap();
    let mut pipe = child.stdout.take().unwrap();
    let reader = thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        buf
    });
    let status = child.wait().unwrap();
    drop(stdin);
    let stdout = reader.join().unwrap();
    std::process::Output {
        status,
        stdout,
        stderr: Vec::new(),
    }
}

fn bin(args: &[&str]) -> std::process::Output {
    wait_collect(spawn_bin(args))
}

fn last_line(output: &std::process::Output) -> serde_json::Value {
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().last().expect("expected json output");
    serde_json::from_str(line).expect("last line must be json")
}

fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in files {
        writer.start_file(*name, opts).unwrap();
        writer.write_all(data).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// `unix_permissions` masks the file-type bits, so a hostile mode must be
/// patched into the central directory's external-attributes field after the
/// archive is built (offset 38 of each `PK\x01\x02` record, mode << 16).
fn make_zip_mode(name: &str, data: &[u8], mode: u32) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer.start_file(name, opts).unwrap();
    writer.write_all(data).unwrap();
    let mut zip = writer.finish().unwrap().into_inner();
    let sig = b"PK\x01\x02";
    let at = zip
        .windows(sig.len())
        .position(|w| w == sig)
        .expect("central directory record");
    zip[at + 38..at + 42].copy_from_slice(&(mode << 16).to_le_bytes());
    zip
}

fn make_zip_zeros(count: usize, name: &str) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    writer.start_file(name, opts).unwrap();
    let zeros = vec![0u8; 1024 * 1024];
    for _ in 0..count {
        writer.write_all(&zeros).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

fn version_file(dir: &Path) -> std::path::PathBuf {
    dir.join("version.json")
}

// ---------- check-version / check-resources ----------

#[test]
fn check_version_ok_newer_equal_older() {
    let http = serve(vec![("/v", Route::ok(" 0.9.0\n"))]);
    for (installed, newer) in [("0.1.0", true), ("0.9.0", false), ("1.0.0", false)] {
        for cmd in ["check-version", "check-resources"] {
            let flag = if cmd == "check-version" {
                "--current"
            } else {
                "--installed"
            };
            let out = bin(&[cmd, "--url", &format!("{}/v", http.base), flag, installed]);
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stdout)
            );
            let json = last_line(&out);
            assert_eq!(json["result"]["latest"], "0.9.0");
            assert_eq!(json["result"]["newer"], newer);
        }
    }
}

#[test]
fn check_version_rejects_garbage_oversize_and_errors() {
    for (body, label) in [
        ("not-a-version", "garbage"),
        ("0.2.5-beta", "suffix"),
        ("0.2.5.1", "four parts"),
    ] {
        let http = serve(vec![("/v", Route::ok(body))]);
        let out = bin(&[
            "check-version",
            "--url",
            &format!("{}/v", http.base),
            "--current",
            "0.0.1",
        ]);
        assert!(!out.status.success(), "{label} must fail");
        assert!(last_line(&out)["error"].is_string());
    }
    // 65-byte body exceeds the 64-byte limit.
    let big = format!("{}.{}.{}", "0", "0", "5".repeat(60));
    let http = serve(vec![("/v", Route::ok(big))]);
    let out = bin(&[
        "check-version",
        "--url",
        &format!("{}/v", http.base),
        "--current",
        "0.0.1",
    ]);
    assert!(!out.status.success(), "oversize body must fail");
    // 404 propagates as an error too.
    let out = bin(&[
        "check-version",
        "--url",
        &format!("{}/absent", http.base),
        "--current",
        "0.0.1",
    ]);
    assert!(!out.status.success(), "http error must fail");
}

#[test]
fn unsafe_urls_are_refused() {
    for url in [
        "http://example.com/x",
        "ftp://127.0.0.1/x",
        "file:///etc/passwd",
    ] {
        let out = bin(&["check-version", "--url", url, "--current", "0.0.1"]);
        assert!(!out.status.success(), "{url} must be refused");
    }
}

#[test]
fn bad_cli_args_fail() {
    for args in [
        vec!["check-version", "--current", "1.2.3"],
        vec!["check-version", "--url", "x", "--current", "1.2"],
        vec!["install", "--version", "1.2.3"],
        vec!["reset", "--bundled", "/tmp"],
        vec!["bogus"],
    ] {
        let out = bin(&args);
        assert!(
            !out.status.success(),
            "{args:?} must fail, got {:?}",
            out.status
        );
    }
}

// ---------- install ----------

#[test]
fn install_downloads_extracts_and_writes_version() {
    let zip = make_zip(&[
        ("examples/a.py", b"print(1)"),
        ("examples/dir/b.py", b"print(2)"),
    ]);
    let sha = format!("{:x}", sha2::Sha256::digest(&zip));
    let http = serve(vec![
        ("/r-1.2.3.zip", Route::ok(zip)),
        (
            "/r-1.2.3.zip.sha256",
            Route::ok(format!("{sha}  r-1.2.3.zip\n")),
        ),
    ]);
    let dir = tmpdir("install-ok");
    let dest = dir.path().join("resources");
    let vf = version_file(dir.path());
    let out = bin(&[
        "install",
        "--url-template",
        &format!("{}/r-%1.%2.%3.zip", http.base),
        "--version",
        "1.2.3",
        "--dest",
        dest.to_str().unwrap(),
        "--version-file",
        vf.to_str().unwrap(),
        "--sha256",
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("\"event\":\"progress\""), "{stdout}");
    assert_eq!(last_line(&out)["result"]["installed"], "1.2.3");
    assert_eq!(fs::read(dest.join("examples/a.py")).unwrap(), b"print(1)");
    assert_eq!(
        fs::read(dest.join("examples/dir/b.py")).unwrap(),
        b"print(2)"
    );
    let recorded = lib::read_version_file(&vf);
    assert_eq!(
        recorded,
        Version {
            major: 1,
            minor: 2,
            patch: 3
        }
    );
    // no temp/staging/backup residue
    for entry in fs::read_dir(dir.path()).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        assert!(!name.starts_with('.'), "residue left: {name}");
    }
}

#[test]
fn install_swap_replaces_old_resources() {
    let zip = make_zip(&[("fresh.txt", b"new")]);
    let http = serve(vec![("/r-0.2.0.zip", Route::ok(zip))]);
    let dir = tmpdir("install-swap");
    let dest = dir.path().join("resources");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("old.txt"), "old").unwrap();
    let vf = version_file(dir.path());
    let out = bin(&[
        "install",
        "--url-template",
        &format!("{}/r-%1.%2.%3.zip", http.base),
        "--version",
        "0.2.0",
        "--dest",
        dest.to_str().unwrap(),
        "--version-file",
        vf.to_str().unwrap(),
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert!(dest.join("fresh.txt").exists());
    assert!(!dest.join("old.txt").exists(), "old tree fully replaced");
}

#[test]
fn sha256_mismatch_keeps_old_resources_and_version() {
    let zip = make_zip(&[("evil.txt", b"bad")]);
    let http = serve(vec![
        ("/r.zip", Route::ok(zip)),
        (
            "/r.zip.sha256",
            Route::ok(format!("{}  r.zip\n", "0".repeat(64))),
        ),
    ]);
    let dir = tmpdir("install-sha-bad");
    let dest = dir.path().join("resources");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("keep.txt"), "keep").unwrap();
    let vf = version_file(dir.path());
    fs::write(&vf, r#"{"major":0,"minor":1,"patch":0}"#).unwrap();
    let out = bin(&[
        "install",
        "--url-template",
        &format!("{}/r.zip", http.base),
        "--version",
        "9.9.9",
        "--dest",
        dest.to_str().unwrap(),
        "--version-file",
        vf.to_str().unwrap(),
        "--sha256",
    ]);
    assert!(!out.status.success(), "sha mismatch must fail");
    assert!(dest.join("keep.txt").exists(), "old resources untouched");
    assert!(!dest.join("evil.txt").exists());
    assert_eq!(
        lib::read_version_file(&vf),
        Version {
            major: 0,
            minor: 1,
            patch: 0
        },
        "version file untouched"
    );
}

#[test]
fn missing_sha256_file_fails_install() {
    let zip = make_zip(&[("a.txt", b"a")]);
    let http = serve(vec![("/r.zip", Route::ok(zip))]);
    let dir = tmpdir("install-sha-missing");
    let out = bin(&[
        "install",
        "--url-template",
        &format!("{}/r.zip", http.base),
        "--version",
        "1.0.0",
        "--dest",
        &dir.path().join("resources").to_string_lossy(),
        "--version-file",
        &version_file(dir.path()).to_string_lossy(),
        "--sha256",
    ]);
    assert!(!out.status.success());
}

#[test]
fn cancel_via_stdin_eof_aborts_and_cleans_up() {
    // Endless slow stream: the download never finishes on its own.
    let http = serve(vec![("/r.zip", Route::ok(vec![0u8; 1024]).slow())]);
    let dir = tmpdir("install-cancel");
    let dest = dir.path().join("resources");
    let mut child = Command::new(BIN)
        .args([
            "install",
            "--url-template",
            &format!("{}/r.zip", http.base),
            "--version",
            "1.0.0",
            "--dest",
            &dest.to_string_lossy(),
            "--version-file",
            &version_file(dir.path()).to_string_lossy(),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    // Wait for real download progress before closing stdin.
    let stdout = child.stdout.take().unwrap();
    let mut lines = BufReader::new(stdout).lines();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut saw_progress = false;
    while Instant::now() < deadline {
        match lines.next() {
            Some(Ok(line)) if line.contains("\"event\":\"progress\"") => {
                saw_progress = true;
                break;
            }
            Some(Ok(_)) => {}
            _ => break,
        }
    }
    assert!(saw_progress, "no progress event before cancel");
    drop(child.stdin.take()); // EOF == cancel
    let status = child.wait().unwrap();
    assert!(!status.success(), "cancelled install must exit nonzero");
    let mut rest = String::new();
    for line in lines.map_while(Result::ok) {
        rest.push_str(&line);
        rest.push('\n');
    }
    let last = rest.lines().last().expect("expected json output");
    let json: serde_json::Value = serde_json::from_str(last).unwrap();
    assert_eq!(json["error"], "cancelled", "{rest}");
    assert!(!dest.exists(), "cancelled install leaves no dest");
    for entry in fs::read_dir(dir.path()).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        assert!(!name.starts_with(".resources."), "residue left: {name}");
    }
}

// ---------- archive safety ----------

fn install_zip(dir: &tempfile::TempDir, zip: Vec<u8>) -> std::process::Output {
    let http = serve(vec![("/r.zip", Route::ok(zip))]);
    bin(&[
        "install",
        "--url-template",
        &format!("{}/r.zip", http.base),
        "--version",
        "1.0.0",
        "--dest",
        &dir.path().join("resources").to_string_lossy(),
        "--version-file",
        &version_file(dir.path()).to_string_lossy(),
    ])
}

#[test]
fn zip_slip_entries_are_rejected() {
    let dir = tmpdir("slip");
    for (name, zip) in [
        ("dotdot", make_zip(&[("../escape.txt", b"x")])),
        ("dotdot-nested", make_zip(&[("a/../../escape.txt", b"x")])),
        ("absolute", make_zip(&[("/etc/nodu-evil", b"x")])),
        ("windows-absolute", make_zip(&[("C:/evil/x.txt", b"x")])),
    ] {
        let out = install_zip(&dir, zip);
        assert!(!out.status.success(), "{name} must fail: {:?}", out.status);
        assert!(!dir.path().join("escape.txt").exists());
        assert!(!Path::new("/etc/nodu-evil").exists());
    }
    // Symlink entry: unix mode 0120xxx.
    let out = install_zip(&dir, make_zip_mode("link.txt", b"target", 0o120777));
    assert!(!out.status.success(), "symlink must fail");
    // FIFO / socket entries (mode 0010xxx / 0140xxx) rejected as non-regular.
    let out = install_zip(&dir, make_zip_mode("fifo", b"", 0o010644));
    assert!(!out.status.success(), "fifo must fail");
}

#[test]
fn entry_count_limit_enforced() {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default();
    for i in 0..=20_000usize {
        writer.start_file(format!("f{i}.txt"), opts).unwrap();
        writer.write_all(b"x").unwrap();
    }
    let zip = writer.finish().unwrap().into_inner();
    let dir = tmpdir("entries");
    let out = install_zip(&dir, zip);
    assert!(!out.status.success(), ">20000 entries must fail");
}

#[test]
fn single_file_size_limit_enforced_on_written_bytes() {
    // 65 MiB of zeros deflates small — the cap must hit on output bytes.
    let zip = make_zip_zeros(65, "big.bin");
    let dir = tmpdir("filesize");
    let out = install_zip(&dir, zip);
    assert!(!out.status.success(), ">64MiB file must fail");
    let written = dir.path().join("resources");
    assert!(
        !written.join("big.bin").exists()
            || fs::metadata(written.join("big.bin")).unwrap().len() <= 64 * 1024 * 1024
    );
}

#[test]
fn total_size_limit_enforced() {
    // 9 x 60 MiB = 540 MiB decompressed; each file under the per-file cap.
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let zeros = vec![0u8; 1024 * 1024];
    for f in 0..9 {
        writer.start_file(format!("part{f}.bin"), opts).unwrap();
        for _ in 0..60 {
            writer.write_all(&zeros).unwrap();
        }
    }
    let zip = writer.finish().unwrap().into_inner();
    let dir = tmpdir("totalsize");
    let out = install_zip(&dir, zip);
    assert!(!out.status.success(), ">512MiB total must fail");
}

// ---------- reset ----------

#[test]
fn reset_copies_bundled_tree_and_writes_version() {
    let dir = tmpdir("reset");
    let bundled = dir.path().join("bundled");
    fs::create_dir_all(bundled.join("examples/Nodu")).unwrap();
    fs::write(bundled.join("examples/Nodu/hello.py"), "print('hi')").unwrap();
    let dest = dir.path().join("resources");
    let vf = version_file(dir.path());
    let out = bin(&[
        "reset",
        "--bundled",
        bundled.to_str().unwrap(),
        "--dest",
        dest.to_str().unwrap(),
        "--version",
        "0.1.4",
        "--version-file",
        vf.to_str().unwrap(),
    ]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(
        fs::read(dest.join("examples/Nodu/hello.py")).unwrap(),
        b"print('hi')"
    );
    assert_eq!(
        lib::read_version_file(&vf),
        Version {
            major: 0,
            minor: 1,
            patch: 4
        }
    );
}

#[test]
fn reset_replaces_existing_tree() {
    let dir = tmpdir("reset-swap");
    let bundled = dir.path().join("bundled");
    fs::create_dir_all(&bundled).unwrap();
    fs::write(bundled.join("new.txt"), "new").unwrap();
    let dest = dir.path().join("resources");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("stale.txt"), "stale").unwrap();
    let vf = version_file(dir.path());
    let out = bin(&[
        "reset",
        "--bundled",
        bundled.to_str().unwrap(),
        "--dest",
        dest.to_str().unwrap(),
        "--version",
        "0.1.4",
        "--version-file",
        vf.to_str().unwrap(),
    ]);
    assert!(out.status.success());
    assert!(!dest.join("stale.txt").exists());
    assert!(dest.join("new.txt").exists());
    // No residue beside the dest.
    for entry in fs::read_dir(dir.path()).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        assert!(!name.starts_with(".resources."), "residue left: {name}");
    }
}

#[test]
fn reset_missing_bundled_dir_fails_without_touching_dest() {
    let dir = tmpdir("reset-missing");
    let dest = dir.path().join("resources");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("keep.txt"), "keep").unwrap();
    let vf = version_file(dir.path());
    fs::write(&vf, r#"{"major":0,"minor":0,"patch":1}"#).unwrap();
    let out = bin(&[
        "reset",
        "--bundled",
        &dir.path().join("absent").to_string_lossy(),
        "--dest",
        dest.to_str().unwrap(),
        "--version",
        "0.1.4",
        "--version-file",
        vf.to_str().unwrap(),
    ]);
    assert!(!out.status.success());
    assert!(dest.join("keep.txt").exists());
    assert_eq!(
        lib::read_version_file(&vf),
        Version {
            major: 0,
            minor: 0,
            patch: 1
        }
    );
}

#[test]
fn install_into_readonly_parent_fails_closed() {
    let zip = make_zip(&[("a.txt", b"a")]);
    let http = serve(vec![("/r.zip", Route::ok(zip))]);
    let dir = tmpdir("install-ro");
    let parent = dir.path().join("ro");
    fs::create_dir_all(&parent).unwrap();
    let dest = parent.join("resources");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("keep.txt"), "keep").unwrap();
    let mut perms = fs::metadata(&parent).unwrap().permissions();
    #[allow(clippy::permissions_set_readonly_false)]
    {
        perms.set_readonly(true);
        fs::set_permissions(&parent, perms.clone()).unwrap();
        let out = bin(&[
            "install",
            "--url-template",
            &format!("{}/r.zip", http.base),
            "--version",
            "1.0.0",
            "--dest",
            dest.to_str().unwrap(),
            "--version-file",
            &version_file(dir.path()).to_string_lossy(),
        ]);
        assert!(!out.status.success(), "read-only parent must fail");
        assert!(dest.join("keep.txt").exists(), "old resources untouched");
        perms.set_readonly(false);
        fs::set_permissions(&parent, perms).unwrap();
    }
}

// ---------- chunked transfer (no Content-Length -> total: null) ----------

#[test]
fn chunked_download_reports_null_total() {
    let zip = make_zip(&[("a.txt", b"chunked")]);
    let http = serve(vec![("/r.zip", Route::ok(zip).chunked())]);
    let dir = tmpdir("install-chunked");
    let out = wait_collect(spawn_bin(&[
        "install",
        "--url-template",
        &format!("{}/r.zip", http.base),
        "--version",
        "1.0.0",
        "--dest",
        &dir.path().join("resources").to_string_lossy(),
        "--version-file",
        &version_file(dir.path()).to_string_lossy(),
    ]));
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("\"total\":null"), "{stdout}");
}
