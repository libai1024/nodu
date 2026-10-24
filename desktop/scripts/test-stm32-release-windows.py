#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
import importlib.util
import pathlib
import struct
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location('release_windows', pathlib.Path(__file__).with_name('prepare-stm32-release-windows.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReleaseInputTests(unittest.TestCase):
    def test_reject_escaping_paths(self):
        for name in ['../secret', '/secret', 'C:/secret', 'a\\..\\secret', 'a/../../secret']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                MODULE.safe_name(name)

    def test_reject_duplicate_case_insensitive_members(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = pathlib.Path(directory) / 'bad.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('File', 'first')
                output.writestr('file', 'second')
            with self.assertRaises(ValueError):
                MODULE.unzip(archive, pathlib.Path(directory) / 'extract')

    def test_reject_symlink_members(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = pathlib.Path(directory) / 'bad.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                entry = zipfile.ZipInfo('link')
                entry.external_attr = 0o120777 << 16
                output.writestr(entry, '../secret')
            with self.assertRaises(ValueError):
                MODULE.unzip(archive, pathlib.Path(directory) / 'extract')

    def test_reject_changed_source(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'source'
            file.write_bytes(b'expected')
            record = {'size': file.stat().st_size, 'sha256': MODULE.sha(file)}
            self.assertEqual(MODULE.verified(file, record), file)
            file.write_bytes(b'modified')
            with self.assertRaises(ValueError):
                MODULE.verified(file, record)

    def test_pe_architecture(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'tool.exe'
            head = bytearray(64)
            head[:2] = b'MZ'
            struct.pack_into('<I', head, 60, 64)
            file.write_bytes(head + b'PE\0\0\x64\x86')
            MODULE.pe_x64(file)
            file.write_bytes(head + b'PE\0\0\x4c\x01')
            with self.assertRaises(ValueError):
                MODULE.pe_x64(file)


if __name__ == '__main__':
    unittest.main()
