// SPDX-License-Identifier: MIT
//! External tool processes (cmake, ninja, openocd, stm32flash).
//!
//! Every child runs in its own process group (unix) so cancelling a build
//! also ends the compilers ninja started. Output is delivered line by line
//! while the process runs. All live children are registered so that the
//! service can end them when its own stdin closes.

use std::collections::{BTreeMap, HashSet};
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use crate::proto::{Failure, Outcome};

#[derive(Debug)]
pub struct Finished {
    pub code: Option<i32>,
    /// Combined stdout and stderr in arrival order.
    pub output: String,
}

impl Finished {
    pub fn ok(&self) -> bool {
        self.code == Some(0)
    }
}

fn live() -> &'static Mutex<HashSet<u32>> {
    static LIVE: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;
    let group = Pid::from_raw(pid as i32);
    let _ = killpg(group, Signal::SIGTERM);
    thread::sleep(Duration::from_millis(300));
    let _ = killpg(group, Signal::SIGKILL);
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    // taskkill /T ends the whole tree without unsafe Job-object calls.
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// End every child still running (service shutdown).
pub fn kill_all() {
    let pids: Vec<u32> = live().lock().map(|set| set.iter().copied().collect()).unwrap_or_default();
    for pid in pids {
        kill_tree(pid);
    }
}

fn spawn_reader(stream: impl Read + Send + 'static, tx: mpsc::Sender<String>) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    if !buffer.is_empty() { let _ = tx.send(String::from_utf8_lossy(&buffer).into_owned()); }
                    break;
                }
                Ok(n) => {
                    for byte in &chunk[..n] {
                        // stm32flash updates progress with CR, without LF.
                        if *byte == b'\r' || *byte == b'\n' {
                            if !buffer.is_empty() {
                                if tx.send(String::from_utf8_lossy(&buffer).into_owned()).is_err() { return; }
                                buffer.clear();
                            }
                        } else { buffer.push(*byte); }
                    }
                }
            }
        }
    });
}

#[derive(Debug, Clone, Copy)]
pub enum Control {
    Continue,
    /// Stop the process now (for example a fatal marker was seen).
    Stop,
}

/// Run `program` to completion.
///
/// `cancelled` is polled every 50 ms; returning true ends the process tree
/// and yields `Failure::cancelled()`. `on_line` sees each output line.
pub fn run(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    timeout: Duration,
    cancelled: &dyn Fn() -> bool,
    on_line: &mut dyn FnMut(&str) -> Control,
) -> Outcome<Finished> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let name = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut child: Child = command
        .spawn()
        .map_err(|e| Failure::new("toolStart", format!("无法启动 {name}：{e}")))?;
    let pid = child.id();
    if let Ok(mut set) = live().lock() {
        set.insert(pid);
    }
    let (tx, rx) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        spawn_reader(stdout, tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_reader(stderr, tx.clone());
    }
    drop(tx);

    let started = Instant::now();
    let mut output = String::new();
    let mut exited_at: Option<Instant> = None;
    let mut stop: Option<Failure> = None;
    let forget = |pid: u32| {
        if let Ok(mut set) = live().lock() {
            set.remove(&pid);
        }
    };
    let mut pipes_closed = false;
    loop {
        if pipes_closed {
            thread::sleep(Duration::from_millis(50));
        } else {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(line) => {
                    output.push_str(&line);
                    output.push('\n');
                    if matches!(on_line(&line), Control::Stop) && stop.is_none() {
                        stop = Some(Failure::new("stopped", format!("{name} 已中止")));
                    }
                }
                Err(RecvTimeoutError::Disconnected) => pipes_closed = true,
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        if exited_at.is_none() && matches!(child.try_wait(), Ok(Some(_))) {
            exited_at = Some(Instant::now());
        }
        if let Some(at) = exited_at {
            // Done once both pipes close; a leftover grandchild may hold them
            // open, so do not wait for it longer than 2 s.
            if pipes_closed || at.elapsed() > Duration::from_secs(2) {
                break;
            }
            continue;
        }
        if stop.is_none() {
            if cancelled() {
                stop = Some(Failure::cancelled());
            } else if started.elapsed() > timeout {
                stop = Some(Failure::new("timeout", format!("{name} 超过 {} 秒没有完成，已停止。", timeout.as_secs())));
            }
        }
        if let Some(failure) = stop.take() {
            kill_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
            forget(pid);
            return Err(failure.with_detail(serde_json::json!({"output": tail(&output, 8000)})));
        }
    }
    let status = child.wait().map_err(|e| Failure::io("等待进程", &e))?;
    forget(pid);
    if let Some(failure) = stop {
        return Err(failure.with_detail(serde_json::json!({"output": tail(&output, 8000)})));
    }
    Ok(Finished { code: status.code(), output })
}

pub fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn sh(script: &str, timeout: Duration, cancel: &AtomicBool) -> Outcome<Finished> {
        let mut env = BTreeMap::new();
        env.insert("PATH".into(), "/usr/bin:/bin".into());
        run(
            Path::new("/bin/sh"),
            &["-c".into(), script.into()],
            Path::new("/"),
            &env,
            timeout,
            &|| cancel.load(Ordering::Relaxed),
            &mut |_| Control::Continue,
        )
    }

    #[test]
    fn carriage_return_progress_arrives_before_process_exit() {
        let mut env = BTreeMap::new();
        env.insert("PATH".into(), "/usr/bin:/bin".into());
        let started = Instant::now();
        let mut lines = Vec::new();
        let error = run(Path::new("/bin/sh"), &["-c".into(), "printf '10%%\\r'; sleep 10".into()], Path::new("/"),
            &env, Duration::from_secs(15), &|| false, &mut |line| { lines.push(line.to_string()); Control::Stop }).unwrap_err();
        assert_eq!(error.code, "stopped");
        assert_eq!(lines, vec!["10%"]);
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn collects_both_streams_and_exit_code() {
        let cancel = AtomicBool::new(false);
        let done = sh("echo out; echo err >&2; exit 3", Duration::from_secs(5), &cancel).expect("run");
        assert_eq!(done.code, Some(3));
        assert!(done.output.contains("out") && done.output.contains("err"));
    }

    #[test]
    fn timeout_ends_the_process_group() {
        let cancel = AtomicBool::new(false);
        let started = Instant::now();
        let error = sh("sleep 30 & sleep 30; wait", Duration::from_millis(300), &cancel).expect_err("timeout");
        assert_eq!(error.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn cancel_flag_stops_the_run() {
        let cancel = AtomicBool::new(true);
        let error = sh("sleep 30", Duration::from_secs(60), &cancel).expect_err("cancel");
        assert_eq!(error.code, "cancelled");
    }
}
