#!/usr/bin/env python3
"""Validate the IDE->raw transition before bulk backup on the real board.

connect(protocol=ide) -> backupDevice -> confirm the pump passes the
transfer-preflight point that failed earlier -> stop -> disconnect.
"""
import json
import os
import subprocess
import threading
import time

ROOT = "/Users/wangwei/Model/k210-studio"
SIDECAR = os.path.join(ROOT, "desktop/native/target/release/nodu-device")
PORT = "/dev/cu.usbserial-3120"
PROFILE = "embedfire-cam-gc2145"
HERE = os.path.dirname(os.path.abspath(__file__))
TRANSCRIPT = os.path.join(HERE, "run-ide-transition.txt")
BACKUP_DIR = os.path.expanduser(
    "~/.nodu/backups/%s-idetransition" % time.strftime("%Y%m%d-%H%M%S")
)
PASS_POINT = 96 * 1024  # past the 64 KiB transfer-preflight + margin

proc = subprocess.Popen(
    [SIDECAR],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
)
pending = {}
lock = threading.Lock()
progress = {"completed": 0, "stage": ""}


def stamp():
    return time.strftime("[%H:%M:%S]")


def log(line):
    with lock:
        with open(TRANSCRIPT, "a") as f:
            f.write(line + "\n")


def reader():
    for line in proc.stdout:
        line = line.rstrip("\n")
        try:
            msg = json.loads(line)
        except ValueError:
            log(f"{stamp()} RAW {line}")
            continue
        if "event" in msg:
            data = msg.get("data") or {}
            prog = data.get("progress")
            if prog:
                progress["completed"] = prog.get("completed") or 0
                progress["stage"] = prog.get("stage") or ""
            log(f"{stamp()} EVENT {line[:600]}")
            continue
        mid = msg.get("id")
        log(f"{stamp()} {'RESULT' if 'result' in msg else 'ERROR'} id={mid} {line[:1500]}")
        with lock:
            pending[mid] = msg


threading.Thread(target=reader, daemon=True).start()
req_id = 0


def send(method, args):
    global req_id
    req_id += 1
    proc.stdin.write(json.dumps({"id": req_id, "method": method, "args": args}) + "\n")
    proc.stdin.flush()
    log(f"--- {stamp()} -> {method} id={req_id}")
    return req_id


def wait_result(mid, timeout_s=120):
    start = time.time()
    while time.time() - start < timeout_s:
        with lock:
            msg = pending.get(mid)
        if msg is not None:
            return msg
        time.sleep(0.1)
    return None


try:
    send("connect", {"port": PORT, "boardProfile": PROFILE, "protocol": "ide"})
    r = wait_result(1, 60)
    assert r and "result" in r, f"connect failed: {r}"
    print("connected (ide):", r["result"].get("firmware"), flush=True)

    bid = send("backupDevice", {"backupDir": BACKUP_DIR})
    # Wait until the pump passes the point that failed before, or the
    # request resolves/errors.
    start = time.time()
    while time.time() - start < 300:
        with lock:
            done = pending.get(bid)
        if done is not None:
            break
        if progress["completed"] >= PASS_POINT:
            break
        time.sleep(0.3)
    print(
        f"pump reached stage={progress['stage']} completed={progress['completed']}",
        flush=True,
    )
    send("stop", {})
    r = wait_result(bid, 90)
    print("backupDevice result:", json.dumps(r)[:600] if r else "none", flush=True)
    send("disconnect", {})
    wait_result(req_id, 30)
    if progress["completed"] >= PASS_POINT:
        print("RESULT: OK — passed transfer-preflight over raw after IDE teardown", flush=True)
        log(f"=== {stamp()} RESULT OK")
    else:
        print("RESULT: did not reach pass point", flush=True)
        log(f"=== {stamp()} RESULT short")
        raise SystemExit(1)
except Exception as e:
    print(f"FAILED: {e}", flush=True)
    log(f"=== {stamp()} FAILED {e}")
    try:
        send("disconnect", {})
        wait_result(req_id, 20)
    except Exception:
        pass
    raise SystemExit(1)
finally:
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.wait(timeout=10)
