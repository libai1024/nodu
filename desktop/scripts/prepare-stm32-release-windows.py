#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Assemble Windows release tools from locked upstream archives and MSYS2 output.

Download the archives named by stm32-release-windows.lock.json and the source
archives named by stm32-release.lock.json into --cache. Build the three source
archives with prepare-stm32-release-windows.sh on Windows. Pass that build root
as --native-root, and the independently pinned SDK tree as --sdk-root.
No development binaries are relabelled. Native execution/compile smoke tests
must run on Windows after assembly; this script alone is not runtime evidence.
"""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import stat
import struct
import tarfile
import tempfile
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
SOURCE_IDS = {'armSource', 'openocd', 'stm32flash', 'libusb', 'ninjaSource'}
SYSTEM_DLLS = {'kernel32.dll', 'msvcrt.dll', 'ucrtbase.dll', 'advapi32.dll',
               'setupapi.dll', 'ole32.dll', 'shell32.dll', 'user32.dll',
               'ws2_32.dll', 'cfgmgr32.dll', 'bcrypt.dll', 'ntdll.dll',
               'winmm.dll', 'gdi32.dll', 'comdlg32.dll', 'comctl32.dll'}


def sha(file):
    h = hashlib.sha256()
    with open(file, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def verified(file, record):
    if file.is_symlink() or not file.is_file() or file.stat().st_size != record['size'] or sha(file) != record['sha256']:
        raise ValueError(f'Archive or SDK digest mismatch: {file}')
    return file


def safe_name(name):
    if '\\' in name or ':' in name or name.startswith('/'):
        raise ValueError(f'Unsafe archive member: {name}')
    parts = pathlib.PurePosixPath(name).parts
    if not parts or '..' in parts:
        raise ValueError(f'Unsafe archive member: {name}')
    return pathlib.Path(*parts)


def unzip(file, dest):
    with zipfile.ZipFile(file) as archive:
        entries = archive.infolist()
        if len(entries) > 50000 or sum(e.file_size for e in entries) > 3 * 1024**3:
            raise ValueError('Archive exceeds extraction budget')
        seen = set()
        for entry in entries:
            name = safe_name(entry.filename)
            if str(name).lower() in seen or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError('Duplicate or symbolic archive member')
            seen.add(str(name).lower())
            if entry.is_dir():
                continue
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)


def copy(source, target):
    if source.is_symlink():
        raise ValueError(f'Symbolic input is not allowed: {source}')
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        for child in source.iterdir():
            copy(child, target / child.name)
    else:
        shutil.copy2(source, target)


def pe_x64(file):
    with file.open('rb') as stream:
        head = stream.read(64)
        if len(head) != 64 or head[:2] != b'MZ':
            raise ValueError(f'Not a PE executable: {file}')
        stream.seek(struct.unpack_from('<I', head, 60)[0])
        if stream.read(6) != b'PE\0\0\x64\x86':
            raise ValueError(f'Not an x64 PE executable: {file}')


def source_notices(archive_file, destination):
    with tarfile.open(archive_file) as archive:
        for member in archive:
            name = safe_name(member.name)
            if not member.isfile() or member.size > 2 * 1024**2:
                continue
            if not re.match(r'^(COPYING|LICENSE|NOTICE|COPYRIGHT|AUTHORS)', name.name, re.I):
                continue
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=pathlib.Path, required=True)
    parser.add_argument('--sdk-root', type=pathlib.Path, required=True)
    parser.add_argument('--native-root', type=pathlib.Path, required=True)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    args = parser.parse_args()
    binary_lock = json.loads((HERE / 'stm32-release-windows.lock.json').read_text())
    source_lock = json.loads((HERE / 'stm32-release.lock.json').read_text())
    sdk_lock = json.loads((HERE / 'stm32-sdk.lock.json').read_text())
    assets = {item['id']: item for item in binary_lock['assets']}
    sources = [item for item in source_lock['assets'] if item['id'] in SOURCE_IDS]
    for item in list(assets.values()) + sources:
        verified(args.cache / item['name'], item)
    for item in sdk_lock['files']:
        verified(args.sdk_root / safe_name(item['path']), item)
    for item in sources:
        if item['id'] in {'openocd', 'libusb', 'stm32flash'}:
            verified(args.native_root / 'cache' / item['name'], item)
    if sha(args.native_root / 'build.sh') != sha(HERE / 'prepare-stm32-release-windows.sh'):
        raise ValueError('Native recipe does not match this source revision')
    imported = re.findall(r'DLL Name:\s*(\S+)', (args.native_root / 'logs/imports.txt').read_text())
    if len(imported) < 2 or any(name.lower() not in SYSTEM_DLLS and not re.fullmatch(r'api-ms-win-crt-[a-z0-9-]+\.dll', name.lower()) for name in imported):
        raise ValueError(f'Unexpected native DLL imports: {imported}')
    if args.out.exists():
        raise ValueError('Output already exists; use a fresh release directory')
    args.out.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix='nodu-win-toolkit-') as temporary:
        extracted = pathlib.Path(temporary)
        for key in ['armGnu', 'cmake', 'clangd', 'ninja']:
            unpacked = extracted / key
            unzip(args.cache / assets[key]['name'], unpacked)
            root = unpacked if key in {'ninja', 'armGnu'} else next(p for p in unpacked.iterdir() if p.is_dir())
            target = args.out / {'armGnu': 'arm-gnu'}.get(key, key)
            if key == 'ninja':
                copy(root / 'ninja.exe', target / 'bin/ninja.exe')
            elif key == 'cmake':
                for name in ['cmake.exe', 'ctest.exe', 'cmcldeps.exe']:
                    copy(root / 'bin' / name, target / 'bin' / name)
                copy(root / 'share', target / 'share')
                for child in (root / 'doc/cmake').iterdir():
                    if child.name not in {'html', 'man'}:
                        copy(child, target / 'licenses' / child.name)
            else:
                copy(root, target)
        for name in ['openocd', 'stm32flash']:
            copy(args.native_root / 'install' / name, args.out / name)
            pe_x64(args.out / name / 'bin' / f'{name}.exe')
        copy(args.native_root / 'logs', args.out / 'licenses/windows-build')
        copy(args.native_root / 'licenses', args.out / 'licenses/windows-runtime')
        copy(HERE / 'prepare-stm32-release-windows.sh', args.out / 'licenses/windows-build/build.sh')
        for item in sdk_lock['files']:
            relative = safe_name(item['path'])
            copy(args.sdk_root / relative, args.out / 'sdk' / relative)
        source_archives = []
        for item in sources:
            file = args.cache / item['name']
            copy(file, args.out / 'sources' / item['name'])
            source_archives.append({'path': 'sources/' + item['name'], 'sha256': item['sha256'], 'upstream': item['url']})
            if item['id'] != 'armSource':
                notices = args.out / 'licenses' / item['id']
                source_notices(file, notices)
                component = {'libusb': 'openocd', 'ninjaSource': 'ninja'}.get(item['id'], item['id'])
                copy(notices, args.out / component / 'licenses' / item['id'])
        for name in ['stm32-release-windows.lock.json', 'stm32-release.lock.json', 'stm32-sdk.lock.json']:
            copy(HERE / name, args.out / 'licenses' / name)
    components = {
        'armGnu': {'path': 'arm-gnu', 'version': '14.2.rel1', 'license': 'GPL-3.0-or-later WITH GCC-exception-3.1; newlib BSD-like'},
        'cmake': {'path': 'cmake', 'version': '4.4.3', 'license': 'BSD-3-Clause and bundled notices'},
        'ninja': {'path': 'ninja', 'version': '1.13.2', 'license': 'Apache-2.0'},
        'clangd': {'path': 'clangd', 'version': '23.1.0', 'license': 'Apache-2.0 WITH LLVM-exception'},
        'openocd': {'path': 'openocd', 'version': '0.12.0', 'license': 'GPL-2.0-or-later', 'source': 'pinned source build with static libusb 1.0.29'},
        'stm32flash': {'path': 'stm32flash', 'version': '0.7', 'license': 'GPL-2.0-or-later', 'source': 'pinned source build'},
    }
    files = [{'path': str(p.relative_to(args.out)).replace('\\', '/'), 'size': p.stat().st_size, 'sha256': sha(p)}
             for p in sorted(args.out.rglob('*')) if p.is_file()]
    manifest = {'schema': 1, 'id': 'nodu-stm32-toolkit', 'version': binary_lock['version'],
                'profile': 'release', 'platform': 'win32', 'hostArch': 'x64',
                'components': components, 'sourceArchives': source_archives,
                'sdk': {'cube-' + key: {'path': 'sdk/cube-' + key, 'version': value['tag'].lstrip('v'), **value}
                        for key, value in sdk_lock['sdk'].items()},
                'files': files, 'totalBytes': sum(item['size'] for item in files)}
    (args.out / 'toolkit.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(args.out), 'files': len(files), 'bytes': manifest['totalBytes']}))


if __name__ == '__main__':
    main()
