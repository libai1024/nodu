# SPDX-License-Identifier: MIT
"""Synthetic transfer diagnostics/preflight contracts; never opens a port."""
import base64
import binascii
from collections import deque
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest import mock


RESOURCES = Path(__file__).resolve().parents[1] / 'resources'


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, RESOURCES / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


firmware = load('transfer_diagnostics_firmware', 'nodu_firmware.py')
worker_module = load('transfer_diagnostics_worker', 'nodu_device_worker.py')


class FragmentSerial:
    """A byte queue with configurable read boundaries, not a board emulator."""
    def __init__(self, data, fragments, on_read=None):
        self.data = bytearray(data)
        self.fragments = deque(fragments)
        self.on_read = on_read
        self.reads = 0

    @property
    def in_waiting(self):
        return min(len(self.data), self.fragments[0] if self.fragments else len(self.data))

    def read(self, size):
        limit = self.fragments.popleft() if self.fragments else size
        result = bytes(self.data[:min(size, limit)])
        del self.data[:len(result)]
        self.reads += 1
        if self.on_read:
            self.on_read(self.reads)
        if not result:
            raise AssertionError('Synthetic test wire exhausted without a protocol outcome')
        return result


def data_line(offset, data):
    return b'NODU_DATA %08x:' % offset + base64.b64encode(data) + b'\r\n'


def successful_frames(payload):
    lines = [data_line(offset, payload[offset:offset + firmware.CHUNK_BYTES])
             for offset in range(0, len(payload), firmware.CHUNK_BYTES)]
    return b''.join(lines) + b'NODU_SHA256 ' + hashlib.sha256(payload).hexdigest().encode() + b'\r\n\x04\x04>tail'


class TransferDiagnosticsTests(unittest.TestCase):
    def peer(self, data, fragments=(), on_read=None):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.firmware_module = firmware
        worker.baud = 115200
        worker.state.update(phase='connected', port='/dev/synthetic-transfer-only')
        worker.session_id = 'synthetic-current-session'
        wire = FragmentSerial(data, fragments, on_read)
        worker.transport = types.SimpleNamespace(serial=worker_module.BufferedSerial(wire))
        worker._start_raw = mock.Mock()
        return worker, wire

    def diagnostic(self, destination):
        path = Path(str(destination) + '.diagnostics.json')
        value = json.loads(path.read_text())
        self.assertEqual(value['version'], 1)
        self.assertLessEqual(len(value['trace']), 32)
        for entry in value['trace']:
            self.assertIn(entry['kind'], ('read', 'line'))
            self.assertIsInstance(entry['bytes'], int)
            allowed = {'kind', 'bytes', 'lf', 'cr', 'eof', 'interrupt'} if entry['kind'] == 'read' else {'kind', 'bytes', 'frameKind', 'offset'}
            self.assertTrue(set(entry) <= allowed)
            if entry['kind'] == 'read':
                for marker in ('lf', 'cr', 'eof', 'interrupt'):
                    self.assertIsInstance(entry[marker], int)
                    self.assertGreaterEqual(entry[marker], 0)
                    self.assertLessEqual(entry[marker], entry['bytes'])
        if os.name != 'nt':
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        return value

    def assert_redacted(self, value, *secrets):
        serialized = json.dumps(value, sort_keys=True)
        for secret in secrets:
            if isinstance(secret, bytes):
                secret = secret.decode('ascii')
            self.assertNotIn(secret, serialized)
        forbidden = {'payload', 'raw', 'text', 'line', 'sourceCode', 'stderr', 'error'}

        def visit(item):
            if isinstance(item, dict):
                self.assertFalse(forbidden.intersection(item))
                for child in item.values():
                    visit(child)
            elif isinstance(item, list):
                for child in item:
                    visit(child)
        visit(value)

    def test_metadata_limits_invalid_positions_and_never_contains_encoded_payload(self):
        private = b'ONLY_SYNTHETIC_PRIVATE_FIXTURE'
        encoded = base64.b64encode(private)
        invalid = b'\r\n\x00\x7f\x80!' * 4
        line = b'NODU_DATA 0000007b:' + encoded + invalid
        value = worker_module.backup_frame_metadata(line, 2581)
        self.assertEqual(value['kind'], 'data')
        self.assertEqual(value['bytes'], len(line))
        self.assertEqual(value['offset'], 123)
        self.assertEqual(value['encodedBytes'], len(encoded + invalid))
        self.assertEqual(value['expectedEncodedBytes'], 3444)
        self.assertEqual(value['invalidCount'], len(invalid))
        self.assertEqual(len(value['invalid']), 16)
        self.assertEqual([entry['position'] for entry in value['invalid']],
                         list(range(len(encoded), len(encoded) + 16)))
        self.assertEqual([entry['kind'] for entry in value['invalid'][:6]],
                         ['cr', 'lf', 'control', 'control', 'non-ascii', 'non-base64-ascii'])
        self.assertTrue(all(set(entry) == {'position', 'kind'} for entry in value['invalid']))
        self.assert_redacted(value, private, encoded)

    def test_metadata_classifies_frames_without_echoing_hash_or_control_text(self):
        secret = b'UNRELATED_SYNTHETIC_TEXT'
        cases = ((b'NODU_FILL 00000000:ff:8', 'fill'),
                 (b'NODU_SHA256 ' + b'a' * 64, 'sha256'),
                 (b'raw REPL; ' + secret, 'repl-control'),
                 (secret, 'other'))
        for line, kind in cases:
            with self.subTest(kind=kind):
                value = worker_module.backup_frame_metadata(line, 8)
                self.assertEqual(value['kind'], kind)
                self.assertEqual(value['bytes'], len(line))
                self.assert_redacted(value, secret, b'a' * 64)

    def test_serial_fragmentation_coalescing_and_eof_preserve_exact_payload_and_prompt(self):
        payload = bytes(range(256)) * 19 + b'synthetic tail'
        frames = successful_frames(payload)
        patterns = ((len(frames),), (1,) * len(frames),
                    (2, 17, 3, 4096, 1, 7, 509, 31, 2000, 13))
        for index, fragments in enumerate(patterns):
            with self.subTest(pattern=index), tempfile.TemporaryDirectory() as directory:
                worker, _ = self.peer(frames, fragments)
                destination = Path(directory) / 'snapshot.bin'
                digest = worker._receive_backup(destination, len(payload), 'synthetic script', lambda *args: None)
                self.assertEqual(digest, hashlib.sha256(payload).hexdigest())
                self.assertEqual(destination.read_bytes(), payload)
                prompt = bytearray()
                while len(prompt) < 5:
                    prompt.extend(worker.transport.serial.read(5 - len(prompt)))
                self.assertEqual(bytes(prompt), b'>tail')
                self.assertFalse(Path(str(destination) + '.diagnostics.json').exists())
                worker._start_raw.assert_called_once_with('synthetic script')
                self.assertFalse(worker.flash_capacity_verified)
                self.assertIsNone(worker.backup_record)

    def test_excess_base64_padding_is_rejected_and_only_metadata_is_saved(self):
        private = b'SYNTHETIC_PADDING_FIXTURE_ONLY!!'
        encoded = base64.b64encode(private)
        # The source has explicit padding, followed by another alphabet-valid
        # padding byte; strict decoding must fail even with invalidCount=0.
        self.assertTrue(encoded.endswith(b'='))
        line = b'NODU_DATA 00000000:' + encoded + b'='
        worker, _ = self.peer(line + b'\r\n\x04\x04>', (1,) * (len(line) + 2))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'partial.bin'
            with self.assertRaises(firmware.FirmwareError) as failure:
                worker._receive_backup(destination, len(private), 'synthetic script', lambda *args: None)
            value = self.diagnostic(destination)
            self.assertEqual(value['stage'], 'stdout')
            self.assertEqual((value['received'], value['expected']), (0, len(private)))
            self.assertEqual(value['errorType'], 'FirmwareError')
            self.assertEqual(value['causeType'], type(failure.exception.__cause__).__name__)
            self.assertEqual(value['lastLine']['invalidCount'], 0)
            self.assertGreater(value['lastLine']['encodedBytes'], value['lastLine']['expectedEncodedBytes'])
            self.assertEqual(len(value['trace']), 32)
            self.assert_redacted(value, private, encoded, line)
            self.assertEqual(destination.stat().st_size, 0)

    def test_raw_eof_in_middle_of_line_retains_partial_without_leaking_buffer(self):
        payload = bytes(range(256)) * 12
        tail = base64.b64encode(b'SYNTHETIC_UNFINISHED_TAIL')
        stream = data_line(0, payload) + b'NODU_DATA 00000c00:' + tail[:17] + b'\x04'
        worker, _ = self.peer(stream, (len(stream),))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'partial.bin'
            with self.assertRaisesRegex(firmware.FirmwareError, 'Incomplete backup line'):
                worker._receive_backup(destination, len(payload) + 99, 'synthetic script', lambda *args: None)
            value = self.diagnostic(destination)
            self.assertEqual(value['stage'], 'stdout')
            self.assertEqual(value['received'], len(payload))
            self.assertEqual(value['bufferedLine']['kind'], 'data')
            self.assertEqual(value['bufferedLine']['offset'], len(payload))
            self.assertEqual(destination.read_bytes(), payload)
            self.assert_redacted(value, tail[:17])

    def test_eof_without_final_digest_is_not_a_success(self):
        payload = b'SYNTHETIC_COMPLETE_DATA_WITHOUT_FINAL_HASH'
        worker, _ = self.peer(data_line(0, payload) + b'\x04\x04>')
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'partial.bin'
            with self.assertRaisesRegex(firmware.FirmwareError, 'SHA256'):
                worker._receive_backup(destination, len(payload), 'synthetic script', lambda *args: None)
            value = self.diagnostic(destination)
            self.assertEqual(value['stage'], 'stderr')
            self.assertEqual(value['received'], len(payload))
            self.assert_redacted(value, payload, base64.b64encode(payload))

    def test_cancellation_retains_partial_but_never_writes_failure_sidecar(self):
        payload = bytes(range(256)) * 12
        first = data_line(0, payload)
        worker, wire = self.peer(first + b'x', (len(first), 1))
        wire.on_read = lambda count: setattr(worker, 'generation', worker.generation + 1) if count == 1 else None
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'partial.bin'
            with self.assertRaises(worker_module.Cancelled):
                worker._receive_backup(destination, len(payload) + 1, 'synthetic script', lambda *args: None)
            self.assertEqual(destination.read_bytes(), payload)
            self.assertFalse(Path(str(destination) + '.diagnostics.json').exists())

    def test_diagnostic_storage_failure_cannot_replace_original_transfer_error(self):
        for storage_error in (OSError('synthetic storage failure'), firmware.FirmwareError('synthetic storage failure'), RuntimeError('synthetic storage failure')):
            with self.subTest(storage=type(storage_error).__name__), tempfile.TemporaryDirectory() as directory:
                worker, _ = self.peer(b'NODU_DATA 00000000:!!!!\n')
                destination = Path(directory) / 'partial.bin'
                with mock.patch.object(firmware, 'write_json', side_effect=storage_error):
                    with self.assertRaisesRegex(firmware.FirmwareError, 'Malformed backup chunk') as failure:
                        worker._receive_backup(destination, 1, 'synthetic script', lambda *args: None)
                self.assertIsInstance(failure.exception.__cause__, ValueError)
                self.assertIsNot(failure.exception, storage_error)

    def prior_failure(self, parent, name='20261019-001.pre-probe', path='/sd/fixture.bin',
                      source_size=200000, partial_size=98304, **changes):
        previous = Path(parent) / name
        previous.mkdir(mode=0o700)
        partial = previous / 'files' / path.lstrip('/')
        partial.parent.mkdir(parents=True, mode=0o700)
        with partial.open('wb') as stream:
            stream.truncate(partial_size)
        manifest = {'port': '/dev/synthetic-transfer-only', 'stateSaved': False,
                    'error': 'Malformed backup chunk.',
                    'files': [{'path': path, 'size': source_size,
                               'directory': False, 'status': 'pending'}]}
        manifest.update(changes)
        metadata = previous / 'manifest.json'
        firmware.write_json(metadata, manifest)
        return metadata, partial

    def test_preflight_plan_reads_only_metadata_and_produces_bounded_unverified_hint(self):
        worker, _ = self.peer(b'')
        pending = [{'path': '/sd/fixture.bin', 'size': 200000, 'status': 'pending'}]
        with tempfile.TemporaryDirectory() as directory:
            metadata, partial = self.prior_failure(directory)
            expected_hash = hashlib.sha256(metadata.read_bytes()).hexdigest()
            read_bytes = Path.read_bytes
            reads = []

            def metadata_only(path):
                self.assertEqual(path.name, 'manifest.json', 'Historical partial content must not be read')
                reads.append(path)
                return read_bytes(path)

            with mock.patch.object(Path, 'read_bytes', metadata_only):
                plan = worker._transfer_preflight_plan(Path(directory) / 'current.pre-probe', pending)
            self.assertEqual(reads, [metadata])
            self.assertEqual(plan['path'], '/sd/fixture.bin')
            self.assertEqual(plan['sourceBytes'], 200000)
            self.assertEqual(plan['offset'], partial.stat().st_size)
            self.assertEqual(plan['length'], 65536)
            self.assertLessEqual(plan['offset'] + plan['length'], plan['sourceBytes'])
            self.assertEqual(plan['sourceFailureManifest'], str(metadata))
            self.assertEqual(plan['sourceFailureManifestSha256'], expected_hash)
            self.assertFalse(plan['verified'])
            self.assertTrue(plan['hintOnly'])
            self.assertFalse(worker.flash_capacity_verified)
            self.assertIsNone(worker.flash_capacity_proof)
            self.assertIsNone(worker.backup_record)

    def test_preflight_plan_rejects_unmatched_successful_or_out_of_bounds_history(self):
        cases = ({'port': '/dev/different-synthetic-port'}, {'stateSaved': True},
                 {'error': 'unrelated failure'}, {'source_size': 200001},
                 {'path': '/sd/different.bin'}, {'partial_size': 200000},
                 {'partial_size': 200001},
                 {'files': [{'path': '/sd/fixture.bin', 'size': 200000, 'status': 'verified'}]})
        for index, changes in enumerate(cases):
            with self.subTest(case=index), tempfile.TemporaryDirectory() as directory:
                worker, _ = self.peer(b'')
                self.prior_failure(directory, **changes)
                plan = worker._transfer_preflight_plan(Path(directory) / 'current.pre-probe',
                    [{'path': '/sd/fixture.bin', 'size': 200000, 'status': 'pending'}])
                self.assertIsNone(plan)

    def test_preflight_plan_limits_search_to_latest_32_metadata_files(self):
        worker, _ = self.peer(b'')
        with tempfile.TemporaryDirectory() as directory:
            oldest, _ = self.prior_failure(directory, name='000.pre-probe', source_size=8, partial_size=2)
            for index in range(1, 33):
                self.prior_failure(directory, name='%03d.pre-probe' % index,
                                   source_size=8, partial_size=2, port='/dev/unmatched')
            reads, read_bytes = [], Path.read_bytes

            def read_metadata(path):
                reads.append(path)
                return read_bytes(path)

            with mock.patch.object(Path, 'read_bytes', read_metadata):
                plan = worker._transfer_preflight_plan(Path(directory) / 'current.pre-probe',
                    [{'path': '/sd/fixture.bin', 'size': 8, 'status': 'pending'}])
            self.assertIsNone(plan)
            self.assertEqual(len(reads), 32)
            self.assertNotIn(oldest, reads)

    @unittest.skipIf(os.name == 'nt', 'Symlink contract exercised on the POSIX development host')
    def test_preflight_plan_does_not_follow_history_or_partial_symlinks(self):
        for mode in ('directory', 'manifest', 'partial', 'partial-parent'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                parent = Path(directory) / 'history'
                parent.mkdir()
                outside = Path(directory) / 'outside'
                outside.mkdir()
                metadata, partial = self.prior_failure(parent, source_size=8, partial_size=2)
                if mode == 'directory':
                    moved = outside / metadata.parent.name
                    metadata.parent.rename(moved)
                    (parent / moved.name).symlink_to(moved, target_is_directory=True)
                elif mode == 'manifest':
                    moved = outside / metadata.name
                    metadata.rename(moved)
                    metadata.symlink_to(moved)
                elif mode == 'partial':
                    moved = outside / partial.name
                    partial.rename(moved)
                    partial.symlink_to(moved)
                else:
                    moved = outside / 'sd'
                    partial.parent.rename(moved)
                    partial.parent.symlink_to(moved, target_is_directory=True)
                worker, _ = self.peer(b'')
                self.assertIsNone(worker._transfer_preflight_plan(parent / 'current.pre-probe',
                    [{'path': '/sd/fixture.bin', 'size': 8, 'status': 'pending'}]))

    def preflight_peer(self, payload=None):
        source = bytes(range(256)) * 40 if payload is None else payload
        plan = {'path': '/sd/fixture.bin', 'sourceBytes': len(source),
                'offset': 157, 'length': 4097, 'verified': False, 'hintOnly': True}
        selected = source[plan['offset']:plan['offset'] + plan['length']]
        worker, _ = self.peer(successful_frames(selected), (7, 23, 509, 1, 4096))
        worker._stat = mock.Mock(return_value=(0x8000, 0, 0, 0, 0, 0, len(source)))
        worker._remote_file_range_hash = mock.Mock(return_value=hashlib.sha256(selected).hexdigest())
        worker._receive_backup = mock.Mock(wraps=worker._receive_backup)
        return worker, plan, selected

    def test_preflight_verifies_one_fresh_range_and_hash_without_certifying_capacity_or_backup(self):
        worker, plan, selected = self.preflight_peer()
        plan['session'] = 'obsolete-history-session'
        with tempfile.TemporaryDirectory() as directory:
            result = worker._verify_transfer_preflight(directory, plan)
            self.assertTrue(result['verified'])
            self.assertEqual(result['session'], worker.session_id)
            self.assertEqual(result['rangeSha256'], hashlib.sha256(selected).hexdigest())
            self.assertEqual((Path(directory) / result['file']).read_bytes(), selected)
            worker._receive_backup.assert_called_once()
            worker._remote_file_range_hash.assert_called_once_with(plan['path'], plan['offset'], plan['length'])
            self.assertEqual(worker._stat.call_args_list, [mock.call(plan['path']), mock.call(plan['path'])])
            self.assertFalse(result['capacityEvidence'])
            self.assertFalse(result['completeBackup'])
            self.assertFalse(plan['verified'])
            self.assertFalse(worker.flash_capacity_verified)
            self.assertIsNone(worker.flash_capacity_proof)
            self.assertIsNone(worker.backup_record)

    def test_preflight_bad_strict_transfer_never_retries_or_runs_independent_hash(self):
        worker, plan, _ = self.preflight_peer()
        worker.transport.serial = worker_module.BufferedSerial(FragmentSerial(
            b'NODU_DATA 00000000:!!!!\n', (100,)))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(firmware.FirmwareError):
                worker._verify_transfer_preflight(directory, plan)
            worker._receive_backup.assert_called_once()
            worker._remote_file_range_hash.assert_not_called()
            self.assertFalse(worker.flash_capacity_verified)
            self.assertIsNone(worker.backup_record)
            self.diagnostic(Path(directory) / 'transfer-preflight.raw.bin')

    def test_preflight_source_hash_or_stat_changes_cannot_return_verified(self):
        for changed in ('hash', 'size-before', 'size-after'):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as directory:
                worker, plan, _ = self.preflight_peer()
                good = (0x8000, 0, 0, 0, 0, 0, plan['sourceBytes'])
                bad = (*good[:6], plan['sourceBytes'] + 1)
                if changed == 'hash':
                    worker._remote_file_range_hash.return_value = '0' * 64
                else:
                    worker._stat.side_effect = [bad] if changed == 'size-before' else [good, bad]
                with self.assertRaises(worker_module.DeviceError):
                    worker._verify_transfer_preflight(directory, plan)
                self.assertEqual(worker._receive_backup.call_count, 0 if changed == 'size-before' else 1)
                self.assertFalse(worker.flash_capacity_verified)
                self.assertIsNone(worker.backup_record)

    def test_preflight_invalid_ranges_fail_before_transfer(self):
        for field, value in (('length', 0), ('length', -1), ('length', 65537),
                             ('length', True), ('offset', -1), ('offset', True)):
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as directory:
                worker, plan, _ = self.preflight_peer()
                plan[field] = value
                with self.assertRaises((worker_module.DeviceError, firmware.FirmwareError)):
                    worker._verify_transfer_preflight(directory, plan)
                worker._receive_backup.assert_not_called()
                worker._remote_file_range_hash.assert_not_called()

    def test_independent_range_hash_executes_a_readonly_bounded_seek(self):
        source = bytes(range(256)) * 100
        offset, length = 131, 8199
        worker, _ = self.peer(b'')
        opened = []

        def open_readonly(path, mode):
            self.assertEqual((path, mode), ('/sd/fixture.bin', 'rb'))
            stream = io.BytesIO(source)
            opened.append(stream)
            return stream

        def execute(code):
            output = io.StringIO()
            with mock.patch.dict(sys.modules, {'uhashlib': hashlib, 'ubinascii': binascii}), contextlib.redirect_stdout(output):
                exec(code, {'open': open_readonly})
            return output.getvalue()

        worker._exec = mock.Mock(side_effect=execute)
        digest = worker._remote_file_range_hash('/sd/fixture.bin', offset, length)
        self.assertEqual(digest, hashlib.sha256(source[offset:offset + length]).hexdigest())
        self.assertEqual(len(opened), 1)
        self.assertTrue(opened[0].closed)
        worker._exec.assert_called_once()


if __name__ == '__main__':
    unittest.main()
