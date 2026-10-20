#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Session-level differential fixtures for the nodu-kflash port.

Drives the Python implementations of probe() and KFlash().process() through a
scripted fake serial port that auto-acknowledges every inbound SLIP frame by
opcode ([op, 0xE0]; op 0xDE returns the fixed 27-byte JEDEC response). The
Rust test replays the same scripted transport and must produce identical
write/pin/baud transcripts, log lines and final results.

Run with the reviewed venv interpreter (pyserial 3.5, kflash 1.1.6):
    ~/.nodu/python/bin/python3 tools/diff/flash_sessions.py
"""
import hashlib
import json
import struct
import sys
import tempfile
import time
from pathlib import Path

RESOURCES = Path(__file__).resolve().parents[2] / 'desktop' / 'scope-extension' / 'resources'
FIXTURES = Path(__file__).resolve().parents[2] / 'desktop' / 'native' / 'crates' / 'nodu-kflash' / 'tests' / 'fixtures'
sys.path.insert(0, str(RESOURCES))

import serial  # noqa: E402  (monkeypatched below)


def jedec_response(jedec=b'\xef\x40\x18', uid=b'\x01\x02\x03\x04\x05\x06\x07\x08'):
    body = b'\x00' * 8 + jedec + uid
    return struct.pack('<HHI', 0xDE, 0, _crc(body)) + body


def _crc(data):
    import binascii
    return binascii.crc32(data) & 0xFFFFFFFF


def slip_frame(payload):
    return b'\xc0' + payload.replace(b'\xdb', b'\xdb\xdd').replace(b'\xc0', b'\xdb\xdc') + b'\xc0'


class ScriptedSerial:
    """Minimal pyserial stand-in; auto-ACKs each decoded SLIP frame."""

    def __init__(self, *args, **kwargs):
        self.transcript = [('ctor', {k: str(v) for k, v in kwargs.items()})]
        self.rx = bytearray()          # queued device->host bytes
        self.write_buf = bytearray()   # accumulating host->device bytes
        self._dtr = False
        self._rts = False
        self.is_open = False
        self._baudrate = kwargs.get('baudrate', 115200)
        # Properties the probe sets before open()
        self.port = kwargs.get('port')
        self.timeout = kwargs.get('timeout')
        self.write_timeout = kwargs.get('write_timeout')

    # --- pin/baud properties (pyserial style attributes) ---
    @property
    def baudrate(self):
        return self._baudrate

    @baudrate.setter
    def baudrate(self, value):
        self._baudrate = value
        self.transcript.append(['baudrate', value])

    @property
    def dtr(self):
        return self._dtr

    @dtr.setter
    def dtr(self, level):
        self._dtr = bool(level)
        self.transcript.append(['dtr', bool(level)])

    @property
    def rts(self):
        return self._rts

    @rts.setter
    def rts(self, level):
        self._rts = bool(level)
        self.transcript.append(['rts', bool(level)])

    # --- pyserial API used by kflash.py ---
    def setDTR(self, level):
        self.dtr = level

    def setRTS(self, level):
        self.rts = level

    def open(self):
        self.is_open = True
        self.transcript.append(['open'])

    def close(self):
        self.is_open = False
        self.transcript.append(['close'])

    def isOpen(self):
        return self.is_open

    def inWaiting(self):
        return len(self.rx)

    @property
    def in_waiting(self):
        return len(self.rx)

    def reset_input_buffer(self):
        self.rx.clear()
        self.transcript.append(['reset_in'])

    def flushInput(self):
        self.reset_input_buffer()

    def flushOutput(self):
        self.transcript.append(['flush_out'])

    def flush(self):
        self.transcript.append(['flush'])

    def _respond(self):
        """Decode complete frames in write_buf; queue an ACK per frame."""
        while True:
            start = self.write_buf.find(b'\xc0')
            if start < 0:
                self.write_buf.clear()
                return
            end = self.write_buf.find(b'\xc0', start + 1)
            if end < 0:
                if start > 0:
                    del self.write_buf[:start]
                return
            frame = bytes(self.write_buf[start + 1:end])
            del self.write_buf[:end + 1]
            # unescape
            payload = bytearray()
            i = 0
            while i < len(frame):
                b = frame[i]
                if b == 0xDB and i + 1 < len(frame):
                    payload.append({0xDC: 0xC0, 0xDD: 0xDB}[frame[i + 1]])
                    i += 2
                else:
                    payload.append(b)
                    i += 1
            if not payload:
                continue
            op = payload[0]
            if op == 0xDE:
                self.rx += slip_frame(jedec_response())
            else:
                self.rx += slip_frame(bytes([op, 0xE0]))

    def write(self, data):
        self.write_buf += data
        self.transcript.append(['write', bytes(data).hex()])
        self._respond()
        return len(data)

    def read(self, n=1):
        out = bytes(self.rx[:n])
        del self.rx[:n]
        return out


def run_probe():
    import nodu_flash_probe as probe_mod

    fake = ScriptedSerial()
    real_serial = serial.Serial
    serial.Serial = lambda *a, **k: fake
    logs = []
    try:
        result = probe_mod.probe(
            'FAKE0', check=lambda: None, log=logs.append,
            nonce='a' * 32, session='session-1')
    except Exception as e:
        result = {'error': {'type': type(e).__name__, 'message': str(e)}}
    finally:
        serial.Serial = real_serial
    if not isinstance(result, dict) or 'error' not in result:
        result = dict(result)
        result.pop('readAt', None)  # wall clock
    return {'transcript': fake.transcript, 'logs': logs, 'result': result}


def run_flash():
    from kflash import KFlash

    fake = ScriptedSerial()
    real_serial = serial.Serial
    serial.Serial = lambda *a, **k: fake
    KFlash.print_callback = lambda *parts, **kw: None
    logs = []

    def printer(*parts, **kwargs):
        text = ' '.join(str(p) for p in parts).strip()
        if text:
            logs.append(text)

    KFlash.print_callback = printer
    image_bytes = bytes((i * 7 + 3) & 0xFF for i in range(5000))
    with tempfile.TemporaryDirectory() as td:
        image = Path(td) / 'firmware.bin'
        image.write_bytes(image_bytes)
        try:
            KFlash().process(terminal=False, dev='FAKE0', baudrate=1500000,
                             board=None, sram=False, file=str(image),
                             callback=lambda *a: None, noansi=True, io_mode='dio')
            result = {'ok': True}
        except SystemExit as e:
            result = {'error': {'type': 'SystemExit', 'message': str(e)}}
        except Exception as e:
            result = {'error': {'type': type(e).__name__, 'message': str(e)}}
    serial.Serial = real_serial
    return {'transcript': fake.transcript, 'logs': logs, 'result': result,
            'image': image_bytes.hex()}


def main():
    sessions = {
        'probe_happy': run_probe(),
        'flash_happy': run_flash(),
    }
    FIXTURES.mkdir(parents=True, exist_ok=True)
    out = FIXTURES / 'session-expected.json'
    out.write_text(json.dumps(sessions, indent=1))
    for name, s in sessions.items():
        print(f'{name}: {len(s["transcript"])} events, {len(s["logs"])} logs, '
              f'result={"ok" if "error" not in s["result"] else s["result"]}')
    print(f'wrote {out}')


if __name__ == '__main__':
    main()
