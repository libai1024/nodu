#!/usr/bin/env python3
"""P0 hardware test. Requires exactly one ST-LINK; backs up Flash before writing."""
import argparse
import json
import plistlib
import re
import subprocess
import time
from pathlib import Path

import validate as p0


def probes():
    tree = plistlib.loads(subprocess.check_output(['ioreg', '-r', '-c', 'IOUSBHostDevice', '-a']))
    found = []
    def visit(value):
        if isinstance(value, dict):
            if value.get('idVendor') == 0x0483 and value.get('idProduct') in (0x3748, 0x374b, 0x374a, 0x374d, 0x374e, 0x374f):
                found.append(value.get('USB Product Name', 'ST-LINK'))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(tree)
    return found


def openocd(target, commands, name):
    args = ['openocd', '-f', 'interface/stlink.cfg', '-f',
            f"target/{p0.TARGETS[target]['openocd']}.cfg"]
    for command in ['adapter speed 1000', 'init', *commands, 'shutdown']:
        args += ['-c', command]
    output = p0.run(args, log=p0.EVIDENCE / name)
    if 'Error:' in output:
        raise RuntimeError(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', required=True, choices=p0.TARGETS)
    parser.add_argument('--execute', action='store_true', help='write the built P0 application after backup')
    args = parser.parse_args()
    target = args.target
    # A failed new attempt must not leave an older "currently running" success record.
    result_path = p0.EVIDENCE / f'{target}-swd-result.json'
    result_path.unlink(missing_ok=True)
    run_id = str(time.time_ns())
    connected = probes()
    if len(connected) != 1:
        raise RuntimeError(f'Exactly one ST-LINK required, found {len(connected)}: {connected}')
    cap_address = 0x1ffff7e0 if target == 'f103c8' else 0x1fff7a22
    uid_address = 0x1ffff7e8 if target == 'f103c8' else 0x1fff7a10
    config = p0.TARGETS[target]
    guard = [
        f'if {{([mrw 0xe0042000] & 0xfff) != {config["id"]}}} {{error "Wrong target family"}}',
        f'if {{[lindex [read_memory {cap_address} 16 1] 0] != {config["flash"] // 1024}}} {{error "Wrong Flash capacity"}}',
    ]
    info = openocd(target, [*guard, 'flash banks', f'mdw {uid_address} 3'], f'{target}-identify.txt')
    print(info)
    uid_match = re.search(rf'0x{uid_address:08x}:\s+([0-9a-f]{{8}})\s+([0-9a-f]{{8}})\s+([0-9a-f]{{8}})', info, re.I)
    if not uid_match:
        raise RuntimeError('Could not read MCU UID')
    uid = uid_match.groups()
    guard += [f'if {{[mrw {uid_address + i * 4}] != 0x{word}}} {{error "Physical MCU changed"}}'
              for i, word in enumerate(uid)]
    if not args.execute:
        print('Identity verified; no Flash write requested.')
        return
    p0.environment()
    with p0.target_lock(target):
        p0.plan(target, 'stlink', None)
        record = json.loads((p0.EVIDENCE / f'{target}-artifact.json').read_text())
        artifact = p0.ROOT / record['artifact']
        directory = p0.LOCAL / 'backups' / f'{target}-{time.time_ns()}'
        directory.mkdir(parents=True)
        backup = directory / 'original.bin'
        openocd(target, ['reset halt', *guard,
                        f'dump_image {{{backup}}} 0x08000000 {config["flash"]}', 'resume'],
                f'{target}-backup.txt')
        if backup.stat().st_size != config['flash']:
            raise RuntimeError('Backup incomplete')
        backup_record = {'target': target, 'mcuUid': uid, 'backup': str(backup.relative_to(p0.ROOT)),
                         'bytes': backup.stat().st_size, 'sha256': p0.sha(backup)}
        (p0.EVIDENCE / f'{target}-backup.json').write_text(json.dumps(backup_record, indent=2) + '\n')
        readback = directory / 'p0-readback.bin'
        commands = ['reset halt', *guard,
                    f'flash write_image erase {{{artifact}/firmware.elf}}',
                    f'verify_image {{{artifact}/firmware.elf}}',
                    f'dump_image {{{readback}}} 0x08000000 {record["binaryBytes"]}',
                    'reset run', 'sleep 1200', f'mdw {record["statusAddress"]} 6',
                    'sleep 1200', f'mdw {record["statusAddress"]} 6']
        output = openocd(target, commands, f'{target}-program.txt')
        print(output)
        if p0.sha(readback) != record['binarySha256']:
            raise RuntimeError('Readback does not match immutable BIN')
        lines = output.splitlines()
        snapshots = []
        for i, line in enumerate(lines):
            if line.startswith(record['statusAddress'] + ':'):
                words = re.findall(r'\b[0-9a-fA-F]{8}\b', line.split(':', 1)[1])
                if len(words) < 6:
                    words += re.findall(r'\b[0-9a-fA-F]{8}\b', lines[i + 1].split(':', 1)[-1])
                snapshots.append([int(word, 16) for word in words[:6]])
        expected_target = 0x0103c8 if target == 'f103c8' else 0x0407a1
        expected_clock = 8000000 if target == 'f103c8' else 16000000
        if (len(snapshots) != 2 or any(len(s) != 6 or s[0] != 0x4e445550 or
                s[1] != expected_target or s[4] != expected_clock or s[5] != 0 for s in snapshots) or
                snapshots[1][2] <= snapshots[0][2] or snapshots[1][3] <= snapshots[0][3]):
            raise RuntimeError(f'Application heartbeat not proven: {snapshots}')
        result = {'runId': run_id, 'target': target, 'transport': 'stlink', 'mcuUid': uid,
                  'binarySha256': record['binarySha256'], 'bundleSha256': record['bundleSha256'],
                  'readback': 'passed', 'running': 'passed', 'snapshots': snapshots,
                  'originalBackup': backup_record, 'boardState': 'P0 firmware running'}
        result_path.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
