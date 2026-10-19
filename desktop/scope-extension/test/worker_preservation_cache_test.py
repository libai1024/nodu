# SPDX-License-Identifier: MIT
"""Private temporary files and synthetic current-state hashes; no serial I/O."""

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest import mock


RESOURCES = Path(__file__).resolve().parents[1] / 'resources'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


firmware = load('preservation_cache_firmware', RESOURCES / 'nodu_firmware.py')
worker_module = load('preservation_cache_worker', RESOURCES / 'nodu_device_worker.py')


def sha(data):
    return hashlib.sha256(data).hexdigest()


class PreservationCacheTests(unittest.TestCase):
    def fixture(self, root):
        worker = worker_module.DeviceWorker(output=io.StringIO())
        worker.firmware_module = firmware
        worker.transport = mock.Mock()
        worker.state.update(port='/dev/synthetic-cache-only', firmware='synthetic firmware',
                            phase='connected', boardProfile='generic-k210')
        worker.session_id = 'current-synthetic-session'
        payload = b'synthetic installed firmware' * 7
        header = b'\x02' + struct.pack('<I', len(payload))
        boot = header + payload + hashlib.sha256(header + payload).digest()
        current = {'prefix': boot.ljust(4096, b'\xff'),
                   'files': {'/flash/main.py': b'PRIVATE_STARTUP\x00BYTES', '/sd/empty.bin': b''}}
        inventory = [{'path': path, 'directory': False, 'size': len(data), 'status': 'pending'}
                     for path, data in current['files'].items()]
        worker._exec = mock.Mock(return_value=repr(header))
        worker._backup_inventory = mock.Mock(side_effect=lambda: copy.deepcopy(inventory))
        worker._fast_backup_serial = contextlib.nullcontext
        worker._transfer_preflight_plan = mock.Mock(return_value=None)
        worker._stat = mock.Mock(side_effect=lambda path:
                                 (0, 0, 0, 0, 0, 0, len(current['files'][path])))
        worker._remote_file_hash = mock.Mock(side_effect=lambda path, expected:
                                            (len(current['files'][path]), sha(current['files'][path])))
        worker._remote_flash_hash = mock.Mock(side_effect=lambda size:
                                             sha(current['prefix'][:size]))
        worker._receive_snapshot = mock.Mock(side_effect=self.receive_snapshot(current))
        previous = root / '100-old.pre-probe'
        previous.mkdir()
        entries = []
        for path, data in current['files'].items():
            relative = 'files/' + path.lstrip('/')
            target = previous / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            entries.append({'path': path, 'directory': False, 'size': len(data),
                            'status': 'verified', 'sha256': sha(data), 'local': relative})
        (previous / 'flash-prefix-candidate.raw.bin').write_bytes(current['prefix'])
        old = {'version': 1, 'createdAt': 100, 'stateSaved': True,
               'scope': 'user-files-current-boot-and-unverified-flash-prefix',
               'port': worker.state['port'], 'firmware': worker.state['firmware'],
               'sessionBeforeProbe': 'old-synthetic-session', 'candidateFlashBytes': 4096,
               'candidateFlashSha256': sha(current['prefix']),
               'completeFlashBackup': False, 'flashCapacityVerified': False, 'files': entries}
        metadata = previous / 'manifest.json'
        metadata.write_text(json.dumps(old), encoding='utf-8')
        return worker, current, inventory, previous, metadata.read_bytes(), boot

    def receive_snapshot(self, current):
        def receive(destination, size, remote_path=None, progress=lambda received, total: None):
            data = current['prefix'] if remote_path is None else current['files'][remote_path]
            self.assertEqual(size, len(data))
            with firmware.private_file(destination) as stream:
                stream.write(data)
            progress(size, size)
            return sha(data)
        return receive

    def test_cache_requires_saved_matching_unverified_scope_and_chooses_newest_valid(self):
        mutations = ({'stateSaved': False}, {'stateSaved': 1}, {'port': '/dev/other'},
                     {'firmware': 'other'}, {'scope': 'complete-backup'},
                     {'candidateFlashBytes': 4095}, {'completeFlashBackup': True},
                     {'flashCapacityVerified': True}, {'createdAt': True},
                     {'files': {}}, {'version': 2})
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(firmware, 'FLASH_BYTES', 4096):
            root = Path(directory)
            worker, _, _, previous, raw, _ = self.fixture(root)
            current_directory = root / '900-new.pre-probe'
            current_directory.mkdir()
            (current_directory / 'manifest.json').write_bytes(raw)
            candidate = root / '800-candidate.pre-probe'
            candidate.mkdir()
            old = json.loads(raw)
            for mutation in mutations:
                with self.subTest(mutation=mutation):
                    value = dict(old, createdAt=200)
                    value.update(mutation)
                    (candidate / 'manifest.json').write_text(json.dumps(value))
                    selected = worker._preservation_cache(current_directory)
                    self.assertEqual(selected['directory'], previous)
                    self.assertEqual(selected['manifestSha256'], sha(raw))
            (candidate / 'manifest.json').write_text(json.dumps(dict(old, createdAt=200)))
            self.assertEqual(worker._preservation_cache(current_directory)['directory'], candidate)
            (candidate / 'manifest.json').write_text('{invalid json')
            (previous / 'manifest.json').unlink()
            self.assertIsNone(worker._preservation_cache(current_directory))

    def test_cache_rejects_symlink_directory_manifest_and_oversized_metadata(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(firmware, 'FLASH_BYTES', 4096):
            root = Path(directory)
            worker, _, _, previous, raw, _ = self.fixture(root)
            current = root / '900-new.pre-probe'
            metadata = previous / 'manifest.json'
            outside = root / 'outside.json'
            outside.write_bytes(raw)
            metadata.unlink()
            metadata.symlink_to(outside)
            self.assertIsNone(worker._preservation_cache(current))
            metadata.unlink()
            metadata.write_bytes(b' ' * (2 * 1024 * 1024 + 1))
            self.assertIsNone(worker._preservation_cache(current))
            metadata.write_bytes(raw)
            renamed = root / 'ordinary-directory'
            previous.rename(renamed)
            previous.symlink_to(renamed, target_is_directory=True)
            self.assertIsNone(worker._preservation_cache(current))

    def test_cached_source_rejects_tampering_escape_and_every_symlink_component(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker, _, _, previous, _, _ = self.fixture(root)
            cache = {'directory': previous}
            source = previous / 'files/flash/main.py'
            data = source.read_bytes()
            self.assertEqual(worker._cached_preservation_source(cache, 'files/flash/main.py', len(data), sha(data)), source)
            for relative, size, digest in (('../outside.bin', len(data), sha(data)),
                    (str(root / 'outside.bin'), len(data), sha(data)),
                    ('files/flash/main.py', True, sha(data)),
                    ('files/flash/main.py', -1, sha(data)),
                    ('files/flash/main.py', len(data) + 1, sha(data)),
                    ('files/flash/main.py', len(data), '0' * 64),
                    ('files/flash/main.py', len(data), 'not a digest')):
                with self.subTest(relative=relative, size=size):
                    self.assertIsNone(worker._cached_preservation_source(cache, relative, size, digest))
            (root / 'outside.bin').write_bytes(data)
            source.unlink()
            source.symlink_to(root / 'outside.bin')
            self.assertIsNone(worker._cached_preservation_source(cache, 'files/flash/main.py', len(data), sha(data)))
            source.unlink()
            source.write_bytes(data)
            internal = previous / 'internal'
            source.parent.rename(internal)
            source.parent.symlink_to(internal, target_is_directory=True)
            self.assertIsNone(worker._cached_preservation_source(cache, 'files/flash/main.py', len(data), sha(data)))

    def test_private_copy_is_exclusive_and_rejects_bad_length_or_target_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker = worker_module.DeviceWorker(output=io.StringIO())
            worker.firmware_module = firmware
            source, target = root / 'source.bin', root / 'copy.bin'
            data = b'original opaque bytes'
            source.write_bytes(data)
            worker._copy_revalidated_preservation(source, target, len(data), sha(data))
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                worker._copy_revalidated_preservation(source, target, len(data), sha(data))
            self.assertEqual(target.read_bytes(), data)
            for label, expected_size, digest in (('truncated', len(data) + 1, sha(data)),
                    ('grown', len(data) - 1, sha(data)), ('bad-hash', len(data), '0' * 64)):
                with self.subTest(label=label), self.assertRaises(worker_module.DeviceError):
                    worker._copy_revalidated_preservation(source, root / label, expected_size, digest)
            self.assertEqual(source.read_bytes(), data)

    def test_cancel_and_unread_source_mutation_never_produce_an_accepted_copy(self):
        for case in ('cancel', 'mutation'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                worker = worker_module.DeviceWorker(output=io.StringIO())
                worker.firmware_module = firmware
                data = b'a' * (1024 * 1024) + b'b' * (1024 * 1024)
                source, target = root / 'source.bin', root / 'copy.bin'
                source.write_bytes(data)
                cancellation = worker_module.Cancelled('synthetic copying cancellation')
                count = 0

                def check():
                    nonlocal count
                    count += 1
                    if count == 2:
                        if case == 'cancel':
                            raise cancellation
                        with source.open('r+b') as changed:
                            changed.seek(1024 * 1024)
                            changed.write(b'c' * (1024 * 1024))

                worker.check = check
                with self.assertRaises(worker_module.Cancelled if case == 'cancel' else worker_module.DeviceError) as error:
                    worker._copy_revalidated_preservation(source, target, len(data), sha(data))
                if case == 'cancel':
                    self.assertIs(error.exception, cancellation)
                    self.assertEqual(target.stat().st_size, 1024 * 1024)
                else:
                    self.assertNotEqual(sha(target.read_bytes()), sha(data))
                self.assertGreaterEqual(count, 2)

    def test_reuse_revalidates_current_hashes_and_records_current_session_without_mutating_history(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(firmware, 'FLASH_BYTES', 4096):
            root = Path(directory)
            worker, current, _, previous, old_raw, boot = self.fixture(root)
            worker._receive_snapshot.side_effect = AssertionError('No serial retransfers after exact revalidation')
            saved = worker._preserve_before_probe(str(root / 'new-backup'))
            manifest, target = saved['manifest'], Path(saved['directory'])
            self.assertTrue(manifest['stateSaved'])
            self.assertFalse(manifest['completeFlashBackup'])
            self.assertFalse(manifest['flashCapacityVerified'])
            self.assertEqual(manifest['sessionBeforeProbe'], worker.session_id)
            self.assertEqual(manifest['reuseSource']['session'], worker.session_id)
            self.assertEqual(manifest['reuseSource']['manifestSha256'], sha(old_raw))
            self.assertFalse(manifest['reuseSource']['capacityEvidence'])
            self.assertFalse(manifest['prefixCopySource']['capacityEvidence'])
            for entry in manifest['files']:
                self.assertEqual(entry['copySource']['session'], worker.session_id)
                original, copied = previous / entry['local'], target / entry['local']
                self.assertEqual(copied.read_bytes(), current['files'][entry['path']])
                self.assertNotEqual(copied.stat().st_ino, original.stat().st_ino)
                self.assertEqual(stat.S_IMODE(copied.stat().st_mode), 0o600)
            self.assertEqual((target / 'original-boot-region.raw.bin').read_bytes(), boot)
            self.assertEqual(worker._remote_flash_hash.call_args_list,
                             [mock.call(4096), mock.call(4096), mock.call(len(boot))])
            expected_file_checks = [mock.call(path, len(data)) for path, data in current['files'].items()]
            self.assertEqual(worker._remote_file_hash.call_args_list, expected_file_checks * 2)
            self.assertEqual(worker._backup_inventory.call_count, 2)
            self.assertEqual((previous / 'manifest.json').read_bytes(), old_raw)
            self.assertFalse(worker.flash_capacity_verified)
            self.assertIsNone(worker.backup_record)
            worker.transport.close.assert_not_called()
            self.assertNotIn('PRIVATE_STARTUP', worker.output.getvalue())

    def test_local_or_current_remote_mismatch_falls_back_to_fresh_snapshot(self):
        for case in ('local-file', 'remote-file', 'local-prefix', 'remote-prefix'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory, \
                    mock.patch.object(firmware, 'FLASH_BYTES', 4096):
                root = Path(directory)
                worker, current, _, previous, old_raw, boot = self.fixture(root)
                if case == 'local-file':
                    (previous / 'files/flash/main.py').write_bytes(b'x' * len(current['files']['/flash/main.py']))
                elif case == 'remote-file':
                    current['files']['/flash/main.py'] = b'y' * len(current['files']['/flash/main.py'])
                elif case == 'local-prefix':
                    (previous / 'flash-prefix-candidate.raw.bin').write_bytes(b'x' * 4096)
                else:
                    current['prefix'] = boot.ljust(4096, b'\xfe')
                saved = worker._preserve_before_probe(str(root / 'new-backup'))
                calls = worker._receive_snapshot.call_args_list
                self.assertEqual(len(calls), 1)
                if case.endswith('file'):
                    self.assertEqual(calls[0].args[2], '/flash/main.py')
                else:
                    self.assertEqual(len(calls[0].args), 2)
                    self.assertEqual(calls[0].args[1], 4096)
                self.assertTrue(saved['manifest']['stateSaved'])
                self.assertEqual((previous / 'manifest.json').read_bytes(), old_raw)

    def test_reuse_does_not_skip_final_prefix_boot_file_or_inventory_stability_checks(self):
        for case in ('prefix', 'boot', 'file', 'inventory'):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory, \
                    mock.patch.object(firmware, 'FLASH_BYTES', 4096):
                root = Path(directory)
                worker, current, inventory, previous, old_raw, boot = self.fixture(root)
                worker._receive_snapshot.side_effect = AssertionError('The unchanged source is already cached')
                if case in ('prefix', 'boot'):
                    count = 0

                    def flash_hash(size):
                        nonlocal count
                        count += 1
                        if (case == 'prefix' and count == 2) or (case == 'boot' and size == len(boot)):
                            return '0' * 64
                        return sha(current['prefix'][:size])

                    worker._remote_flash_hash.side_effect = flash_hash
                elif case == 'file':
                    calls = 0

                    def file_hash(path, expected):
                        nonlocal calls
                        calls += 1
                        return len(current['files'][path]), ('0' * 64 if calls > 2 else sha(current['files'][path]))

                    worker._remote_file_hash.side_effect = file_hash
                else:
                    changed = copy.deepcopy(inventory)
                    changed[0]['path'] = '/flash/changed.py'
                    worker._backup_inventory.side_effect = [copy.deepcopy(inventory), changed]
                with self.assertRaises(worker_module.DeviceError):
                    worker._preserve_before_probe(str(root / 'new-backup'))
                failed = json.loads((root / 'new-backup.pre-probe/manifest.json').read_text())
                self.assertFalse(failed['stateSaved'])
                self.assertFalse(failed['flashCapacityVerified'])
                self.assertEqual((previous / 'manifest.json').read_bytes(), old_raw)
                worker.transport.close.assert_not_called()

    def test_complete_backup_still_takes_a_full_snapshot_after_successful_cache_reuse(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(firmware, 'FLASH_BYTES', 4096):
            root = Path(directory)
            worker, current, _, _, _, _ = self.fixture(root)
            worker.pre_probe_record = worker._preserve_before_probe(str(root / 'before-probe'))
            worker._receive_snapshot.reset_mock()
            worker.flash_capacity_verified = True
            worker.flash_capacity_proof = {'testOnly': True, 'jedecId': 'EF4018', 'capacityBytes': 4096}
            worker._ensure_flash_capacity = mock.Mock()
            result = worker.do_backupDevice({'backupDir': str(root / 'full-backup')})
            self.assertTrue(result['verified'])
            calls = worker._receive_snapshot.call_args_list
            self.assertEqual(calls[0].args[1], 4096)
            self.assertEqual(len(calls[0].args), 2)
            self.assertEqual([call.args[2] for call in calls[1:]], list(current['files']))
            manifest = json.loads((root / 'full-backup/manifest.json').read_text())
            self.assertTrue(manifest['snapshotVerification']['inventoryUnchanged'])
            self.assertEqual(manifest['snapshotVerification']['filesVerified'], len(current['files']))
            firmware.validate_backup(root / 'full-backup', manifest)


if __name__ == '__main__':
    unittest.main()
