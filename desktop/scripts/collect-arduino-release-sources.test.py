#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Offline integrity tests for the corresponding-source release gate."""
import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest
import zipfile
from unittest import mock

spec = importlib.util.spec_from_file_location("source_collector", pathlib.Path(__file__).with_name("collect-arduino-release-sources.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class SourceIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.archive = self.root / "sources/fixture.tar.gz"
        self.archive.parent.mkdir()
        self.write_archive({"fixture/COPYING": b"Original license\n", "fixture/main.c": b"int main(void) { return 0; }\n"})
        self.lock = {
            "schemaVersion": 1, "scope": "fixture", "notes": [],
            "files": [{"path": "sources/fixture.tar.gz", "sha256": collector.sha256(self.archive),
                       "size": self.archive.stat().st_size, "url": "https://example.invalid/fixture.tar.gz", "kind": "source"}],
            "coverage": [{"component": "fixture@1", "files": ["sources/fixture.tar.gz"], "complete": True}],
        }

    def write_archive(self, members):
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, data in members.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))

    def collect(self, **options):
        with contextlib.redirect_stdout(io.StringIO()), mock.patch.object(collector.subprocess, "run", side_effect=AssertionError("Verification must not use network")):
            return collector.collect(self.lock, self.root, verify_only=True, **options)

    def test_retains_original_archive_and_license_bytes_without_network(self):
        original = self.archive.read_bytes()
        manifest = self.collect(require_complete=True)
        self.assertTrue(manifest["releaseReady"])
        self.assertEqual(self.archive.read_bytes(), original)
        license_record = next(item for item in manifest["files"] if item["kind"] == "license")
        self.assertEqual((self.root / license_record["path"]).read_bytes(), b"Original license\n")
        self.assertEqual(license_record["sha256"], hashlib.sha256(b"Original license\n").hexdigest())
        self.assertFalse((self.root / "fixture/main.c").exists())

    def test_same_size_corruption_is_rejected(self):
        changed = bytearray(self.archive.read_bytes())
        changed[-1] ^= 1
        self.archive.write_bytes(changed)
        with self.assertRaisesRegex(ValueError, "corrupt pinned source"):
            self.collect()
        self.assertFalse((self.root / "source-manifest.json").exists())

    def test_registry_license_is_retained_but_cannot_replace_source(self):
        license_path = self.root / "registry-LICENSE.txt"
        license_path.write_bytes(b"Original registry license\n")
        record = {"path": license_path.name, "kind": "license", "size": license_path.stat().st_size,
                  "sha256": collector.sha256(license_path), "url": "https://example.invalid/license.txt"}
        self.lock["files"].append(record)
        self.lock["coverage"][0]["files"].append(license_path.name)
        manifest = self.collect(require_complete=True)
        self.assertIn(record, manifest["files"])
        self.lock["coverage"][0]["files"] = [license_path.name]
        with self.assertRaisesRegex(ValueError, "requires actual source archives"):
            self.collect(require_complete=True)

    def test_incomplete_review_cannot_be_promoted_by_valid_download(self):
        self.lock["coverage"][0]["complete"] = False
        self.assertFalse(self.collect()["releaseReady"])
        with self.assertRaisesRegex(ValueError, "closure remains incomplete"):
            self.collect(require_complete=True)
        saved = json.loads((self.root / "source-manifest.json").read_text())
        self.assertFalse(saved["coverage"][0]["complete"])
        self.assertFalse(saved["releaseReady"])

    def test_inventory_traversal_and_symlink_escape_are_rejected(self):
        for unsafe in ["../source.tar.gz", "/source.tar.gz", "sources/../source.tar.gz", "sources\\source.tar.gz"]:
            with self.subTest(path=unsafe), self.assertRaises(ValueError):
                collector.safe_path(self.root, unsafe)
        with tempfile.TemporaryDirectory() as outside:
            (self.root / "escape").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "escapes output"):
                collector.safe_path(self.root, "escape/COPYING")

    def test_archive_license_traversal_is_rejected(self):
        self.write_archive({"fixture/../../../COPYING": b"must not escape"})
        item = self.lock["files"][0]
        item.update(sha256=collector.sha256(self.archive), size=self.archive.stat().st_size)
        with self.assertRaisesRegex(ValueError, "Invalid inventory path"):
            self.collect()

    def test_untrusted_url_is_rejected_even_when_archive_is_cached(self):
        for url in ["http://example.invalid/source", "https://user:password@example.invalid/source", "file:///source", "https:///source"]:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "credential-free HTTPS"):
                self.lock["files"][0]["url"] = url
                self.collect()

    def test_duplicate_coverage_is_rejected(self):
        self.lock["coverage"].append(dict(self.lock["coverage"][0]))
        with self.assertRaisesRegex(ValueError, "Duplicate component coverage"):
            self.collect()

    def test_go_module_zip_preserves_license_and_rejects_traversal(self):
        archive = self.root / 'sources/module.zip'
        item = dict(self.lock['files'][0], path='sources/module.zip')
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('example.org/module@v1.0/LICENSE', b'Unmodified module license')
            z.writestr('example.org/module@v1.0/main.go', b'package module')
            z.writestr('LICENSE.txt', b'Root component license')
        records = collector.license_files(self.root, item)
        self.assertEqual(len(records), 2)
        self.assertEqual((self.root / records[0]['path']).read_bytes(), b'Unmodified module license')
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('module/../../../LICENSE', b'escape')
        with self.assertRaisesRegex(ValueError, 'Invalid inventory path'):
            collector.license_files(self.root, item)


if __name__ == "__main__":
    unittest.main()
