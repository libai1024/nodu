"""Compare captured board stdout with the frozen S0 and pre-flash evidence."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
MANIFEST = Path(
    "/Users/wangwei/.nodu/backups/"
    "2026-10-20T13-25-43-460Z-7829feb4/manifest.json"
)
baseline = json.loads((ROOT / "baseline.json").read_text())
manifest = json.loads(MANIFEST.read_text())
assert manifest["verified"] is True
assert manifest["flashVerification"]["verified"] is True
assert manifest["flashVerification"]["payloadSha256"] == (
    "6dde2d59adc344ee0c7f96300528b4feff5e36c160f5cc0066016389394f15fa"
)

expected = {}
expected_dirs = {"/flash", "/sd"}
for root, entries in baseline["listing"].items():
    assert entries is not None, "Missing baseline root: " + root
    for entry in entries:
        assert entry["path"] not in expected
        if entry["directory"]:
            expected_dirs.add(entry["path"])
        else:
            expected[entry["path"]] = {"size": entry["size"]}

backup_files = {
    entry["path"]: entry for entry in manifest["files"]
    if not entry["directory"]
}
assert set(backup_files) == set(expected), "S0/pre-flash file sets differ"
pre_flash_differences = []
for path, facts in expected.items():
    backup = backup_files[path]
    assert backup["status"] == "verified", path
    if path in baseline["hashes"]:
        captured = baseline["hashes"][path]
        assert "error" not in captured, path
        assert captured["size"] == facts["size"], path
        facts["sha256"] = captured["sha256"]
        facts["hashSource"] = "S0"
        if any(captured[key] != backup[key] for key in ("size", "sha256")):
            pre_flash_differences.append({
                "path": path, "baseline": captured,
                "preFlash": {key: backup[key] for key in ("size", "sha256")},
            })
    else:
        assert backup["size"] == facts["size"], path
        facts["sha256"] = backup["sha256"]
        facts["hashSource"] = "pre-flash backup only (S0 size/listing)"

capture_path = Path(sys.argv[1])
capture = capture_path.read_text()
records = [
    json.loads(line.split("NODU_INVENTORY:", 1)[1])
    for line in capture.splitlines() if line.startswith("NODU_INVENTORY:")
]
completed = [record for record in records if record["type"] == "complete"]
assert len(completed) == 1 and not completed[0]["errors"], completed
actual = {}
actual_dirs = set()
for record in records:
    if record["type"] == "file":
        assert record["path"] not in actual, "Duplicate file record"
        actual[record["path"]] = record
    elif record["type"] == "directory":
        assert record["path"] not in actual_dirs, "Duplicate directory record"
        actual_dirs.add(record["path"])
    else:
        assert record["type"] == "complete", record

changed = [
    {"path": path, "expected": facts, "actual": actual[path]}
    for path, facts in expected.items()
    if path in actual and any(
        facts[key] != actual[path][key] for key in ("size", "sha256")
    )
]
result = {
    "capture": str(capture_path),
    "captureSha256": hashlib.sha256(capture_path.read_bytes()).hexdigest(),
    "baselineFiles": len(expected),
    "baselineHashedFiles": len(baseline["hashes"]),
    "actualFiles": len(actual),
    "missing": sorted(set(expected) - set(actual)),
    "added": sorted(set(actual) - set(expected)),
    "changed": changed,
    "missingDirectories": sorted(expected_dirs - actual_dirs),
    "addedDirectories": sorted(actual_dirs - expected_dirs),
    "preFlashBaselineDifferences": pre_flash_differences,
    "hashProvenance": {path: facts["hashSource"] for path, facts in expected.items()},
}
result["identical"] = not any(
    result[key] for key in (
        "missing", "added", "changed", "missingDirectories", "addedDirectories"
    )
)
print(json.dumps(result, ensure_ascii=False, indent=2))
sys.exit(0 if result["identical"] else 1)
