#!/usr/bin/env python3
"""Real-board flashFirmware run driver.

Drives the release nodu-device sidecar over JSON-lines:
  connect -> prepareFirmware -> backupDevice -> flashFirmware -> disconnect.

Full transcript is written to run.txt in this directory.
"""
import json
import os
import subprocess
import sys
import threading
import time

ROOT = "/Users/wangwei/Model/k210-studio"
SIDECAR = os.path.join(ROOT, "desktop/native/target/release/nodu-device")
PORT = "/dev/cu.usbserial-3120"
PROFILE = "embedfire-cam-gc2145"
HERE = os.path.dirname(os.path.abspath(__file__))
TRANSCRIPT = os.path.join(HERE, "run.txt")
BACKUP_DIR = os.path.expanduser(
    "~/.nodu/backups/%s-prewrite" % time.strftime("%Y%m%d-%H%M%S")
)

proc = subprocess.Popen(
    [SIDECAR],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
)

lock = threading.Lock()
pending = {}
done = threading.Event()
state = {}


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
            if msg["event"] == "state":
                state.update({k: v for k, v in data.items() if v is not None})
                prog = data.get("progress")
                if prog:
                    short = (
                        f"stage={prog.get('stage')} "
                        f"{prog.get('completed')}/{prog.get('total')}"
                    )
                    log(f"{stamp()} EVENT progress {short}")
                    print(f"{stamp()} progress {short}", flush=True)
                else:
                    log(f"{stamp()} EVENT {line}")
            else:
                log(f"{stamp()} EVENT {line}")
            continue
        mid = msg.get("id")
        log(f"{stamp()} {'RESULT' if 'result' in msg else 'ERROR'} id={mid} {line[:2000]}")
        with lock:
            if mid in pending:
                pending[mid] = msg
                done.set()
    done.set()


threading.Thread(target=reader, daemon=True).start()

req_id = 0


def request(method, args, label=None, timeout_s=3900):
    global req_id
    req_id += 1
    mid = req_id
    pending[mid] = None
    tag = label or method
    log(f"--- {stamp()} -> {tag} id={mid} args={json.dumps(args)}")
    print(f"--- {stamp()} -> {tag} id={mid}", flush=True)
    proc.stdin.write(json.dumps({"id": mid, "method": method, "args": args}) + "\n")
    proc.stdin.flush()
    start = time.time()
    while time.time() - start < timeout_s:
        with lock:
            msg = pending[mid]
        if msg is not None:
            if "error" in msg:
                raise RuntimeError(f"{tag} failed: {msg['error']}")
            return msg["result"]
        if proc.poll() is not None:
            raise RuntimeError(f"sidecar exited {proc.returncode} during {tag}")
        time.sleep(0.2)
    raise RuntimeError(f"{tag} timed out")


try:
    state_r = request(
        "connect",
        {"port": PORT, "boardProfile": PROFILE, "protocol": "raw"},
        label="connect",
    )
    print("connected:", state_r.get("firmware"), flush=True)

    plan = request(
        "prepareFirmware",
        {"cacheDir": os.path.expanduser("~/.nodu/firmware")},
        label="prepareFirmware",
    )
    print("prepared:", json.dumps(plan)[:300], flush=True)

    result = request(
        "backupDevice", {"backupDir": BACKUP_DIR}, label="backupDevice"
    )
    print(
        "backup:",
        json.dumps({k: result.get(k) for k in ("directory", "verified", "flashSha256")}),
        flush=True,
    )

    flash = request(
        "flashFirmware", {"backupDir": BACKUP_DIR}, label="flashFirmware"
    )
    print("flash result:", json.dumps(flash)[:2000], flush=True)

    final = request("getState", {}, label="getState")
    print("final state:", json.dumps(final)[:800], flush=True)
    request("disconnect", {})
    print("RESULT: OK", flush=True)
    log(f"=== {stamp()} RESULT OK")
except Exception as e:
    print(f"FAILED: {e}", flush=True)
    log(f"=== {stamp()} FAILED {e}")
    try:
        request("disconnect", {}, timeout_s=30)
    except Exception:
        pass
    sys.exit(1)
finally:
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.wait(timeout=10)
