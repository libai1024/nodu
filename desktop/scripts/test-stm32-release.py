#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Regression checks for the offline STM32 release producer."""
import importlib.util
import pathlib
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('release', pathlib.Path(__file__).with_name('prepare-stm32-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class Inputs(unittest.TestCase):
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
