#!/usr/bin/env python3
"""Build the pinned, redistributable macOS arm64 STM32 toolkit (no hardware I/O)."""
import argparse
import concurrent.futures
import hashlib
import json
import os
import pathlib
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
LOCK = json.loads((HERE / 'stm32-release.lock.json').read_text())
SDK = json.loads((HERE / 'stm32-sdk.lock.json').read_text())
ASSETS = {a['id']: a for a in LOCK['assets']}


def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def valid(p, item):
    return p.is_file() and p.stat().st_size == item['size'] and digest(p) == item['sha256']


def download(item, dest, offline):
    if valid(dest, item):
        return dest
    if offline:
        raise RuntimeError('Missing or invalid offline asset: ' + str(dest))
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + '.part')
    # Fixed HTTPS inputs, bounded bytes, verified before they become cache entries.
    if not item['url'].startswith('https://'):
        raise ValueError('HTTPS required')
    try:
        with urllib.request.urlopen(item['url'], timeout=60) as response, part.open('wb') as output:
            count = 0
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > item['size']:
                    raise ValueError('Archive exceeds pinned size')
                output.write(chunk)
        if not valid(part, item):
            raise ValueError('Archive checksum mismatch: ' + item['name'])
        part.replace(dest)
        return dest
    finally:
        part.unlink(missing_ok=True)


def extract(file, root):
    if file.suffix == '.zip':
        with zipfile.ZipFile(file) as z:
            for info in z.infolist():
                target = root / info.filename
                if not target.resolve().is_relative_to(root.resolve()) or '\\' in info.filename:
                    raise ValueError('Unsafe ZIP member')
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('Unexpected ZIP symlink')
            z.extractall(root)
            for info in z.infolist():
                p = root / info.filename
                if p.is_file():
                    p.chmod(0o755 if (info.external_attr >> 16) & 0o111 else 0o644)
    else:
        with tarfile.open(file) as t:
            t.extractall(root, filter='data')


def copy(source, dest, ignore=None):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, dest, dirs_exist_ok=True, symlinks=False, ignore=ignore)
    else:
        shutil.copy2(source.resolve(), dest)
        dest.chmod(dest.stat().st_mode | 0o200)


def run(args, cwd=None, env=None, log=None):
    print('+', ' '.join(map(str, args)), flush=True)
    with log.open('ab') if log else open(os.devnull, 'wb') as output:
        subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True,
                       stdout=output, stderr=subprocess.STDOUT)


def arm_subset(source, dest):
    tools = 'addr2line ar as c++filt cpp gcc gcc-ar gcc-nm gcc-ranlib gdb ld nm objcopy objdump ranlib readelf size strings strip'.split()
    for tool in tools:
        copy(source / 'bin' / ('arm-none-eabi-' + tool), dest / 'bin' / ('arm-none-eabi-' + tool))
    for rel in ['arm-none-eabi/bin', 'lib/bfd-plugins', 'share/doc',
                '14.2.rel1-darwin-arm64-arm-none-eabi-manifest.txt']:
        copy(source / rel, dest / rel)
    for name in ['cc1', 'collect2', 'lto-wrapper', 'liblto_plugin.so']:
        rel = 'libexec/gcc/arm-none-eabi/14.2.1/' + name
        copy(source / rel, dest / rel)
    for rel in ['lib/gcc/arm-none-eabi/14.2.1', 'arm-none-eabi/include', 'arm-none-eabi/lib']:
        copy(source / rel, dest / rel)
    # Only C, Cortex-M3 and Cortex-M4F target libraries are used in Nodu 0.2.2.
    shutil.rmtree(dest / 'arm-none-eabi/include/c++', ignore_errors=True)
    multilibs = ['thumb/v7-m/nofp', 'thumb/v7e-m+fp/hard']
    for prefix in ['lib/gcc/arm-none-eabi/14.2.1', 'arm-none-eabi/lib']:
        root = dest / prefix
        for p in sorted(root.rglob('*'), key=lambda p: len(p.parts), reverse=True):
            rel = p.relative_to(root).as_posix()
            keep = not (rel == 'arm' or rel.startswith('arm/') or p.name.startswith(('libstdc++', 'libsupc++', 'libgfortran')))
            if rel == 'thumb' or rel.startswith('thumb/'):
                keep = any(rel == m or rel.startswith(m + '/') or m.startswith(rel + '/') for m in multilibs)
            if rel.split('/')[0] in ['finclude', 'plugin', 'install-tools']:
                keep = False
            if not keep:
                shutil.rmtree(p) if p.is_dir() else p.unlink(missing_ok=True)
        if prefix == 'arm-none-eabi/lib':
            for p in root.iterdir():
                if p.is_file() and p.suffix in ['.a', '.o']:
                    p.unlink()


def sdk_files(out, cache, source, offline):
    def one(item):
        target = out / item['path']
        local = source / item['path'] if source else pathlib.Path('/nonexistent')
        if valid(local, item):
            copy(local, target)
        else:
            record = {**item, 'name': item['path']}
            cached = download(record, cache / 'sdk' / item['path'], offline)
            copy(cached, target)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(one, SDK['files']))


def build_sources(build, out):
    # Xcode is only the build compiler; no Xcode program or SDK is distributed.
    env = {**os.environ, 'PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
           'CC': '/usr/bin/clang', 'CXX': '/usr/bin/clang++',
           'CFLAGS': '-O2 -mmacosx-version-min=15.0',
           'LDFLAGS': '-mmacosx-version-min=15.0', 'PKG_CONFIG': '/usr/bin/false',
           'MACOSX_DEPLOYMENT_TARGET': '15.0'}
    deps = build / 'deps'
    usb = build / 'libusb-1.0.29'
    run(['./configure', '--prefix=' + str(deps), '--disable-static', '--disable-examples-build', '--disable-tests-build'], usb, env, build / 'libusb.log')
    run(['/usr/bin/make', '-j8'], usb, env, build / 'libusb.log')
    run(['/usr/bin/make', 'install'], usb, env, build / 'libusb.log')
    oc = build / 'openocd-0.12.0'
    ocenv = {**env, 'LIBUSB1_CFLAGS': '-I' + str(deps / 'include/libusb-1.0'),
             'LIBUSB1_LIBS': '-L' + str(deps / 'lib') + ' -lusb-1.0'}
    args = ['./configure', '--prefix=' + str(build / 'openocd-install'), '--enable-stlink',
            '--disable-doxygen-html', '--disable-doxygen-pdf', '--disable-internal-libjaylink',
            '--disable-jlink', '--disable-cmsis-dap', '--disable-kitprog', '--disable-ftdi',
            '--without-capstone', '--disable-werror']
    run(args, oc, ocenv, build / 'openocd.log')
    run(['/usr/bin/make', '-j8'], oc, ocenv, build / 'openocd.log')
    flash = build / 'stm32flash-0.7'
    run(['/usr/bin/make', '-j8', 'CC=/usr/bin/clang', 'CFLAGS=' + env['CFLAGS'], 'LDFLAGS=' + env['LDFLAGS']], flash, env, build / 'stm32flash.log')
    copy(oc / 'src/openocd', out / 'openocd/bin/openocd')
    copy(oc / 'tcl', out / 'openocd/share/openocd/scripts')
    copy(deps / 'lib/libusb-1.0.0.dylib', out / 'openocd/lib/libusb-1.0.0.dylib')
    copy(flash / 'stm32flash', out / 'stm32flash/bin/stm32flash')
    run(['/usr/bin/install_name_tool', '-change', str(deps / 'lib/libusb-1.0.0.dylib'),
         '@loader_path/../lib/libusb-1.0.0.dylib', out / 'openocd/bin/openocd'])
    run(['/usr/bin/install_name_tool', '-id', '@rpath/libusb-1.0.0.dylib', out / 'openocd/lib/libusb-1.0.0.dylib'])
    for name, source in [('OpenOCD-COPYING', oc / 'COPYING'), ('JimTcl-LICENSE', oc / 'jimtcl/LICENSE'),
                         ('libusb-COPYING', usb / 'COPYING'), ('stm32flash-COPYING', flash / 'gpl-2.0.txt'),
                         ('stm32flash-AUTHORS', flash / 'AUTHORS')]:
        copy(source, out / 'licenses' / name)


def sign_and_audit(out):
    results = []
    magics = [bytes.fromhex(m) for m in ['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca']]
    for p in sorted(out.rglob('*')):
        if not p.is_file():
            continue
        with p.open('rb') as f:
            if f.read(4) not in magics:
                continue
        archs = subprocess.check_output(['/usr/bin/lipo', '-archs', p], text=True).strip()
        if 'arm64' not in archs.split():
            raise RuntimeError('Unexpected Mach-O architecture: ' + str(p))
        if 'x86_64' in archs.split():
            thin = p.with_name(p.name + '.thin')
            run(['/usr/bin/lipo', p, '-thin', 'arm64', '-output', thin])
            thin.replace(p)
            p.chmod(0o755)
        libraries = subprocess.check_output(['/usr/bin/otool', '-L', p], text=True)
        for line in libraries.splitlines()[1:]:
            dep = line.strip().split(' (')[0]
            if not dep.startswith(('/usr/lib/', '/System/Library/', '@loader_path/', '@rpath/')):
                raise RuntimeError('Nonportable dependency in ' + str(p) + ': ' + dep)
            if dep.startswith('@loader_path/') and not (p.parent / dep[len('@loader_path/'):]).resolve().is_file():
                raise RuntimeError('Missing packaged library: ' + dep)
        run(['/usr/bin/codesign', '-s', '-', '-f', p])
        results.append({'path': p.relative_to(out).as_posix(), 'libraries': libraries.splitlines()[1:]})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=pathlib.Path, required=True)
    parser.add_argument('--cache', type=pathlib.Path, required=True)
    parser.add_argument('--work-dir', type=pathlib.Path)
    parser.add_argument('--sdk-source', type=pathlib.Path, help='Optional cache, every byte checked against the official source lock')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('This producer builds darwin-arm64 only')
    if args.out.exists():
        raise RuntimeError('Output already exists; choose a new output directory')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    build = (args.work_dir or args.cache.parent / 'stm32-build').resolve()
    build.mkdir(parents=True, exist_ok=True)
    for a in LOCK['assets']:
        archive = download(a, args.cache / a['name'], args.offline)
        # The GCC source archive is retained verbatim, not compiled for this release.
        if a['id'] != 'armSource':
            extract(archive, build)
    out = pathlib.Path(tempfile.mkdtemp(prefix='stm32-release-', dir=args.out.parent))
    try:
        arm_subset(build / 'arm-gnu-toolchain-14.2.rel1-darwin-arm64-arm-none-eabi', out / 'arm-gnu')
        cm = build / 'cmake-4.4.3-macos-universal/CMake.app/Contents'
        for name in ['cmake', 'ctest']:
            copy(cm / 'bin' / name, out / 'cmake/bin' / name)
        copy(cm / 'share/cmake-4.4', out / 'cmake/share/cmake-4.4', shutil.ignore_patterns('Help'))
        copy(cm / 'doc/cmake', out / 'licenses/cmake', shutil.ignore_patterns('html'))
        copy(build / 'ninja', out / 'ninja/bin/ninja')
        copy(build / 'ninja-1.13.2/COPYING', out / 'licenses/Ninja-COPYING')
        copy(build / 'clangd_23.1.0/bin/clangd', out / 'clangd/bin/clangd')
        copy(build / 'clangd_23.1.0/lib/clang/23/include', out / 'clangd/lib/clang/23/include')
        copy(build / 'clangd_23.1.0/LICENSE.TXT', out / 'licenses/Clangd-LICENSE')
        sdk_files(out / 'sdk', args.cache, args.sdk_source, args.offline)
        build_sources(build, out)
        source_archives = []
        for key in ['armSource', 'openocd', 'libusb', 'stm32flash', 'ninjaSource']:
            a = ASSETS[key]
            copy(args.cache / a['name'], out / 'sources' / a['name'])
            source_archives.append({'path': 'sources/' + a['name'], 'sha256': a['sha256'], 'upstream': a['url']})
        for name in ['prepare-stm32-release.py', 'stm32-release.lock.json', 'stm32-sdk.lock.json']:
            copy(HERE / name, out / 'sources' / name)
        (out / 'licenses/README.txt').write_text(
            'Nodu STM32 toolkit 2026.10.24 (darwin-arm64)\n'
            'GNU compiler/binutils/GDB/newlib corresponding source is the unmodified Arm 14.2.rel1 snapshot in ../sources.\n'
            'OpenOCD, bundled JimTcl, libusb and stm32flash were built from the accompanying original archives.\n'
            'Build recipe and fixed inputs are in ../sources; no patches were applied. libusb remains a replaceable dynamic library.\n'
            'Arm documentation/license notices are retained in ../arm-gnu/share/doc. SDK notices remain in ../sdk.\n'
            'CMake and clangd are official binaries; Ninja is the official binary with its Apache license.\n'
            'The Apple SDK/compiler is used to build but is not included. No Homebrew or Xcode executable is shipped.\n')
        imports = sign_and_audit(out)
        checks = {}
        for key, rel, option in [('gcc', 'arm-gnu/bin/arm-none-eabi-gcc', '--version'), ('cmake', 'cmake/bin/cmake', '--version'),
                                 ('ninja', 'ninja/bin/ninja', '--version'), ('openocd', 'openocd/bin/openocd', '--version'),
                                 ('clangd', 'clangd/bin/clangd', '--version')]:
            result = subprocess.run([out / rel, option], capture_output=True, text=True, check=True)
            checks[key] = (result.stdout + result.stderr).splitlines()[0]
        absent_port = build / '__nodu_release_check_no_device__'
        if absent_port.exists():
            raise RuntimeError('Smoke-test missing-port path unexpectedly exists')
        flash = subprocess.run([out / 'stm32flash/bin/stm32flash', '-b', '115200', absent_port], capture_output=True, text=True)
        if 'stm32flash 0.7' not in flash.stdout + flash.stderr:
            raise RuntimeError('stm32flash smoke failed')
        checks['stm32flash'] = 'stm32flash 0.7 (nonexistent test port rejected; no device opened)'
        (out / 'licenses/BUILD-EVIDENCE.json').write_text(json.dumps({'versions': checks, 'imports': imports}, indent=2) + '\n')
        files = [{'path': p.relative_to(out).as_posix(), 'size': p.stat().st_size, 'sha256': digest(p)}
                 for p in sorted(out.rglob('*')) if p.is_file()]
        manifest = {'schema': 1, 'id': 'nodu-stm32-toolkit', 'version': LOCK['version'], 'profile': 'release',
                    'platform': 'darwin', 'hostArch': 'arm64', 'sourceArchives': source_archives,
                    'components': {'armGnu': {'version': '14.2.rel1', 'path': 'arm-gnu'}, 'cmake': {'version': '4.4.3', 'path': 'cmake'},
                                   'ninja': {'version': '1.13.2', 'path': 'ninja'}, 'openocd': {'version': '0.12.0', 'path': 'openocd'},
                                   'stm32flash': {'version': '0.7', 'path': 'stm32flash'}, 'clangd': {'version': '23.1.0', 'path': 'clangd'}},
                    'sdk': {'cube-' + f: {**pin, 'path': 'sdk/cube-' + f, 'version': pin['tag'].lstrip('v')}
                            for f, pin in SDK['sdk'].items()},
                    'files': files, 'totalBytes': sum(f['size'] for f in files)}
        (out / 'toolkit.json').write_text(json.dumps(manifest, indent=2) + '\n')
        out.rename(args.out)
        print(json.dumps({'output': str(args.out), 'files': len(files), 'bytes': manifest['totalBytes'], 'versions': checks}, indent=2))
    except BaseException:
        shutil.rmtree(out)
        raise


if __name__ == '__main__':
    main()
