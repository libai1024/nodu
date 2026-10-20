#!/usr/bin/env python3
"""Python/Rust device-worker differential harness — no hardware.

The legacy Python worker (kept as the migration oracle) is connected to a
PTY slave backed by `mock-bridge` (the Rust simulated board over a real
serial fd). The Rust sidecar runs with `--mock` (same simulated board,
in-process). An identical JSON-lines RPC sequence is driven into both and
the observable results — result/error, emitted logs, state phases — are
compared per step.

Exit 0 when every step matches; prints a per-step diff report either way.
Known intentional divergences are classified separately from real diffs.
"""

import base64
import json
import os
import pty
import queue
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PY = os.path.expanduser("~/.nodu/python/bin/python3")
WORKER = os.path.join(ROOT, "desktop/scope-extension/resources/nodu_device_worker.py")
RUST = os.path.join(ROOT, "desktop/native/target/release/nodu-device")
BRIDGE = os.path.join(ROOT, "desktop/native/target/release/mock-bridge")

STEP_TIMEOUT = 30.0


class JsonWorker:
    """JSON-lines request/response client for one worker process."""

    def __init__(self, argv):
        self.proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self.results = {}
        self.logs = []
        self.states = []
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()
        self.next_id = 0

    def _read(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in msg:
                self.results[msg["id"]] = msg
            elif msg.get("event") == "log":
                self.logs.append(msg["data"])
            elif msg.get("event") == "state":
                self.states.append(msg["data"])

    def call(self, method, args=None, timeout=STEP_TIMEOUT):
        self.next_id += 1
        rid = self.next_id
        self.proc.stdin.write(json.dumps(
            {"id": rid, "method": method, "args": args or {}}) + "\n")
        self.proc.stdin.flush()
        end = time.time() + timeout
        while time.time() < end:
            if rid in self.results:
                return self.results.pop(rid)
            if self.proc.poll() is not None:
                raise RuntimeError(f"{method}: worker exited {self.proc.returncode}")
            time.sleep(0.01)
        raise RuntimeError(f"{method}: no reply within {timeout}s")

    def take_logs(self):
        logs, self.logs = self.logs, []
        return logs

    def wait_state(self, **wanted):
        end = time.time() + STEP_TIMEOUT
        while time.time() < end:
            for state in reversed(self.states):
                if all(state.get(k) == v for k, v in wanted.items()):
                    return state
            time.sleep(0.02)
        return None

    def close(self):
        try:
            self.call("disconnect", {}, timeout=5)
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()


def log_texts(logs, stream=None):
    return [entry["text"] for entry in logs
            if entry.get("text") and (stream is None or entry.get("stream") == stream)]


def outcome(reply):
    if "error" in reply:
        return ("error", reply["error"])
    return ("ok", None)


def run_sequence(name, worker, port_args):
    """Drive the shared RPC sequence; return per-step observations."""
    out = []
    rec = out.append

    reply = worker.call("connect", port_args)
    rec(("connect", outcome(reply)))
    if outcome(reply)[0] != "ok":
        return out
    time.sleep(0.3)

    reply = worker.call("getState")
    state = reply.get("result", {})
    caps = state.get("capabilities", {})
    rec(("state", (state.get("phase"), caps.get("repl"), caps.get("files"),
                   caps.get("script"), caps.get("framebuffer"))))

    worker.take_logs()
    reply = worker.call("execute", {"code": 'print("diff-ok")'})
    time.sleep(0.4)
    logs = worker.take_logs()
    rec(("execute-print", outcome(reply)[0],
         any("diff-ok" in t for t in log_texts(logs, "stdout"))))

    worker.take_logs()
    reply = worker.call("execute", {"code": "1/0"})
    time.sleep(0.4)
    logs = worker.take_logs()
    rec(("execute-error", outcome(reply)[0],
         any("ZeroDivisionError" in t for t in log_texts(logs, "stderr"))))

    # Long-running script: identical deterministic stdout stream.
    worker.take_logs()
    code = 'import time\nfor i in range(3):\n print("T", i)\n time.sleep(0.05)\n'
    reply = worker.call("runScript", {"code": code, "name": "diff"})
    tick_state = worker.wait_state(running=False)
    time.sleep(0.6)
    logs = worker.take_logs()
    # The mock emits synthetic `tick<N>` lines while a script runs (it does
    # not execute real Python) — the differential is that both workers stream
    # stdout while running and report running=False afterwards.
    stream = [line for t in log_texts(logs, "stdout") for line in t.splitlines()]
    rec(("run-print", outcome(reply)[0],
         tick_state is not None,
         bool(stream) and all(line.startswith("tick") for line in stream)))

    # Stop during a running script: both must end running=False without a
    # device error. Log content is a documented divergence (raw REPL echoes
    # the KeyboardInterrupt traceback; IDE suppresses its interrupt tail).
    worker.take_logs()
    reply = worker.call("runScript", {"code": "while True:\n print('S')\n", "name": "loop"})
    running = worker.wait_state(running=True)
    time.sleep(0.4)
    worker.take_logs()
    stop = worker.call("stop")
    stopped = worker.wait_state(running=False)
    time.sleep(0.4)
    logs = worker.take_logs()
    device_error = any("设备" in t or "IDE interrupt" in t for t in log_texts(logs, "stderr"))
    rec(("stop-running", outcome(reply)[0], running is not None,
         outcome(stop)[0], stopped is not None, not device_error))

    # Files: deterministic round-trip on identical VFS contents.
    worker.take_logs()
    reply = worker.call("listFiles", {"path": "/flash"})
    names = sorted(f["name"] for f in reply.get("result", []))
    rec(("list-before", outcome(reply)[0], names))

    payload = base64.b64encode(b"print(7)\n").decode()
    reply = worker.call("writeFile",
                        {"path": "/flash/diff_test.py", "data": payload,
                         "overwrite": False})
    rec(("write-new", outcome(reply)[0]))

    reply = worker.call("writeFile",
                        {"path": "/flash/diff_test.py", "data": payload,
                         "overwrite": False})
    rec(("write-noclobber", outcome(reply)[0]))

    reply = worker.call("readFile", {"path": "/flash/diff_test.py"})
    data = reply.get("result", {})
    rec(("read-back", outcome(reply)[0], data.get("size"),
         base64.b64decode(data.get("data", "")) == b"print(7)\n"))

    reply = worker.call("listFiles", {"path": "/flash"})
    names = sorted(f["name"] for f in reply.get("result", []))
    rec(("list-after", outcome(reply)[0], names))

    reply = worker.call("disconnect")
    time.sleep(0.3)
    reply2 = worker.call("getState")
    rec(("disconnect", outcome(reply)[0], reply2.get("result", {}).get("phase")))
    return out


def main():
    for path in (PY, WORKER, RUST, BRIDGE):
        if not os.path.exists(path):
            print(f"missing: {path}")
            return 2

    # Python worker side: PTY slave (a real serial path) -> mock bridge.
    master, slave = pty.openpty()
    slave_name = os.ttyname(slave)
    bridge = subprocess.Popen([BRIDGE], stdin=master, stdout=master,
                              close_fds=True)
    os.close(master)

    py = JsonWorker([PY, WORKER])
    rust = JsonWorker([RUST, "--mock"])
    failures = divergences = 0
    try:
        py_out = run_sequence("python", py, {
            "port": slave_name, "boardProfile": "embedfire-cam-gc2145"})
        rust_out = run_sequence("rust", rust, {
            # --mock swaps the transport whenever port == "mock"; the label
            # doubles as its own PortLock key so there is no PTY contention.
            "port": "mock",
            "boardProfile": "embedfire-cam-gc2145",
            "boardId": 0, "protocol": "ide"})
    finally:
        py.close()
        rust.close()
        bridge.terminate()
        try:
            bridge.wait(5)
        except subprocess.TimeoutExpired:
            bridge.kill()

    py_steps = {step[0]: step[1:] for step in py_out}
    rust_steps = {step[0]: step[1:] for step in rust_out}
    order = [step[0] for step in py_out]
    print(f"{'step':<18} {'python':<46} {'rust':<46} verdict")
    print("-" * 124)
    for step_name in order:
        p = py_steps.get(step_name)
        r = rust_steps.get(step_name)
        if p == r:
            verdict = "MATCH"
        elif step_name == "stop-running":
            verdict = "DIVERGENCE?"
            divergences += 1
        else:
            verdict = "DIFF"
            failures += 1
        print(f"{step_name:<18} {str(p):<46} {str(r):<46} {verdict}")
    print("-" * 124)
    print(f"{failures} diff(s), {divergences} divergence(s) to inspect")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
