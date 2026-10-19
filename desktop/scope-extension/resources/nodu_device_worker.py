#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Single-owner K210 JSON-lines device worker.

Install ``mpremote==1.25.0 pyserial==3.5`` in the selected Python environment.
Only JSON is written to stdout. Requests are {id, method, args}; replies are
{id, result} or {id, error}; notifications are {event, data}. Binary file and
frame data are base64. Void results are null. No startup files are written.

The camera path was checked against MaixPy-v1's MIT-licensed ide_dbg.c/h and
py_image.c at d8901fd2272f000226f1c1037c1eb7c412b88e66. It uses standard JPEG
through raw REPL because switching UART IDE mode modifies ide_mode.conf and
returning from IDE mode soft-reboots this firmware. No Qt client code is used.
"""
import ast
import base64
import binascii
import codecs
from collections import deque
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import posixpath
import queue
import struct
import sys
import tempfile
import threading
import time
import uuid

MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_CODE_BYTES = 256 * 1024
MAX_LINE_BYTES = 4 * 1024 * 1024
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
OPERATION_TIMEOUT = 20.0


class DeviceError(Exception):
    pass


class Cancelled(DeviceError):
    pass


class ProtocolError(DeviceError):
    """A serial/raw-REPL transaction did not reach a known completion."""
    pass


def backup_frame_metadata(line, expected_bytes):
    """Describe framing failures without retaining encoded user bytes/text."""
    result = {'bytes': len(line), 'sha256': hashlib.sha256(line).hexdigest(),
              'kind': 'other', 'hasDataMarker': b'NODU_DATA ' in line}
    if line.startswith(b'NODU_DATA '):
        result['kind'] = 'data'
        header = line[10:18]
        valid_offset = len(header) == 8 and all(c in b'0123456789abcdefABCDEF' for c in header)
        result.update(offset=int(header, 16) if valid_offset else None,
                      offsetHexValid=valid_offset, colonValid=line[18:19] == b':')
        encoded = line[19:] if len(line) >= 19 else b''
        invalid = []
        count = 0
        for position, value in enumerate(encoded):
            if value not in b'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=':
                count += 1
                if len(invalid) < 16:
                    kind = ('cr' if value == 13 else 'lf' if value == 10 else
                            'control' if value < 32 or value == 127 else
                            'non-ascii' if value > 127 else 'non-base64-ascii')
                    invalid.append({'position': position, 'kind': kind})
        result.update(encodedBytes=len(encoded), expectedEncodedBytes=4 * ((expected_bytes + 2) // 3),
                      base64Remainder=len(encoded) % 4, paddingBytes=encoded.count(b'='),
                      invalidCount=count, invalid=invalid)
    elif line.startswith(b'NODU_FILL '):
        result['kind'] = 'fill'
    elif line.startswith(b'NODU_SHA256 '):
        value = line[12:]
        result.update(kind='sha256', digestBytes=len(value),
                      digestHexValid=len(value) == 64 and all(c in b'0123456789abcdef' for c in value))
    elif line.startswith((b'>>>', b'raw REPL;', b'OK')):
        result['kind'] = 'repl-control'
    return result


class PortLock:
    """OS-released advisory process lock; never unlink a live lock inode."""
    def __init__(self, port, directory=None):
        canonical = os.path.realpath(port)
        # macOS exposes the same serial device as tty.* and cu.*.
        canonical = canonical.replace('/dev/tty.', '/dev/cu.')
        digest = hashlib.sha256(canonical.encode()).hexdigest()[:32]
        root = Path(directory or tempfile.gettempdir()) / 'nodu-device-locks'
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = root / (digest + '.lock')
        self.file = None

    def acquire(self):
        self.file = open(self.path, 'a+b')
        try:
            if os.name == 'nt':
                import msvcrt
                self.file.seek(0)
                if not self.file.read(1):
                    self.file.write(b'0')
                    self.file.flush()
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, IOError):
            self.file.close()
            self.file = None
            raise DeviceError('Serial port is owned by another Nodu process.') from None
        return self

    def release(self):
        if self.file:
            self.file.close()
            self.file = None


def remote_path(value, writing=False):
    if not isinstance(value, str) or not value or '\x00' in value or '\\' in value:
        raise DeviceError('Expected a nonempty POSIX device path.')
    if len(value.encode('utf-8')) > 512:
        raise DeviceError('Device path is too long.')
    if '..' in value.split('/'):
        raise DeviceError('Parent traversal is not allowed in device paths.')
    value = posixpath.normpath(value if value.startswith('/') else '/flash/' + value)
    if writing and posixpath.basename(value).lower() in ('boot.py', 'main.py'):
        raise DeviceError('Writing boot.py or main.py is disabled in this version.')
    if writing and value == '/':
        raise DeviceError('A file path is required.')
    return value


def decode_file(value):
    if not isinstance(value, str) or len(value) > ((MAX_FILE_BYTES + 2) // 3) * 4:
        raise DeviceError('File exceeds the 2 MiB transfer limit.')
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise DeviceError('File data must be valid base64.') from None
    if len(data) > MAX_FILE_BYTES:
        raise DeviceError('File exceeds the 2 MiB transfer limit.')
    return data


def jpeg_dimensions(data):
    """Read dimensions from a bounded standard JPEG, rejecting IDE envelopes."""
    if not isinstance(data, bytes) or not 4 <= len(data) <= MAX_FILE_BYTES:
        raise DeviceError('Invalid JPEG byte length.')
    if not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
        raise DeviceError('Camera returned an invalid standard JPEG.')
    cursor = 2
    while cursor + 3 < len(data):
        if data[cursor] != 0xff:
            raise DeviceError('Invalid JPEG marker.')
        while cursor < len(data) and data[cursor] == 0xff:
            cursor += 1
        if cursor >= len(data):
            break
        marker = data[cursor]
        cursor += 1
        if marker in (0xd8, 0xd9) or 0xd0 <= marker <= 0xd7:
            continue
        if cursor + 2 > len(data):
            break
        length = struct.unpack('>H', data[cursor:cursor + 2])[0]
        if length < 2 or cursor + length > len(data):
            raise DeviceError('Invalid JPEG segment length.')
        if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
            if length < 8:
                raise DeviceError('Invalid JPEG frame header.')
            height, width = struct.unpack('>HH', data[cursor + 3:cursor + 7])
            if not 0 < width <= 4096 or not 0 < height <= 4096:
                raise DeviceError('Invalid JPEG dimensions.')
            return width, height
        if marker == 0xda:
            break
        cursor += length
    raise DeviceError('JPEG has no supported frame header.')


def validate_request(value):
    if not isinstance(value, dict):
        raise DeviceError('Request must be an object.')
    request_id = value.get('id')
    if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
        raise DeviceError('Request id must be a string or integer.')
    if isinstance(request_id, str) and (not request_id or len(request_id) > 128):
        raise DeviceError('Request id must have 1–128 characters.')
    method = value.get('method')
    if not isinstance(method, str) or method not in DeviceWorker.METHODS:
        raise DeviceError('Unknown device method.')
    args = value.get('args', {})
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise DeviceError('Request args must be an object.')
    return request_id, method, args


class BufferedSerial:
    """Return surplus raw-REPL bytes to mpremote without losing its prompt."""
    def __init__(self, serial):
        self.serial = serial
        self.pending = bytearray()

    def __getattr__(self, key):
        return getattr(self.serial, key)

    def unread(self, data):
        self.pending[:0] = data

    @property
    def in_waiting(self):
        return len(self.pending) + self.serial.in_waiting

    def inWaiting(self):
        return self.in_waiting

    def read(self, size=1):
        data = bytes(self.pending[:size])
        del self.pending[:len(data)]
        return data + self.serial.read(size - len(data)) if len(data) < size else data

    def reset_input_buffer(self):
        self.pending.clear()
        self.serial.reset_input_buffer()

    @property
    def baudrate(self):
        return self.serial.baudrate

    @baudrate.setter
    def baudrate(self, value):
        self.serial.baudrate = value


def open_transport(port, baud, check):
    """Adapt mpremote's open and raw handshake without DTR/RTS reset pulses."""
    try:
        import serial
        from mpremote.transport_serial import SerialTransport
    except ImportError as exc:
        raise DeviceError('Python dependencies missing; install mpremote==1.25.0 pyserial==3.5 in this Python environment.') from exc

    class K210Transport(SerialTransport):
        def __init__(self, device, baudrate):
            # Set inactive control lines before open on every platform, without
            # mpremote's CP210x Windows branch subsequently asserting them.
            self.in_raw_repl = False
            self.use_raw_paste = False
            self.device_name = device
            self.mounted = False
            self.operation_timeout = OPERATION_TIMEOUT
            options = {'baudrate': baudrate, 'timeout': 0.2,
                       'inter_byte_timeout': 0.2, 'write_timeout': 1.0}
            if os.name != 'nt':
                options['exclusive'] = True
            raw_serial = serial.serial_for_url(device, do_not_open=True, **options)
            try:
                raw_serial.dtr = False
                raw_serial.rts = False
                raw_serial.open()
            except Exception:
                raw_serial.close()
                raise
            self.serial = BufferedSerial(raw_serial)
            self.is_pty = False

        def read_until(self, min_num_bytes, ending, timeout=10,
                       data_consumer=None, timeout_overall=None):
            output = bytearray()
            started = last = time.monotonic()
            overall = min(timeout_overall if timeout_overall is not None else self.operation_timeout,
                          self.operation_timeout)
            while not output.endswith(ending):
                check()
                now = time.monotonic()
                if now - started > overall or (timeout is not None and now - last > timeout):
                    break
                if self.serial.in_waiting:
                    chunk = self.serial.read(min(self.serial.in_waiting, 4096))
                    if chunk:
                        last = now
                        output.extend(chunk)
                        index = output.find(ending)
                        if index >= 0:
                            tail = index + len(ending)
                            self.serial.unread(output[tail:])
                            del output[tail:]
                        if data_consumer and (index >= 0 or len(output) > len(ending)):
                            count = len(output) if index >= 0 else len(output) - len(ending)
                            data_consumer(bytes(output[:count]))
                            del output[:count]
                            if index >= 0:
                                return ending
                        if len(output) > MAX_OUTPUT_BYTES:
                            raise ProtocolError('Device response exceeds the 4 MiB output limit; press Stop to recover the REPL.')
                else:
                    time.sleep(0.005)
            return bytes(output)

        def exec_raw_no_follow(self, command):
            command = command.encode('utf-8') if isinstance(command, str) else command
            if not self.read_until(1, b'>').endswith(b'>'):
                raise ProtocolError('Timed out waiting for the raw REPL prompt.')
            for offset in range(0, len(command), 256):
                check()
                self.serial.write(command[offset:offset + 256])
                time.sleep(0.01)
            check()
            self.serial.write(b'\x04')
            reply = bytearray()
            end = time.monotonic() + 3
            while len(reply) < 2 and time.monotonic() < end:
                check()
                reply.extend(self.serial.read(2 - len(reply)))
            if reply != b'OK':
                raise ProtocolError('Raw REPL rejected code: %r' % bytes(reply))

        def enter_raw_repl(self, soft_reset=False, timeout_overall=10):
            # Adapt /opt/homebrew/share/maixpy-k210/tools/mpremote_k210.py:
            # interrupt through a possibly still-booting CH340 without reset.
            deadline = time.monotonic() + timeout_overall
            received = bytearray()
            while time.monotonic() < deadline:
                check()
                # This fixed MaixPy UART handler toggles a pending interrupt
                # on another Ctrl-C. A pair can cancel before the VM handles
                # it, especially in the startup delay. Send one per interval.
                self.serial.write(b'\r\x03\x02\r')
                for _ in range(5):
                    check()
                    time.sleep(0.01)
                    if self.serial.in_waiting:
                        received.extend(self.serial.read(self.serial.in_waiting))
                    if b'>>>' in received:
                        break
                if b'>>>' in received:
                    break
            else:
                raise DeviceError('Timed out waiting for the K210 REPL; close other serial apps and check the baud rate.')
            self.serial.reset_input_buffer()
            super().enter_raw_repl(soft_reset=False, timeout_overall=timeout_overall)

    return K210Transport(port, baudrate=baud)


class DeviceWorker:
    METHODS = frozenset(('connect', 'listPorts', 'getState', 'disconnect', 'execute',
                         'runScript', 'stop', 'listFiles', 'readFile', 'writeFile',
                         'setPreview', 'startCamera', 'prepareFirmware',
                         'backupDevice', 'flashFirmware'))

    def __init__(self, output=None, transport_factory=None, lock_factory=None):
        self.output = output or sys.stdout
        self.output_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.state = {'phase': 'disconnected', 'busy': False, 'running': False,
                      'preview': False, 'flashCapacityVerified': False,
                      'capabilities': dict.fromkeys(
                          ('repl', 'files', 'framebuffer', 'script'), False)}
        self.transport_factory = transport_factory or open_transport
        self.lock_factory = lock_factory or PortLock
        self.transport = None
        self.port_lock = None
        self.requests = queue.PriorityQueue()
        self.sequence = 0
        self.generation = 0
        self.active_generation = 0
        self.pending = set()
        self.input_lock = threading.Lock()
        self.input_closed = False
        self.input_eof = False
        self.current_method = None
        self.deadline = None
        self.raw_stage = None
        self.stdout_decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.stderr_decoder = codecs.getincrementaldecoder('utf-8')('replace')
        self.frame_sequence = 0
        self.next_frame = 0
        self.camera_ready = False
        self.connecting_started = False
        self.baud = None
        self.session_id = None
        self.prepared_firmware = None
        self.backup_record = None
        self.flash_in_progress = False
        self.restoring_io = False
        self.firmware_module = None
        # Reading N bytes does not prove capacity: smaller SPI chips may wrap.
        # Only a future hardware JEDEC probe may populate this proof.
        self.flash_capacity_verified = False
        self.flash_capacity_proof = None
        self.pre_probe_record = None

    def emit(self, value):
        with self.output_lock:
            if self.output is None:
                return
            try:
                self.output.write(json.dumps(value, ensure_ascii=True, separators=(',', ':')) + '\n')
                self.output.flush()
            except BrokenPipeError:
                # Losing the UI must never abort a firmware write halfway.
                self.output = None

    def log(self, text, stream='system'):
        if text:
            self.emit({'event': 'log', 'data': {'text': text, 'stream': stream,
                                              'time': int(time.time() * 1000)}})

    def update(self, **changes):
        with self.state_lock:
            for key, value in changes.items():
                if value is None:
                    self.state.pop(key, None)
                else:
                    self.state[key] = value
            state = json.loads(json.dumps(self.state))
        self.emit({'event': 'state', 'data': state})
        return state

    def snapshot(self):
        with self.state_lock:
            return json.loads(json.dumps(self.state))

    def check(self):
        if not self.restoring_io and (self.active_generation != self.generation or self.input_closed):
            raise Cancelled('Operation cancelled by stop, disconnect, or worker shutdown.')
        if self.deadline and time.monotonic() > self.deadline:
            raise DeviceError('Device operation timed out.')

    def submit(self, value):
        request_id, method, args = validate_request(value)
        with self.input_lock:
            if self.flash_in_progress and method in ('stop', 'disconnect', 'connect'):
                self.emit({'id': request_id, 'error': 'Firmware writing is in progress; wait for verification before stopping or disconnecting.'})
                return
            key = (type(request_id), request_id)
            if key in self.pending:
                self.emit({'id': request_id, 'error': 'Duplicate pending request id.'})
                return
            self.pending.add(key)
            if method in ('stop', 'disconnect'):
                self.generation += 1
            self.sequence += 1
            self.requests.put((0 if method in ('stop', 'disconnect') else 1,
                               self.sequence, self.generation, request_id, method, args))

    def read_requests(self, source):
        while True:
            line = source.readline(MAX_LINE_BYTES + 1)
            if not line:
                break
            if len(line) > MAX_LINE_BYTES:
                while line and not line.endswith('\n'):
                    line = source.readline(MAX_LINE_BYTES + 1)
                self.emit({'id': None, 'error': 'Request exceeds the 4 MiB JSON-line limit.'})
                continue
            value = None
            try:
                value = json.loads(line)
                self.submit(value)
            except (ValueError, DeviceError) as exc:
                request_id = value.get('id') if isinstance(value, dict) else None
                if isinstance(request_id, bool) or not isinstance(request_id, (str, int)):
                    request_id = None
                self.emit({'id': request_id, 'error': str(exc)})
        self.input_eof = True

    def serve(self, source=None):
        self.update()
        reader = threading.Thread(target=self.read_requests, args=(source or sys.stdin,),
                                  name='nodu-json-input', daemon=True)
        reader.start()
        try:
            while not self.input_closed and (not self.input_eof or not self.requests.empty()):
                try:
                    item = self.requests.get(timeout=0.04)
                except queue.Empty:
                    try:
                        self.active_generation = self.generation
                        self.deadline = time.monotonic() + 5
                        self.poll()
                    except Cancelled:
                        pass
                    except Exception as exc:
                        self._lost(exc)
                    continue
                self.handle(item)
        finally:
            self.input_closed = True
            self.generation += 1
            if self.transport and self.state['running']:
                try:
                    self.transport.serial.write(b'\x03')
                except Exception:
                    pass
            self._close()

    def handle(self, item):
        _, _, generation, request_id, method, args = item
        self.active_generation = generation
        self.current_method = method
        timeout = {'connect': 40, 'readFile': 900, 'writeFile': 900,
                   'prepareFirmware': 180, 'backupDevice': 3600,
                   'flashFirmware': 900}.get(method, OPERATION_TIMEOUT)
        if method in ('execute', 'runScript') and isinstance(args.get('code'), str):
            timeout = min(120, self._upload_seconds(args['code'])) + OPERATION_TIMEOUT
        self.deadline = time.monotonic() + timeout
        active = method not in ('getState', 'listPorts')
        finished = False
        self.connecting_started = False
        try:
            if method not in ('stop', 'disconnect'):
                self.check()
            if active:
                self.update(busy=True, operation=method, lastError=None, progress=None)
            result = getattr(self, 'do_' + method)(args)
            if active:
                self.update(busy=False, operation=None)
                finished = True
            if method == 'connect':
                result = self.snapshot()
            self.emit({'id': request_id, 'result': result})
        except Exception as exc:
            text = str(exc) or exc.__class__.__name__
            self.emit({'id': request_id, 'error': text})
            if active:
                self.update(lastError=text)
            if method == 'connect' and self.connecting_started:
                self._close()
                self.update(phase='error', running=False, preview=False,
                            capabilities=dict.fromkeys(('repl', 'files', 'framebuffer', 'script'), False))
            elif self.transport and not isinstance(exc, Cancelled):
                # A timed out raw transaction has unknown parser position.
                # Recover with stop; do not assume it is safe to send another command.
                if isinstance(exc, ProtocolError) or 'timed out' in text.lower() or 'timeout' in text.lower():
                    self.update(phase='error')
        finally:
            if active and not finished:
                self.update(busy=False, operation=None)
            self.current_method = None
            self.deadline = None
            with self.input_lock:
                self.pending.discard((type(request_id), request_id))

    def _require(self, idle=True):
        if not self.transport:
            raise DeviceError('Connect a K210 first.')
        if idle and self.state['running']:
            raise DeviceError('Stop the running script before this operation.')
        if idle and self.state['phase'] == 'error':
            raise DeviceError('Device needs recovery; press Stop or reconnect.')

    def _code(self, args):
        code = args.get('code')
        if not isinstance(code, str) or not code.strip():
            raise DeviceError('Code must be a nonempty string.')
        if len(code.encode('utf-8')) > MAX_CODE_BYTES:
            raise DeviceError('Code exceeds the 256 KiB RAM execution limit.')
        if self._upload_seconds(code) > 120:
            raise DeviceError('Code upload would exceed 120 seconds at this baud; increase the baud rate or reduce the script.')
        return code

    def _upload_seconds(self, code):
        size = len(code.encode('utf-8'))
        return 5 + size * 10 / (self.baud or 115200) + ((size + 255) // 256) * 0.01

    def _start_raw(self, code):
        try:
            self.transport.exec_raw_no_follow(code)
        except Cancelled:
            raise
        except ProtocolError:
            self.update(phase='error')
            raise
        except Exception as exc:
            self.update(phase='error')
            raise ProtocolError(str(exc) or 'Serial code upload failed.') from exc

    def _exec(self, code, log=False, timeout=20):
        self.check()
        previous_timeout = getattr(self.transport, 'operation_timeout', OPERATION_TIMEOUT)
        self.transport.operation_timeout = timeout
        try:
            output, error = self.transport.exec_raw(code, timeout=timeout)
        except Cancelled:
            raise
        except ProtocolError:
            self.update(phase='error')
            raise
        except Exception as exc:
            self.update(phase='error')
            raise ProtocolError(str(exc) or 'Serial transaction failed.') from exc
        finally:
            self.transport.operation_timeout = previous_timeout
        self.check()
        text = output.decode('utf-8', 'replace')
        if log:
            self.log(text, 'stdout')
            self.log(error.decode('utf-8', 'replace'), 'stderr')
        if error:
            raise DeviceError(error.decode('utf-8', 'replace').strip())
        return text

    def _eval(self, expression):
        return ast.literal_eval(self._exec('print(repr(' + expression + '))').strip())

    def _stat(self, path):
        # Distinguish absent files from permission, I/O and filesystem errors.
        text = self._exec("import os\ntry:\n print(repr(tuple(os.stat(%r))))\nexcept OSError as e:\n print('ERR', e.args[0])" % path).strip()
        if text.startswith('ERR '):
            if text == 'ERR 2':
                return None
            raise DeviceError('Device stat failed: ' + text)
        return ast.literal_eval(text)

    def do_getState(self, args):
        return self.snapshot()

    def do_listPorts(self, args):
        try:
            from serial.tools import list_ports
        except ImportError as exc:
            raise DeviceError('Python dependency pyserial is missing from this Python environment.') from exc
        return [dict({'path': p.device, 'description': p.description or p.device},
                     **{key: value for key, value in (('vid', p.vid), ('pid', p.pid),
                       ('serialNumber', p.serial_number)) if value is not None})
                for p in sorted(list_ports.comports(), key=lambda p: p.device)]

    def do_connect(self, args):
        port = args.get('port')
        profile = args.get('boardProfile', 'embedfire-cam-gc2145')
        baud = args.get('baud', 115200)
        if not isinstance(port, str) or not port or len(port) > 512:
            raise DeviceError('A serial port is required.')
        if '://' in port:
            raise DeviceError('Only local serial ports are supported.')
        if profile not in ('embedfire-cam-gc2145', 'generic-k210'):
            raise DeviceError('Unknown physical board profile.')
        if isinstance(baud, bool) or not isinstance(baud, int) or not 9600 <= baud <= 3000000:
            raise DeviceError('Baud must be an integer from 9600 to 3000000.')
        if (self.transport and self.state.get('port') == port
                and self.state.get('boardProfile') == profile and self.baud == baud
                and self.state['phase'] != 'error'):
            return self.snapshot()
        self.connecting_started = True
        self._close()
        self.update(phase='connecting', port=port, boardProfile=profile,
                    running=False, preview=False, firmware=None, architecture=None,
                    flashCapacityVerified=False)
        self.port_lock = self.lock_factory(port).acquire()
        self.transport = self.transport_factory(port, baud, self.check)
        self.baud = baud
        self.session_id = uuid.uuid4().hex
        self.backup_record = None
        self.flash_capacity_verified = False
        self.flash_capacity_proof = None
        self.pre_probe_record = None
        # mpremote may print diagnostics; only our structured logs reach stdout.
        self.transport.enter_raw_repl(soft_reset=False, timeout_overall=10)
        info = self._exec('import sys, os\nprint(repr(sys.version))\nprint(repr(tuple(os.uname())))').splitlines()
        interpreter = str(ast.literal_eval(info[0])) if info else 'version unavailable'
        uname = ast.literal_eval(info[1]) if len(info) > 1 else ()
        firmware = ('%s %s (%s)' % (uname[0], uname[2], uname[3]) if len(uname) > 3
                    else 'MicroPython ' + interpreter)
        architecture = str(uname[4]) if len(uname) > 4 else str(uname)
        # Firmware architecture is diagnostic only; never replace physical profile.
        return self.update(phase='connected', firmware=firmware, architecture=architecture,
                           capabilities={'repl': True, 'files': True,
                                         'framebuffer': profile == 'embedfire-cam-gc2145',
                                         'script': True})

    def _close(self):
        transport, self.transport = self.transport, None
        try:
            if transport:
                transport.close()
        finally:
            if self.port_lock:
                self.port_lock.release()
                self.port_lock = None
        self.raw_stage = None
        self.camera_ready = False
        self.baud = None
        self.session_id = None
        self.backup_record = None
        self.pre_probe_record = None
        self.flash_capacity_verified = False
        self.flash_capacity_proof = None

    def do_disconnect(self, args):
        self.active_generation = self.generation
        if self.transport:
            try:
                self.do_stop({})
            except Exception as exc:
                self.log('Disconnect recovery: ' + str(exc))
        self._close()
        self.update(phase='disconnected', port=None, running=False, preview=False,
                    flashCapacityVerified=False,
                    capabilities=dict.fromkeys(('repl', 'files', 'framebuffer', 'script'), False))

    def do_execute(self, args):
        self._require()
        code = self._code(args)
        self.backup_record = None
        return self._exec(code, log=True)

    def do_runScript(self, args):
        self._require()
        code = self._code(args)
        self.backup_record = None
        self.check()
        self._start_raw(code)
        self.raw_stage = 'stdout'
        self.stdout_decoder.reset()
        self.stderr_decoder.reset()
        self.update(phase='running', running=True)

    def do_stop(self, args):
        self.active_generation = self.generation
        if not self.transport:
            return
        self.deadline = time.monotonic() + 8
        self.raw_stage = None
        self.transport.enter_raw_repl(soft_reset=False, timeout_overall=5)
        self.update(phase='connected', running=False, preview=False)

    def do_listFiles(self, args):
        self._require()
        path = remote_path(args.get('path', '/flash'))
        files = self._eval("[(n, tuple(os.stat(%r + '/' + n))) for n in os.listdir(%r)]" % (path, path))
        result = []
        for name, stat in files:
            name = str(name)
            if '/' in name or name in ('.', '..'):
                continue
            result.append({'name': name, 'path': posixpath.join(path, name),
                           'size': int(stat[6]), 'directory': bool(stat[0] & 0x4000)})
        return sorted(result, key=lambda entry: (not entry['directory'], entry['name']))

    def do_readFile(self, args):
        self._require()
        path = remote_path(args.get('path'))
        stat = self._stat(path)
        if stat is None:
            raise DeviceError('Device file does not exist: ' + path)
        if stat[0] & 0x4000:
            raise DeviceError('Cannot read a directory as a file.')
        if stat[6] > MAX_FILE_BYTES:
            raise DeviceError('File exceeds the 2 MiB transfer limit.')
        result = bytearray()
        self._exec('_nodu_file=open(%r,"rb")' % path)
        try:
            while True:
                self.check()
                chunk = self._eval('_nodu_file.read(512)')
                if not isinstance(chunk, bytes):
                    raise DeviceError('Invalid file response from device.')
                if not chunk:
                    break
                result.extend(chunk)
                if len(result) > MAX_FILE_BYTES:
                    raise DeviceError('File grew beyond the 2 MiB transfer limit.')
        finally:
            self._close_remote_file()
        return {'data': base64.b64encode(result).decode('ascii'), 'size': len(result)}

    def _close_remote_file(self):
        # Never send a cleanup transaction into a cancelled/unknown REPL state.
        if (self.active_generation == self.generation and not self.input_closed
                and self.state['phase'] != 'error'):
            self._exec('_nodu_file.close()\ndel _nodu_file')

    def do_writeFile(self, args):
        self._require()
        path = remote_path(args.get('path'), writing=True)
        data = decode_file(args.get('data'))
        overwrite = args.get('overwrite', False)
        if not isinstance(overwrite, bool):
            raise DeviceError('overwrite must be a boolean.')
        self.backup_record = None
        stat = self._stat(path)
        if stat is not None and (stat[0] & 0x4000):
            raise DeviceError('Cannot overwrite a directory.')
        if stat is not None and not overwrite:
            raise DeviceError('Device file already exists; explicit overwrite is required.')
        temporary = posixpath.join(posixpath.dirname(path), '.nodu-transfer-' + uuid.uuid4().hex + '.tmp')
        if self._stat(temporary) is not None:
            raise DeviceError('Transfer temporary path unexpectedly exists; retry.')
        opened = False
        try:
            self._exec('_nodu_file=open(%r,"wb")' % temporary)
            opened = True
            for offset in range(0, len(data), 512):
                chunk = data[offset:offset + 512]
                count = self._eval('_nodu_file.write(%r)' % chunk)
                if count != len(chunk):
                    raise DeviceError('Device reported a short file write.')
            self._close_remote_file()
            opened = False
            written = self._stat(temporary)
            if written is None or written[6] != len(data):
                raise DeviceError('Device transfer size verification failed.')
            # Recheck before rename, including non-overwrite races. We never
            # remove the target to make a failed rename succeed.
            if not overwrite and self._stat(path) is not None:
                raise DeviceError('Target appeared during transfer; refusing to overwrite.')
            self._exec('os.rename(%r,%r)' % (temporary, path))
        except Exception as exc:
            if opened:
                try:
                    self._close_remote_file()
                except Exception:
                    pass
            error_type = ProtocolError if isinstance(exc, ProtocolError) else (Cancelled if isinstance(exc, Cancelled) else DeviceError)
            raise error_type('%s Transfer may remain at %s; no user file was deleted.' % (exc, temporary)) from exc

    def do_setPreview(self, args):
        self._require(idle=False)
        enabled = args.get('enabled')
        if not isinstance(enabled, bool):
            raise DeviceError('enabled must be a boolean.')
        if enabled and not self.state['capabilities']['framebuffer']:
            raise DeviceError('Camera preview requires the embedfire-cam-gc2145 physical profile.')
        self.update(preview=enabled)
        self.next_frame = 0

    def do_startCamera(self, args):
        self._require()
        if self.state.get('boardProfile') != 'embedfire-cam-gc2145':
            raise DeviceError('Select the embedfire-cam-gc2145 physical board profile first.')
        # Some MaixPy builds cannot import a readable .py module from /flash.
        # Compile the existing helper into a private RAM namespace; no board
        # file is installed, modified, or added to the startup sequence.
        helper = self._stat('/flash/gc2145_board.py')
        if helper is None:
            raise DeviceError('Required /flash/gc2145_board.py is missing; install the board helper explicitly first.')
        if helper[0] & 0x4000 or not 0 < helper[6] <= 65536:
            raise DeviceError('Existing /flash/gc2145_board.py has an invalid size (maximum 64 KiB).')
        self._exec("_nodu_camera_ns={'__name__':'gc2145_board'}\n_nodu_helper_file=open('/flash/gc2145_board.py','r')\ntry:\n _nodu_helper_source=_nodu_helper_file.read(65537)\nfinally:\n _nodu_helper_file.close()\nif len(_nodu_helper_source)>65536: raise Exception('Board helper grew beyond 64 KiB')\nexec(_nodu_helper_source,_nodu_camera_ns)\ndel _nodu_helper_source\n_nodu_camera_ns['init_camera']()\nimport sensor\nsensor.skip_frames(time=1000)", log=True)
        self.camera_ready = True
        self.update(preview=True)
        self.next_frame = 0

    def _firmware(self):
        if self.firmware_module is None:
            spec = importlib.util.spec_from_file_location(
                'nodu_firmware', Path(__file__).with_name('nodu_firmware.py'))
            self.firmware_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.firmware_module)
        return self.firmware_module

    def _progress(self, stage, completed, total):
        self.update(progress={'stage': stage, 'completed': completed, 'total': total,
                              'percent': min(100, int(completed * 100 / total)) if total else 100})

    def do_prepareFirmware(self, args):
        firmware = self._firmware()
        self._progress('prepare', 0, firmware.SIZE)
        self.prepared_firmware = firmware.prepare(args.get('cacheDir'), args.get('sourceFile'),
                                                  self.check, self.log)
        self._progress('prepare', firmware.SIZE, firmware.SIZE)
        return firmware.plan()

    def _change_baud(self, baud):
        # The initial delay lets the host switch after receiving raw REPL's OK.
        # ide=False never calls ide_dbg_init2/init3 and does not touch config.
        code = ('import time\nfrom machine import UART\ntime.sleep_ms(100)\n'
                'UART.repl_uart().init(baudrate=%d,ide=False)\ntime.sleep_ms(100)' % baud)
        self._start_raw(code)
        self.transport.serial.baudrate = baud
        self.baud = baud
        output, error = self.transport.follow(timeout=5)
        if error:
            raise DeviceError('Cannot change the REPL transfer baud: ' + error.decode('utf-8', 'replace'))

    @contextlib.contextmanager
    def _fast_backup_serial(self):
        # Keep the established REPL rate: real reads at 1.5M produced malformed
        # frames on this board/adapter. Uniform blocks use bounded fill frames
        # instead of reinitializing the live firmware UART for speed.
        original_baud = self.baud or 115200
        try:
            self.log('Backup keeps ordinary raw REPL at %d baud; bounded fill frames reduce uniform-block traffic.' % original_baud)
            yield
        finally:
            # Cancellation must not prevent returning both endpoints to the
            # original baud. This bounded recovery never writes flash/files.
            old_deadline = self.deadline
            self.deadline = time.monotonic() + 20
            self.restoring_io = True
            restored = False
            try:
                for attempt in range(3):
                    try:
                        self.transport.serial.baudrate = original_baud
                        self.baud = original_baud
                        self.transport.serial.reset_input_buffer()
                        self.transport.enter_raw_repl(soft_reset=False, timeout_overall=5)
                        restored = True
                        self.log('Backup serial baud restored to %d.' % original_baud)
                        break
                    except Exception:
                        continue
            finally:
                self.restoring_io = False
                self.deadline = old_deadline
            if not restored:
                self.update(phase='error')
                raise DeviceError('Backup stopped, but REPL baud recovery failed. Reconnect at 115200 or power-cycle; no flash was written.')

    def _receive_backup(self, destination, size, code, progress):
        firmware = self._firmware()
        receiver = firmware.BackupReceiver(destination, size, progress)
        line_buffer = bytearray()
        error_buffer = bytearray()
        stage = 'stdout'
        last_data = time.monotonic()
        trace = deque(maxlen=32)
        last_line = None
        try:
            self.check()
            self._start_raw(code)
            while True:
                self.check()
                serial = self.transport.serial
                data = serial.read(min(max(serial.in_waiting, 1), 65536))
                if not data:
                    if time.monotonic() - last_data > 20:
                        raise ProtocolError('Backup transfer timed out; incomplete data was retained and flashing is blocked.')
                    continue
                last_data = time.monotonic()
                trace.append({'kind': 'read', 'bytes': len(data), 'lf': data.count(b'\n'),
                              'cr': data.count(b'\r'), 'eof': data.count(b'\x04'),
                              'interrupt': data.count(b'\x03')})
                while data:
                    before, marker, after = data.partition(b'\x04')
                    if stage == 'stdout':
                        line_buffer.extend(before)
                        while b'\n' in line_buffer:
                            line, _, remainder = line_buffer.partition(b'\n')
                            line_buffer[:] = remainder
                            if line.rstrip(b'\r'):
                                stripped = bytes(line).rstrip(b'\r')
                                last_line = backup_frame_metadata(stripped, min(firmware.CHUNK_BYTES, size - receiver.received))
                                last_line['trailingCR'] = len(line) - len(stripped)
                                trace.append({'kind': 'line', 'bytes': len(line),
                                              'frameKind': last_line['kind'],
                                              'offset': last_line.get('offset')})
                                receiver.line(stripped)
                        if len(line_buffer) > 4200:
                            raise firmware.FirmwareError('Backup line exceeded the bounded protocol size.')
                        if marker:
                            if line_buffer.strip():
                                raise firmware.FirmwareError('Incomplete backup line before raw REPL EOF.')
                            stage = 'stderr'
                    else:
                        error_buffer.extend(before)
                        if len(error_buffer) > 8192:
                            raise firmware.FirmwareError('Backup program failed with excessive diagnostics.')
                        if marker:
                            serial.unread(after)
                            if error_buffer:
                                raise firmware.FirmwareError('Device backup failed: ' + error_buffer.decode('utf-8', 'replace').strip())
                            return receiver.finish()
                    if not marker:
                        break
                    data = after
        except Cancelled:
            raise
        except Exception as exc:
            # Only bounded protocol metadata is saved. Never retain/log the
            # raw Base64, arbitrary stderr, source code or user-file content.
            diagnostic = {'version': 1, 'time': int(time.time() * 1000),
                          'session': self.session_id, 'stage': stage, 'received': receiver.received,
                          'expected': size, 'baud': self.baud,
                          'errorType': type(exc).__name__,
                          'causeType': type(exc.__cause__).__name__ if exc.__cause__ else None,
                          'lastLine': last_line,
                          'bufferedLine': backup_frame_metadata(bytes(line_buffer), min(firmware.CHUNK_BYTES, max(0, size - receiver.received))) if line_buffer else None,
                          'stderrBytes': len(error_buffer), 'trace': list(trace)}
            try:
                firmware.write_json(Path(str(destination) + '.diagnostics.json'), diagnostic)
            except Exception:
                pass  # Diagnostic storage must not replace the original failure.
            raise
        finally:
            receiver.close()

    def _receive_snapshot(self, destination, size, remote_path=None, progress=lambda received, total: None):
        """Assemble verified bounded ranges, then independently hash the source.

        A corrupt range never enters the assembled file. Failed attempts stay
        private beside the snapshot; retries retain the same serial owner and
        never reset Python, change baud or write a board file.
        """
        firmware = self._firmware()
        # Validate the complete range before creating any local output.
        firmware.dump_script(size, remote_path)
        destination = Path(destination)
        ranges = firmware.private_directory(
            str(destination) + '.ranges-' + uuid.uuid4().hex, fresh=True)
        digest = hashlib.sha256()
        failures = 0
        with firmware.private_file(destination) as assembled:
            for offset in range(0, max(size, 1), 64 * 1024):
                self.check()
                length = min(64 * 1024, size - offset)
                code = firmware.dump_script(length, remote_path, offset=offset)
                for attempt in range(3):
                    self.check()
                    part = ranges / ('%08x-%d.part' % (offset, attempt))
                    try:
                        part_digest = self._receive_backup(part, length, code,
                                                          lambda received, total: None)
                        break
                    except Cancelled:
                        raise
                    except (firmware.FirmwareError, ProtocolError):
                        failures += 1
                        self.check()
                        if attempt == 2 or failures >= 12:
                            raise
                        self.log('Snapshot range 0x%08x failed verification; retry %d/2. Failed local bytes were retained.' % (offset, attempt + 1))
                        self.transport.serial.reset_input_buffer()
                        self.transport.enter_raw_repl(soft_reset=False, timeout_overall=5)
                        self.check()
                        self.update(phase='connected')
                # Read only one bounded range, and check it again immediately
                # before appending. No failed/oversized partial is committed.
                with part.open('rb') as source:
                    data = source.read(length + 1)
                if len(data) != length or hashlib.sha256(data).hexdigest() != part_digest:
                    raise firmware.FirmwareError('Verified snapshot range changed locally; flashing is blocked.')
                assembled.write(data)
                digest.update(data)
                part.unlink()
                progress(offset + length, size)
            assembled.flush()
            os.fsync(assembled.fileno())
        expected = digest.hexdigest()
        if destination.stat().st_size != size or firmware.file_sha256(destination) != expected:
            raise firmware.FirmwareError('Assembled snapshot local SHA256 verification failed.')
        self.check()
        if remote_path is None:
            remote_digest = self._remote_flash_hash(size)
        else:
            remote_size, remote_digest = self._remote_file_hash(remote_path, size)
            if remote_size != size:
                raise firmware.FirmwareError('Source file size changed during segmented backup; flashing is blocked.')
        if remote_digest != expected:
            raise firmware.FirmwareError('Source SHA256 changed during segmented backup; flashing is blocked.')
        # Retain failed attempt files when a retry succeeded, for diagnosis.
        if not any(ranges.iterdir()):
            ranges.rmdir()
        return expected

    def _backup_inventory(self):
        firmware = self._firmware()
        entries = []

        def visit(path, depth):
            if depth > 32 or len(entries) > 5000:
                raise firmware.FirmwareError('Device file tree exceeds safe backup bounds; flashing is blocked.')
            for entry in self.do_listFiles({'path': path}):
                self.check()
                if entry['directory']:
                    entries.append(dict(entry, status='directory'))
                    visit(entry['path'], depth + 1)
                else:
                    eligible, reason = firmware.eligible_file(entry['path'])
                    if eligible and entry['size'] > firmware.MAX_USER_FILE:
                        raise firmware.FirmwareError('A program/model file exceeds the 128 MiB backup limit; flashing is blocked.')
                    entries.append(dict(entry, status='pending' if eligible else 'excluded', reason=reason))

        for mount in ('/flash', '/sd'):
            stat = self._stat(mount)
            if stat is not None:
                visit(mount, 0)
        return entries

    def _remote_flash_hash(self, size, offset=0):
        code = ('import uhashlib, ubinascii\nfrom Maix import utils\n'
                '_nodu_verify_hash=uhashlib.sha256()\n'
                'for _nodu_verify_offset in range(%d,%d,8192):\n'
                ' _nodu_verify_hash.update(utils.flash_read(_nodu_verify_offset,min(8192,%d-_nodu_verify_offset)))\n'
                'print(ubinascii.hexlify(_nodu_verify_hash.digest()).decode())' % (offset, offset + size, offset + size))
        digest = self._exec(code).strip()
        if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise DeviceError('Device returned an invalid flash SHA256.')
        return digest

    def _remote_file_hash(self, path, expected_size=0):
        code = ('import uhashlib,ubinascii\n_nodu_verify_hash=uhashlib.sha256()\n'
                '_nodu_verify_size=0\n_nodu_verify_file=open(%r,"rb")\n'
                'try:\n while True:\n  _nodu_verify_chunk=_nodu_verify_file.read(8192)\n'
                '  if not _nodu_verify_chunk: break\n'
                '  _nodu_verify_hash.update(_nodu_verify_chunk)\n'
                '  _nodu_verify_size+=len(_nodu_verify_chunk)\n'
                'finally:\n _nodu_verify_file.close()\n'
                'print(repr((_nodu_verify_size,ubinascii.hexlify(_nodu_verify_hash.digest()).decode())))' % path)
        # SD/model files can be much larger than interactive REPL commands.
        # The reader still checks cancellation and the request deadline.
        budget = max(20, min(300, expected_size / (256 * 1024) + 10))
        size, digest = ast.literal_eval(self._exec(code, timeout=budget).strip())
        if not isinstance(size, int) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise DeviceError('Invalid device file SHA256 response.')
        return size, digest

    def _remote_file_range_hash(self, path, offset, length):
        firmware = self._firmware()
        firmware.dump_script(length, path, offset)  # Same strict range bounds.
        code = ('import uhashlib,ubinascii\n_nodu_range_hash=uhashlib.sha256()\n'
                '_nodu_range_left=%d\n_nodu_range_file=open(%r,"rb")\n'
                'try:\n _nodu_range_file.seek(%d)\n while _nodu_range_left:\n'
                '  _nodu_range_chunk=_nodu_range_file.read(min(8192,_nodu_range_left))\n'
                '  if not _nodu_range_chunk: raise Exception("Unexpected range EOF")\n'
                '  _nodu_range_hash.update(_nodu_range_chunk)\n'
                '  _nodu_range_left-=len(_nodu_range_chunk)\n'
                'finally:\n _nodu_range_file.close()\n'
                'print(ubinascii.hexlify(_nodu_range_hash.digest()).decode())' % (length, path, offset))
        digest = self._exec(code).strip()
        if len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise DeviceError('Invalid device range SHA256 response.')
        return digest

    def _transfer_preflight_plan(self, directory, pending):
        """Use a prior failed offset only as a hint for a fresh bounded read.

        No historical bytes or verification flags are imported. The current
        inventory/port must match; actual identity remains unverified.
        """
        current = {entry['path']: entry for entry in pending}
        parents = list(Path(directory).parent.glob('*.pre-probe'))
        # Backend directory names begin with UTC timestamps. Bound both the
        # number and size of metadata files inspected; never read user bytes.
        for previous in sorted(parents, key=lambda value: value.name, reverse=True)[:32]:
            if previous == Path(directory) or previous.is_symlink():
                continue
            metadata = previous / 'manifest.json'
            try:
                if metadata.is_symlink() or not metadata.is_file() or metadata.stat().st_size > 2 * 1024 * 1024:
                    continue
                raw = metadata.read_bytes()
                if len(raw) > 2 * 1024 * 1024:
                    continue
                old = json.loads(raw)
                if (not isinstance(old, dict) or old.get('port') != self.state.get('port')
                        or old.get('stateSaved') is not False
                        or old.get('error') not in ('Malformed backup chunk.', 'Malformed bounded fill chunk.',
                            'Backup offset/chunk size mismatch; flashing is blocked.')):
                    continue
                files = old.get('files')
                if not isinstance(files, list) or len(files) > 5000:
                    continue
                for entry in files:
                    if not isinstance(entry, dict) or entry.get('status') != 'pending':
                        continue
                    path = entry.get('path')
                    if not isinstance(path, str) or path not in current or entry.get('size') != current[path]['size']:
                        continue
                    source_size = current[path]['size']
                    partial = previous / 'files' / path.lstrip('/')
                    if (partial.is_symlink() or not partial.resolve().is_relative_to(previous.resolve())
                            or not partial.is_file()):
                        continue
                    offset = partial.stat().st_size
                    if not 0 <= offset < source_size:
                        continue
                    return {'path': path, 'sourceBytes': source_size, 'offset': offset,
                            'length': min(65536, source_size - offset),
                            'sourceFailureManifest': str(metadata),
                            'sourceFailureManifestSha256': hashlib.sha256(raw).hexdigest(),
                            'verified': False, 'hintOnly': True}
            except (OSError, ValueError, TypeError):
                continue
        return None

    def _verify_transfer_preflight(self, directory, plan):
        """One range, no retry: strict transfer plus an independent source hash."""
        firmware = self._firmware()
        path = remote_path(plan['path'])
        offset, length, source_size = plan['offset'], plan['length'], plan['sourceBytes']
        if type(length) is not int or not 0 < length <= 65536:
            raise DeviceError('Transfer preflight exceeds its 64 KiB bound.')
        code = firmware.dump_script(length, path, offset)
        before = self._stat(path)
        if before is None or before[6] != source_size or offset + length > source_size:
            raise DeviceError('Transfer preflight source size changed.')
        target = Path(directory) / 'transfer-preflight.raw.bin'
        digest = self._receive_backup(target, length, code, lambda received, total: None)
        if self._remote_file_range_hash(path, offset, length) != digest:
            raise DeviceError('Transfer preflight source range changed; RAM probing is blocked.')
        after = self._stat(path)
        if after is None or after[6] != source_size:
            raise DeviceError('Transfer preflight source size changed.')
        self.check()
        return {'verified': True, 'session': self.session_id, 'rangeSha256': digest,
                'file': target.name, 'verifiedAt': int(time.time() * 1000),
                'capacityEvidence': False, 'completeBackup': False}

    def _preservation_cache(self, directory):
        """Locate opaque bytes for revalidation, never a capacity certificate."""
        firmware = self._firmware()
        previous_directories = sorted(Path(directory).parent.glob('*.pre-probe'),
                                      key=lambda value: value.name, reverse=True)[:32]
        candidates = []
        for previous in previous_directories:
            if previous == Path(directory) or previous.is_symlink():
                continue
            source = previous / 'manifest.json'
            try:
                if source.is_symlink() or not source.is_file() or source.stat().st_size > 2 * 1024 * 1024:
                    continue
                raw = source.read_bytes()
                if len(raw) > 2 * 1024 * 1024:
                    continue
                old = json.loads(raw)
                if (not isinstance(old, dict) or old.get('version') != 1
                        or old.get('stateSaved') is not True
                        or old.get('scope') != 'user-files-current-boot-and-unverified-flash-prefix'
                        or old.get('port') != self.state.get('port')
                        or old.get('firmware') != self.state.get('firmware')
                        or old.get('candidateFlashBytes') != firmware.FLASH_BYTES
                        or old.get('completeFlashBackup') is not False
                        or old.get('flashCapacityVerified') is not False
                        or type(old.get('createdAt')) is not int
                        or not isinstance(old.get('files'), list) or len(old['files']) > 5000):
                    continue
                candidates.append((old['createdAt'], {'directory': previous,
                    'manifest': old, 'manifestSha256': hashlib.sha256(raw).hexdigest()}))
            except (OSError, ValueError, TypeError):
                continue
        return max(candidates, key=lambda item: item[0])[1] if candidates else None

    def _cached_preservation_source(self, cache, relative, size, digest):
        if not cache or not isinstance(relative, str) or not isinstance(digest, str):
            return None
        if (len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest)
                or type(size) is not int or size < 0):
            return None
        root = cache['directory']
        relative_path = Path(relative)
        if relative_path.is_absolute() or '..' in relative_path.parts:
            return None
        source = root / relative_path
        try:
            component = root
            for part in relative_path.parts:
                component = component / part
                if component.is_symlink():
                    return None
            if (not source.resolve().is_relative_to(root.resolve())
                    or not source.is_file() or source.stat().st_size != size
                    or self._firmware().file_sha256(source) != digest):
                return None
        except OSError:
            return None
        return source

    def _copy_revalidated_preservation(self, source, destination, size, digest):
        """Commit a new private copy only after source and current hashes agree."""
        firmware = self._firmware()
        remaining = size
        with source.open('rb') as original, firmware.private_file(destination) as copied:
            while remaining:
                self.check()
                data = original.read(min(1024 * 1024, remaining))
                if not data:
                    raise DeviceError('Revalidated preservation source was truncated.')
                copied.write(data)
                remaining -= len(data)
            if original.read(1):
                raise DeviceError('Revalidated preservation source changed size.')
            copied.flush()
            os.fsync(copied.fileno())
        if firmware.file_sha256(destination) != digest:
            raise DeviceError('Revalidated preservation copy changed locally.')

    def _preserve_before_probe(self, backup_directory):
        """Save recoverable files/boot bytes before a RAM loader ends Python.

        This is deliberately not a complete flash or capacity certificate.
        Existing raw-REPL backup framing verifies every copied byte locally.
        No user file is written and no soft reset is requested here.
        """
        firmware = self._firmware()
        if not isinstance(backup_directory, str) or not os.path.isabs(backup_directory):
            raise DeviceError('An absolute managed backup directory is required before RAM probing.')
        directory = firmware.private_directory(backup_directory + '.pre-probe', fresh=True)
        manifest_path = directory / 'manifest.json'
        manifest = {'version': 1, 'createdAt': int(time.time() * 1000),
                    'port': self.state['port'], 'sessionBeforeProbe': self.session_id,
                    'firmware': self.state.get('firmware'),
                    'scope': 'user-files-current-boot-and-unverified-flash-prefix',
                    'completeFlashBackup': False, 'flashCapacityVerified': False,
                    'stateSaved': False, 'files': []}
        firmware.write_json(manifest_path, manifest)
        try:
            header = ast.literal_eval(self._exec(
                'from Maix import utils\nprint(repr(utils.flash_read(0,5)))').strip())
            if not isinstance(header, bytes) or len(header) != 5 or header[0] not in (0, 2):
                raise DeviceError('Current boot header is unsupported; RAM probing is blocked.')
            payload_size = struct.unpack('<I', header[1:5])[0]
            # This bounded prefix is validated by its embedded boot SHA. It
            # never proves the physical chip capacity or full flash coverage.
            if not 0 < payload_size <= 8 * 1024 * 1024:
                raise DeviceError('Current boot length exceeds the preservation bound; RAM probing is blocked.')
            boot_size = payload_size + 37
            manifest['files'] = self._backup_inventory()
            pending = [entry for entry in manifest['files'] if entry['status'] == 'pending']
            cache = self._preservation_cache(directory)
            cached_files = {}
            if cache:
                # Historical flags remain unchanged. Every reused byte source
                # is authenticated locally and against this live session.
                for old_entry in cache['manifest']['files']:
                    if (isinstance(old_entry, dict) and old_entry.get('status') == 'verified'
                            and isinstance(old_entry.get('path'), str)):
                        cached_files[old_entry['path']] = old_entry
                manifest['reuseSource'] = {'directory': str(cache['directory']),
                    'manifestSha256': cache['manifestSha256'], 'session': self.session_id,
                    'capacityEvidence': False}
            total = firmware.FLASH_BYTES + sum(entry['size'] for entry in pending)
            firmware.ensure_space(directory, total)
            firmware.write_json(manifest_path, manifest)
            completed = 0
            last_percent = -1

            def progress(received, expected):
                nonlocal last_percent
                percent = int((completed + received) * 100 / total) if total else 100
                if percent != last_percent:
                    last_percent = percent
                    self._progress('preserve-before-probe', completed + received, total)

            self.log('Preserving user files, current boot bytes and an unverified 16 MiB flash-prefix candidate before the RAM reader. The prefix length does not prove chip capacity or complete coverage.')
            with self._fast_backup_serial():
                preflight = self._transfer_preflight_plan(directory, pending)
                if preflight:
                    manifest['transferPreflight'] = preflight
                    firmware.write_json(manifest_path, manifest)
                    preflight.update(self._verify_transfer_preflight(directory, preflight))
                    firmware.write_json(manifest_path, manifest)
                for entry in pending:
                    self.check()
                    remote = remote_path(entry['path'])
                    local = directory / 'files' / remote.lstrip('/')
                    firmware.private_directory(str(local.parent))
                    old_entry = cached_files.get(remote, {})
                    digest = old_entry.get('sha256')
                    source = self._cached_preservation_source(cache, 'files/' + remote.lstrip('/'),
                        entry['size'], digest) if old_entry.get('size') == entry['size'] else None
                    if source and self._remote_file_hash(remote, entry['size']) == (entry['size'], digest):
                        self._copy_revalidated_preservation(source, local, entry['size'], digest)
                        entry['copySource'] = {'directory': str(cache['directory']),
                            'manifestSha256': cache['manifestSha256'], 'session': self.session_id,
                            'remoteSha256RecheckedAt': int(time.time() * 1000)}
                        progress(entry['size'], entry['size'])
                    else:
                        digest = self._receive_snapshot(local, entry['size'], remote, progress)
                    entry.update(status='verified', sha256=digest,
                                 local=str(local.relative_to(directory)))
                    completed += entry['size']
                    firmware.write_json(manifest_path, manifest)
                candidate_path = directory / 'flash-prefix-candidate.raw.bin'
                candidate_digest = cache['manifest'].get('candidateFlashSha256') if cache else None
                source = self._cached_preservation_source(cache, 'flash-prefix-candidate.raw.bin',
                    firmware.FLASH_BYTES, candidate_digest)
                if source and self._remote_flash_hash(firmware.FLASH_BYTES) == candidate_digest:
                    self._copy_revalidated_preservation(source, candidate_path, firmware.FLASH_BYTES, candidate_digest)
                    manifest['prefixCopySource'] = {'directory': str(cache['directory']),
                        'manifestSha256': cache['manifestSha256'], 'session': self.session_id,
                        'remoteSha256RecheckedAt': int(time.time() * 1000), 'capacityEvidence': False}
                    progress(firmware.FLASH_BYTES, firmware.FLASH_BYTES)
                else:
                    candidate_digest = self._receive_snapshot(candidate_path, firmware.FLASH_BYTES,
                        progress=progress)
                metadata, original_boot = firmware.boot_region(candidate_path.read_bytes())
                if metadata['bootBytes'] != boot_size or original_boot[:5] != header:
                    raise DeviceError('Boot header changed while preserving state; RAM probing is blocked.')
                boot_path = directory / 'original-boot-region.raw.bin'
                with firmware.private_file(boot_path) as stream:
                    stream.write(original_boot)
                manifest['candidateFlashBytes'] = firmware.FLASH_BYTES
                manifest['candidateFlashSha256'] = candidate_digest
                manifest['candidateFlashFile'] = candidate_path.name
                manifest.update(metadata)
                if self._remote_flash_hash(firmware.FLASH_BYTES) != candidate_digest:
                    raise DeviceError('Flash prefix changed while preserving state; RAM probing is blocked.')
                if self._remote_flash_hash(boot_size) != metadata['bootSha256']:
                    raise DeviceError('Boot bytes changed while preserving state; RAM probing is blocked.')
                self._verify_preserved_files(manifest)
                self._verify_inventory_unchanged(manifest)
            manifest['stateSaved'] = True
            manifest['bootRestore'] = {'file': boot_path.name, 'address': 0,
                                       'sha256Prefix': False, 'bytes': boot_size,
                                       'sha256': metadata['bootSha256']}
            firmware.write_json(manifest_path, manifest)
            self._progress('preserve-before-probe', total, total)
            self.log('User-file and boot preservation verified locally. RAM loading will end the current Python runtime; restarting the installed firmware may run user startup code.')
            return {'directory': str(directory), 'manifest': manifest}
        except Exception as exc:
            manifest['stateSaved'] = False
            manifest['error'] = str(exc)
            firmware.write_json(manifest_path, manifest)
            self.log('State preservation failed; no RAM reader will be loaded. Partial local copies remain at ' + str(directory), 'stderr')
            raise

    def _verify_inventory_unchanged(self, manifest):
        def shape(entries):
            return sorted((entry['path'], bool(entry['directory']), entry['size'])
                          for entry in entries)
        if shape(self._backup_inventory()) != shape(manifest['files']):
            raise DeviceError('Device file inventory changed during the operation; automatic continuation is blocked.')

    def _ensure_flash_capacity(self, backup_directory=None):
        firmware = self._firmware()
        if (self.flash_capacity_verified and self.flash_capacity_proof
                and self.flash_capacity_proof.get('capacityBytes') == firmware.FLASH_BYTES):
            return
        path = Path(__file__).with_name('nodu_flash_probe.py')
        if not path.is_file():
            raise DeviceError('Physical JEDEC capacity probe is unavailable; complete backup verification and flashing are blocked.')
        spec = importlib.util.spec_from_file_location('nodu_flash_probe', path)
        module = importlib.util.module_from_spec(spec)
        sys.modules['nodu_flash_probe'] = module
        spec.loader.exec_module(module)
        module.validate_build()  # Authenticate the pinned image before I/O.
        self.check()
        # The source-built reader replaces the Python runtime. Its availability
        # alone never authorizes dropping the only recoverable state.
        preserved = self._preserve_before_probe(backup_directory)
        self.check()
        port = self.state['port']
        session_before_probe = self.session_id
        request_nonce = uuid.uuid4().hex
        self.flash_capacity_verified = False
        self.flash_capacity_proof = None
        self.backup_record = None
        self.update(preview=False, flashCapacityVerified=False)
        self._progress('probe-flash-capacity', 0, 1)
        self.log('Loading the source-built RAM identity reader. Its command set reads flash identity only; the return reboot can run installed user startup code.')
        transport, self.transport = self.transport, None
        proof = None
        try:
            transport.close()
            # PortLock remains held while the probe temporarily owns pyserial.
            proof = module.probe(port, check=self.check, log=self.log,
                                 nonce=request_nonce, session=session_before_probe)
        finally:
            # The probe resets back to the installed firmware. Recover the
            # ordinary REPL even when a user cancels this read-only operation.
            previous_deadline = self.deadline
            self.deadline = time.monotonic() + 25
            self.restoring_io = True
            try:
                self.transport = self.transport_factory(port, 115200, self.check)
                self.baud = 115200
                self.transport.enter_raw_repl(soft_reset=False, timeout_overall=10)
                self.camera_ready = False
                self.raw_stage = None
                self.session_id = uuid.uuid4().hex
                self.update(phase='connected', running=False, flashCapacityVerified=False)
            except Exception as exc:
                self.update(phase='error', running=False, flashCapacityVerified=False)
                raise DeviceError('Read-only capacity probe finished, but reconnecting the installed firmware failed: ' + str(exc)) from exc
            finally:
                self.restoring_io = False
                self.deadline = previous_deadline
        self.check()
        if not isinstance(proof, dict) or proof.get('verified') is not True:
            raise DeviceError('Physical JEDEC capacity was not verified; flashing remains blocked.')
        if (proof.get('probePort') != port
                or proof.get('sessionBeforeProbe') != session_before_probe
                or proof.get('requestNonce') != request_nonce
                or proof.get('stubSha256') != module.STUB_SHA256):
            raise DeviceError('Flash identity proof does not match this request, port, session and reviewed reader; flashing remains blocked.')
        self.flash_capacity_proof = proof
        if proof.get('capacityBytes') != firmware.FLASH_BYTES:
            raise DeviceError('Physical JEDEC reports %s bytes. This backup workflow currently supports only 16777216-byte chips; flashing is blocked.' % proof.get('capacityBytes'))
        # A restarted firmware is outside the reader's no-write boundary.
        # Any startup-induced change stops automatic continuation and retains
        # the pre-probe local originals; never silently restore over new data.
        manifest = preserved['manifest']
        self._verify_preserved_files(manifest)
        self._verify_inventory_unchanged(manifest)
        if self._remote_flash_hash(manifest['bootBytes']) != manifest['bootSha256']:
            raise DeviceError('Installed boot bytes changed after the RAM reader; flashing is blocked.')
        if (manifest['candidateFlashBytes'] != proof['capacityBytes']
                or self._remote_flash_hash(proof['capacityBytes']) != manifest['candidateFlashSha256']):
            raise DeviceError('Flash contents differ from the pre-probe candidate; automatic flashing is blocked. Preserve both states for review.')
        self.pre_probe_record = preserved
        self.flash_capacity_verified = True
        self.update(flashCapacityVerified=True)
        self._progress('probe-flash-capacity', 1, 1)
        self.log('Physical JEDEC %s verified: %d bytes.' % (proof.get('jedecId'), proof['capacityBytes']))

    def _verify_preserved_files(self, manifest):
        files = [entry for entry in manifest['files'] if entry['status'] == 'verified']
        self._progress('verify-preserved-files', 0, len(files))
        for index, entry in enumerate(files):
            self.check()
            path = remote_path(entry['path'])
            stat = self._stat(path)
            if stat is None or stat[0] & 0x4000 or stat[6] != entry['size']:
                raise DeviceError('Post-flash file is missing or changed size: ' + path)
            size, digest = self._remote_file_hash(path, entry['size'])
            if size != entry['size'] or digest != entry['sha256']:
                raise DeviceError('Post-flash file SHA256 changed: ' + path)
            self._progress('verify-preserved-files', index + 1, len(files))
        self.log('All %d backed-up files verified unchanged by size and device SHA256.' % len(files))
        return len(files)

    def do_backupDevice(self, args):
        self._require()
        firmware = self._firmware()
        self._ensure_flash_capacity(args.get('backupDir'))
        directory = firmware.private_directory(args.get('backupDir'), fresh=True)
        self.backup_record = None
        self.update(preview=False)
        created = int(time.time() * 1000)
        manifest = {'version': 1, 'verified': False, 'createdAt': created,
                    'port': self.state['port'], 'boardProfile': self.state['boardProfile'],
                    'firmware': self.state.get('firmware'), 'architecture': self.state.get('architecture'),
                    'session': self.session_id, 'flashBytes': firmware.FLASH_BYTES,
                    'flashCapacityVerified': self.flash_capacity_verified,
                    'flashCapacityProof': self.flash_capacity_proof,
                    'preProbePreservation': self.pre_probe_record,
                    'files': [], 'note': 'Complete Flash plus all regular /flash and /sd files are private opaque recovery copies. Contents may include user data; no file content is decoded, logged, or transmitted off this computer.'}
        manifest_path = directory / 'manifest.json'
        firmware.write_json(manifest_path, manifest)
        try:
            self.log('Preparing complete 16 MiB flash and opaque copies of all regular /flash and /sd files; no board files will be modified.')
            manifest['files'] = self._backup_inventory()
            pending = [entry for entry in manifest['files'] if entry['status'] == 'pending']
            user_bytes = sum(entry['size'] for entry in pending)
            firmware.ensure_space(directory, user_bytes)
            total = firmware.FLASH_BYTES + user_bytes
            firmware.write_json(manifest_path, manifest)
            self._exec('import uhashlib,ubinascii\nfrom Maix import utils\nprint(ubinascii.hexlify(uhashlib.sha256(b"test").digest()).decode())')
            completed = 0
            last_percent = -1

            def progress(received, expected):
                nonlocal last_percent
                percent = int((completed + received) * 100 / total) if total else 100
                if percent != last_percent:
                    last_percent = percent
                    self._progress('backup', completed + received, total)
                    self.log('Backup %d%% (%d/%d bytes).' % (percent, completed + received, total))

            full_path = directory / 'full-flash.raw.bin'
            with self._fast_backup_serial():
                manifest['flashSha256'] = self._receive_snapshot(full_path, firmware.FLASH_BYTES,
                    progress=progress)
                completed += firmware.FLASH_BYTES
                # Header verification uses the complete host read-back image.
                metadata, original_boot = firmware.boot_region(full_path.read_bytes())
                manifest.update(metadata)
                self.log('Full flash SHA256 and original K210 boot header verified.')
                for entry in pending:
                    self.check()
                    # Inventory paths are validated POSIX paths, with no '..'.
                    remote = remote_path(entry['path'])
                    local = directory / 'files' / remote.lstrip('/')
                    firmware.private_directory(str(local.parent))
                    digest = self._receive_snapshot(local, entry['size'], remote, progress)
                    entry.update(status='verified', sha256=digest,
                                 local=str(local.relative_to(directory)))
                    completed += entry['size']
                    firmware.write_json(manifest_path, manifest)
                # Re-read the entire identified address range after copying
                # files. A stable boot region alone cannot certify a stable
                # full-chip snapshot.
                if self._remote_flash_hash(firmware.FLASH_BYTES) != manifest['flashSha256']:
                    raise DeviceError('Device flash contents changed during backup; flashing is blocked.')
                if self._remote_flash_hash(metadata['bootBytes']) != metadata['bootSha256']:
                    raise DeviceError('Device boot bytes changed during backup; flashing is blocked.')
                self._verify_preserved_files(manifest)
                self._verify_inventory_unchanged(manifest)
                manifest['snapshotVerification'] = {
                    'fullFlashSecondReadSha256': manifest['flashSha256'],
                    'filesVerified': len(pending), 'inventoryUnchanged': True,
                    'verifiedAt': int(time.time() * 1000)}
            self._progress('verify-backup', 0, 1)
            if not self.flash_capacity_verified or not self.flash_capacity_proof:
                manifest['candidateSnapshot'] = True
                manifest['flashCapacityVerified'] = False
                manifest['note'] += ' The 16 MiB read-back is only a candidate snapshot until physical JEDEC capacity is verified; smaller chips can wrap addresses.'
                raise DeviceError('Physical flash capacity has not been verified by JEDEC. The 16 MiB candidate snapshot may wrap and cannot authorize flashing. Candidate files remain at ' + str(directory))
            firmware.make_restore_packages(directory, full_path, original_boot)
            manifest['restore'] = {'boot': [sys.executable, '-m', 'kflash', '-p', self.state['port'], '-b', '1500000', str(directory / 'boot-restore.kfpkg')],
                                   'full': [sys.executable, '-m', 'kflash', '-p', self.state['port'], '-b', '1500000', str(directory / 'full-flash-restore.kfpkg')],
                                   'sha256Prefix': False, 'address': 0}
            manifest['verified'] = True
            firmware.write_json(manifest_path, manifest)
            self.backup_record = {'directory': str(directory), 'manifest': manifest,
                                  'fullPath': str(full_path), 'session': self.session_id}
            self._progress('backup-complete', total, total)
            self.log('Complete backup verified; restore packages and manifest saved privately on this computer.')
            return {'directory': str(directory), 'flashSha256': manifest['flashSha256'],
                    'flashBytes': firmware.FLASH_BYTES, 'verified': True,
                    'flashCapacityVerified': True,
                    'flashJedecId': self.flash_capacity_proof.get('jedecId'),
                    'createdAt': created, 'files': len(pending)}
        except Exception as exc:
            manifest['verified'] = False
            manifest['error'] = str(exc)
            firmware.write_json(manifest_path, manifest)
            self.backup_record = None
            self.log('Backup incomplete; flashing is blocked. Partial backup remains at ' + str(directory), 'stderr')
            raise

    def do_flashFirmware(self, args):
        self._require()
        firmware = self._firmware()
        if (not self.flash_capacity_verified or not self.flash_capacity_proof
                or self.flash_capacity_proof.get('capacityBytes') != firmware.FLASH_BYTES):
            raise DeviceError('Flashing is blocked until the actual flash JEDEC capacity is verified; a 16 MiB read-back alone is not proof.')
        record = self.backup_record
        if not self.prepared_firmware:
            raise DeviceError('Prepare and verify the pinned official firmware before flashing.')
        firmware.validate_image(self.prepared_firmware)
        if (not record or args.get('backupDir') != record['directory']
                or record['session'] != self.session_id or not record['manifest'].get('verified')):
            raise DeviceError('A complete verified backup of the current connection is required before flashing.')
        manifest = record['manifest']
        if not manifest.get('flashCapacityVerified') or manifest.get('flashCapacityProof') != self.flash_capacity_proof:
            raise DeviceError('This backup has no matching hardware flash-capacity proof; take a new verified backup.')
        self._progress('verify-backup', 0, 3)
        full_path, metadata = firmware.validate_backup(record['directory'], manifest,
            lambda completed, total: (self.check(), self._progress('verify-local-recovery-files', completed, total)))
        if str(full_path) != str(Path(record['fullPath']).resolve()):
            raise DeviceError('Full-flash recovery path no longer matches this backup.')
        self._progress('verify-backup', 1, 3)
        if self._remote_flash_hash(manifest['bootBytes']) != manifest['bootSha256']:
            self.backup_record = None
            raise DeviceError('Current device boot bytes do not match the verified backup; take a fresh backup.')
        if self._remote_flash_hash(firmware.FLASH_BYTES) != manifest['flashSha256']:
            self.backup_record = None
            raise DeviceError('Current device flash contents do not match the verified backup; take a fresh backup.')
        self._verify_preserved_files(manifest)
        self._verify_inventory_unchanged(manifest)
        self._progress('verify-backup', 3, 3)
        port = self.state['port']
        profile = self.state['boardProfile']
        original_baud = self.baud or 115200
        with self.input_lock:
            self.check()
            self.flash_in_progress = True
        self.update(preview=False, running=False)
        self.log('Writing the pinned official BIN at address 0 with its K210 SHA256 prefix; full-chip erase is disabled. Stop is unavailable until verification completes.')
        try:
            # Keep the process PortLock while kflash owns the physical serial FD.
            old_transport, self.transport = self.transport, None
            old_transport.close()

            def flash_log(text):
                self.log(text)

            firmware.flash_image(self.prepared_firmware, port, flash_log, self._progress)
            self._progress('reconnect', 0, 1)
            self.transport = self.transport_factory(port, original_baud, self.check)
            self.baud = original_baud
            self.transport.enter_raw_repl(soft_reset=False, timeout_overall=15)
            info = self._exec('import os\nprint(repr(tuple(os.uname())))').strip()
            uname = ast.literal_eval(info)
            identity = '%s %s (%s)' % (uname[0], uname[2], uname[3])
            self.update(phase='connected', port=port, boardProfile=profile,
                        firmware=identity, architecture=str(uname[4]))
            self._progress('verify-written-flash', 0, firmware.WRITE_BYTES)
            self._exec('from Maix import utils')
            header = self._eval('utils.flash_read(0,5)')
            if not isinstance(header, bytes) or header[0] not in (0x00, 0x02) or struct.unpack('<I', header[1:5])[0] != firmware.SIZE:
                raise DeviceError('Written firmware boot header does not match the pinned image.')
            payload_digest = self._remote_flash_hash(firmware.SIZE, 5)
            if payload_digest != firmware.SHA256:
                raise DeviceError('Read-back firmware payload SHA256 does not match the official image.')
            image = Path(self.prepared_firmware).read_bytes()
            expected_prefix_digest = hashlib.sha256(header + image).digest()
            expected_boot_digest = hashlib.sha256(header + image + expected_prefix_digest).hexdigest()
            if self._remote_flash_hash(firmware.WRITE_BYTES) != expected_boot_digest:
                raise DeviceError('Read-back firmware boot-region SHA256 verification failed.')
            preserved_files = self._verify_preserved_files(manifest)
            self._verify_inventory_unchanged(manifest)
            manifest['flashVerification'] = {'verified': True, 'payloadSha256': payload_digest,
                'bootSha256': expected_boot_digest, 'preservedFiles': preserved_files,
                'verifiedAt': int(time.time() * 1000)}
            firmware.write_json(Path(record['directory']) / 'manifest.json', manifest)
            self.backup_record = None
            self.session_id = uuid.uuid4().hex
            self._progress('flash-verified', firmware.WRITE_BYTES, firmware.WRITE_BYTES)
            self.log('Firmware boot-region/payload SHA256 and all backed-up user files verified; user startup files were not written.')
            return {'verified': True, 'firmware': identity,
                    'backupDirectory': record['directory'], 'sha256': payload_digest}
        except Exception as exc:
            self.update(phase='error', running=False, preview=False)
            manifest['flashVerification'] = {'verified': False, 'error': str(exc),
                                              'verifiedAt': int(time.time() * 1000)}
            try:
                firmware.write_json(Path(record['directory']) / 'manifest.json', manifest)
            except OSError:
                self.log('Could not update verification metadata; original backup files remain in the recovery directory.', 'stderr')
            self.log('Firmware operation failed. The verified backup and restore packages remain at ' + record['directory'], 'stderr')
            raise DeviceError('%s Recovery backup: %s; use boot-restore.kfpkg (address 0, sha256Prefix=false), without erase.' % (exc, record['directory'])) from exc
        finally:
            with self.input_lock:
                self.flash_in_progress = False

    def _poll_raw(self):
        serial = self.transport.serial
        if not serial.in_waiting:
            return
        chunk = serial.read(min(serial.in_waiting, 32768))
        while chunk and self.raw_stage:
            before, marker, after = chunk.partition(b'\x04')
            decoder = self.stdout_decoder if self.raw_stage == 'stdout' else self.stderr_decoder
            self.log(decoder.decode(before, final=bool(marker)), self.raw_stage)
            if not marker:
                return
            if self.raw_stage == 'stdout':
                self.raw_stage = 'stderr'
            else:
                self.raw_stage = None
                serial.unread(after)
                self.update(phase='connected', running=False)
                return
            chunk = after

    def _poll_frame(self):
        # A raw REPL owns the serial parser during user scripts. Idle capture
        # uses the same serialized transport and actual sensor JPEG bytes.
        # This safe path does not toggle UART IDE mode or ide_mode.conf.
        result = self._exec('import sensor, ubinascii\n_nodu_image=sensor.snapshot()\n_nodu_jpeg=_nodu_image.compress(quality=35)\nprint(ubinascii.b2a_base64(_nodu_jpeg.to_bytes()).decode().strip())').strip()
        data = decode_file(result)
        width, height = jpeg_dimensions(data)
        self.frame_sequence += 1
        self.emit({'event': 'frame', 'data': {'mime': 'image/jpeg',
                  'data': base64.b64encode(data).decode('ascii'),
                  'width': width, 'height': height, 'sequence': self.frame_sequence,
                  'time': int(time.time() * 1000)}})

    def poll(self):
        if not self.transport or self.state['phase'] == 'error':
            return
        if self.raw_stage:
            self._poll_raw()
        elif self.state['preview'] and self.camera_ready and time.monotonic() >= self.next_frame:
            self.next_frame = time.monotonic() + 0.4
            try:
                self._poll_frame()
            except Cancelled:
                raise
            except Exception as exc:
                changes = {'preview': False, 'lastError': str(exc)}
                if isinstance(exc, ProtocolError) or 'timeout' in str(exc).lower() or 'timed out' in str(exc).lower():
                    changes['phase'] = 'error'
                self.update(**changes)
                self.log('Camera preview stopped: ' + str(exc), 'stderr')

    def _lost(self, exc):
        text = str(exc) or exc.__class__.__name__
        try:
            self._close()
        finally:
            self.update(phase='error', running=False, preview=False, lastError=text)
            self.log(text, 'stderr')


class StructuredDiagnostics:
    """Keep dependency print() diagnostics away from the JSON stdout stream."""
    def __init__(self, worker):
        self.worker = worker

    def write(self, text):
        self.worker.log(text, 'system')
        return len(text)

    def flush(self):
        pass


def main():
    worker = DeviceWorker(output=sys.stdout)
    # mpremote prints raw-handshake failures on stdout. Capture those as logs.
    with contextlib.redirect_stdout(StructuredDiagnostics(worker)):
        try:
            worker.serve()
        except KeyboardInterrupt:
            pass
        except BrokenPipeError:
            pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
