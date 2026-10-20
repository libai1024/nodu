# SPDX-License-Identifier: MIT
# PTY raw-mode proof for nodu-terminal: the child runs with a real
# controlling terminal, so crossterm raw mode is actually exercised.
# Verifies: Ctrl-C / Ctrl-R arrive as bytes (no SIGINT), Ctrl-] exits, and
# termios is restored on the slave.
#
# The slave is adopted as controlling terminal by a helper session leader
# that stays alive after nodu-terminal exits — otherwise the hangup would
# revoke the parent's slave fd before termios can be re-read.
# Loopback only; no serial hardware.
import os
import pty
import socket
import subprocess
import sys
import termios
import threading
import time

HELPER = (
    "import os,sys,termios,fcntl,time\n"
    # start_new_session made this process a session leader; adopt the ctty.
    "fcntl.ioctl(0, termios.TIOCSCTTY, 0)\n"
    "pid=os.fork()\n"
    "if pid==0: os.execv(sys.argv[1],[sys.argv[1]]+sys.argv[2:])\n"
    "os.waitpid(pid,0)\n"
    # Keep the session alive so the pty stays valid for the termios check.
    "time.sleep(3600)\n"
)


def main() -> int:
    binary = sys.argv[1]

    # Loopback echo server that records what the terminal sends it and notes
    # when the terminal disconnects.
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    received = []
    accepted = []
    peer_closed = threading.Event()

    def serve():
        try:
            conn, _ = srv.accept()
        except OSError:
            return
        accepted.append(conn)
        conn.settimeout(0.1)
        while True:
            try:
                data = conn.recv(4096)
            except socket.timeout:
                continue
            except OSError:
                peer_closed.set()
                return
            if not data:
                peer_closed.set()
                return
            received.append(data)

    threading.Thread(target=serve, daemon=True).start()

    master, slave = pty.openpty()
    saved = termios.tcgetattr(slave)

    # A real terminal emulator drains the master continuously; without this
    # the small pty output queue fills and the child blocks on stdout write.
    def drain_master():
        while True:
            try:
                if not os.read(master, 65536):
                    return
            except OSError:
                return

    threading.Thread(target=drain_master, daemon=True).start()

    session = subprocess.Popen(
        [
            sys.executable, "-c", HELPER, binary,
            "-open_tcp_client_terminal", f"127.0.0.1:{port}",
        ],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        close_fds=True,
    )
    try:
        deadline = time.time() + 10
        while not accepted and time.time() < deadline:
            if session.poll() is not None:
                break
            time.sleep(0.02)
        if not accepted:
            print("terminal never connected", file=sys.stderr)
            return 1

        # Raw mode proof: the line discipline must not be in cooked mode.
        live = termios.tcgetattr(slave)
        if live[3] & (termios.ICANON | termios.ECHO):
            print("raw mode never took effect on the slave", file=sys.stderr)
            return 1

        # Ctrl-C (0x03) and Ctrl-R (0x12): raw mode forwards them as bytes;
        # cooked mode would turn 0x03 into SIGINT and swallow it.
        os.write(master, b"\x03\x12")
        deadline = time.time() + 5
        while sum(map(len, received)) < 2 and time.time() < deadline:
            time.sleep(0.02)
        got = b"".join(received)
        if got != b"\x03\x12":
            print(f"control bytes not forwarded, got {got!r}", file=sys.stderr)
            return 1

        # Ctrl-] (0x1d) exits locally: the socket closes.
        os.write(master, b"\x1d")
        if not peer_closed.wait(timeout=10):
            print("Ctrl-] did not exit the terminal", file=sys.stderr)
            return 1

        # termios restored while the slave fd is still open in the parent.
        deadline = time.time() + 5
        restored = None
        while time.time() < deadline:
            try:
                restored = termios.tcgetattr(slave)
            except termios.error:
                time.sleep(0.02)
                continue
            if restored == saved:
                break
            time.sleep(0.02)
        if restored != saved:
            print(
                f"termios not restored: lflag {saved[3]:#x} -> "
                f"{restored[3] if restored else 'unreadable'}",
                file=sys.stderr,
            )
            return 1
        print("pty raw-mode ok")
        return 0
    finally:
        session.kill()
        session.wait()
        os.close(master)
        os.close(slave)
        srv.close()


if __name__ == "__main__":
    sys.exit(main())
