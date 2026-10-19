// SPDX-License-Identifier: MIT
//! `nodu-device`: stdio JSON-lines device service for Nodu · 见微.
//!
//! Wire contract is identical to `resources/nodu_device_worker.py`; the Node
//! backend spawns this binary and speaks to it verbatim. `--mock` (feature
//! `mock`) swaps the serial transport for an in-memory MaixPy simulator so
//! Node end-to-end tests need no hardware.

use std::io::BufReader;
use std::sync::Arc;
use std::thread;

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

fn main() {
    #[cfg(feature = "mock")]
    let mock = std::env::args().any(|a| a == "--mock");
    #[cfg(not(feature = "mock"))]
    let mock = false;

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
    worker.main_loop();
}
