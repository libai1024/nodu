#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Regression checks for the offline STM32 release producer."""
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import zipfile

spec = importlib.util.spec_from_file_location('release', pathlib.Path(__file__).with_name('prepare-stm32-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class Inputs(unittest.TestCase):
    def test_openocd_usb_selection_gate_is_configuration_only(self):
        with patch.object(release.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 0, '', 'NODU_USB_LOCATION_READY\n')) as run:
            release.check_usb_location(pathlib.Path('/toolkit'))
        args = run.call_args.args[0]
        commands = [args[i + 1] for i, arg in enumerate(args) if arg == '-c']
        self.assertEqual(commands, ['adapter usb location 1-1', 'echo NODU_USB_LOCATION_READY', 'shutdown'])
        self.assertNotIn('init', args)

    def test_openocd_without_usb_selection_is_rejected(self):
        with patch.object(release.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, [])):
            with self.assertRaises(subprocess.CalledProcessError):
                release.check_usb_location(pathlib.Path('/toolkit'))
        with patch.object(release.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, '', '')):
            with self.assertRaisesRegex(RuntimeError, 'USB location'):
                release.check_usb_location(pathlib.Path('/toolkit'))

    def test_corrupt_offline_asset_is_not_used(self):
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / 'asset'
            p.write_bytes(b'wrong')
            with self.assertRaisesRegex(RuntimeError, 'invalid offline'):
                release.download({'size': 5, 'sha256': '0' * 64}, p, True)

    def test_valid_offline_asset_needs_no_network(self):
        with tempfile.TemporaryDirectory() as d:
            p = pathlib.Path(d) / 'asset'
            p.write_bytes(b'pinned')
            self.assertEqual(release.download({'size': 6, 'sha256': release.digest(p)}, p, True), p)

    def test_zip_traversal_is_rejected_before_extract(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d) / 'output'
            root.mkdir()
            archive = pathlib.Path(d) / 'attack.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('valid', 'data')
                z.writestr('../escape', 'data')
            with self.assertRaisesRegex(ValueError, 'Unsafe ZIP'):
                release.extract(archive, root)
            self.assertFalse((root / 'valid').exists())
            self.assertFalse((root.parent / 'escape').exists())

    def test_zip_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = pathlib.Path(d)
            archive = root / 'attack.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                info = zipfile.ZipInfo('link')
                info.external_attr = 0o120777 << 16
                z.writestr(info, '/tmp/elsewhere')
            with self.assertRaisesRegex(ValueError, 'symlink'):
                release.extract(archive, root)


if __name__ == '__main__':
    unittest.main()
