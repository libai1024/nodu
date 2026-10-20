// SPDX-License-Identifier: MIT
// Standalone serial/TCP/UDP byte terminal (`nodu-terminal` binary).
// Ported from openmv-qt-creator openmvterminal.cpp + OpenMV.json.in (MIT)
//
// Source: openmv/qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv/OpenMV.json.in
// Source: openmv/qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv/openmvterminal.cpp
//
// The five `-open_*_terminal` flag names and `port:baud`/`host:port`
//! parameter formats mirror the original launch arguments. Serial opens
//! assert DTR (original `openmvterminal.cpp` open behaviour); a board reset
//! only runs when `--reset-board` is given explicitly — no IDE init or file
//! writes ever happen here. Ctrl-] (0x1d) exits locally; every other byte,
//! including Ctrl-C/Ctrl-D/Ctrl-R/Ctrl-E, is forwarded unchanged.

use std::io::{self, ErrorKind, IsTerminal, Read, Write};
use std::net::{
    IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs, UdpSocket,
};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, sync_channel};
use std::thread;
use std::time::{Duration, Instant};

use nodu_maix_connect::reset_sequence;
use nodu_serial::{SerialTransport, Transport};

use crate::PortLock;

const CHUNK: usize = 4096;
const STDIN_CHANNEL: usize = 8;
const UDP_BUF: usize = 65_507;
const SERIAL_READ_SLICE: Duration = Duration::from_millis(50);
const SERIAL_MIN_BAUD: u32 = 1;
const SERIAL_MAX_BAUD: u32 = 4_000_000;
const MIN_TIMEOUT_MS: u64 = 1;
const MAX_TIMEOUT_MS: u64 = 60_000;

/// Which of the five original `-open_*_terminal` flags selected the link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Serial,
    TcpClient,
    TcpServer,
    UdpClient,
    UdpServer,
}

/// Parsed and validated CLI options for `run`.
#[derive(Debug, Clone)]
pub struct Options {
    pub mode: Mode,
    pub endpoint: String,
    pub bind: IpAddr,
    /// `true` when `--bind` was given; an unspecified UDP client picks an
    /// ANY address matching the resolved peer family instead.
    pub bind_explicit: bool,
    pub reset_board: Option<u8>,
    pub io_timeout: Duration,
    pub connect_timeout: Duration,
}

/// Usage text for `--help` and parse failures.
pub const USAGE: &str = "nodu-terminal — byte terminal for serial / TCP / UDP links

usage: nodu-terminal <mode> [options]

exactly one mode:
  -open_serial_terminal <port:baud>       serial port, DTR asserted
  -open_tcp_client_terminal <host:port>   connect out (IPv6 as [addr]:port)
  -open_tcp_server_terminal <port>        listen, one peer at a time (0 = any port)
  -open_udp_client_terminal <host:port>   connected UDP to one peer
  -open_udp_server_terminal <port>        UDP listen, replies to last sender (0 = any port)

options:
  --bind <ip>                 local bind for server/UDP modes (default 127.0.0.1)
  --connect-timeout-ms <ms>   client connect/DNS deadline, 1-60000 (default 30000)
  --io-timeout-ms <ms>        stalled-write deadline, 1-60000 (default 1000)
  --reset-board <0-8>         run the board reset sequence after opening serial

keys: Ctrl-] exits locally; Ctrl-C / Ctrl-D / Ctrl-R / Ctrl-E are forwarded.
";

fn bad(message: impl Into<String>) -> String {
    message.into()
}

fn timeout_ms(value: &str, name: &str) -> Result<Duration, String> {
    let ms: u64 = value.parse().map_err(|_| {
        bad(format!(
            "{name} expects a millisecond number, got {value:?}."
        ))
    })?;
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&ms) {
        return Err(bad(format!(
            "{name} must be {MIN_TIMEOUT_MS}-{MAX_TIMEOUT_MS} ms, got {ms}."
        )));
    }
    Ok(Duration::from_millis(ms))
}

fn clean_host(host: &str) -> Result<String, String> {
    let host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if host.is_empty() || host.len() > 512 || host.contains('\0') {
        return Err(bad("host must be non-empty, <=512 bytes, NUL-free."));
    }
    Ok(host.to_string())
}

/// `port:baud` split from the RIGHT so Windows paths (`COM5:115200` keeps one
/// colon anyway) and odd port names still resolve.
fn serial_parts(endpoint: &str) -> Result<(String, u32), String> {
    let (port, baud) = endpoint
        .rsplit_once(':')
        .ok_or_else(|| bad("serial endpoint must be <port:baud>."))?;
    if port.is_empty() || port.len() > 512 || port.contains('\0') {
        return Err(bad("serial port must be non-empty, <=512 bytes, NUL-free."));
    }
    let baud: u32 = baud
        .parse()
        .map_err(|_| bad(format!("serial baud must be a number, got {baud:?}.")))?;
    if !(SERIAL_MIN_BAUD..=SERIAL_MAX_BAUD).contains(&baud) {
        return Err(bad(format!(
            "serial baud must be {SERIAL_MIN_BAUD}-{SERIAL_MAX_BAUD}, got {baud}."
        )));
    }
    Ok((port.to_string(), baud))
}

/// `host:port` split from the RIGHT so `[::1]:9000` keeps its colon inside the
/// brackets. Client ports are 1..=65535.
fn client_parts(endpoint: &str) -> Result<(String, u16), String> {
    let (host, port) = endpoint
        .rsplit_once(':')
        .ok_or_else(|| bad("client endpoint must be <host:port>."))?;
    let host = clean_host(host)?;
    let port: u16 = port
        .parse()
        .map_err(|_| bad(format!("port must be a number, got {port:?}.")))?;
    if port == 0 {
        return Err(bad("client port must be 1-65535; port 0 is server-only."));
    }
    Ok((host, port))
}

fn server_parts(endpoint: &str) -> Result<u16, String> {
    endpoint.parse().map_err(|_| {
        bad(format!(
            "server endpoint must be a port number 0-65535, got {endpoint:?}."
        ))
    })
}

/// Parse CLI args (program name excluded). Exactly one mode flag; unknown or
/// missing arguments are an error — never guessed.
pub fn parse(args: &[String]) -> Result<Options, String> {
    let mut mode: Option<(Mode, String)> = None;
    let mut bind: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
    let mut reset_board: Option<u8> = None;
    let mut io_timeout = Duration::from_millis(1000);
    let mut connect_timeout = Duration::from_secs(30);
    let mut bind_seen = false;
    let mut reset_seen = false;

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        let flag_mode = match arg {
            "-open_serial_terminal" => Some(Mode::Serial),
            "-open_tcp_client_terminal" => Some(Mode::TcpClient),
            "-open_tcp_server_terminal" => Some(Mode::TcpServer),
            "-open_udp_client_terminal" => Some(Mode::UdpClient),
            "-open_udp_server_terminal" => Some(Mode::UdpServer),
            _ => None,
        };
        if let Some(m) = flag_mode {
            if mode.is_some() {
                return Err(bad(format!(
                    "{arg}: only one -open_*_terminal flag is allowed."
                )));
            }
            i += 1;
            let value = args
                .get(i)
                .ok_or_else(|| bad(format!("{arg} requires a parameter.")))?;
            mode = Some((m, value.clone()));
            i += 1;
            continue;
        }
        i += 1;
        let value = |name: &str| -> Result<String, String> {
            let v = args
                .get(i)
                .ok_or_else(|| bad(format!("{name} requires a value.")))?;
            Ok(v.clone())
        };
        match arg {
            "--bind" => {
                bind = value("--bind")?
                    .parse()
                    .map_err(|_| bad("--bind expects an IP address such as 127.0.0.1 or ::1."))?;
                bind_seen = true;
                i += 1;
            }
            "--connect-timeout-ms" => {
                connect_timeout =
                    timeout_ms(&value("--connect-timeout-ms")?, "--connect-timeout-ms")?;
                i += 1;
            }
            "--io-timeout-ms" => {
                io_timeout = timeout_ms(&value("--io-timeout-ms")?, "--io-timeout-ms")?;
                i += 1;
            }
            "--reset-board" => {
                let board: u8 = value("--reset-board")?
                    .parse()
                    .map_err(|_| bad("--reset-board expects a board id 0-8."))?;
                if board > 8 {
                    return Err(bad(format!("--reset-board must be 0-8, got {board}.")));
                }
                reset_board = Some(board);
                reset_seen = true;
                i += 1;
            }
            other => return Err(bad(format!("unknown argument {other:?}."))),
        }
    }
    let (mode, endpoint) = mode.ok_or_else(|| bad("one -open_*_terminal flag is required."))?;
    // Validate the endpoint per mode now; run() re-splits it the same way.
    match mode {
        Mode::Serial => {
            serial_parts(&endpoint)?;
        }
        Mode::TcpClient | Mode::UdpClient => {
            client_parts(&endpoint)?;
        }
        Mode::TcpServer | Mode::UdpServer => {
            server_parts(&endpoint)?;
        }
    }
    if reset_seen && mode != Mode::Serial {
        return Err(bad("--reset-board only applies to -open_serial_terminal."));
    }
    if bind_seen && matches!(mode, Mode::Serial | Mode::TcpClient) {
        return Err(bad("--bind only applies to server and UDP-client modes."));
    }
    Ok(Options {
        mode,
        endpoint,
        bind,
        bind_explicit: bind_seen,
        reset_board,
        io_timeout,
        connect_timeout,
    })
}

/// RAII raw-mode guard; engaged when stdin is a real TTY — which includes a
/// Theia terminal PTY — so Ctrl-C/Ctrl-R reach the device as bytes instead
/// of becoming signals/lines. Piped stdin (tests) skips it.
struct RawMode;
impl RawMode {
    fn enable() -> io::Result<Option<Self>> {
        if io::stdin().is_terminal() {
            crossterm::terminal::enable_raw_mode()?;
            Ok(Some(Self))
        } else {
            Ok(None)
        }
    }
}
impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

enum Stdin {
    Bytes(Vec<u8>),
    Eof,
}

/// Reader thread: bounded chunks into a small channel, EOF reported once.
fn stdin_reader(tx: SyncSender<Stdin>) {
    let mut stdin = io::stdin();
    let mut buf = [0u8; CHUNK];
    loop {
        match stdin.read(&mut buf) {
            Ok(0) | Err(_) => {
                let _ = tx.send(Stdin::Eof);
                return;
            }
            Ok(n) => {
                if tx.send(Stdin::Bytes(buf[..n].to_vec())).is_err() {
                    return;
                }
            }
        }
    }
}

/// Drain pending stdin chunks. At most `STDIN_CHANNEL` chunks per call so a
/// fast producer cannot keep this loop running forever; the leftovers are
/// picked up by the next loop iteration. Ctrl-] (0x1d) sends everything
/// before it then exits locally; EOF/disconnect exits immediately. Returns
/// `true` when the session should end after `out` has been flushed.
fn drain_stdin(rx: &Receiver<Stdin>, out: &mut Vec<Vec<u8>>) -> bool {
    for _ in 0..STDIN_CHANNEL {
        match rx.try_recv() {
            Ok(Stdin::Bytes(chunk)) => {
                if let Some(at) = chunk.iter().position(|&b| b == 0x1d) {
                    if at > 0 {
                        out.push(chunk[..at].to_vec());
                    }
                    return true;
                }
                out.push(chunk);
            }
            Ok(Stdin::Eof) | Err(TryRecvError::Disconnected) => return true,
            Err(TryRecvError::Empty) => return false,
        }
    }
    false
}

fn pump_out(bytes: &[u8]) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(bytes)?;
    stdout.flush()
}

/// Our own status lines end in CRLF so they stay on one line while the
/// terminal is in raw mode (a bare '\n' would not return the cursor).
/// Remote bytes are never touched by this.
fn status(message: &str) {
    let mut stderr = io::stderr().lock();
    let _ = stderr.write_all(message.as_bytes());
    let _ = stderr.write_all(b"\r\n");
}

/// Socket errors that mean the remote peer is gone (RST/fin), as opposed to
/// a local I/O failure: a TCP server treats these as peer disconnects.
fn peer_gone(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::BrokenPipe
            | ErrorKind::UnexpectedEof
    )
}

/// Write all of `data` within `deadline`; every blocking write gets only the
/// time still left, WouldBlock/TimedOut retries every 5 ms, a zero-byte
/// write is an error, partial writes never drop bytes.
fn write_deadline(stream: &mut TcpStream, data: &[u8], deadline: Duration) -> io::Result<()> {
    let end = Instant::now() + deadline;
    let mut sent = 0;
    while sent < data.len() {
        let remaining = end.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                ErrorKind::TimedOut,
                "socket write deadline exceeded",
            ));
        }
        // The OS-level timeout makes one write() wait at most `remaining`,
        // so a series of partial writes cannot outlive the total deadline.
        stream.set_write_timeout(Some(remaining.max(Duration::from_millis(1))))?;
        match stream.write(&data[sent..]) {
            Ok(0) => {
                return Err(io::Error::new(
                    ErrorKind::WriteZero,
                    "socket write returned 0 bytes",
                ));
            }
            Ok(n) => sent += n,
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Bounded DNS resolve: name resolution runs on a scratch thread so a hung
/// resolver cannot stall the terminal past `connect_timeout`.
fn resolve(host: &str, port: u16, deadline: Duration) -> io::Result<Vec<SocketAddr>> {
    let host = host.to_string();
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send((host.as_str(), port).to_socket_addrs());
    });
    rx.recv_timeout(deadline)
        .map_err(|_| io::Error::new(ErrorKind::TimedOut, "name resolution timed out"))?
        .map(|addrs| addrs.collect())
        .map_err(io::Error::other)
}

fn is_wait(e: &io::Error) -> bool {
    matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
}

enum SessionEnd {
    /// Ctrl-] or stdin EOF: leave run() entirely.
    Local,
    /// Peer closed the stream: a TCP server returns to accept().
    Peer,
}

/// One connected TCP session: socket -> stdout, stdin -> socket.
fn tcp_session(
    mut stream: TcpStream,
    rx: &Receiver<Stdin>,
    io_timeout: Duration,
) -> io::Result<SessionEnd> {
    let mut buf = [0u8; CHUNK];
    loop {
        let mut chunks = Vec::new();
        let exit = drain_stdin(rx, &mut chunks);
        for chunk in &chunks {
            match write_deadline(&mut stream, chunk, io_timeout) {
                Ok(()) => {}
                // RST/broken pipe while writing means the peer went away.
                Err(e) if peer_gone(&e) => return Ok(SessionEnd::Peer),
                Err(e) => return Err(e),
            }
        }
        if exit {
            return Ok(SessionEnd::Local);
        }
        match stream.read(&mut buf) {
            Ok(0) => return Ok(SessionEnd::Peer),
            Ok(n) => pump_out(&buf[..n])?,
            Err(e) if is_wait(&e) => {}
            Err(e) if peer_gone(&e) => return Ok(SessionEnd::Peer),
            Err(e) => return Err(e),
        }
    }
}

fn tcp_connect(options: &Options) -> io::Result<TcpStream> {
    let (host, port) = client_parts(&options.endpoint).map_err(io::Error::other)?;
    // One connect_timeout budget total: DNS may use all of it, the connect
    // attempts then share whatever time is left.
    let deadline = Instant::now() + options.connect_timeout;
    let addrs = resolve(&host, port, options.connect_timeout)?;
    if addrs.is_empty() {
        return Err(io::Error::other(format!(
            "{host}:{port} resolved to no addresses"
        )));
    }
    let mut last = None;
    for addr in addrs {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match TcpStream::connect_timeout(&addr, remaining.max(Duration::from_millis(1))) {
            Ok(stream) => {
                stream.set_read_timeout(Some(Duration::from_millis(50)))?;
                stream.set_write_timeout(Some(options.io_timeout))?;
                return Ok(stream);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::new(ErrorKind::TimedOut, "connect deadline exceeded")))
}

fn tcp_server(options: &Options, rx: &Receiver<Stdin>) -> io::Result<()> {
    let port = server_parts(&options.endpoint).map_err(io::Error::other)?;
    let listener = TcpListener::bind((options.bind, port))?;
    listener.set_nonblocking(true)?;
    status(&format!("Listening on {}", listener.local_addr()?));
    status("Ctrl-] exits; one peer at a time.");
    let mut warned = false;
    loop {
        match listener.accept() {
            Ok((stream, peer)) => {
                warned = false;
                status(&format!("Peer connected: {peer}"));
                stream.set_nonblocking(false)?;
                stream.set_read_timeout(Some(Duration::from_millis(50)))?;
                stream.set_write_timeout(Some(options.io_timeout))?;
                match tcp_session(stream, rx, options.io_timeout)? {
                    SessionEnd::Local => return Ok(()),
                    SessionEnd::Peer => status("Peer closed; listening again."),
                }
            }
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                let mut chunks = Vec::new();
                if drain_stdin(rx, &mut chunks) {
                    return Ok(());
                }
                if !chunks.is_empty() && !warned {
                    status("No peer connected; keyboard input is not queued.");
                    warned = true;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(e),
        }
    }
}

fn udp_socket(bind: IpAddr, port: u16, options: &Options) -> io::Result<UdpSocket> {
    let socket = UdpSocket::bind((bind, port))?;
    socket.set_read_timeout(Some(Duration::from_millis(50)))?;
    socket.set_write_timeout(Some(options.io_timeout))?;
    Ok(socket)
}

/// Choose the UDP peer and the local bind for a client: an explicit `--bind`
/// filters resolved addresses to the matching family; otherwise the first
/// resolved address wins and the socket binds ANY of the same family so the
/// kernel picks a routable source interface (required for IPv6 and
/// non-loopback peers).
fn udp_client_target(addrs: &[SocketAddr], options: &Options) -> io::Result<(SocketAddr, IpAddr)> {
    let peer = if options.bind_explicit {
        addrs
            .iter()
            .copied()
            .find(|addr| addr.is_ipv4() == options.bind.is_ipv4())
            .ok_or_else(|| {
                io::Error::other(format!(
                    "{} resolved to no {} address matching --bind {}",
                    options.endpoint,
                    if options.bind.is_ipv4() {
                        "IPv4"
                    } else {
                        "IPv6"
                    },
                    options.bind
                ))
            })?
    } else {
        *addrs.first().ok_or_else(|| {
            io::Error::other(format!("{} resolved to no addresses", options.endpoint))
        })?
    };
    let bind = if options.bind_explicit {
        options.bind
    } else if peer.is_ipv4() {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    } else {
        IpAddr::V6(Ipv6Addr::UNSPECIFIED)
    };
    Ok((peer, bind))
}

fn udp_client(options: &Options, rx: &Receiver<Stdin>) -> io::Result<()> {
    let (host, port) = client_parts(&options.endpoint).map_err(io::Error::other)?;
    let addrs = resolve(&host, port, options.connect_timeout)?;
    let (addr, bind) = udp_client_target(&addrs, options)?;
    let socket = udp_socket(bind, 0, options)?;
    // Connected UDP restricts the peer: replies from other senders drop in
    // the kernel, matching the original client terminal.
    socket.connect(addr)?;
    status(&format!("UDP client -> {addr}; Ctrl-] exits."));
    let mut buf = vec![0u8; UDP_BUF];
    loop {
        let mut chunks = Vec::new();
        let exit = drain_stdin(rx, &mut chunks);
        for chunk in &chunks {
            if socket.send(chunk)? != chunk.len() {
                return Err(io::Error::other("truncated UDP datagram write"));
            }
        }
        if exit {
            return Ok(());
        }
        match socket.recv(&mut buf) {
            Ok(n) => pump_out(&buf[..n])?,
            Err(e) if is_wait(&e) => {}
            Err(e) => return Err(e),
        }
    }
}

fn udp_server(options: &Options, rx: &Receiver<Stdin>) -> io::Result<()> {
    let port = server_parts(&options.endpoint).map_err(io::Error::other)?;
    let socket = udp_socket(options.bind, port, options)?;
    status(&format!("Listening on {}", socket.local_addr()?));
    status("Ctrl-] exits; replies go to the last sender.");
    let mut peer: Option<SocketAddr> = None;
    let mut warned = false;
    let mut buf = vec![0u8; UDP_BUF];
    loop {
        let mut chunks = Vec::new();
        let exit = drain_stdin(rx, &mut chunks);
        for chunk in &chunks {
            match peer {
                Some(p) => {
                    if socket.send_to(chunk, p)? != chunk.len() {
                        return Err(io::Error::other("truncated UDP datagram write"));
                    }
                }
                None => {
                    if !warned {
                        status("No UDP peer yet; keyboard input is not queued.");
                        warned = true;
                    }
                }
            }
        }
        if exit {
            return Ok(());
        }
        match socket.recv_from(&mut buf) {
            Ok((n, from)) => {
                peer = Some(from);
                pump_out(&buf[..n])?;
            }
            Err(e) if is_wait(&e) => {}
            Err(e) => return Err(e),
        }
    }
}

fn serial_session(options: &Options, rx: &Receiver<Stdin>) -> io::Result<()> {
    let (port, baud) = serial_parts(&options.endpoint).map_err(io::Error::other)?;
    // The lock is held for the whole session so the IDE or another terminal
    // cannot steal the port; it is released when the process ends.
    let _lock = PortLock::acquire(&port).map_err(io::Error::other)?;
    let mut transport = SerialTransport::open(&port, baud)?;
    if let Some(board) = options.reset_board {
        for (dtr, rts, hold) in reset_sequence(board).map_err(io::Error::other)? {
            transport.set_dtr(dtr)?;
            transport.set_rts(rts)?;
            thread::sleep(hold);
        }
    } else {
        // Original terminal open asserts DTR and performs no reset.
        transport.set_dtr(true)?;
    }
    // DTR/reset done through the Transport; drop down to the raw port so
    // each write can be bounded by --io-timeout-ms (serialport uses one
    // timeout for reads and writes, so it is re-set around every write).
    let mut serial = transport.into_inner();
    serial
        .set_timeout(SERIAL_READ_SLICE)
        .map_err(io::Error::other)?;
    status(&format!(
        "Serial terminal {port} @ {baud} baud; Ctrl-] exits."
    ));
    let mut buf = [0u8; CHUNK];
    loop {
        let mut chunks = Vec::new();
        let exit = drain_stdin(rx, &mut chunks);
        for chunk in &chunks {
            serial
                .set_timeout(options.io_timeout)
                .map_err(io::Error::other)?;
            let written = serial.write_all(chunk);
            serial
                .set_timeout(SERIAL_READ_SLICE)
                .map_err(io::Error::other)?;
            written?;
        }
        if exit {
            return Ok(());
        }
        match serial.read(&mut buf) {
            Ok(n) => pump_out(&buf[..n])?,
            // A serial read timeout is a 50 ms slice with no bytes, not an
            // error; keep polling stdin.
            Err(e) if e.kind() == ErrorKind::TimedOut => {}
            Err(e) => return Err(e),
        }
    }
}

/// Run the terminal until Ctrl-] or stdin EOF. All I/O errors surface to the
/// caller; dropping handles closes FDs and releases the port lock.
pub fn run(options: Options) -> io::Result<()> {
    let _raw = RawMode::enable()?;
    let (tx, rx) = sync_channel::<Stdin>(STDIN_CHANNEL);
    thread::spawn(move || stdin_reader(tx));
    match options.mode {
        Mode::Serial => serial_session(&options, &rx),
        Mode::TcpClient => {
            let stream = tcp_connect(&options)?;
            status(&format!("Connected to {}; Ctrl-] exits.", options.endpoint));
            tcp_session(stream, &rx, options.io_timeout).map(|_| ())
        }
        Mode::TcpServer => tcp_server(&options, &rx),
        Mode::UdpClient => udp_client(&options, &rx),
        Mode::UdpServer => udp_server(&options, &rx),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn parse_requires_exactly_one_mode() {
        assert!(parse(&args(&[])).is_err());
        assert!(parse(&args(&["-open_tcp_client_terminal"])).is_err());
        assert!(
            parse(&args(&[
                "-open_tcp_client_terminal",
                "127.0.0.1:9000",
                "-open_udp_client_terminal",
                "127.0.0.1:9000",
            ]))
            .is_err()
        );
        assert!(
            parse(&args(&[
                "-open_tcp_client_terminal",
                "127.0.0.1:9000",
                "--bogus"
            ]))
            .is_err()
        );
    }

    #[test]
    fn parse_serial_and_baud_bounds() {
        let o = parse(&args(&[
            "-open_serial_terminal",
            "/dev/cu.usbserial:115200",
        ]))
        .expect("serial");
        assert_eq!(o.mode, Mode::Serial);
        assert!(parse(&args(&["-open_serial_terminal", "/dev/cu.x:0"])).is_err());
        assert!(parse(&args(&["-open_serial_terminal", "/dev/cu.x:4000001"])).is_err());
        assert!(parse(&args(&["-open_serial_terminal", ":115200"])).is_err());
        assert!(parse(&args(&["-open_serial_terminal", "/dev/cu.x"])).is_err());
    }

    #[test]
    fn parse_clients_accept_ipv6_and_reject_port_zero() {
        let o = parse(&args(&["-open_tcp_client_terminal", "[::1]:9000"])).expect("v6");
        assert_eq!(o.mode, Mode::TcpClient);
        assert_eq!(
            client_parts(&o.endpoint).expect("parts"),
            ("::1".to_string(), 9000)
        );
        assert!(parse(&args(&["-open_udp_client_terminal", "127.0.0.1:0"])).is_err());
        assert!(parse(&args(&["-open_tcp_client_terminal", "127.0.0.1:65536"])).is_err());
    }

    #[test]
    fn parse_servers_allow_port_zero_only() {
        let o = parse(&args(&["-open_tcp_server_terminal", "0"])).expect("server 0");
        assert_eq!(server_parts(&o.endpoint).expect("port"), 0);
        assert!(parse(&args(&["-open_udp_server_terminal", "65536"])).is_err());
        assert!(parse(&args(&["-open_udp_server_terminal", "nope"])).is_err());
    }

    #[test]
    fn parse_flags_bounded_and_mode_checked() {
        let o = parse(&args(&[
            "-open_udp_server_terminal",
            "7777",
            "--bind",
            "::1",
            "--connect-timeout-ms",
            "5000",
            "--io-timeout-ms",
            "250",
        ]))
        .expect("flags");
        assert_eq!(o.bind, IpAddr::V6(std::net::Ipv6Addr::LOCALHOST));
        assert_eq!(o.connect_timeout, Duration::from_millis(5000));
        assert_eq!(o.io_timeout, Duration::from_millis(250));
        assert!(
            parse(&args(&[
                "-open_tcp_client_terminal",
                "h:1",
                "--bind",
                "127.0.0.1"
            ]))
            .is_err()
        );
        assert!(
            parse(&args(&[
                "-open_serial_terminal",
                "p:1",
                "--bind",
                "127.0.0.1"
            ]))
            .is_err()
        );
        assert!(
            parse(&args(&[
                "-open_tcp_client_terminal",
                "h:1",
                "--reset-board",
                "4"
            ]))
            .is_err()
        );
        assert!(
            parse(&args(&[
                "-open_udp_server_terminal",
                "9",
                "--io-timeout-ms",
                "0"
            ]))
            .is_err()
        );
        assert!(
            parse(&args(&[
                "-open_udp_server_terminal",
                "9",
                "--io-timeout-ms",
                "60001"
            ]))
            .is_err()
        );
        assert!(
            parse(&args(&[
                "-open_serial_terminal",
                "p:115200",
                "--reset-board",
                "9"
            ]))
            .is_err()
        );
        let o = parse(&args(&[
            "-open_serial_terminal",
            "p:115200",
            "--reset-board",
            "8",
        ]))
        .expect("reset");
        assert_eq!(o.reset_board, Some(8));
    }

    #[test]
    fn drain_stdin_takes_at_most_one_channel_per_call() {
        let (tx, rx) = sync_channel::<Stdin>(64);
        for i in 0..20u8 {
            tx.send(Stdin::Bytes(vec![i; 8])).expect("send");
        }
        tx.send(Stdin::Eof).expect("eof");
        let mut out = Vec::new();
        // A producer can always have more queued; one call is still bounded.
        assert!(!drain_stdin(&rx, &mut out));
        assert_eq!(out.len(), STDIN_CHANNEL);
        let mut drained = out.len();
        out.clear();
        while !drain_stdin(&rx, &mut out) {
            drained += out.len();
            out.clear();
        }
        drained += out.len();
        assert_eq!(drained, 20, "no bytes lost across bounded calls");
    }

    #[test]
    fn drain_stdin_ctrl_bracket_still_flushes_preceding_bytes() {
        let (tx, rx) = sync_channel::<Stdin>(64);
        tx.send(Stdin::Bytes(b"ab".to_vec())).expect("1");
        tx.send(Stdin::Bytes(vec![b'c', 0x1d, b'd'])).expect("2");
        let mut out = Vec::new();
        assert!(drain_stdin(&rx, &mut out));
        assert_eq!(out, vec![b"ab".to_vec(), b"c".to_vec()]);
    }

    #[test]
    fn udp_client_bind_defaults_to_unspecified_peer_family() {
        let base = Options {
            mode: Mode::UdpClient,
            endpoint: "h:9".into(),
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            bind_explicit: false,
            reset_board: None,
            io_timeout: Duration::from_millis(1000),
            connect_timeout: Duration::from_secs(1),
        };
        let v4 = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 9);
        let v6 = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 9);
        let (peer, bind) = udp_client_target(&[v4], &base).expect("v4");
        assert_eq!(peer, v4);
        assert_eq!(bind, IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        let (peer, bind) = udp_client_target(&[v6], &base).expect("v6");
        assert_eq!(peer, v6);
        assert_eq!(bind, IpAddr::V6(Ipv6Addr::UNSPECIFIED));

        let mut explicit = base.clone();
        explicit.bind = IpAddr::V6(Ipv6Addr::LOCALHOST);
        explicit.bind_explicit = true;
        let (peer, bind) = udp_client_target(&[v6, v4], &explicit).expect("v6 pick");
        assert_eq!(peer, v6);
        assert_eq!(bind, IpAddr::V6(Ipv6Addr::LOCALHOST));
        // An explicit IPv6 bind with only an IPv4 result is a clear error.
        assert!(udp_client_target(&[v4], &explicit).is_err());
    }

    #[test]
    fn port_lock_conflicts_for_same_port() {
        let lock = PortLock::acquire("/dev/cu.nodu-terminal-test").expect("first lock");
        assert!(PortLock::acquire("/dev/cu.nodu-terminal-test").is_err());
        drop(lock);
        assert!(PortLock::acquire("/dev/cu.nodu-terminal-test").is_ok());
    }
}
