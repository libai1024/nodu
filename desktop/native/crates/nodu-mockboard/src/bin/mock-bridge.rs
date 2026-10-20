// SPDX-License-Identifier: MIT
//! stdio <-> MockBoard byte bridge.
//!
//! stdin bytes are host->board writes; bytes the simulated board produces are
//! written to stdout. The Python/Rust worker differential harness
//! (tools/diff/worker_diff.py) connects a real PTY master to this process's
//! stdio so the Python worker sees an ordinary serial device path backed by
//! the simulated board — no hardware and no unsafe code needed.

use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nodu_mockboard::MockBoard;
use nodu_serial::Transport;

fn main() -> io::Result<()> {
    let board = Arc::new(Mutex::new(MockBoard::new()));

    // Host -> board: blocking stdin reads; exits when the master side closes.
    let writer = {
        let board = Arc::clone(&board);
        std::thread::spawn(move || {
            let mut stdin = io::stdin().lock();
            let mut buf = [0u8; 4096];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        let mut board = board.lock().expect("mock board poisoned");
                        if board.write_all(&buf[..n]).is_err() {
                            return;
                        }
                        if board.flush().is_err() {
                            return;
                        }
                    }
                }
            }
        })
    };

    // Board -> host: poll what the board has buffered. `in_waiting` also
    // advances simulated running-program output, so call it every loop.
    let mut stdout = io::stdout().lock();
    let mut buf = [0u8; 4096];
    while !writer.is_finished() {
        let n = {
            let mut board = board.lock().expect("mock board poisoned");
            match board.in_waiting() {
                Ok(0) => 0,
                Ok(_) => board.read(&mut buf).unwrap_or(0),
                Err(_) => 0,
            }
        };
        if n > 0 {
            stdout.write_all(&buf[..n])?;
            stdout.flush()?;
        } else {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    // Drain whatever the board still holds after the writer finished.
    let mut board = board.lock().expect("mock board poisoned");
    while let Ok(n) = board.read(&mut buf) {
        if n == 0 {
            break;
        }
        stdout.write_all(&buf[..n])?;
        stdout.flush()?;
    }
    Ok(())
}
