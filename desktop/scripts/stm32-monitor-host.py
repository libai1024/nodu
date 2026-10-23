#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""POSIX pseudo-terminal smoke test; no physical serial device is opened."""
import base64
import json
import os
from pathlib import Path
import queue
import select
import subprocess
import tempfile
import threading

class PtyUnsupported(Exception):
    pass

root = Path(__file__).resolve().parents[1]
master, slave = os.openpty()
port = os.ttyname(slave)
with tempfile.TemporaryDirectory(prefix='nodu-monitor-') as data:
    process = subprocess.Popen([str(root / 'native/target/release/nodu-embedded'), '--resources', str(root / 'scope-extension/resources/stm32'), '--toolkit', str(root / '.tools/stm32/darwin'), '--data-dir', data], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    inbox = queue.Queue()
    def reader():
        for line in process.stdout:
            inbox.put(json.loads(line))
    threading.Thread(target=reader, daemon=True).start()
    sequence = 0
    events = []
    def call(method, args=None):
        global sequence
        sequence += 1
        process.stdin.write(json.dumps({'id': sequence, 'method': method, 'args': args or {}}) + '\n')
        process.stdin.flush()
        while True:
            reply = inbox.get(timeout=5)
            if reply.get('id') == sequence:
                if reply.get('code') == 'portOpen' and 'Not a typewriter' in reply.get('error', ''):
                    raise PtyUnsupported(reply['error'])
                assert 'error' not in reply, reply
                return reply.get('result')
            events.append(reply)
    try:
        assert call('openMonitor', {'port': port, 'baud': 115200})['open']
        payload = '你好 Nodu\n'.encode()
        os.write(master, payload)
        received = b''
        while len(received) < len(payload):
            event = inbox.get(timeout=5)
            if event.get('event') == 'monitor.data':
                received += base64.b64decode(event['data']['data'])
        assert received == payload
        call('writeMonitor', {'data': base64.b64encode(b'ping\n').decode()})
        assert select.select([master], [], [], 3)[0]
        assert os.read(master, 100) == b'ping\n'
        call('closeMonitor')
        assert call('openMonitor', {'port': port, 'baud': 115200})['open']
        call('closeMonitor')
        print(json.dumps({'host': 'macOS POSIX PTY', 'physicalHardware': False, 'rx': 'passed', 'tx': 'passed', 'closeReopen': 'passed'}, indent=2))
    except PtyUnsupported as error:
        print(json.dumps({'host': 'macOS POSIX PTY', 'physicalHardware': False, 'status': 'unsupported', 'reason': str(error), 'note': 'serialport uses hardware modem ioctls that macOS PTYs do not implement; use real USB serial hardware'}, indent=2, ensure_ascii=False))
        raise SystemExit(77)
    finally:
        process.stdin.close()
        process.wait(timeout=5)
        os.close(master)
        os.close(slave)
