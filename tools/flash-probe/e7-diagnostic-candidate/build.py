#!/usr/bin/env python3
"""Offline-only build. Never opens serial ports or executes the RISC-V output."""
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Nodu contributors.
import argparse
import hashlib
import json
import pathlib
import shlex
import subprocess
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent
SDK_COMMIT = '45642af98f15c24d64703ff57c97360794ca6f55'
SDK_ARCHIVE_SHA = '18281ca5d8da535d8815a906f0d3f31d047b99cbd0d29f8dc98fb77c9be45a44'
LEGACY_ARCHIVE_SHA = 'f3cc7dc8c5fa8928aa804cc305f91935957ef81c41829064d8ee8da8d5aa8ec4'
LIBGCC_SHA = '966235fc4bd270d2a5abcd0f42886549ad02a54cf21c785a99e1ae60608ade66'
SDK_INPUTS = [
    'lib/bsp/crt.S', 'lib/drivers/sysctl.c', 'lib/drivers/fpioa.c',
    'lib/drivers/uarths.c',
]
OWN_INPUTS = ['src/boot.c', 'src/protocol.c', 'src/slip.c', 'src/platform.c']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sdk', type=pathlib.Path, required=True)
    parser.add_argument('--sdk-archive', type=pathlib.Path, required=True)
    parser.add_argument('--legacy-toolchain', type=pathlib.Path, required=True,
                        help='fixed official 8.2 target headers; its compiler is never run')
    parser.add_argument('--legacy-archive', type=pathlib.Path, required=True)
    parser.add_argument('--gcc', type=pathlib.Path, required=True)
    parser.add_argument('--binutils-prefix', required=True)
    parser.add_argument('--libgcc', type=pathlib.Path,
                        help='explicit audited lp64f archive, if required by retained code')
    args = parser.parse_args()
    sdk, toolchain = args.sdk.resolve(), args.legacy_toolchain.resolve()
    if digest(args.sdk_archive) != SDK_ARCHIVE_SHA:
        raise SystemExit('SDK archive hash mismatch')
    if digest(args.legacy_archive) != LEGACY_ARCHIVE_SHA:
        raise SystemExit('Legacy target header/runtime archive hash mismatch')
    if args.libgcc and digest(args.libgcc) != LIBGCC_SHA:
        raise SystemExit('Explicit libgcc is not the audited official lp64f archive')
    with tarfile.open(args.sdk_archive, 'r:gz') as archive:
        prefix = f'kendryte-standalone-sdk-{SDK_COMMIT}/'
        official = {m.name[len(prefix):]: m for m in archive.getmembers()
                    if m.isfile() and m.name.startswith(prefix)}
        # Verify explicit translation units before any compiler invocation.
        for name in SDK_INPUTS:
            if hashlib.sha256(archive.extractfile(official[name]).read()).hexdigest() != digest(sdk / name):
                raise SystemExit('SDK source differs from pinned archive: ' + name)
    build = ROOT / 'build'
    build.mkdir(exist_ok=True)
    prefix = args.binutils_prefix
    gcc = str(args.gcc.resolve())
    commands = []
    logs = []

    def run(command):
        commands.append(command)
        proc = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
        logs.append('$ ' + shlex.join(command) + '\n' + proc.stdout + proc.stderr)
        (build / 'build.log').write_text('\n'.join(logs))
        if proc.returncode:
            raise SystemExit(proc.returncode)
        return proc.stdout

    version = run([gcc, '--version']).splitlines()[0]
    gcc_root = args.gcc.resolve().parent.parent
    flags = ['-Os', '-g', '-ffreestanding', '-fno-builtin', '-fno-common',
             '-fno-stack-protector', '-ffunction-sections', '-fdata-sections',
             '-fstrict-volatile-bitfields',
             '-mcmodel=medany', '-march=rv64imafc', '-mabi=lp64f',
             '-misa-spec=2.2', '-DNDEBUG',
             '-Wall', '-Wextra', '-Werror=implicit-function-declaration',
             '-I' + str(ROOT / 'src'), '-I' + str(sdk / 'lib/bsp/include'),
             '-I' + str(sdk / 'lib/drivers/include'),
             '-isystem', str(toolchain / 'riscv64-unknown-elf/include')]
    objects = []
    dependencies = set()
    sources = [sdk / name for name in SDK_INPUTS] + [ROOT / name for name in OWN_INPUTS]
    for index, source in enumerate(sources):
        obj = build / f'{index}-{source.stem}.o'
        dep = obj.with_suffix('.d')
        run([gcc, *flags, '-MD', '-MF', str(dep), '-c', str(source), '-o', str(obj)])
        objects.append(str(obj))
        contents = dep.read_text().replace('\\\n', ' ')
        dependencies.update(pathlib.Path(p).resolve() for p in shlex.split(contents.split(':', 1)[1]))
    # Check every consumed SDK header against the fixed archive before linking.
    with tarfile.open(args.sdk_archive, 'r:gz') as archive:
        for path in sorted(dependencies):
            if path.is_relative_to(sdk):
                name = str(path.relative_to(sdk))
                if name not in official or hashlib.sha256(archive.extractfile(official[name]).read()).hexdigest() != digest(path):
                    raise SystemExit('SDK dependency differs from fixed archive: ' + name)
    legacy_dependencies = [p for p in dependencies if p.is_relative_to(toolchain)]
    if args.libgcc:
        legacy_dependencies.append(args.libgcc.resolve())
    with tarfile.open(args.legacy_archive, 'r:gz') as archive:
        legacy_members = {m.name: m for m in archive.getmembers() if m.isfile()}
        for path in legacy_dependencies:
            name = 'kendryte-toolchain/' + str(path.relative_to(toolchain))
            if name not in legacy_members or hashlib.sha256(archive.extractfile(legacy_members[name]).read()).hexdigest() != digest(path):
                raise SystemExit('Legacy target input differs from fixed archive: ' + name)
    elf = build / 'probe.elf'
    runtime = [str(args.libgcc.resolve())] if args.libgcc else []
    run([gcc, '-mcmodel=medany', '-march=rv64imafc', '-mabi=lp64f', '-misa-spec=2.2',
         '-nostdlib', '-nostartfiles', '-nodefaultlibs',
         '-Wl,--gc-sections', '-Wl,--build-id=none', '-Wl,-T,' + str(ROOT / 'ram.ld'),
         '-Wl,-Map,' + str(build / 'probe.map'), *objects, *runtime, '-o', str(elf)])
    run([str(prefix) + 'objcopy', '-O', 'binary', str(elf), str(build / 'probe.bin')])
    for name, command in {
        'probe.disassembly.txt': [str(prefix) + 'objdump', '-d', '-S', str(elf)],
        'probe.symbols.txt': [str(prefix) + 'nm', '-n', str(elf)],
        'probe.sections.txt': [str(prefix) + 'readelf', '-h', '-S', '-l', str(elf)],
        'probe.size.txt': [str(prefix) + 'size', str(elf)],
    }.items():
        (build / name).write_text(run(command))
    undefined = run([str(prefix) + 'nm', '-u', str(elf)]).strip()
    if undefined:
        raise SystemExit('Undefined runtime dependency: ' + undefined)
    source_manifest = []
    dependencies.update([ROOT / 'ram.ld', ROOT / 'build.py'])
    if args.libgcc:
        dependencies.add(args.libgcc.resolve())
    for path in sorted(dependencies):
        contents = path.read_text(errors='replace') if path.suffix != '.a' else ''
        if path.is_relative_to(sdk):
            origin, name = 'SDK ' + SDK_COMMIT, str(path.relative_to(sdk))
        elif path.is_relative_to(ROOT):
            origin, name = 'Nodu candidate', str(path.relative_to(ROOT))
        elif path.is_relative_to(toolchain):
            origin, name = 'official GNU toolchain 8.2.0 target headers/runtime', str(path.relative_to(toolchain))
        elif path.is_relative_to(gcc_root):
            origin, name = 'Homebrew GNU GCC 16.2.0 builtin headers', str(path.relative_to(gcc_root))
        else:
            origin, name = 'unexpected external input', str(path)
        head = '\n'.join(contents.splitlines()[:100])
        if 'Apache License, Version 2.0' in head or 'SPDX-License-Identifier: Apache-2.0' in head:
            license_value = 'Apache-2.0, explicit file header'
        elif 'MIT License' in head or 'SPDX-License-Identifier: MIT' in head:
            license_value = 'MIT, explicit file header'
        elif 'Redistribution and use' in head:
            license_value = 'BSD-style text present; inspect exact header'
        elif 'GNU General Public License' in head:
            license_value = 'GNU notice present; toolchain exception requires separate review'
        else:
            license_value = 'no explicit license in first 100 lines; see notices review'
        source_manifest.append(dict(origin=origin, path=name, sha256=digest(path),
                                    license_observed=license_value))
    (ROOT / 'source-manifest.json').write_text(json.dumps(source_manifest, indent=2) + '\n')
    report = dict(status='offline build only; NOT executed on hardware',
                  compiler=version, compiler_sha256=digest(pathlib.Path(gcc)),
                  sdk_commit=SDK_COMMIT, sdk_archive_sha256=SDK_ARCHIVE_SHA,
                  legacy_archive_sha256=LEGACY_ARCHIVE_SHA,
                  entry='0x80000000', target_arch='rv64imafc', target_abi='lp64f',
                  misa_spec='2.2', uses_libc=False, uses_libgcc=bool(args.libgcc),
                  explicit_libgcc=(dict(path=str(args.libgcc.resolve()),
                                       sha256=digest(args.libgcc.resolve()))
                                   if args.libgcc else None),
                  undefined_symbols=undefined, commands=commands,
                  artifacts={name: dict(bytes=(build / name).stat().st_size,
                                        sha256=digest(build / name))
                             for name in ['probe.elf', 'probe.bin', 'probe.map',
                                          'probe.disassembly.txt', 'probe.symbols.txt',
                                          'probe.sections.txt', 'probe.size.txt']})
    (ROOT / 'build-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: report[k] for k in ['status', 'compiler', 'artifacts']}, indent=2))


if __name__ == '__main__':
    main()
