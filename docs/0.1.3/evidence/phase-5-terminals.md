# Phase 5 — serial/TCP/UDP terminals + original CLI flags

Scope: `nodu-terminal` standalone binary (Rust, crossterm for portable TTY
raw mode), `terminal.rs` in `nodu-device`, `NoduTerminalContribution`
frontend, Node `getTerminalExecutable`/`takeStartupTerminals`, launcher flag
extraction, and IDE-protocol read-timeout overrides.

## Semantics (vs. original `openmvterminal.cpp` / `OpenMV.json.in`)

- All five original flags are supported verbatim:
  `-open_serial_terminal <port:baud>`, `-open_tcp_client_terminal <host:port>`,
  `-open_tcp_server_terminal <port>`, `-open_udp_client_terminal <host:port>`,
  `-open_udp_server_terminal <port>`. Nodu extras are double-dash flags
  (`--bind`, `--connect-timeout-ms`, `--io-timeout-ms`, `--reset-board`).
- Serial open asserts DTR (original line ~1197 behaviour); a reset runs
  **only** when `--reset-board <0-8>` is given. No IDE init, no file writes.
  `PortLock` is held for the whole session so the IDE or another Nodu process
  cannot steal the port.
- Ctrl-] (0x1d) exits locally after flushing preceding bytes; every other
  byte (Ctrl-C, Ctrl-D, Ctrl-R 0x12, Ctrl-E 0x05) is forwarded unchanged.
  stdin EOF exits. Stdout receives raw link bytes — no UTF-8 or line logic.
- TCP client: bounded DNS (resolve on a scratch thread, `recv_timeout` at the
  connect deadline) then `connect_timeout` per candidate. TCP server: real
  `TcpListener`, reports the bound port (port 0 allowed), one peer at a time,
  returns to accept on peer EOF; pre-peer keystrokes are dropped with a
  one-line stderr notice, never queued. TCP writes never drop partial data:
  a WouldBlock/TimedOut retry loop bounded by `io_timeout`; a zero-byte
  write is an error. UDP: 65507-byte datagrams; the server replies to the
  last sender only; the client `connect()`s so other senders are filtered
  by the kernel.
- Default `--bind` is **127.0.0.1** (loopback) — servers do not open to the
  LAN unless `--bind` says so.
- Diagnostics go to bounded stderr strings; nothing else writes stdout.

## Launch-flag plumbing

- `launch.cjs` extracts the five `-open_*` pairs (max 16) into
  `NODU_STARTUP_TERMINALS` JSON and `-override_read_timeout` /
  `-override_read_stall_timeout` (1–60000 ms) into `NODU_READ_TIMEOUT_MS` /
  `NODU_READ_STALL_TIMEOUT_MS`; nothing is forwarded to Theia unknowingly.
- The backend validates the env values and appends the original flag names
  to the `nodu-device` argv; `takeStartupTerminals` is consumed once per
  backend; `getTerminalExecutable` resolves packaged sibling →
  `native/target/release` dev build → `NODU_TERMINAL_BIN` dev override.
  The frontend can never supply an executable path.
- Worker `set_read_timeouts` applies the override to every IDE session
  (connect, exec, files, framebuffer, reset); the 500 ms query-ack cap is
  kept. `IdeSession.with_stall_timeout` bounds a **partial** reply's
  progress gap; zero-byte waits still use the overall timeout.
- **Intentional difference**: the original plugin sent a `SCRIPT_RUNNING`
  ping after a stall; we fail closed with a protocol error instead — a
  mid-reply request would corrupt the byte stream.

## Verified (actual)

- `cargo test -p nodu-device --all-features`: lib 27/27, mock 29/29,
  terminal_integration **10/10** — TCP client/server/UDP client/server
  loopback through the real binary with exact-byte checks (0x12 forwarded,
  Ctrl-] exit, stdin-EOF exit, TCP server re-accept after peer EOF, bound
  port reported for port 0, UDP replies to last sender), invalid/conflicting
  CLI → exit 2, `-override_*` bad values → exit 2 before any port opens.
- `cargo test -p nodu-maix-ide`: 20/20 incl.
  `stalled_partial_reply_fails_closed_before_overall_timeout` (stall bound
  fires <5 s inside a 30 s overall window; without it the same gap waits
  for the overall timeout).
- `cargo clippy` (nodu-device/-maix-ide/-maix-connect, all targets): 0 warnings.
- `npm run compile`: 0 errors; `npm run build:native`: staged
  `nodu-device` + `nodu-terminal` under `resources/bin/darwin-arm64`;
  `check:licenses`: 192 files clean.
- `node --test backend-validation.cjs`: 21/21 incl. startup-terminal
  JSON consumption-once, raw-payload size bound (140 KB pre-parse), empty
  argument-array rejection, read-timeout env→argv validation, launcher flag
  extraction with <=512-char/NUL parameter checks.
- Live UI on runtime 4195 (no mock env): `getTerminalExecutable` resolved
  the **staged** binary; `terminalService.newTerminal` + `start()` opened a
  real PTY terminal to a loopback echo server; `sendText("hi\x12bye")`
  arrived at the server as `[104,105,18,98,121,101]` and the
  `scope.terminal-control-r` command delivered `[18]` (raw 0x12); the
  `Connected to …; Ctrl-] exits.` diagnostic and echo rendered in xterm;
  `destroyTermOnClose` left no orphan process. Commands `scope.open-terminal`,
  `scope.terminal-control-r/e` registered; `ctrlcmd+r/e` keybindings carry
  `when: 'terminalFocus'` (+ physical `ctrl+r/e` on macOS) while the
  workbench run/stop bindings now require `!terminalFocus`.
- `cargo deny check`: advisories/bans/licenses/sources **ok** with the new
  crossterm + serialport edges.
- `git diff --check`: clean after `build:native` normalized line-trailing
  whitespace in `src/common/generated/*.ts` (ts-rs output only; no source
  files touched).

### Review-round hardening (verified)

- `drain_stdin` pulls at most 8 chunks (32 KiB) per call — a streaming
  producer can no longer spin the drain loop; unit test proves the bound and
  zero byte loss across calls.
- UDP client without `--bind` picks `0.0.0.0`/`::` matching the resolved
  peer family (fixes remote-client routing + IPv6); explicit `--bind`
  filters resolved addresses by family with a clear error when none match.
  Covered by the `udp_ipv6_loopback` test (client→::1 and server `--bind ::1`
  on loopback only) and a pure `udp_client_target` unit test.
- TCP writes re-check the remaining deadline every iteration and set the
  OS write timeout to that remainder, so partial writes cannot outlive
  `io_timeout`; the connect deadline is created before DNS so resolve +
  connect share one `connect_timeout` budget.
- An RST (not just FIN) on an *established* TCP-server session ends it as a
  peer disconnect and the listener accepts the next peer — proven by the
  `tcp_server_recovers_from_peer_reset` test (SO_LINGER(1,0)+close via a
  python one-liner, loopback only). stdout write errors remain fatal.
- Serial writes now honour `--io-timeout-ms`: after DTR/reset the
  `SerialTransport` is consumed via `into_inner()` and the port timeout is
  toggled io-timeout(write)/50 ms(read) per chunk. **Not verified on real
  hardware** — parse + PortLock coverage only.
- Session status lines use CRLF via `status()` so they render on one line
  under raw mode; remote bytes are never touched.
- `pty_raw_mode_forwards_control_bytes` runs the binary under a real PTY
  (python `pty` + controlling tty): Ctrl-C/Ctrl-R arrive at the socket as
  bytes (`0x03 0x12`, no SIGINT), Ctrl-] exits with code 0, and the slave's
  termios is restored while the parent still holds the fd — the crossterm
  raw-mode path is now actually exercised. (The test drains the master like
  a real emulator; an undrained pty output queue legitimately applies
  backpressure.)
- Help/usage no longer claims 5000/1000 defaults: unset
  `-override_read_timeout` keeps each operation's default (20 s ordinary
  reads, 500 ms query-ack cap), unset `-override_read_stall_timeout` adds
  no stall bound. Backend only appends the flags when the env var is set.
- Serial dialog's reset-board field is a select showing the nine MaixPy
  board names (`BOARD_IDS`, exported from the device panel), defaulting to
  the device model's board id; failed `start()`/`open()` now disposes the
  terminal widget; UDP-client bind field reads
  `本机绑定 IP（留空自动选择本机接口）`.

## Not verified / limits

- Serial mode is untested (no hardware; parse + PortLock-conflict covered
  only).
- Windows/Linux binaries unverified (host-only build; `.exe` name handling
  is coded but untested).
- The crossterm raw-mode path IS exercised by the PTY test; a real keyboard
  Ctrl-] inside the Theia widget was driven via `sendText` (same byte path).
- NODU_STARTUP_TERMINALS end-to-end spawn verified in backend tests;
  onStart loop exercised only indirectly (same `spawnTerminal` path as the
  menu flow, which was driven live).
