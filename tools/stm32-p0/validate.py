#!/usr/bin/env python3
"""Reproducible STM32 P0 builds and upload plans; never flashes implicitly."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
LOCAL = ROOT / '.local/stm32-p0'
EVIDENCE = HERE / 'evidence'
LOCK = json.loads((HERE / 'toolchain.lock.json').read_text())
ARM = LOCAL / 'tools' / LOCK['tools']['armGnu']['archive'].removesuffix('.tar.xz')
TARGETS = {
    'f103c8': {'family': 'f1', 'flash': 64 * 1024, 'ram': 20 * 1024,
               'openocd': 'stm32f1x', 'cpu': '-mcpu=cortex-m3', 'id': 0x410},
    'f407zg': {'family': 'f4', 'flash': 1024 * 1024, 'ram': 128 * 1024,
               'openocd': 'stm32f4x', 'cpu': '-mcpu=cortex-m4', 'id': 0x413},
}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_hashes():
    files = sorted(HERE.glob('src/*.c')) + sorted(HERE.glob('linker/*.ld'))
    files += [HERE / 'CMakeLists.txt', HERE / 'cmake/arm-gcc.cmake', HERE / 'toolchain.lock.json']
    return {str(p.relative_to(ROOT)): sha(p) for p in files}


@contextmanager
def target_lock(target):
    LOCAL.mkdir(parents=True, exist_ok=True)
    with (LOCAL / f'{target}.lock').open('a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError(f'Another build/plan owns {target}') from error
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def run(args, log=None, check=True):
    result = subprocess.run([str(x) for x in args], cwd=ROOT, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    if log:
        with Path(log).open('a') as output:
            output.write(json.dumps([str(x) for x in args]) + '\n' + result.stdout)
            output.write(f'\nexitCode={result.returncode}\n')
    if check and result.returncode:
        raise RuntimeError(result.stdout)
    return result.stdout


def verify_sdk(family):
    sdk = LOCAL / 'sdk' / f'cube-{family}'
    pin = LOCK['sdk'][family]
    paths = {
        sdk: pin['commit'],
        sdk / f'Drivers/STM32{family.upper()}xx_HAL_Driver': pin['halCommit'],
        sdk / f'Drivers/CMSIS/Device/ST/STM32{family.upper()}xx': pin['deviceCommit'],
    }
    for path, expected in paths.items():
        actual = run(['git', '-C', path, 'rev-parse', 'HEAD']).strip()
        if actual != expected or run(['git', '-C', path, 'status', '--porcelain']).strip():
            raise RuntimeError(f'SDK pin or worktree mismatch: {path}')
    return sdk


def environment():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('This P0 lock is validated only for macOS arm64')
    versions = {}
    checks = [('gcc', ARM / 'bin/arm-none-eabi-gcc', LOCK['tools']['armGnu']['gccVersion']),
              ('gdb', ARM / 'bin/arm-none-eabi-gdb', '15.2.90.20241130'),
              ('cmake', shutil.which('cmake'), LOCK['tools']['cmake']),
              ('ninja', shutil.which('ninja'), LOCK['tools']['ninja']),
              ('openocd', shutil.which('openocd'), LOCK['tools']['openocd']['version'])]
    for name, path, expected in checks:
        if not path:
            raise RuntimeError(f'Missing tool: {name}')
        output = run([path, '--version'])
        if not re.search(r'(?<![0-9.])' + re.escape(expected) + r'(?![0-9.])', output):
            raise RuntimeError(f'Tool version mismatch: {name}: {output}')
        versions[name] = {'version': output.splitlines()[0], 'path': str(Path(path).resolve()),
                          'binarySha256': sha(path)}
    # A nonexistent path exercises the executable without opening any real device.
    path = shutil.which('stm32flash')
    if not path:
        raise RuntimeError('Missing stm32flash')
    output = run([path, '-b', '115200', '-m', '8e1', LOCAL / 'nonexistent-port'], check=False)
    if 'stm32flash 0.7' not in output:
        raise RuntimeError(f'stm32flash version not confirmed: {output}')
    versions['stm32flash'] = {'version': '0.7', 'path': str(Path(path).resolve()),
                             'binarySha256': sha(path), 'cliSmokeOnly': output}
    archive = LOCAL / 'downloads' / LOCK['tools']['armGnu']['archive']
    if sha(archive) != LOCK['tools']['armGnu']['sha256']:
        raise RuntimeError('Arm archive checksum mismatch')
    for family in ('f1', 'f4'):
        verify_sdk(family)
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    (EVIDENCE / 'environment.json').write_text(json.dumps(versions, indent=2) + '\n')
    print(json.dumps(versions, indent=2))


def build(target):
    config = TARGETS[target]
    sdk = verify_sdk(config['family'])
    directory = LOCAL / 'build' / target
    log = EVIDENCE / f'{target}-build.txt'
    record_path = EVIDENCE / f'{target}-artifact.json'
    # Failed or interrupted builds must not leave an apparently current upload record.
    record_path.unlink(missing_ok=True)
    inputs_before = source_hashes()
    log.write_text('')
    run(['cmake', '-S', HERE, '-B', directory, '-G', 'Ninja',
         f'-DCMAKE_TOOLCHAIN_FILE={HERE}/cmake/arm-gcc.cmake',
         f'-DARM_TOOLCHAIN_ROOT={ARM}', f'-DNODU_TARGET={target}', f'-DSDK_ROOT={sdk}'], log)
    run(['cmake', '--build', directory], log)
    if inputs_before != source_hashes():
        raise RuntimeError('Source changed during build; build again')
    verify_sdk(config['family'])
    binary = directory / 'firmware.bin'
    data = binary.read_bytes()
    stack, reset = struct.unpack_from('<II', data)
    if not (0x20000000 < stack <= 0x20000000 + config['ram'] and
            reset & 1 and 0x08000000 <= (reset & ~1) < 0x08000000 + len(data)
            and len(data) <= config['flash']):
        raise RuntimeError('Vector table or Flash bounds invalid')
    commands = (directory / 'compile_commands.json').read_text()
    if config['cpu'] not in commands:
        raise RuntimeError('Unexpected CPU compilation flags')
    digest = sha(binary)
    file_hashes = {f'firmware.{ext}': sha(directory / f'firmware.{ext}')
                   for ext in ('elf', 'bin', 'hex', 'map')}
    bundle_digest = hashlib.sha256(json.dumps(file_hashes, sort_keys=True).encode()).hexdigest()
    artifact = LOCAL / 'artifacts' / bundle_digest
    artifact.mkdir(parents=True, exist_ok=True)
    for ext in ('elf', 'bin', 'hex', 'map'):
        source = directory / f'firmware.{ext}'
        destination = artifact / source.name
        if destination.exists():
            if sha(destination) != sha(source):
                raise RuntimeError('Immutable artifact collision')
        else:
            shutil.copyfile(source, destination)
            destination.chmod(0o444)
    attributes = run([ARM / 'bin/arm-none-eabi-readelf', '-A', artifact / 'firmware.elf'])
    symbols = run([ARM / 'bin/arm-none-eabi-nm', '-n', artifact / 'firmware.elf'])
    match = re.search(r'^([0-9a-f]+) D nodu_p0_status$', symbols, re.M)
    if not match:
        raise RuntimeError('Missing P0 status symbol')
    record = {'target': target, 'binaryBytes': len(data), 'binarySha256': digest,
              'fileSha256': file_hashes, 'bundleSha256': bundle_digest,
              'initialStack': hex(stack), 'resetVector': hex(reset), 'statusAddress': '0x' + match[1],
              'artifact': str(artifact.relative_to(ROOT)), 'elfAttributes': attributes,
              'sourceSha256': inputs_before,
              'sdk': LOCK['sdk'][config['family']]}
    record_path.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record, indent=2))


def plan(target, transport, port):
    record_path = EVIDENCE / f'{target}-artifact.json'
    if not record_path.exists():
        raise RuntimeError('No current successful build; build this target first')
    record = json.loads(record_path.read_text())
    if record['target'] != target or record['sourceSha256'] != source_hashes():
        raise RuntimeError('Target or source changed; rebuild before planning upload')
    verify_sdk(TARGETS[target]['family'])
    artifact = ROOT / record['artifact']
    binary = artifact / 'firmware.bin'
    if sha(binary) != record['binarySha256'] or binary.stat().st_size != record['binaryBytes']:
        raise RuntimeError('Artifact changed since build')
    for name, digest in record['fileSha256'].items():
        if sha(artifact / name) != digest:
            raise RuntimeError(f'Artifact changed since build: {name}')
    if transport == 'uart':
        command = ['stm32flash', '-b', '115200', '-m', '8e1', '-f', '-w', str(binary),
                   '-v', '-S', f"0x08000000:{record['binaryBytes']}", port or '<STM32_PORT>']
        steps = ['Confirm MCU and port; close monitor', 'BOOT0=1, BOOT1=0, reset',
                 'Query ROM device identity and back up existing Flash before write',
                 'Execute only after identity/capacity checks', 'BOOT0=0 and normal reset',
                 'Observe application separately; write verification is not an execution test']
    else:
        command = ['openocd', '-f', 'interface/stlink.cfg', '-f', f"target/{TARGETS[target]['openocd']}.cfg"]
        steps = ['Select exactly one intended probe', 'Identify target and back up Flash',
                 'Check group ID plus capacity; reject mismatches before erase',
                 'Program immutable ELF and verify', 'Read back BIN and compare SHA256',
                 f"Reset and inspect heartbeat at {record['statusAddress']}"]
    print(json.dumps({'target': target, 'transport': transport, 'command': command,
                      'steps': steps, 'executed': False}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('env', 'build', 'plan'))
    parser.add_argument('--target', choices=TARGETS)
    parser.add_argument('--transport', choices=('stlink', 'uart'), default='stlink')
    parser.add_argument('--port')
    args = parser.parse_args()
    if args.action == 'env':
        environment()
    else:
        if not args.target:
            parser.error('--target is required')
        with target_lock(args.target):
            if args.action == 'build':
                environment()
                build(args.target)
            else:
                plan(args.target, args.transport, args.port)


if __name__ == '__main__':
    main()
