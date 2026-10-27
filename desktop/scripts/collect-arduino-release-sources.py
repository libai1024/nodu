#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Fetch the reviewed source lock and retain original license files without altering vendors.

The lock's coverage flags are review decisions. Download success never upgrades incomplete
coverage, and --require-complete fails while any release component has an unresolved gap.
Requires Python 3.11+ and curl on the build host only.
"""
import argparse
import concurrent.futures
import hashlib
import json
import pathlib
import re
import subprocess
import tarfile
import tempfile
import urllib.parse


def sha256(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def safe_path(root, value):
    parts = pathlib.PurePosixPath(value)
    if parts.is_absolute() or not value or "\\" in value or any(p in ("", ".", "..") for p in value.split("/")):
        raise ValueError(f"Invalid inventory path: {value}")
    destination = root.joinpath(*parts.parts)
    if not destination.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Inventory path escapes output: {value}")
    return destination


def fetch(root, item, verify_only):
    target = safe_path(root, item["path"])
    url = urllib.parse.urlsplit(item["url"])
    if url.scheme != "https" or not url.hostname or url.username or url.password:
        raise ValueError("Source URL must use credential-free HTTPS")
    if target.is_file() and target.stat().st_size == item["size"] and sha256(target) == item["sha256"]:
        return item
    if verify_only:
        raise ValueError(f"Missing or corrupt pinned source: {item['path']}")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, suffix=".part", delete=False) as handle:
        temporary = pathlib.Path(handle.name)
    try:
        subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location", "--retry", "2", "--retry-all-errors",
                        "--connect-timeout", "20", "--max-time", "300", "--max-filesize", str(item["size"]),
                        item["url"], "--output", str(temporary)], check=True)
        if temporary.stat().st_size != item["size"] or sha256(temporary) != item["sha256"]:
            raise ValueError(f"Source checksum mismatch: {item['path']}")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)
    return item


def license_files(root, item):
    result = []
    archive = safe_path(root, item["path"])
    namespace = re.sub(r"\.tar\.(?:gz|xz|bz2)$", "", archive.name)
    with tarfile.open(archive) as opened:
        for member in opened:
            if not member.isfile() or member.size > 2 * 1024 * 1024:
                continue
            name = pathlib.PurePosixPath(member.name).name
            if not re.match(r"^(?:COPYING|COPYRIGHT|LICENSE|LICENCE|NOTICE)(?:$|[.\-_])", name, re.I):
                continue
            parts = pathlib.PurePosixPath(member.name).parts
            if len(parts) < 2:
                continue
            relative = "/".join(("licenses", namespace, *parts[1:]))
            destination = safe_path(root, relative)
            data = opened.extractfile(member).read()
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists() or destination.read_bytes() != data:
                destination.write_bytes(data)
            result.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
                           "url": item["url"] + "#" + urllib.parse.quote(member.name), "kind": "license",
                           "sourceArchive": item["path"], "archiveMember": member.name})
    return result


def collect(lock, output, verify_only=False, require_complete=False):
    if lock.get("schemaVersion") != 1:
        raise ValueError("Unsupported source lock schema")
    output.mkdir(parents=True, exist_ok=True)
    entries = lock["files"]
    paths = {item["path"] for item in entries}
    if len(paths) != len(entries):
        raise ValueError("Duplicate source inventory paths")
    for item in entries:
        if item["kind"] != "source" or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"]) or item["size"] <= 0:
            raise ValueError("Invalid pinned source record")
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(lambda item: fetch(output, item, verify_only), entries))
    files = list(entries)
    for item in entries:
        files.extend(license_files(output, item))
    coverage = lock["coverage"]
    if len({item["component"] for item in coverage}) != len(coverage):
        raise ValueError("Duplicate component coverage")
    for item in coverage:
        if not isinstance(item["complete"], bool) or not set(item["files"]).issubset(paths):
            raise ValueError(f"Invalid coverage record: {item['component']}")
        if item["complete"] and not item["files"]:
            raise ValueError("Complete coverage requires actual source archives")
    gaps = [item["component"] for item in coverage if not item["complete"]]
    manifest = {"schemaVersion": 1, "scope": lock["scope"], "releaseReady": not gaps,
                "files": sorted(files, key=lambda item: item["path"]), "coverage": coverage,
                "notes": lock["notes"]}
    destination = output / "source-manifest.json"
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(destination)
    print(json.dumps({"sourceArchives": len(entries), "sourceBytes": sum(item["size"] for item in entries),
                      "licenseFiles": len(files) - len(entries), "completeComponents": len(coverage) - len(gaps),
                      "totalComponents": len(coverage), "releaseReady": not gaps, "unresolved": gaps}, ensure_ascii=False))
    if require_complete and gaps:
        raise ValueError("Corresponding-source closure remains incomplete: " + ", ".join(gaps))
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    desktop = pathlib.Path(__file__).resolve().parent.parent
    parser.add_argument("--lock", type=pathlib.Path, default=desktop / "scripts/arduino-release-sources.lock.json")
    parser.add_argument("--out", type=pathlib.Path, default=desktop / ".tools/arduino-release-sources")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--require-complete", action="store_true")
    args = parser.parse_args()
    try:
        collect(json.loads(args.lock.read_text()), args.out.resolve(), args.verify_only, args.require_complete)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, str(error) + "\n")
