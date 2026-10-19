# SPDX-License-Identifier: MIT
import base64
import binascii
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import struct
import sys
import tempfile
import types
import unittest
from unittest import mock
import warnings
import zipfile

RESOURCES = Path(__file__).resolve().parents[1] / 'resources'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


firmware = load('firmware_test_subject', RESOURCES / 'nodu_firmware.py')
worker_module = load('worker_firmware_subject', RESOURCES / 'nodu_device_worker.py')


class FirmwareTests(unittest.TestCase):
    def _snapshot_peer(self, payload, transform=None):
        """Run real generated scripts and strict receivers over an in-memory wire."""
        class Wire:
            baudrate = 115200

            def __init__(self):
                self.data = bytearray()
                self.resets = 0
                self.writes = []

            @property
            def in_waiting(self):
                return len(self.data)

            def read(self, size):
                result = bytes(self.data[:min(size, 509)])
                del self.data[:len(result)]
                return result

            def reset_input_buffer(self):
                self.data.clear()
                self.resets += 1

            def write(self, data):
                self.writes.append(data)
                return len(data)

        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.firmware_module = firmware
        worker.baud = 115200
        worker.state.update(phase='connected', port='/dev/synthetic-only')
        worker.port_lock = object()
        wire, offsets, attempts = Wire(), [], {}
        transport = types.SimpleNamespace(serial=worker_module.BufferedSerial(wire),
                                          enter_raw_repl=mock.Mock())

        def execute(code):
            # exec_raw_no_follow consumes the previous raw prompt before the
            # generated program starts; model that separately from recovery.
            transport.serial.pending.clear()
            wire.data.clear()
            is_file = '_nodu_backup_file=open(' in code
            expression = r'_nodu_backup_file\.seek\((\d+)\)' if is_file else r'utils\.flash_read\((\d+)\+'
            offset = int(re.search(expression, code).group(1))
            offsets.append(offset)
            attempts[offset] = attempts.get(offset, 0) + 1
            output = io.StringIO()
            modules = {'Maix': types.SimpleNamespace(utils=types.SimpleNamespace(
                           flash_read=lambda start, size: payload[start:start + size])),
                       'ubinascii': binascii, 'uhashlib': hashlib}

            def open_source(path, mode):
                self.assertEqual(path, '/sd/synthetic-only.bin')
                self.assertEqual(mode, 'rb')
                return io.BytesIO(payload)

            with mock.patch.dict(sys.modules, modules), contextlib.redirect_stdout(output):
                exec(code, {'open': open_source})
            frames = output.getvalue().encode('ascii')
            if transform:
                frames = transform(frames, offset, attempts[offset])
            wire.data.extend(frames + b'\x04\x04>')

        transport.exec_raw_no_follow = execute
        worker.transport = transport
        worker._remote_flash_hash = mock.Mock(return_value=hashlib.sha256(payload).hexdigest())
        worker._remote_file_hash = mock.Mock(return_value=(len(payload), hashlib.sha256(payload).hexdigest()))
        return types.SimpleNamespace(worker=worker, wire=wire, transport=transport,
                                     offsets=offsets, attempts=attempts, owner=worker.port_lock)

    def _restore_fixture(self, directory):
        payload = b'original recovery fixture' * 8
        header = b'\x02' + struct.pack('<I', len(payload))
        boot = header + payload + hashlib.sha256(header + payload).digest()
        full = boot.ljust(firmware.FLASH_BYTES, b'\xff')
        path = Path(directory) / 'full-flash.raw.bin'
        path.write_bytes(full)
        metadata, _ = firmware.boot_region(full)
        manifest = dict(metadata, verified=True, flashBytes=len(full), files=[],
                        flashSha256=hashlib.sha256(full).hexdigest())
        firmware.make_restore_packages(directory, path, boot)
        return path, boot, manifest

    def test_pinned_write_range_is_only_the_boot_image_and_sector_padding(self):
        self.assertEqual(firmware.SIZE, 2116288)
        self.assertEqual(firmware.WRITE_BYTES, 2116325)
        self.assertEqual(firmware.SECTOR_END, 0x205000)
        self.assertEqual(firmware.plan()['address'], 0)
        self.assertEqual(firmware.SHA256, '6dde2d59adc344ee0c7f96300528b4feff5e36c160f5cc0066016389394f15fa')

    def test_cache_requires_pinned_hash_and_never_downloads_when_valid(self):
        payload = b'official test bytes'
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.bin'
            source.write_bytes(payload)
            cache = Path(directory) / 'cache'
            with mock.patch.object(firmware, 'SIZE', len(payload)), mock.patch.object(firmware, 'SHA256', hashlib.sha256(payload).hexdigest()), mock.patch.object(firmware.urllib.request, 'urlopen') as download:
                prepared = firmware.prepare(str(cache), str(source))
                self.assertEqual(prepared.read_bytes(), payload)
                self.assertEqual(firmware.prepare(str(cache)), prepared)
                download.assert_not_called()
                prepared.write_bytes(b'x' * len(payload))
                with self.assertRaisesRegex(firmware.FirmwareError, 'cache is invalid'):
                    firmware.prepare(str(cache), str(source))
                self.assertEqual(prepared.read_bytes(), b'x' * len(payload))
            if os.name != 'nt':
                self.assertEqual(cache.stat().st_mode & 0o777, 0o700)
                self.assertEqual(prepared.stat().st_mode & 0o777, 0o600)

    def test_download_hash_failure_retains_other_cache_files_and_removes_own_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            unrelated = Path(directory) / 'keep.bin'
            unrelated.write_bytes(b'user data')
            with mock.patch.object(firmware, 'SIZE', 3), mock.patch.object(firmware, 'SHA256', hashlib.sha256(b'abc').hexdigest()), mock.patch.object(firmware.urllib.request, 'urlopen', return_value=io.BytesIO(b'bad')):
                with self.assertRaisesRegex(firmware.FirmwareError, 'SHA256'):
                    firmware.prepare(directory)
            self.assertEqual(unrelated.read_bytes(), b'user data')
            self.assertEqual(sorted(p.name for p in Path(directory).iterdir()), ['keep.bin'])

    def test_dio_boot_header_verifies_hash_and_rejects_tampered_or_unbounded_length(self):
        payload = b'firmware' * 512
        header = b'\x02' + struct.pack('<I', len(payload))
        boot = header + payload + hashlib.sha256(header + payload).digest()
        metadata, region = firmware.boot_region(boot + b'\xff' * 1024)
        self.assertEqual(metadata['flag'], 2)
        self.assertEqual(metadata['firmwareSha256'], hashlib.sha256(payload).hexdigest())
        self.assertEqual(region, boot)
        for malformed in (boot[:10], boot[:-1] + b'x', b'\x02\xff\xff\xff\xff' + boot[5:], b'\x01' + boot[1:]):
            with self.assertRaises(firmware.FirmwareError):
                firmware.boot_region(malformed)

    def test_device_dump_and_receiver_roundtrip_all_binary_values(self):
        payload = bytes(range(256)) * 29
        output = io.StringIO()
        fake_utils = types.SimpleNamespace(flash_read=lambda offset, length: payload[offset:offset + length])
        modules = {'Maix': types.SimpleNamespace(utils=fake_utils),
                   'ubinascii': binascii, 'uhashlib': hashlib}
        with mock.patch.dict(sys.modules, modules), contextlib.redirect_stdout(output):
            exec(firmware.dump_script(len(payload)), {})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'flash.bin'
            receiver = firmware.BackupReceiver(path, len(payload))
            for line in output.getvalue().splitlines():
                receiver.line(line.encode())
            self.assertEqual(receiver.finish(), hashlib.sha256(payload).hexdigest())
            self.assertEqual(path.read_bytes(), payload)

    def test_flash_range_roundtrip_reads_absolute_addresses_with_relative_frames(self):
        payload = bytes(range(256)) * 25 + b'\xff' * 3072 + b'tail'
        for offset, size in ((0, len(payload)), (157, 4097), (6400, 3072),
                             (len(payload) - 17, 17), (len(payload), 0)):
            with self.subTest(offset=offset, size=size):
                reads, output = [], io.StringIO()

                def read_flash(address, length):
                    self.assertGreaterEqual(address, offset)
                    self.assertLessEqual(address + length, offset + size)
                    reads.append((address, length))
                    return payload[address:address + length]

                modules = {'Maix': types.SimpleNamespace(utils=types.SimpleNamespace(flash_read=read_flash)),
                           'ubinascii': binascii, 'uhashlib': hashlib}
                with mock.patch.object(firmware, 'FLASH_BYTES', len(payload)), \
                        mock.patch.dict(sys.modules, modules), contextlib.redirect_stdout(output):
                    exec(firmware.dump_script(size, offset=offset), {})
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / 'range.bin'
                    receiver = firmware.BackupReceiver(path, size)
                    for line in output.getvalue().splitlines():
                        receiver.line(line.encode())
                    self.assertEqual(receiver.finish(), hashlib.sha256(payload[offset:offset + size]).hexdigest())
                    self.assertEqual(path.read_bytes(), payload[offset:offset + size])
                if size:
                    self.assertEqual(reads[0][0], offset)
                else:
                    self.assertEqual(reads, [])

    def test_file_range_roundtrip_seeks_readonly_and_preserves_source(self):
        payload = bytes(range(256)) * 25 + b'\x00' * 3072 + b'file tail'
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.bin'
            source.write_bytes(payload)
            for offset, size in ((0, len(payload)), (101, 3800), (6400, 3072),
                                 (len(payload) - 19, 19), (len(payload), 0)):
                with self.subTest(offset=offset, size=size):
                    output, opened = io.StringIO(), []

                    def open_readonly(path, mode):
                        self.assertEqual(path, str(source))
                        self.assertEqual(mode, 'rb')
                        stream = open(path, mode)
                        opened.append(stream)
                        return stream

                    modules = {'Maix': types.SimpleNamespace(utils=types.SimpleNamespace(
                                   flash_read=mock.Mock(side_effect=AssertionError('file range must not read Flash')))),
                               'ubinascii': binascii, 'uhashlib': hashlib}
                    with mock.patch.dict(sys.modules, modules), contextlib.redirect_stdout(output):
                        exec(firmware.dump_script(size, str(source), offset), {'open': open_readonly})
                    destination = Path(directory) / ('range-%d-%d.bin' % (offset, size))
                    receiver = firmware.BackupReceiver(destination, size)
                    for line in output.getvalue().splitlines():
                        receiver.line(line.encode())
                    self.assertEqual(receiver.finish(), hashlib.sha256(payload[offset:offset + size]).hexdigest())
                    self.assertEqual(destination.read_bytes(), payload[offset:offset + size])
                    self.assertEqual(len(opened), 1)
                    self.assertTrue(opened[0].closed)
                    self.assertEqual(source.read_bytes(), payload)

    def test_snapshot_ranges_reject_invalid_types_bounds_and_paths(self):
        for size, offset in ((-1, 0), (0, -1), (True, 0), (0, False),
                             (1.5, 0), (1, '0'), ('1', 0)):
            with self.subTest(size=size, offset=offset), self.assertRaises(firmware.FirmwareError):
                firmware.dump_script(size, offset=offset)
        for remote, limit in ((None, firmware.FLASH_BYTES), ('/sd/model.bin', firmware.MAX_USER_FILE)):
            for size, offset in ((1, limit), (0, limit + 1), (limit + 1, 0), (2, limit - 1)):
                with self.subTest(remote=remote, size=size, offset=offset), self.assertRaises(firmware.FirmwareError):
                    firmware.dump_script(size, remote, offset)
            compile(firmware.dump_script(0, remote, limit), '<bounded-empty-range>', 'exec')
            compile(firmware.dump_script(1, remote, limit - 1), '<bounded-tail-range>', 'exec')
        for remote in ('', '/sd/nul\x00name', 0, False):
            with self.subTest(remote=remote), self.assertRaises(firmware.FirmwareError):
                firmware.dump_script(0, remote)

    def test_empty_file_snapshot_emits_only_verified_empty_sha(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'empty.bin'
            source.write_bytes(b'')
            output = io.StringIO()
            modules = {'Maix': types.SimpleNamespace(utils=types.SimpleNamespace()),
                       'ubinascii': binascii, 'uhashlib': hashlib}
            with mock.patch.dict(sys.modules, modules), contextlib.redirect_stdout(output):
                exec(firmware.dump_script(0, str(source)), {})
            lines = output.getvalue().splitlines()
            self.assertEqual(lines, ['NODU_SHA256 ' + hashlib.sha256(b'').hexdigest()])
            destination = Path(directory) / 'empty-copy.bin'
            receiver = firmware.BackupReceiver(destination, 0)
            receiver.line(lines[0].encode())
            self.assertEqual(receiver.finish(), hashlib.sha256(b'').hexdigest())
            self.assertEqual(destination.read_bytes(), b'')

    def test_file_range_read_or_seek_failure_closes_without_certifying_partial_bytes(self):
        class Unseekable(io.BytesIO):
            def seek(self, offset, whence=0):
                raise OSError('synthetic seek failure')

        for case in ('short-file', 'seek-failure'):
            with self.subTest(case=case):
                stream = io.BytesIO(b'abc') if case == 'short-file' else Unseekable(b'abc')
                output = io.StringIO()
                modules = {'Maix': types.SimpleNamespace(utils=types.SimpleNamespace()),
                           'ubinascii': binascii, 'uhashlib': hashlib}
                with mock.patch.dict(sys.modules, modules), contextlib.redirect_stdout(output):
                    expected = 'Unexpected backup EOF' if case == 'short-file' else 'synthetic seek failure'
                    with self.assertRaisesRegex(Exception, expected):
                        exec(firmware.dump_script(4, '/sd/synthetic-only.bin', 2),
                             {'open': lambda path, mode: stream})
                self.assertTrue(stream.closed)
                self.assertNotIn('NODU_SHA256 ', output.getvalue())
                if case == 'short-file':
                    with tempfile.TemporaryDirectory() as directory:
                        receiver = firmware.BackupReceiver(Path(directory) / 'partial.bin', 4)
                        try:
                            with self.assertRaises(firmware.FirmwareError):
                                receiver.line(output.getvalue().splitlines()[0].encode())
                        finally:
                            receiver.close()

    def test_receiver_rejects_offset_size_hash_and_trailing_data(self):
        payload = b'abc'
        valid = b'NODU_DATA 00000000:' + base64.b64encode(payload)
        cases = [(valid.replace(b'00000000', b'00000001'),),
                 (b'NODU_DATA 00000000:YQ==',),
                 (valid, b'NODU_SHA256 ' + b'0' * 64),
                 (valid, b'NODU_SHA256 ' + hashlib.sha256(payload).hexdigest().encode(), valid)]
        with tempfile.TemporaryDirectory() as directory:
            for index, lines in enumerate(cases):
                receiver = firmware.BackupReceiver(Path(directory) / str(index), len(payload))
                with self.subTest(index=index), self.assertRaises(firmware.FirmwareError):
                    try:
                        for line in lines:
                            receiver.line(line)
                        receiver.finish()
                    finally:
                        receiver.close()

    def test_segmented_snapshot_roundtrip_flash_file_tail_and_empty(self):
        for remote, payload in ((None, bytes(range(256)) * 512 + b'tail-43' * 7),
                                ('/sd/synthetic-only.bin', b'\xff' * 65536 + b'\x00' * 65536 + b'tail'),
                                ('/sd/synthetic-only.bin', b'')):
            with self.subTest(remote=remote, size=len(payload)), tempfile.TemporaryDirectory() as directory:
                peer = self._snapshot_peer(payload)
                destination = Path(directory) / 'snapshot.bin'
                progress = mock.Mock()
                result = peer.worker._receive_snapshot(destination, len(payload), remote, progress)
                self.assertEqual(result, hashlib.sha256(payload).hexdigest())
                self.assertEqual(destination.read_bytes(), payload)
                self.assertEqual(peer.offsets, list(range(0, max(len(payload), 1), 65536)))
                progress.assert_called_with(len(payload), len(payload))
                self.assertEqual(list(Path(directory).iterdir()), [destination])
                peer.transport.enter_raw_repl.assert_not_called()
                self.assertIs(peer.worker.port_lock, peer.owner)
                self.assertEqual(peer.wire.baudrate, 115200)
                self.assertEqual(peer.wire.writes, [])
                if remote is None:
                    peer.worker._remote_flash_hash.assert_called_once_with(len(payload))
                else:
                    peer.worker._remote_file_hash.assert_called_once_with(remote, len(payload))

    def test_segmented_snapshot_retries_corrupt_data_and_nonascii_sha_without_soft_reset(self):
        payload = bytes(range(256)) * 256 + b'\xff' * 37
        for corruption in ('base64', 'nonascii-sha'):
            def corrupt(frames, offset, attempt):
                if offset == 65536 and attempt == 1:
                    if corruption == 'base64':
                        return b'NODU_DATA 00000000:%%%\n'
                    return re.sub(rb'NODU_SHA256 [0-9a-f]{64}', b'NODU_SHA256 \xff', frames)
                return frames

            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory() as directory:
                peer = self._snapshot_peer(payload, corrupt)
                destination = Path(directory) / 'snapshot.bin'
                self.assertEqual(peer.worker._receive_snapshot(destination, len(payload)), hashlib.sha256(payload).hexdigest())
                self.assertEqual(destination.read_bytes(), payload)
                self.assertEqual(peer.offsets, [0, 65536, 65536])
                peer.transport.enter_raw_repl.assert_called_once_with(soft_reset=False, timeout_overall=5)
                self.assertEqual(peer.wire.resets, 1)
                self.assertEqual(peer.wire.writes, [])
                self.assertIs(peer.worker.port_lock, peer.owner)
                self.assertEqual(peer.wire.baudrate, 115200)
                self.assertEqual(len(list(Path(directory).glob('*.ranges-*/*.part'))), 1)

    def test_segmented_snapshot_range_and_global_retry_budgets_keep_partial_bytes(self):
        for case in ('range-limit', 'global-limit'):
            payload = b'\xff' * (13 * 65536)

            def corrupt(frames, offset, attempt):
                if (case == 'range-limit' and offset == 65536) or (case == 'global-limit' and attempt == 1):
                    return b'NODU_FILL 00000000:ff:9999\n'
                return frames

            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                peer = self._snapshot_peer(payload, corrupt)
                destination = Path(directory) / 'partial.bin'
                with self.assertRaises(firmware.FirmwareError):
                    peer.worker._receive_snapshot(destination, len(payload))
                if case == 'range-limit':
                    self.assertEqual(peer.offsets, [0, 65536, 65536, 65536])
                    self.assertEqual(destination.read_bytes(), payload[:65536])
                    self.assertEqual(peer.transport.enter_raw_repl.call_count, 2)
                else:
                    self.assertEqual(len(peer.offsets), 23)
                    self.assertEqual(peer.offsets[-1], 11 * 65536)
                    self.assertEqual(destination.read_bytes(), payload[:11 * 65536])
                    self.assertEqual(peer.transport.enter_raw_repl.call_count, 11)
                peer.worker._remote_flash_hash.assert_not_called()
                self.assertIs(peer.worker.port_lock, peer.owner)
                self.assertTrue(list(Path(directory).glob('*.ranges-*/*.part')))

    def test_segmented_snapshot_cancellation_does_not_retry_or_commit_next_range(self):
        payload = b'\xff' * (65536 + 10)
        peer = self._snapshot_peer(payload)

        def cancel_after_first(received, total):
            peer.worker.generation += 1

        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'partial.bin'
            with self.assertRaises(worker_module.Cancelled):
                peer.worker._receive_snapshot(destination, len(payload), progress=cancel_after_first)
            self.assertEqual(peer.offsets, [0])
            self.assertEqual(destination.read_bytes(), payload[:65536])
            peer.transport.enter_raw_repl.assert_not_called()
            peer.worker._remote_flash_hash.assert_not_called()
            self.assertIs(peer.worker.port_lock, peer.owner)

    def test_segmented_snapshot_rejects_changed_final_source_hash_or_size(self):
        payload = b'\xff' * 65536 + b'final tail'
        for case in ('flash-hash', 'file-hash', 'file-size'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                peer = self._snapshot_peer(payload)
                remote = None if case == 'flash-hash' else '/sd/synthetic-only.bin'
                if case == 'flash-hash':
                    peer.worker._remote_flash_hash.return_value = '0' * 64
                else:
                    peer.worker._remote_file_hash.return_value = (
                        len(payload) + (1 if case == 'file-size' else 0),
                        '0' * 64 if case == 'file-hash' else hashlib.sha256(payload).hexdigest())
                destination = Path(directory) / 'uncertified.bin'
                with self.assertRaisesRegex(firmware.FirmwareError, 'Source (SHA256|file size) changed'):
                    peer.worker._receive_snapshot(destination, len(payload), remote)
                self.assertEqual(destination.read_bytes(), payload)
                self.assertFalse(peer.worker.flash_capacity_verified)
                self.assertIsNone(peer.worker.backup_record)
                peer.transport.enter_raw_repl.assert_not_called()

    def test_segmented_snapshot_rejects_local_part_tamper_before_append(self):
        payload = b'\xff' * 65536 + b'tail'
        peer = self._snapshot_peer(payload)
        receive = peer.worker._receive_backup

        def receive_then_tamper(destination, size, code, progress):
            digest = receive(destination, size, code, progress)
            destination.write_bytes(b'x' * size)
            return digest

        peer.worker._receive_backup = receive_then_tamper
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'partial.bin'
            with self.assertRaisesRegex(firmware.FirmwareError, 'changed locally'):
                peer.worker._receive_snapshot(destination, len(payload))
            self.assertEqual(destination.read_bytes(), b'')
            peer.worker._remote_flash_hash.assert_not_called()
            peer.transport.enter_raw_repl.assert_not_called()

    def test_restore_packages_preserve_raw_header_and_disable_prefix(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(firmware, 'FLASH_BYTES', 4096):
            full, boot, manifest = self._restore_fixture(directory)
            firmware.validate_restore_packages(directory, manifest)
            for name, data in (('boot-restore.kfpkg', boot), ('full-flash-restore.kfpkg', full.read_bytes())):
                with zipfile.ZipFile(Path(directory) / name) as archive:
                    text = archive.read('flash-list.json').decode()
                    # Exact fixed kflash 1.1.6 KFPKG JSON preprocessing, without
                    # importing or executing its serial/ISP loader.
                    compatible = re.sub(r'"address": (.*),', r'"address": "\1",', text)
                    item = json.loads(compatible)['files'][0]
                    self.assertIs(item['sha256Prefix'], False)
                    self.assertEqual(int(item['address'], 0), 0)
                    self.assertEqual(archive.read(item['bin']), data)
                if os.name != 'nt':
                    self.assertEqual((Path(directory) / name).stat().st_mode & 0o777, 0o600)

    def test_invalid_restore_packages_block_loader_before_serial_release(self):
        cases = ('missing-boot', 'missing-full', 'broken-zip', 'address', 'prefix',
                 'payload', 'duplicate', 'escape', 'extra', 'duplicate-json', 'crc', 'legacy-json')
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory, mock.patch.object(firmware, 'FLASH_BYTES', 4096):
                full, boot, manifest = self._restore_fixture(directory)
                package = Path(directory) / 'full-flash-restore.kfpkg'
                if case.startswith('missing-'):
                    (Path(directory) / ('boot-restore.kfpkg' if case == 'missing-boot'
                                        else 'full-flash-restore.kfpkg')).unlink()
                elif case == 'broken-zip':
                    package.write_bytes(b'not a ZIP package')
                else:
                    raw_name = '../full-flash.raw.bin' if case == 'escape' else full.name
                    plan = {'version': '0.1.0', 'files': [{'address': '0x00001000' if case == 'address' else '0x00000000',
                             'bin': raw_name, 'sha256Prefix': case == 'prefix'}]}
                    text = json.dumps(plan, separators=(',', ':'))
                    if case == 'legacy-json':
                        text = json.dumps(plan)  # Fixed kflash's regex corrupts this old spelling.
                    if case == 'duplicate-json':
                        text = text.replace('"version":', '"version":"0.1.0","version":', 1)
                    payload = full.read_bytes()
                    if case == 'payload':
                        payload = payload[:-1] + b'\x00'
                    with warnings.catch_warnings():
                        warnings.simplefilter('ignore', UserWarning)
                        with zipfile.ZipFile(package, 'w', zipfile.ZIP_STORED) as archive:
                            archive.writestr(raw_name, payload)
                            archive.writestr('flash-list.json', text)
                            if case == 'duplicate':
                                archive.writestr(raw_name, payload)
                            if case == 'extra':
                                archive.writestr('unreviewed.bin', b'extra')
                    if case == 'crc':
                        with zipfile.ZipFile(package) as archive:
                            info = archive.getinfo(full.name)
                            offset = info.header_offset + 30 + len(info.filename.encode('ascii'))
                        with open(package, 'r+b') as stream:
                            stream.seek(offset)
                            stream.write(b'\xff')  # Preserve headers/central CRC, corrupt stored bytes.
                worker = worker_module.DeviceWorker(output=io.StringIO())
                worker.firmware_module = firmware
                worker.transport = mock.Mock()
                worker.state.update(phase='connected', port='/dev/synthetic-restore-only')
                worker.session_id = 'synthetic-current-session'
                worker.prepared_firmware = '/synthetic/pinned.bin'
                worker.flash_capacity_verified = True
                worker.flash_capacity_proof = {'capacityBytes': 4096, 'testOnly': True}
                manifest.update(flashCapacityVerified=True, flashCapacityProof=worker.flash_capacity_proof)
                worker.backup_record = {'directory': directory, 'manifest': manifest,
                                        'session': worker.session_id, 'fullPath': str(full)}
                worker._remote_flash_hash = mock.Mock()
                with mock.patch.object(firmware, 'validate_image'), mock.patch.object(firmware, 'flash_image') as loader, mock.patch.object(zipfile.ZipFile, 'extractall', side_effect=AssertionError('must never extract')):
                    with self.assertRaises(firmware.FirmwareError):
                        worker.do_flashFirmware({'backupDir': directory})
                loader.assert_not_called()
                worker.transport.close.assert_not_called()
                worker._remote_flash_hash.assert_not_called()

    def test_all_file_extensions_are_opaque_backup_candidates(self):
        for path in ('/sd/photo.jpg', '/sd/unknown.asset', '/flash/boot.py',
                     '/sd/.env', '/flash/wifi.json', '/sd/runtime.log'):
            self.assertEqual(firmware.eligible_file(path), (True, None))

    def test_post_flash_file_verification_requires_size_and_every_hash(self):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        manifest = {'files': [{'path': '/flash/main.py', 'size': 3,
                              'sha256': hashlib.sha256(b'abc').hexdigest(), 'status': 'verified'},
                             {'path': '/sd/photo.jpg', 'size': 4,
                              'sha256': hashlib.sha256(b'1234').hexdigest(), 'status': 'verified'}]}
        worker._stat = lambda path: (0, 0, 0, 0, 0, 0, 3 if path.endswith('.py') else 4)
        worker._remote_file_hash = lambda path, size: ((3, hashlib.sha256(b'abc').hexdigest())
                                                if path.endswith('.py') else (4, hashlib.sha256(b'1234').hexdigest()))
        self.assertEqual(worker._verify_preserved_files(manifest), 2)
        worker._remote_file_hash = lambda path, size: (3 if path.endswith('.py') else 4, '0' * 64)
        with self.assertRaisesRegex(worker_module.DeviceError, 'SHA256 changed'):
            worker._verify_preserved_files(manifest)
        worker._stat = lambda path: None
        with self.assertRaisesRegex(worker_module.DeviceError, 'missing or changed size'):
            worker._verify_preserved_files(manifest)

    def test_flash_without_backup_cannot_release_serial_or_invoke_loader(self):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        transport = mock.Mock()
        worker.transport = transport
        worker.state['phase'] = 'connected'
        worker.prepared_firmware = '/backend/firmware.bin'
        worker.firmware_module = firmware
        worker.flash_capacity_verified = True
        worker.flash_capacity_proof = {'testOnly': 'fixture capacity proof', 'capacityBytes': firmware.FLASH_BYTES}
        with mock.patch.object(firmware, 'validate_image'), mock.patch.object(firmware, 'flash_image') as flash:
            with self.assertRaisesRegex(worker_module.DeviceError, 'complete verified backup'):
                worker.do_flashFirmware({'backupDir': '/fake'})
            flash.assert_not_called()
            transport.close.assert_not_called()

    def test_stop_disconnect_and_connect_are_rejected_during_firmware_write(self):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.flash_in_progress = True
        generation = worker.generation
        for number, method in enumerate(('stop', 'disconnect', 'connect')):
            worker.submit({'id': number, 'method': method})
        self.assertEqual(worker.generation, generation)
        self.assertTrue(worker.requests.empty())
        replies = [json.loads(line) for line in worker.output.getvalue().splitlines()]
        self.assertTrue(all('Firmware writing is in progress' in item['error'] for item in replies))

    def test_cancelling_backup_restores_original_baud_without_soft_reset(self):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.transport = mock.Mock()
        worker.baud = 115200
        original_deadline = worker_module.time.monotonic() + 60
        worker.deadline = original_deadline
        writes = []
        serial = types.SimpleNamespace(baudrate=115200, reset_input_buffer=mock.Mock(),
                                       write=lambda data: writes.append(data))
        worker.transport.serial = serial
        changes = []

        def change(baud):
            changes.append(baud)
            worker.baud = baud

        worker._change_baud = change

        def enter(*, soft_reset, timeout_overall):
            self.assertFalse(soft_reset)
            self.assertEqual(timeout_overall, 5)
            self.assertEqual(writes, [])  # No outer Ctrl-C before the transport's handshake.
            self.assertTrue(worker.restoring_io)
            worker.check()  # Cancellation is ignored only while restoring I/O.
            serial.write(b'\r\x03\x02\r')

        worker.transport.enter_raw_repl.side_effect = enter
        with self.assertRaises(worker_module.Cancelled):
            with worker._fast_backup_serial():
                self.assertEqual(worker.baud, 115200)
                worker.generation += 1
                worker.check()
        self.assertEqual(changes, [])
        self.assertEqual(worker.baud, 115200)
        self.assertEqual(writes, [b'\r\x03\x02\r'])
        self.assertFalse(worker.restoring_io)
        self.assertEqual(worker.deadline, original_deadline)
        with self.assertRaises(worker_module.Cancelled):
            worker.check()
        worker.transport.enter_raw_repl.assert_called_once_with(soft_reset=False, timeout_overall=5)

    def test_backup_recovery_failure_is_bounded_and_restores_cancellation_state(self):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.transport = mock.Mock()
        worker.baud = 115200
        original_deadline = worker_module.time.monotonic() + 60
        worker.deadline = original_deadline

        def fail_enter(**kwargs):
            worker.transport.serial.write.assert_not_called()
            self.assertTrue(worker.restoring_io)
            worker.check()
            raise worker_module.DeviceError('synthetic handshake failure')

        worker.transport.enter_raw_repl.side_effect = fail_enter
        with self.assertRaisesRegex(worker_module.DeviceError, 'recovery failed'):
            with worker._fast_backup_serial():
                worker.generation += 1
        self.assertEqual(worker.transport.enter_raw_repl.call_args_list,
                         [mock.call(soft_reset=False, timeout_overall=5)] * 3)
        worker.transport.serial.write.assert_not_called()
        self.assertEqual(worker.state['phase'], 'error')
        self.assertFalse(worker.restoring_io)
        self.assertEqual(worker.deadline, original_deadline)
        with self.assertRaises(worker_module.Cancelled):
            worker.check()

    def test_uniform_fill_frames_restore_exact_bytes_and_verify_the_device_hash(self):
        payload = b'\xff' * 3072 + bytes(range(256)) * 12 + b'\x00' * 151
        output = io.StringIO()
        modules = {'Maix': types.SimpleNamespace(utils=types.SimpleNamespace(
                       flash_read=lambda offset, length: payload[offset:offset + length])),
                   'ubinascii': binascii, 'uhashlib': hashlib}
        with mock.patch.dict(sys.modules, modules), contextlib.redirect_stdout(output):
            exec(firmware.dump_script(len(payload)), {})
        self.assertIn('NODU_FILL 00000000:ff:3072', output.getvalue())
        self.assertIn('NODU_DATA 00000c00:', output.getvalue())
        self.assertIn('NODU_FILL 00001800:00:151', output.getvalue())
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'mixed.bin'
            receiver = firmware.BackupReceiver(path, len(payload))
            for line in output.getvalue().splitlines():
                receiver.line(line.encode())
            self.assertEqual(receiver.finish(), hashlib.sha256(payload).hexdigest())
            self.assertEqual(path.read_bytes(), payload)

    def test_fill_frames_cannot_expand_out_of_order_out_of_bounds_or_after_hash(self):
        bad = (b'NODU_FILL 00000001:ff:3072', b'NODU_FILL 00000000:gg:3072',
               b'NODU_FILL 00000000:ff:3073', b'NODU_FILL 00000000:ff:0',
               b'NODU_FILL 00000000:ff:99999999', b'NODU_FILL 00000000:ff:-1',
               b'NODU_FILL 00000000:ff:1:extra')
        with tempfile.TemporaryDirectory() as directory:
            for index, line in enumerate(bad):
                receiver = firmware.BackupReceiver(Path(directory) / str(index), 3072)
                with self.assertRaises(firmware.FirmwareError):
                    try:
                        receiver.line(line)
                    finally:
                        receiver.close()
            receiver = firmware.BackupReceiver(Path(directory) / 'after-hash', 3072)
            receiver.line(b'NODU_SHA256 ' + b'0' * 64)
            with self.assertRaisesRegex(firmware.FirmwareError, 'after the final hash'):
                receiver.line(b'NODU_FILL 00000000:ff:3072')
            receiver.close()

    def test_loader_uses_reviewed_binary_api_without_erase_address_or_profile_override(self):
        calls = []
        events = []

        class Loader:
            print_callback = None

            def process(self, **kwargs):
                calls.append(kwargs)
                kwargs['callback']('BIN', 50, 100, '')

        with mock.patch.dict(sys.modules, {'kflash': types.SimpleNamespace(KFlash=Loader)}), mock.patch.object(firmware, 'validate_image'), mock.patch.object(firmware.importlib.metadata, 'version', return_value='1.1.6'):
            firmware.flash_image('/backend/pinned.bin', '/dev/worker-test', lambda text: None,
                                 lambda *args: events.append(args))
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]['dev'], '/dev/worker-test')
        self.assertEqual(calls[0]['file'], '/backend/pinned.bin')
        self.assertFalse(calls[0]['sram'])
        self.assertFalse(calls[0]['terminal'])
        self.assertIsNone(calls[0]['board'])
        self.assertNotIn('addr', calls[0])
        self.assertNotIn('length', calls[0])
        self.assertNotIn('erase', calls[0])
        self.assertEqual(events, [('flash-BIN', 50, 100)])

    def test_missing_tampered_or_escaped_local_recovery_blocks_loader_and_keeps_serial(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(firmware, 'FLASH_BYTES', 4096):
            root = Path(directory)
            local = root / 'files' / 'sd' / 'model.bin'
            local.parent.mkdir(parents=True)
            payload = b'original firmware'
            header = b'\x02' + struct.pack('<I', len(payload))
            boot = header + payload + hashlib.sha256(header + payload).digest()
            full = root / 'full-flash.raw.bin'
            full.write_bytes(boot.ljust(4096, b'\xff'))
            metadata, _ = firmware.boot_region(full.read_bytes())
            entry = {'path': '/sd/model.bin', 'local': 'files/sd/model.bin',
                     'status': 'verified', 'size': 4,
                     'sha256': hashlib.sha256(b'user').hexdigest()}
            manifest = dict(metadata, verified=True, flashBytes=4096,
                            flashSha256=firmware.file_sha256(full), files=[entry],
                            flashCapacityVerified=True,
                            flashCapacityProof={'testOnly': 'fixture capacity proof', 'capacityBytes': firmware.FLASH_BYTES})

            def attempt():
                worker = worker_module.DeviceWorker(output=io.StringIO())
                worker.firmware_module = firmware
                worker.transport = mock.Mock()
                worker.state.update(phase='connected')
                worker.prepared_firmware = '/backend/pinned.bin'
                worker.session_id = 'same-session'
                worker.flash_capacity_verified = True
                worker.flash_capacity_proof = manifest['flashCapacityProof']
                worker.backup_record = {'directory': directory, 'session': 'same-session',
                                        'fullPath': str(full), 'manifest': manifest}
                with mock.patch.object(firmware, 'validate_image'), mock.patch.object(firmware, 'flash_image') as flash:
                    with self.assertRaises(firmware.FirmwareError):
                        worker.do_flashFirmware({'backupDir': directory})
                    flash.assert_not_called()
                    worker.transport.close.assert_not_called()

            # Missing and same-length corrupted copies must both stop ISP entry.
            attempt()
            local.write_bytes(b'evil')
            attempt()
            local.write_bytes(b'user')
            entry['local'] = '../outside.bin'
            attempt()
            entry['local'] = 'files/sd/model.bin'
            local.unlink()
            external = root / 'external.bin'
            external.write_bytes(b'user')
            local.symlink_to(external)
            attempt()

    def test_candidate_readback_or_old_verified_record_cannot_bypass_capacity_gate(self):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.transport = mock.Mock()
        worker.state['phase'] = 'connected'
        worker.firmware_module = firmware
        worker.prepared_firmware = '/backend/firmware.bin'
        worker.backup_record = {'directory': '/candidate', 'manifest': {
            'verified': True, 'flashBytes': 16 * 1024 * 1024}}
        with mock.patch.object(firmware, 'flash_image') as flash:
            with self.assertRaisesRegex(worker_module.DeviceError, 'JEDEC capacity'):
                worker.do_flashFirmware({'backupDir': '/candidate'})
            flash.assert_not_called()
            worker.transport.close.assert_not_called()

    def test_readonly_capacity_probe_keeps_port_lock_reconnects_and_gates_exact_capacity(self):
        for size in (16 * 1024 * 1024, 8 * 1024 * 1024):
            worker = worker_module.DeviceWorker(output=io.StringIO())
            worker.firmware_module = firmware
            worker.transport = mock.Mock()
            old_transport = worker.transport
            worker.state.update(port='/dev/worker-test', phase='connected', operation='backupDevice')
            worker.session_id = 'fixture source session'
            owner = object()
            worker.port_lock = owner
            fresh_transport = mock.Mock()
            fresh_transport.enter_raw_repl.side_effect = lambda **kwargs: worker.check()
            worker.transport_factory = mock.Mock(return_value=fresh_transport)
            proof = {'verified': True, 'capacityBytes': size, 'jedecId': 'ef4018'}
            saved = {'manifest': {'files': [], 'bootBytes': 128, 'bootSha256': 'a' * 64,
                                  'candidateFlashBytes': firmware.FLASH_BYTES,
                                  'candidateFlashSha256': 'a' * 64}}
            worker._preserve_before_probe = mock.Mock(return_value=saved)
            worker._verify_preserved_files = mock.Mock()
            worker._verify_inventory_unchanged = mock.Mock()
            worker._remote_flash_hash = mock.Mock(return_value='a' * 64)
            def probe_response(port, **kwargs):
                return dict(proof, probePort=port, sessionBeforeProbe=kwargs['session'],
                            requestNonce=kwargs['nonce'], stubSha256='fixture reviewed hash')
            module = types.SimpleNamespace(probe=mock.Mock(side_effect=probe_response),
                                           validate_build=mock.Mock(), STUB_SHA256='fixture reviewed hash')
            spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda value: None))
            with mock.patch.object(worker_module.Path, 'is_file', return_value=True), mock.patch.object(worker_module.importlib.util, 'spec_from_file_location', return_value=spec), mock.patch.object(worker_module.importlib.util, 'module_from_spec', return_value=module):
                if size == firmware.FLASH_BYTES:
                    worker._ensure_flash_capacity('/backend/new-backup')
                    self.assertTrue(worker.flash_capacity_verified)
                else:
                    with self.assertRaisesRegex(worker_module.DeviceError, 'only 16777216-byte'):
                        worker._ensure_flash_capacity('/backend/new-backup')
                    self.assertFalse(worker.flash_capacity_verified)
            self.assertIs(worker.port_lock, owner)
            self.assertIs(worker.transport, fresh_transport)
            old_transport.close.assert_called_once()
            fresh_transport.enter_raw_repl.assert_called_once_with(soft_reset=False, timeout_overall=10)
            self.assertEqual(worker.state['operation'], 'backupDevice')
            worker._preserve_before_probe.assert_called_once_with('/backend/new-backup')

    def test_state_preservation_failure_prevents_ram_probe_and_keeps_serial(self):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.firmware_module = firmware
        worker.transport = mock.Mock()
        worker.state.update(port='/dev/worker-test', phase='connected')
        worker._preserve_before_probe = mock.Mock(side_effect=worker_module.DeviceError('synthetic preservation failure'))
        module = types.SimpleNamespace(probe=mock.Mock(), validate_build=mock.Mock())
        spec = types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda value: None))
        with mock.patch.object(worker_module.Path, 'is_file', return_value=True), mock.patch.object(worker_module.importlib.util, 'spec_from_file_location', return_value=spec), mock.patch.object(worker_module.importlib.util, 'module_from_spec', return_value=module):
            with self.assertRaisesRegex(worker_module.DeviceError, 'preservation failure'):
                worker._ensure_flash_capacity('/backend/new-backup')
        worker.transport.close.assert_not_called()
        module.probe.assert_not_called()
        self.assertFalse(worker.flash_capacity_verified)

    def test_pre_probe_snapshot_verifies_files_and_boot_without_claiming_full_flash(self):
        user_data = b'private startup bytes'
        payload = b'current firmware' * 100
        header = b'\x02' + struct.pack('<I', len(payload))
        boot = header + payload + hashlib.sha256(header + payload).digest()
        prefix = boot.ljust(4096, b'\xff')
        inventory = [{'path': '/flash/main.py', 'directory': False,
                      'size': len(user_data), 'status': 'pending'}]
        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.firmware_module = firmware
        worker.state.update(port='/dev/worker-test', firmware='fixture firmware')
        worker.session_id = 'fixture session before RAM'
        worker._exec = mock.Mock(return_value=repr(header))
        worker._backup_inventory = lambda: copy.deepcopy(inventory)
        worker._fast_backup_serial = contextlib.nullcontext
        worker._remote_flash_hash = lambda size: hashlib.sha256(prefix if size == 4096 else boot).hexdigest()
        worker._stat = lambda path: (0, 0, 0, 0, 0, 0, len(user_data))
        worker._remote_file_hash = lambda path, expected: (len(user_data), hashlib.sha256(user_data).hexdigest())

        def receive(destination, size, script, progress):
            data = prefix if 'utils.flash_read(' in script else user_data
            self.assertEqual(size, len(data))
            with firmware.private_file(destination) as stream:
                stream.write(data)
            progress(size, size)
            return hashlib.sha256(data).hexdigest()

        worker._receive_backup = receive
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(firmware, 'FLASH_BYTES', 4096):
            saved = worker._preserve_before_probe(str(Path(directory) / 'new-backup'))
            manifest = saved['manifest']
            self.assertTrue(manifest['stateSaved'])
            self.assertFalse(manifest['completeFlashBackup'])
            self.assertFalse(manifest['flashCapacityVerified'])
            self.assertNotIn('verified', manifest)
            self.assertEqual(manifest['sessionBeforeProbe'], 'fixture session before RAM')
            self.assertEqual((Path(saved['directory']) / 'files/flash/main.py').read_bytes(), user_data)
            self.assertEqual((Path(saved['directory']) / 'original-boot-region.raw.bin').read_bytes(), boot)
            self.assertEqual((Path(saved['directory']) / 'flash-prefix-candidate.raw.bin').read_bytes(), prefix)
            self.assertEqual(manifest['candidateFlashBytes'], 4096)
            self.assertFalse(worker.flash_capacity_verified)
            self.assertIsNone(worker.backup_record)
            self.assertNotIn(user_data.decode(), worker.output.getvalue())

    def test_bad_boot_or_changed_inventory_blocks_preservation(self):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.firmware_module = firmware
        worker.state['port'] = '/dev/worker-test'
        worker._exec = mock.Mock(return_value=repr(b'\x02\xff\xff\xff\xff'))
        worker._receive_backup = mock.Mock()
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(worker_module.DeviceError, 'preservation bound'):
                worker._preserve_before_probe(str(Path(directory) / 'new-backup'))
            manifest = json.loads((Path(directory) / 'new-backup.pre-probe/manifest.json').read_text())
            self.assertFalse(manifest['stateSaved'])
        worker._receive_backup.assert_not_called()
        worker._backup_inventory = lambda: [{'path': '/flash/new.py', 'directory': False, 'size': 1}]
        with self.assertRaisesRegex(worker_module.DeviceError, 'inventory changed'):
            worker._verify_inventory_unchanged({'files': []})

    def test_successful_backup_result_satisfies_app_capacity_contract(self):
        # Small synthetic image exercises the entire backup result/restore
        # path. This is not a physical ID or hardware acceptance fixture.
        payload = b'synthetic firmware'
        header = b'\x02' + struct.pack('<I', len(payload))
        boot = header + payload + hashlib.sha256(header + payload).digest()
        full = boot.ljust(4096, b'\xff')
        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.firmware_module = firmware
        worker.transport = mock.Mock()
        worker.state.update(phase='connected', port='/dev/worker-test', boardProfile='generic-k210')
        worker.session_id = 'fixture session'
        worker.flash_capacity_verified = True
        worker.flash_capacity_proof = {'testOnly': True, 'jedecId': 'EF4018', 'capacityBytes': 4096}
        worker._ensure_flash_capacity = mock.Mock()
        worker._backup_inventory = lambda: []
        worker._exec = mock.Mock()
        worker._fast_backup_serial = contextlib.nullcontext
        worker._remote_flash_hash = lambda size: hashlib.sha256(full if size == len(full) else boot).hexdigest()

        def receive(destination, size, script, progress):
            with firmware.private_file(destination) as stream:
                stream.write(full)
            progress(size, size)
            return hashlib.sha256(full).hexdigest()

        worker._receive_backup = receive
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(firmware, 'FLASH_BYTES', 4096):
            target = str(Path(directory) / 'new-backup')
            result = worker.do_backupDevice({'backupDir': target})
            self.assertTrue(result['verified'])
            self.assertTrue(result['flashCapacityVerified'])
            self.assertEqual(result['flashJedecId'], 'EF4018')
            self.assertIs(type(result['createdAt']), int)
            self.assertEqual(result['directory'], target)
            manifest = json.loads((Path(target) / 'manifest.json').read_text())
            self.assertTrue(manifest['verified'])
            firmware.validate_backup(target, manifest)
            self.assertTrue((Path(target) / 'boot-restore.kfpkg').is_file())
            self.assertTrue((Path(target) / 'full-flash-restore.kfpkg').is_file())

    def test_changed_full_flash_file_or_inventory_blocks_complete_backup(self):
        payload = b'synthetic unchanged firmware'
        header = b'\x02' + struct.pack('<I', len(payload))
        boot = header + payload + hashlib.sha256(header + payload).digest()
        full = boot.ljust(4096, b'\xff')
        user_data = b'current user program bytes'
        initial = [{'path': '/flash/main.py', 'directory': False,
                    'size': len(user_data), 'status': 'pending'}]
        for case in ('full-flash', 'file', 'inventory'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory, mock.patch.object(firmware, 'FLASH_BYTES', len(full)):
                worker = worker_module.DeviceWorker(output=io.StringIO())
                worker.firmware_module = firmware
                worker.transport = mock.Mock()
                worker.state.update(phase='connected', port='/dev/synthetic-backup-only',
                                    boardProfile='generic-k210')
                worker.session_id = 'synthetic-current-session'
                worker.flash_capacity_verified = True
                worker.flash_capacity_proof = {'testOnly': True, 'capacityBytes': len(full)}
                worker._ensure_flash_capacity = mock.Mock()
                worker._exec = mock.Mock()
                worker._fast_backup_serial = contextlib.nullcontext
                inventory_calls = []

                def inventory():
                    inventory_calls.append(True)
                    result = copy.deepcopy(initial)
                    if case == 'inventory' and len(inventory_calls) > 1:
                        result[0]['path'] = '/flash/new-program.py'
                    return result

                worker._backup_inventory = inventory
                full_hash_calls, file_hash_calls = [], []

                def flash_hash(size):
                    if size == len(full):
                        full_hash_calls.append(size)
                        if case == 'full-flash' and len(full_hash_calls) > 1:
                            return '0' * 64
                    return hashlib.sha256(full if size == len(full) else boot).hexdigest()

                worker._remote_flash_hash = flash_hash
                worker._stat = lambda path: (0, 0, 0, 0, 0, 0, len(user_data))

                def file_hash(path, expected):
                    file_hash_calls.append(path)
                    return (len(user_data), '0' * 64 if case == 'file' and len(file_hash_calls) > 1
                            else hashlib.sha256(user_data).hexdigest())

                worker._remote_file_hash = file_hash

                def receive(destination, size, script, progress):
                    data = full if 'utils.flash_read(' in script else user_data
                    self.assertEqual(size, len(data))
                    with firmware.private_file(destination) as stream:
                        stream.write(data)
                    progress(size, size)
                    return hashlib.sha256(data).hexdigest()

                worker._receive_backup = receive
                target = str(Path(directory) / 'new-backup')
                with mock.patch.object(firmware, 'make_restore_packages') as packages:
                    with self.assertRaises(worker_module.DeviceError):
                        worker.do_backupDevice({'backupDir': target})
                packages.assert_not_called()
                self.assertIsNone(worker.backup_record)
                manifest = json.loads((Path(target) / 'manifest.json').read_text())
                self.assertFalse(manifest['verified'])
                self.assertGreaterEqual(len(full_hash_calls), 2)
                if case != 'full-flash':
                    self.assertGreaterEqual(len(file_hash_calls), 2)


if __name__ == '__main__':
    unittest.main()
