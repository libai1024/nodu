# Design: honor stop after an in-flight IDE polling transaction

Do not implement until the current hardware batch is disconnected.

## Grounded mechanism

`SubmitState::submit(stop|disconnect)` increments generation immediately.
`poll_ide()` currently uses `connect_check()`, which checks that generation
inside `IdeSession::read_opt()` after a reply header has already been sent.
The resulting cancellation is correctly classified as protocol desync by
the low-level parser; `Worker::lost()` closes the port before queued stop
can run. Actual camera-stop logs include the cancellation suffix.

The low-level fail-closed parser is correct and must remain unchanged.
The idle poll should finish its bounded pending transaction, then let
the priority queue process stop/disconnect. Long user operations retain
their existing immediate generation cancellation.

Original behavior reference: `openmvpluginio.cpp@af179e44`:
`scriptStop()` enqueues a command; `command()` dispatches only when posted
and completion queue sizes match; frame-size completion prepends frame-dump
commands before later commands. This serializes complete replies.

Recording-start failure is not proven to have the same cause. Existing
captures contain stale log tails and an eventual stop that may cancel a
queued recording request. Recheck recording separately after this fix.

## Product change

In `desktop/native/crates/nodu-device/src/lib.rs`, immediately before
`poll_ide`, add exactly this helper:

```rust
    /// Finish bounded idle-poll transactions before servicing queued
    /// stop/disconnect requests. Cancelling a reply after its header has
    /// been sent would poison the IDE stream. Shutdown and deadlines still
    /// fail closed; request handlers retain generation cancellation.
    fn poll_ide_check(&self) -> Check {
        let deadline = self.deadline;
        let shared = Arc::clone(&self.shared);
        Arc::new(move || {
            if shared.input_closed.load(Ordering::SeqCst) {
                return Err(ReplError::cancelled());
            }
            if let Some(deadline) = deadline
                && Instant::now() > deadline
            {
                return Err(ReplError::timeout("Device operation timed out."));
            }
            Ok(())
        })
    }
```

Only in `poll_ide`, replace:

```rust
        let check = self.connect_check();
```

with:

```rust
        let check = self.poll_ide_check();
```

No other session, generation counter, operation timeout, flash gate or parser
change. Do not suppress errors, auto-reconnect on desync, or send STOP while
a payload remains unread.

## Deterministic regression design

Use existing `desktop/native/crates/nodu-device/tests/mock_integration.rs`
and `IdeHarness`; no new test file or real-device dependency. Add a test-only
`FrameRequestTransport` wrapper around `MockBoard`, forwarding `Transport`.
Exact state:

```rust
struct FrameRequestTransport {
    board: MockBoard,
    shared: Arc<SubmitState>,
    request: Value,
    armed: Arc<std::sync::atomic::AtomicBool>,
    fired: Arc<std::sync::atomic::AtomicBool>,
    wrote_mid_reply: Arc<std::sync::atomic::AtomicBool>,
    remaining: usize,
    stall_after_first_byte: bool,
}
```

`write_all` records an illegal write if `remaining > 0`, forwards bytes,
and recognizes an exact 6-byte `[0x30,0x82,lenLE...]` frame-dump header,
setting `remaining` to its declared payload length.

`read` outside a frame delegates unchanged. During an armed frame:

1. Before the first injection, limit the read buffer to one byte.
2. Subtract consumed bytes from `remaining`.
3. After a positive first read, atomically mark `fired` and call
   `shared.submit(request.clone())` exactly once.
4. Subsequent reads drain up to `remaining` normally, except in the
   `stall_after_first_byte` case where they return `Ok(0)`.
5. Never fake frame content; all reply bytes come from `MockBoard`.

Construct an `IdeHarness` using this factory (same MockBoard/shared/lines
as existing harness); return harness and atomic controls. Arm only after
`connect` and `startCamera` replies. This ensures cancellation is injected
inside a pending frame read, not merely between worker steps.

Test names and exact cases/assertions:

- `ide_queued_stop_drains_inflight_frame`:
  inject `{"id":90,"method":"stop","args":{}}`; one idle `worker.step` then
  `run_until_reply(90)`. Assert injection fired, `wrote_mid_reply == false`,
  frame event emitted, stop result exists, final phase connected/running
  false, no desync stderr. Execute `print(7)` under a fresh request id and
  assert result `"7\n"` without reconnect.
- `ide_queued_disconnect_drains_inflight_frame`:
  inject disconnect id90; same drain/no-midwrite assertions, final phase
  disconnected, no desync stderr. Reconnect with a FRESH id (do not reuse
  connect id1 in run_until_reply) and assert success/IDE protocol.
- `ide_queued_stop_stalled_frame_still_fails_closed`:
  inject stop id90, enable stall after first byte; after connection set
  read timeout 120 ms/stall timeout 30 ms. Assert fired, no mid-reply write,
  no frame event, phase error, framebuffer capability false, stderr contains
  `stalled`; queued stop must not write to the poisoned transport. This
  preserves fail-closed behavior for a real truncated reply.

Run the first two against the old product code and capture the failures;
then apply the helper change and run all three. Do not weaken tests or change
low-level cancellation tests to force green.

## Verification after implementation

From `desktop/native`:

```sh
cargo test -p nodu-device --test mock_integration ide_queued_
cargo test -p nodu-maix-ide
cargo fmt --check
cargo clippy -p nodu-device --all-targets -- -D warnings
```

Build the actual application sidecar using the existing build script; replace
only once the board is disconnected and old worker has been stopped. Reuse
the browser/backend unless a restart is necessary to load the new binary.

Hardware regression: same helper-adapted camera script, real UI Run → obtain
new frame sequence → Stop → REPL `print(1+1)` returns 2, for three independent
cycles without reconnect. Then record for 5 s and finalize using the actual
“结束录制” control, waiting for operation completion before stopping camera;
capture recording counters, new logs (subscribe, not bounded-array index),
state and .bin file. Finally disconnect while streaming and reconnect.
No firmware write or full backup.

Report exact diff, tests and hardware evidence before any commit.
