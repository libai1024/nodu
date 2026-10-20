// SPDX-License-Identifier: MIT
// Ported from openmv-qt-creator@af179e44cddf396a5ab618792d71e9de5cc67032:
// src/plugins/openmv/openmvpluginio.cpp (MIT) and the observed MaixPy IDE
// 0.2.5 binary parameters in docs/0.1.3/evidence/original-private-params.md.
// Source: openmv-qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv/openmvpluginio.cpp
//! Original MaixPy IDE 0.2.5 connect sequence: board reset via DTR/RTS,
//! `repl.init(..., ide=True)` over raw REPL at 115200, then a 1.5 Mbps
//! `USBDBG_QUERY_STATUS` handshake.

use std::thread::sleep;
use std::time::{Duration, Instant};

use nodu_maix_ide::{BAUD, IdeSession};
use nodu_repl::{Check, ReplError, Session};
use nodu_serial::Transport;

/// Boot banner the firmware prints before the `>>>` prompt.
const BOOT_BANNER: &[u8] = b"[MaixPy] init end";
const RESET_STEP: Duration = Duration::from_millis(100);
const RESET_CHECK: Duration = Duration::from_millis(10);
const BOOT_TIMEOUT: Duration = Duration::from_secs(10);
const POST_INIT_WAIT: Duration = Duration::from_millis(500);
const QUERY_RETRIES: u32 = 31;
const QUERY_RETRY_DELAY: Duration = Duration::from_millis(50);

/// One DTR/RTS hold step of the board reset sequence.
pub type ResetStep = (bool, bool, Duration);

/// Original `setBoard(id, nullptr, 0)` sequence, `id` 0..=8.
///
/// step 1: (0,0); step 2: DTR=`bit(0xF9,id)`, RTS=`bit(0x06,id)`
/// (id>7 → DTR=0, RTS=1); step 3: DTR=RTS=`(id==4)`; each held 100 ms.
pub fn reset_sequence(board: u8) -> Result<Vec<ResetStep>, ReplError> {
    if board > 8 {
        return Err(ReplError::device(format!(
            "Unknown board id {board}; expected 0–8."
        )));
    }
    let dtr = if board > 7 {
        false
    } else {
        (0xF9u8 >> board) & 1 == 1
    };
    let rts = if board > 7 {
        true
    } else {
        (0x06u8 >> board) & 1 == 1
    };
    Ok(vec![
        (false, false, RESET_STEP),
        (dtr, rts, RESET_STEP),
        (board == 4, board == 4, RESET_STEP),
    ])
}

/// Full IDE connect on an open 115200 `transport`.
///
/// On success the transport is left at [`BAUD`] and the board is in IDE mode
/// (query acknowledged). `check` is propagated to both the raw-REPL phase and
/// the returned session's caller is responsible for its own check afterward.
/// `read_timeout` overrides the per-reply wait (`-override_read_timeout`);
/// `stall_timeout` bounds progress stalls inside a partial reply.
pub fn connect(
    transport: &mut dyn Transport,
    check: &Check,
    board: u8,
    timeout: Duration,
    read_timeout: Option<Duration>,
    stall_timeout: Option<Duration>,
) -> Result<(), ReplError> {
    // 1. Original reset sequence, 100 ms per step, cancellation every 10 ms.
    for (dtr, rts, hold) in reset_sequence(board)? {
        transport.set_dtr(dtr).map_err(io_err)?;
        transport.set_rts(rts).map_err(io_err)?;
        wait_checked(hold, RESET_CHECK, check)?;
    }
    // 2. Stay at 115200 and wait for the boot banner / >>> (bounded buffer).
    transport.set_baud_rate(115_200).map_err(io_err)?;
    wait_for_boot(transport, check, BOOT_TIMEOUT)?;
    // 3. Robust raw-REPL synchronization via the existing session logic.
    {
        let mut session = Session::new(&mut *transport, share_check(check));
        session.operation_timeout = timeout.min(Duration::from_secs(10));
        session.enter_raw_repl(timeout.min(BOOT_TIMEOUT))?;
        // Upload the ide=True init snippet and return to normal REPL; do NOT
        // follow the raw markers after the UART is reinitialized.
        let init = format!(
            "from machine import UART\r\nrepl = UART.repl_uart()\r\nrepl.init({BAUD}, 8, None, 1, read_buf_len=2048, ide=True)\r\n\r\n"
        );
        session.exec_raw_no_follow(init.as_bytes())?;
    }
    // 4. Give the UART reinit a moment, switch to 1.5 Mbps, drop stale bytes.
    wait_checked(POST_INIT_WAIT, RESET_CHECK, check)?;
    transport.set_baud_rate(BAUD).map_err(io_err)?;
    transport.reset_input_buffer().map_err(io_err)?;
    // 5. Query: retry only while replies are entirely zero; any partial or
    // garbled reply is a protocol failure (callers should close/reconnect).
    let mut last_err = None;
    for _ in 0..QUERY_RETRIES {
        check()?;
        let mut session = IdeSession::new(
            &mut *transport,
            share_check(check),
            read_timeout.unwrap_or(timeout),
        )
        .with_stall_timeout(stall_timeout);
        match session.query_status() {
            Ok(true) => return Ok(()),
            Ok(false) => {
                wait_checked(QUERY_RETRY_DELAY, RESET_CHECK, check)?;
            }
            Err(e) => {
                last_err = Some(e);
                break;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| {
        ReplError::protocol(
            "Connect fail, board ide mode no ack: the board did not enter IDE mode.",
        )
    }))
}

/// Wait for the boot banner or `>>>` with a bounded receive buffer.
fn wait_for_boot(
    transport: &mut dyn Transport,
    check: &Check,
    timeout: Duration,
) -> Result<(), ReplError> {
    let deadline = Instant::now() + timeout;
    let mut received: Vec<u8> = Vec::new();
    while Instant::now() < deadline {
        check()?;
        let waiting = transport.in_waiting().map_err(io_err)?;
        if waiting > 0 {
            let mut buf = vec![0u8; waiting.min(4096)];
            let n = transport.read(&mut buf).map_err(io_err)?;
            received.extend_from_slice(&buf[..n]);
            let hit = received
                .windows(BOOT_BANNER.len())
                .any(|w| w == BOOT_BANNER)
                || received.windows(3).any(|w| w == b">>>");
            if hit {
                return Ok(());
            }
            // Keep only a tail long enough to span the longest marker.
            let keep = BOOT_BANNER.len() + 1;
            if received.len() > keep {
                received.drain(..received.len() - keep);
            }
        } else {
            sleep(RESET_CHECK);
        }
    }
    Err(ReplError::protocol(
        "Timed out waiting for the board boot banner.",
    ))
}

fn wait_checked(total: Duration, slice: Duration, check: &Check) -> Result<(), ReplError> {
    let deadline = Instant::now() + total;
    while Instant::now() < deadline {
        check()?;
        sleep(slice.min(total));
    }
    check()
}

fn share_check(check: &Check) -> Check {
    check.clone()
}

use std::io;
fn io_err(e: io::Error) -> ReplError {
    ReplError::Device(if e.to_string().is_empty() {
        "Serial I/O error.".into()
    } else {
        e.to_string()
    })
}
