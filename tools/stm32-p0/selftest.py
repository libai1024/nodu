#!/usr/bin/env python3
"""Exercise real compiler failures and upload-plan rejection; no hardware access."""
import json
from pathlib import Path
import subprocess
import sys

import validate as p0


def cli(*args, succeeds=True):
    result = subprocess.run([sys.executable, str(p0.HERE / 'validate.py'), *args],
                            cwd=p0.ROOT, capture_output=True, text=True, timeout=180)
    if (result.returncode == 0) != succeeds:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout + result.stderr


def main():
    source = p0.HERE / 'src/main.c'
    original = source.read_bytes()
    results = []
    try:
        cli('build', '--target', 'f103c8')
        first = json.loads((p0.EVIDENCE / 'f103c8-artifact.json').read_text())
        # A source line shift can preserve machine code while changing debug information.
        source.write_bytes(b'\n' + original)
        output = cli('plan', '--target', 'f103c8', succeeds=False)
        assert 'source changed' in output
        results.append('source-change plan rejected')
        cli('build', '--target', 'f103c8')
        second = json.loads((p0.EVIDENCE / 'f103c8-artifact.json').read_text())
        assert first['binarySha256'] == second['binarySha256']
        assert first['bundleSha256'] != second['bundleSha256']
        results.append('same BIN with changed ELF stored as distinct bundle')
        elf = p0.ROOT / second['artifact'] / 'firmware.elf'
        old_elf = elf.read_bytes()
        try:
            elf.chmod(0o644)
            elf.write_bytes(old_elf + b'P0 tamper sample')
            output = cli('plan', '--target', 'f103c8', succeeds=False)
            assert 'Artifact changed since build: firmware.elf' in output
            results.append('ELF tamper rejected even when BIN is unchanged')
        finally:
            elf.write_bytes(old_elf)
            elf.chmod(0o444)
        source.write_bytes(original + b'\n#error P0_expected_compile_failure\n')
        cli('build', '--target', 'f103c8', succeeds=False)
        output = cli('plan', '--target', 'f103c8', succeeds=False)
        assert 'No current successful build' in output
        results.append('failed real compile invalidated previous successful artifact')
        with p0.target_lock('f103c8'):
            output = cli('plan', '--target', 'f103c8', succeeds=False)
            assert 'Another build/plan owns f103c8' in output
        results.append('concurrent target ownership rejected')
    finally:
        source.write_bytes(original)
        cli('build', '--target', 'f103c8')
        cli('build', '--target', 'f407zg')
    for target in p0.TARGETS:
        cli('plan', '--target', target, '--transport', 'uart')
        cli('plan', '--target', target, '--transport', 'stlink')
    result = {'hardwareAccess': False, 'passed': results,
              'finalBuilds': ['f103c8', 'f407zg'], 'plansExecuted': False}
    (p0.EVIDENCE / 'selftest.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
