// SPDX-License-Identifier: MIT
//! `nodu-device`: stdio JSON-lines device service for Nodu · 见微.
//!
//! Wire contract is identical to `resources/nodu_device_worker.py`; the Node
//! backend spawns this binary and speaks to it verbatim. `--mock` (feature
//! `mock`) swaps the serial transport for an in-memory MaixPy simulator so
//! Node end-to-end tests need no hardware.
//!
//! Original OpenMV plugin launch flags `-override_read_timeout` and
//! `-override_read_stall_timeout` (ms, 1-60000) tune the IDE protocol read
//! deadline and the partial-reply stall bound.

use std::io::BufReader;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use nodu_device::{SubmitState, Worker};

#[cfg(feature = "mock")]
fn factory(mock_port: &str) -> nodu_device::TransportFactory {
    let mock_port = mock_port.to_string();
    Arc::new(move |path, baud| {
        if path == mock_port {
            Ok(Box::new(nodu_mockboard::MockBoard::new()))
        } else {
            nodu_device::Worker::serial_factory()(path, baud)
        }
    })
}

const USAGE: &str = "nodu-device — stdio JSON-lines device service

usage: nodu-device [--mock] [-override_read_timeout <ms>]
                   [-override_read_stall_timeout <ms>]

  --mock                              in-memory MaixPy simulator (dev/tests)
  -override_read_timeout <ms>         IDE reply deadline, 1-60000;
                                      unset uses each operation's default limit
  -override_read_stall_timeout <ms>   stalled partial-reply budget, 1-60000;
                                      unset keeps the 1 s default that pokes
                                      SCRIPT_RUNNING mid-reply (original plugin)
";

fn timeout_flag(args: &[String], i: &mut usize, name: &str) -> Result<Duration, String> {
    *i += 1;
    let value = args
        .get(*i)
        .ok_or_else(|| format!("{name} requires a millisecond value."))?;
    let ms: u64 = value
        .parse()
        .map_err(|_| format!("{name} expects a number, got {value:?}."))?;
    if !(1..=60_000).contains(&ms) {
        return Err(format!("{name} must be 1-60000 ms, got {ms}."));
    }
    Ok(Duration::from_millis(ms))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help") {
        print!("{USAGE}");
        return;
    }
    let mut mock = false;
    let mut read_timeout = None;
    let mut stall_timeout = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--mock" => {
                if cfg!(not(feature = "mock")) {
                    eprintln!("nodu-device: --mock is not available in this build.");
                    std::process::exit(2);
                }
                mock = true;
            }
            "-override_read_timeout" => match timeout_flag(&args, &mut i, "-override_read_timeout")
            {
                Ok(d) => read_timeout = Some(d),
                Err(e) => {
                    eprintln!("nodu-device: {e}");
                    std::process::exit(2);
                }
            },
            "-override_read_stall_timeout" => {
                match timeout_flag(&args, &mut i, "-override_read_stall_timeout") {
                    Ok(d) => stall_timeout = Some(d),
                    Err(e) => {
                        eprintln!("nodu-device: {e}");
                        std::process::exit(2);
                    }
                }
            }
            other => {
                eprintln!("nodu-device: unknown argument {other:?}; try --help");
                std::process::exit(2);
            }
        }
        i += 1;
    }

    let stdout = std::io::stdout();
    let shared = Arc::new(SubmitState::new(Box::new(stdout)));

    #[cfg(feature = "mock")]
    let factory: nodu_device::TransportFactory = if mock {
        factory("mock")
    } else {
        Worker::serial_factory()
    };
    #[cfg(not(feature = "mock"))]
    let factory: nodu_device::TransportFactory = Worker::serial_factory();
    let _ = mock;

    let reader_shared = Arc::clone(&shared);
    thread::spawn(move || {
        reader_shared.read_requests(BufReader::new(std::io::stdin()));
    });

    let mut worker = Worker::new(shared, factory);
    worker.mock = mock;
    worker.set_read_timeouts(read_timeout, stall_timeout);
    worker.main_loop();
}
