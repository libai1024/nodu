# SPDX-License-Identifier: MIT
"""Hardware-free worker contract tests: python -m unittest discover -s test -p 'worker*_test.py'."""
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock


WORKER_PATH = Path(__file__).resolve().parents[1] / 'resources' / 'nodu_device_worker.py'
SPEC = importlib.util.spec_from_file_location('nodu_worker', WORKER_PATH)
worker_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker_module)


def messages(worker):
    return [json.loads(line) for line in worker.output.getvalue().splitlines()]


class LocalExecutionPeer:
    """Execute board snippets in a temporary host directory, without serial I/O.

    This exercises real byte roundtrips, stat and rename semantics instead of
    reproducing the worker's file API in a mock. Tests only pass temporary paths.
    """
    def __init__(self):
        self.namespace = {}
        self.commands = []

    def exec_raw(self, code, timeout=10):
        self.commands.append(code)
        output = io.StringIO()
        try:
            with contextlib.redirect_stdout(output):
                exec(code, self.namespace)
        except Exception as exc:
            return output.getvalue().encode(), ('%s: %s' % (type(exc).__name__, exc)).encode()
        return output.getvalue().encode(), b''


class K210PendingInterruptSerial:
    """Small fake of the fixed UART pending-exception toggle, not a board emulator."""
    def __init__(self, interrupt_enabled_at=0, on_sleep=lambda: None):
        self.now = 0.0
        self.interrupt_enabled_at = interrupt_enabled_at
        self.on_sleep = on_sleep
        self.dtr = self.rts = True
        self.baudrate = 115200
        self.data = bytearray()
        self.uart_received = bytearray()
        self.writes = []
        self.pending = False
        self.consume_at = None
        self.running = True
        self.toggle_clears = 0
        self.closed = False

    def open(self):
        pass

    def close(self):
        self.closed = True

    def sleep(self, duration):
        self.now += duration
        self.on_sleep()
        if self.pending and self.now >= self.consume_at:
            self.pending = False
            self.running = False
            self.data.extend(b'KeyboardInterrupt\r\n>>> ')

    @property
    def in_waiting(self):
        return len(self.data)

    def read(self, count):
        data = bytes(self.data[:count])
        del self.data[:count]
        return data

    def reset_input_buffer(self):
        self.data.clear()

    def write(self, data):
        self.writes.append((self.now, data))
        for byte in data:
            # The real UART receives bytes before main enables interrupt_char.
            self.uart_received.append(byte)
            if byte == 3 and self.now >= self.interrupt_enabled_at:
                if self.running:
                    self.pending = not self.pending
                    if not self.pending:
                        self.toggle_clears += 1
                    self.consume_at = self.now + 0.015 if self.pending else None
                else:
                    self.data.extend(b'\r\n>>> ')
            elif byte == 1 and not self.running:
                self.data.extend(b'raw REPL; CTRL-B to exit\r\n>')
            elif byte == 4:
                raise AssertionError('Handshake must never send Ctrl-D / soft reset')
        return len(data)


class WorkerContractTests(unittest.TestCase):
    def make_worker(self):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.transport = LocalExecutionPeer()
        worker.state.update(phase='connected')
        return worker

    def test_json_process_handles_malformed_requests_and_finite_input(self):
        payload = '\n'.join(('not json', '[]', '{"id":true,"method":"getState"}',
                             '{"id":"missing","method":"__dict__"}',
                             '{"id":1,"method":"getState"}',
                             '{"id":2,"method":"getState","args":[]}')) + '\n'
        result = subprocess.run([sys.executable, str(WORKER_PATH)], input=payload,
                                text=True, capture_output=True, timeout=5, check=True)
        records = [json.loads(line) for line in result.stdout.splitlines()]
        replies = [record for record in records if 'id' in record]
        self.assertEqual(len(replies), 6)
        self.assertEqual(next(r['result']['phase'] for r in replies if r['id'] == 1), 'disconnected')
        self.assertEqual(sum('error' in r for r in replies), 5)
        self.assertNotIn('Traceback', result.stdout)

    def test_protected_paths_rejected_before_any_device_write(self):
        worker = self.make_worker()
        for path in ('main.py', '/flash/boot.py', '/sd/BOOT.PY', '/flash/a/../boot.py'):
            with self.subTest(path=path), self.assertRaises(worker_module.DeviceError):
                worker.do_writeFile({'path': path, 'data': 'YQ==', 'overwrite': True})
        self.assertEqual(worker.transport.commands, [])

    def test_file_binary_roundtrip_and_explicit_overwrite(self):
        worker = self.make_worker()
        contents = bytes(range(256)) * 5 + '中文\x00行\n'.encode()
        encoded = base64.b64encode(contents).decode()
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'sample.bin')
            worker.do_writeFile({'path': path, 'data': encoded})
            result = worker.do_readFile({'path': path})
            self.assertEqual(base64.b64decode(result['data']), contents)
            self.assertEqual(result['size'], len(contents))
            with self.assertRaisesRegex(worker_module.DeviceError, 'explicit overwrite'):
                worker.do_writeFile({'path': path, 'data': 'Yg=='})
            self.assertEqual(Path(path).read_bytes(), contents)
            worker.do_writeFile({'path': path, 'data': '', 'overwrite': True})
            self.assertEqual(Path(path).read_bytes(), b'')
            self.assertEqual(list(Path(directory).glob('.nodu-transfer-*')), [])

    def test_transfer_failure_keeps_target_and_reports_temporary_path(self):
        worker = self.make_worker()
        original_exec = worker.transport.exec_raw

        def fail_rename(code, timeout=10):
            if code.startswith('os.rename('):
                return b'', b'OSError: simulated rename failure'
            return original_exec(code, timeout)

        worker.transport.exec_raw = fail_rename
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'existing.bin'
            path.write_bytes(b'user data')
            with self.assertRaisesRegex(worker_module.DeviceError, r'Transfer may remain at .+\.tmp'):
                worker.do_writeFile({'path': str(path), 'data': 'bmV3', 'overwrite': True})
            self.assertEqual(path.read_bytes(), b'user data')
            temporary = list(Path(directory).glob('.nodu-transfer-*'))
            self.assertEqual(len(temporary), 1)
            self.assertEqual(temporary[0].read_bytes(), b'new')

    def test_payload_limits_and_base64_are_checked_before_upload(self):
        worker = self.make_worker()
        for value in ('%%%', 'abc', 'YQ==\n', 'A' * (4 * ((worker_module.MAX_FILE_BYTES + 2) // 3) + 4)):
            with self.subTest(length=len(value)), self.assertRaises(worker_module.DeviceError):
                worker.do_writeFile({'path': '/flash/data.bin', 'data': value})
        self.assertEqual(worker.transport.commands, [])
        self.assertEqual(len(worker_module.decode_file(base64.b64encode(b'x' * worker_module.MAX_FILE_BYTES).decode())), worker_module.MAX_FILE_BYTES)

    def test_file_size_limit_uses_stat_before_open(self):
        worker = self.make_worker()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'large.bin'
            with path.open('wb') as stream:
                stream.truncate(worker_module.MAX_FILE_BYTES + 1)
            with self.assertRaisesRegex(worker_module.DeviceError, '2 MiB'):
                worker.do_readFile({'path': str(path)})
            self.assertFalse(any('_nodu_file=open' in code for code in worker.transport.commands))

    def test_idle_stdout_demultiplexes_eof_without_losing_next_prompt(self):
        class FakeSerial:
            def __init__(self):
                self.data = bytearray('hello中'.encode() + b'\x04error\x04>')

            @property
            def in_waiting(self):
                return len(self.data)

            def read(self, count):
                result = bytes(self.data[:count])
                del self.data[:count]
                return result

        worker = self.make_worker()
        worker.transport.serial = worker_module.BufferedSerial(FakeSerial())
        worker.raw_stage = 'stdout'
        worker.state.update(phase='running', running=True)
        worker._poll_raw()
        logs = [r['data'] for r in messages(worker) if r.get('event') == 'log']
        self.assertEqual([(r['stream'], r['text']) for r in logs], [('stdout', 'hello中'), ('stderr', 'error')])
        self.assertFalse(worker.state['running'])
        self.assertEqual(worker.transport.serial.read(1), b'>')

    def test_standard_jpeg_dimensions_and_corrupt_envelopes(self):
        # SOF0 with one component, 320x240; dimension parser deliberately
        # does not claim to decode entropy data (the UI decodes the JPEG).
        jpeg = b'\xff\xd8\xff\xc0\x00\x0b\x08\x00\xf0\x01\x40\x01\x01\x11\x00\xff\xd9'
        self.assertEqual(worker_module.jpeg_dimensions(jpeg), (320, 240))
        for data in (b'\xfe' + jpeg + b'\xfe', b'\xff\xd8bogus\xff\xd9',
                     jpeg[:-2], jpeg.replace(b'\x00\x0b', b'\xff\xff'),
                     jpeg.replace(b'\x01\x40', b'\x00\x00')):
            with self.subTest(data=data), self.assertRaises(worker_module.DeviceError):
                worker_module.jpeg_dimensions(data)

    def test_expired_deadline_prevents_serial_command(self):
        worker = self.make_worker()
        worker.deadline = time.monotonic() - 1
        with self.assertRaisesRegex(worker_module.DeviceError, 'timed out'):
            worker.do_execute({'code': 'print(42)'})
        self.assertEqual(worker.transport.commands, [])

    def test_transport_sets_inactive_lines_before_open_and_upload_is_interruptible(self):
        try:
            import serial
        except ImportError:
            self.skipTest('pyserial is not installed in this Python environment')

        class ClosedSerial:
            def __init__(self):
                self.dtr = self.rts = True
                self.data = bytearray(b'>')
                self.writes = []
                self.opened_with = None

            def open(self):
                self.opened_with = (self.dtr, self.rts)

            def close(self):
                pass

            @property
            def in_waiting(self):
                return len(self.data)

            def read(self, count):
                data = bytes(self.data[:count])
                del self.data[:count]
                return data

            def write(self, data):
                self.writes.append(data)

        closed = ClosedSerial()

        def check():
            if closed.writes:
                raise worker_module.Cancelled('upload interrupted')

        with mock.patch.object(serial, 'serial_for_url', return_value=closed) as factory:
            transport = worker_module.open_transport('/dev/worker-test', 115200, check)
        self.assertEqual(closed.opened_with, (False, False))
        self.assertTrue(factory.call_args.kwargs['do_not_open'])
        if os.name != 'nt':
            self.assertTrue(factory.call_args.kwargs['exclusive'])
        with self.assertRaisesRegex(worker_module.Cancelled, 'upload interrupted'):
            transport.exec_raw_no_follow('x' * 2048)
        self.assertEqual(closed.writes, [b'x' * 256])

    def test_buffered_serial_baudrate_assignment_reaches_real_serial(self):
        class PhysicalSerial:
            baudrate = 115200

        physical = PhysicalSerial()
        buffered = worker_module.BufferedSerial(physical)
        buffered.baudrate = 1500000
        self.assertEqual(physical.baudrate, 1500000)
        self.assertEqual(buffered.baudrate, 1500000)
        buffered.baudrate = 115200
        self.assertEqual(physical.baudrate, 115200)

    def test_k210_single_interrupt_retries_allow_pending_exception_to_be_consumed(self):
        try:
            import serial
            from mpremote.transport_serial import SerialTransport
        except ImportError:
            self.skipTest('Pinned serial dependencies are not installed')
        cancelled_pair = K210PendingInterruptSerial()
        cancelled_pair.write(b'\r\x03\x03\x02\r')
        cancelled_pair.sleep(0.05)
        self.assertTrue(cancelled_pair.running)
        self.assertFalse(cancelled_pair.pending)
        self.assertEqual(cancelled_pair.toggle_clears, 1)
        self.assertNotIn(b'>>>', cancelled_pair.data)

        peer = K210PendingInterruptSerial(interrupt_enabled_at=0.11)
        parent_enter = SerialTransport.enter_raw_repl
        with mock.patch.object(serial, 'serial_for_url', return_value=peer), \
                mock.patch.object(worker_module.time, 'monotonic', side_effect=lambda: peer.now), \
                mock.patch.object(worker_module.time, 'sleep', side_effect=peer.sleep), \
                mock.patch.object(SerialTransport, 'enter_raw_repl', autospec=True,
                                  side_effect=parent_enter) as parent:
            transport = worker_module.open_transport('/dev/synthetic-k210-only', 115200, lambda: None)
            # Even a caller's True must not make the parent send a soft reset.
            transport.enter_raw_repl(soft_reset=True, timeout_overall=1)
            parent.assert_called_once_with(transport, soft_reset=False, timeout_overall=1)
            self.assertTrue(transport.in_raw_repl)
            transport.close()
        bursts = [(when, data) for when, data in peer.writes if data == b'\r\x03\x02\r']
        self.assertGreaterEqual(len(bursts), 3)
        self.assertTrue(all(later[0] - earlier[0] >= 0.049
                            for earlier, later in zip(bursts, bursts[1:])))
        self.assertEqual([data for _, data in peer.writes[-2:]], [b'\r\x03', b'\r\x01'])
        self.assertEqual(peer.toggle_clears, 0)
        self.assertTrue(peer.closed)
        self.assertNotIn(b'\x03\x03', b''.join(data for _, data in peer.writes))
        self.assertNotIn(b'\x04', b''.join(data for _, data in peer.writes))

    def test_cancelled_k210_connect_closes_fake_serial_and_releases_owner(self):
        try:
            import serial
            from mpremote.transport_serial import SerialTransport
        except ImportError:
            self.skipTest('Pinned serial dependencies are not installed')
        worker = worker_module.DeviceWorker(output=io.StringIO())
        owner = mock.Mock()
        owner.acquire.return_value = owner
        worker.lock_factory = mock.Mock(return_value=owner)
        peer = K210PendingInterruptSerial(interrupt_enabled_at=1)
        peer.on_sleep = lambda: setattr(worker, 'generation', 1) if peer.now >= 0.06 else None
        with mock.patch.object(serial, 'serial_for_url', return_value=peer), \
                mock.patch.object(worker_module.time, 'monotonic', side_effect=lambda: peer.now), \
                mock.patch.object(worker_module.time, 'sleep', side_effect=peer.sleep), \
                mock.patch.object(SerialTransport, 'enter_raw_repl') as parent:
            worker.handle((0, 0, 0, 'synthetic-cancel', 'connect',
                           {'port': '/dev/synthetic-k210-only'}))
        parent.assert_not_called()
        self.assertTrue(peer.closed)
        owner.release.assert_called_once()
        self.assertIsNone(worker.transport)
        self.assertIsNone(worker.port_lock)
        self.assertTrue(peer.writes)
        self.assertTrue(all(data == b'\r\x03\x02\r' for _, data in peer.writes))
        self.assertIn('cancelled', next(r['error'] for r in messages(worker)
                                      if r.get('id') == 'synthetic-cancel').lower())

    def test_worker_shutdown_uses_only_one_interrupt(self):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        transport = mock.Mock()
        worker.transport = transport
        worker.state['running'] = True
        worker.input_eof = True
        worker.serve(io.StringIO(''))
        transport.serial.write.assert_called_once_with(b'\x03')
        transport.close.assert_called_once()

    def test_stop_cancels_active_and_older_queued_requests(self):
        worker = self.make_worker()
        entered = threading.Event()
        stopped = threading.Event()

        class InterruptibleTransport:
            def __init__(self):
                self.serial = self
                self.writes = []

            def exec_raw(self, code, timeout=10):
                entered.set()
                end = time.monotonic() + 3
                while time.monotonic() < end:
                    worker.check()
                    time.sleep(0.005)
                raise AssertionError('stop did not interrupt the operation')

            def write(self, data):
                self.writes.append(data)

            def enter_raw_repl(self, soft_reset, timeout_overall):
                self.soft_reset = soft_reset
                stopped.set()

        worker.transport = InterruptibleTransport()
        worker.submit({'id': 1, 'method': 'execute', 'args': {'code': 'blocking()'}})
        thread = threading.Thread(target=worker.handle, args=(worker.requests.get(),))
        thread.start()
        self.assertTrue(entered.wait(1))
        worker.submit({'id': 2, 'method': 'execute', 'args': {'code': 'never_send()'}})
        worker.submit({'id': 3, 'method': 'stop'})
        thread.join(1)
        self.assertFalse(thread.is_alive())
        worker.handle(worker.requests.get())
        self.assertTrue(stopped.is_set())
        worker.handle(worker.requests.get())
        replies = {r['id']: r for r in messages(worker) if 'id' in r}
        self.assertIn('cancelled', replies[1]['error'])
        self.assertIn('cancelled', replies[2]['error'])
        self.assertIsNone(replies[3]['result'])
        self.assertFalse(worker.transport.soft_reset)
        self.assertEqual(worker.transport.writes, [])  # enter_raw_repl owns the interrupt.
        self.assertFalse(worker.state['preview'])

    def test_duplicate_pending_id_is_not_executed_twice(self):
        worker = self.make_worker()
        request = {'id': 'same', 'method': 'getState'}
        worker.submit(request)
        worker.submit(request)
        self.assertEqual(worker.requests.qsize(), 1)
        self.assertIn('Duplicate', messages(worker)[0]['error'])

    def test_unplug_and_unfinished_protocol_errors_block_subsequent_commands(self):
        for failure in (OSError('device unplugged'), worker_module.ProtocolError('response too large')):
            worker = self.make_worker()
            worker.transport = mock.Mock()
            worker.transport.exec_raw.side_effect = failure
            worker.submit({'id': 1, 'method': 'execute', 'args': {'code': 'print(1)'}})
            worker.handle(worker.requests.get())
            self.assertEqual(worker.state['phase'], 'error')
            worker.submit({'id': 2, 'method': 'execute', 'args': {'code': 'print(2)'}})
            worker.handle(worker.requests.get())
            self.assertEqual(worker.transport.exec_raw.call_count, 1)
            replies = {r['id']: r for r in messages(worker) if 'id' in r}
            self.assertIn('needs recovery', replies[2]['error'])

    def test_completed_remote_exception_keeps_the_session_usable(self):
        worker = self.make_worker()
        worker.transport = mock.Mock()
        worker.transport.exec_raw.return_value = (b'', b'ValueError: intentional test')
        worker.submit({'id': 1, 'method': 'execute', 'args': {'code': 'raise ValueError()'}})
        worker.handle(worker.requests.get())
        self.assertEqual(worker.state['phase'], 'connected')
        worker.transport.exec_raw.return_value = (b'42\n', b'')
        self.assertEqual(worker.do_execute({'code': 'print(42)'}), '42\n')

    def test_large_script_gets_wire_upload_budget_in_addition_to_execution_budget(self):
        worker = self.make_worker()
        worker.baud = 115200
        remaining = []

        def upload(code):
            remaining.append(worker.deadline - time.monotonic())

        worker.transport = mock.Mock()
        worker.transport.exec_raw_no_follow.side_effect = upload
        worker.submit({'id': 1, 'method': 'runScript', 'args': {'code': '#' + 'x' * (worker_module.MAX_CODE_BYTES - 1)}})
        worker.handle(worker.requests.get())
        self.assertEqual(len(remaining), 1)
        self.assertGreater(remaining[0], 50)
        self.assertLess(remaining[0], 150)
        self.assertTrue(worker.state['running'])

    def test_process_lock_released_by_process_death_and_aliases_match(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = worker_module.PortLock('/dev/tty.worker-test', directory).acquire()
            self.assertEqual(owner.path, worker_module.PortLock('/dev/cu.worker-test', directory).path)
            script = ("import importlib.util,sys;"
                      "s=importlib.util.spec_from_file_location('w',sys.argv[1]);"
                      "w=importlib.util.module_from_spec(s);s.loader.exec_module(w);"
                      "w.PortLock('/dev/cu.worker-test',sys.argv[2]).acquire()")
            blocked = subprocess.run([sys.executable, '-c', script, str(WORKER_PATH), directory],
                                     text=True, capture_output=True, timeout=5)
            self.assertNotEqual(blocked.returncode, 0)
            self.assertIn('owned by another', blocked.stderr)
            owner.release()
            available = subprocess.run([sys.executable, '-c', script, str(WORKER_PATH), directory],
                                       text=True, capture_output=True, timeout=5)
            self.assertEqual(available.returncode, 0, available.stderr)
            # The child exited without explicit release; OS lock is now free.
            worker_module.PortLock('/dev/cu.worker-test', directory).acquire().release()


if __name__ == '__main__':
    unittest.main()
