#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Prepare verified official tools. Build-time only; never called by the AI/runtime."""
import argparse, hashlib, json, os, pathlib, platform, shutil, tarfile, tempfile, urllib.request
DESKTOP = pathlib.Path(__file__).resolve().parents[1]
LOCK = json.loads((DESKTOP/'scripts/tutor-tools.lock.json').read_text())

def digest(file):
    h=hashlib.sha256()
    with open(file,'rb') as stream:
        while chunk:=stream.read(1024*1024): h.update(chunk)
    return h.hexdigest()

def archive(asset, cache, offline):
    file=cache/asset['name']
    if file.exists():
        if file.stat().st_size!=asset['size'] or digest(file)!=asset['sha256']: raise ValueError('Cached archive failed SHA256: '+asset['name'])
        return file
    if offline: raise ValueError('Offline archive missing: '+asset['name'])
    cache.mkdir(parents=True,exist_ok=True)
    part=file.with_suffix(file.suffix+'.part-'+str(os.getpid()))
    try:
        with urllib.request.urlopen(asset['url'],timeout=45) as response,part.open('wb') as out:
            count=0
            while chunk:=response.read(1024*1024):
                count+=len(chunk)
                if count>asset['size']: raise ValueError('Download larger than pinned archive')
                out.write(chunk)
        if part.stat().st_size!=asset['size'] or digest(part)!=asset['sha256']: raise ValueError('Downloaded archive failed SHA256')
        os.replace(part,file)
    finally: part.unlink(missing_ok=True)
    return file

def extract(file, destination, folder):
    # Verify all members before writing. Keep tarfile's data filter as a second boundary.
    if not hasattr(tarfile,'data_filter'): raise ValueError('Preparing tutor tools requires Python 3.12 or newer')
    destination=destination.resolve()
    with tarfile.open(file) as tar:
        members=tar.getmembers()
        if len(members)>50000 or sum(m.size for m in members)>2*1024**3: raise ValueError('Archive exceeds extraction budget')
        for m in members:
            p=pathlib.PurePosixPath(m.name)
            if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0]!=folder or '\\' in m.name: raise ValueError('Unsafe archive path')
            if not (m.isfile() or m.isdir() or m.issym() or m.islnk()): raise ValueError('Unsupported archive member')
            if m.issym() or m.islnk():
                base=destination/p.parent if m.issym() else destination
                target=(base/m.linkname).resolve()
                if not target.is_relative_to(destination/folder): raise ValueError('Archive link escapes its component')
        tar.extractall(destination,members=members,filter='data')

def copy_inside(root, relative, dest):
    source=(root/relative).resolve()
    if not source.is_relative_to(root.resolve()) or not source.is_file(): raise ValueError('Component file missing or outside archive: '+relative)
    dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,dest)

def verify_existing(out,target):
    manifest_file=out/'toolkit.json'
    if out.is_symlink() or manifest_file.is_symlink() or manifest_file.stat().st_size>128000: raise ValueError('Invalid installed manifest')
    m=json.loads(manifest_file.read_text())
    if m.get('version')!=LOCK['version'] or m.get('platform')!=target or m.get('archives')!=LOCK['platforms'][target] or not isinstance(m.get('files'),list) or not 1<=len(m['files'])<=200: raise ValueError('Installed toolkit differs from pin')
    seen=set();total=0
    for f in m['files']:
        rel=pathlib.PurePosixPath(f['path'])
        if '\\' in f['path'] or any(part in ('', '.', '..') for part in f['path'].split('/')) or rel.is_absolute() or not rel.parts or rel.parts[0] not in ['sdk','runtime','licenses'] or '..' in rel.parts or f['path'] in seen: raise ValueError('Invalid installed inventory')
        seen.add(f['path']);full=out/rel
        if full.is_symlink() or not full.resolve().is_relative_to(out.resolve()) or full.stat().st_size!=f['size'] or digest(full)!=f['sha256']: raise ValueError('Installed toolkit failed checksum')
        total+=f['size']
    actual={p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file()}
    if any(p.is_symlink() for p in out.rglob('*')) or actual!=seen|{'toolkit.json'} or total!=m['totalBytes']: raise ValueError('Installed toolkit contains unexpected files')
    required={'sdk/bin/clang','sdk/bin/wasm-ld','runtime/wasmtime','licenses/WASI-SDK-LICENSE','licenses/LLVM-LICENSE','licenses/Libedit-COPYING','licenses/Wasmtime-LICENSE','licenses/SOURCES.json'}
    if not required<=seen: raise ValueError('Installed toolkit missing tools or licenses')
    for source in (DESKTOP/'scope-extension/resources/licenses/tutor-wasi').iterdir():
        if source.is_file() and digest(source)!=digest(out/'licenses'/source.name): raise ValueError('Installed toolkit license material is stale: '+source.name)
    return m

def sdk_components(target):
    files=[('bin/clang-23','sdk/bin/clang'),('bin/lld','sdk/bin/wasm-ld'),
        ('lib/libLLVM.23.1-wasi-sdk.dylib','sdk/lib/libLLVM.23.1-wasi-sdk.dylib'),
        ('lib/libclang-cpp.23.1-wasi-sdk.dylib','sdk/lib/libclang-cpp.23.1-wasi-sdk.dylib')]
    # The pinned x64 macOS release disables libedit when cross-built on arm64.
    # Keep it required on arm64; do not silently ignore an incomplete archive.
    if target=='darwin-arm64': files.append(('lib/libedit.0.dylib','sdk/lib/libedit.0.dylib'))
    return files

def prepare(target, cache, out, offline=False):
    assets=LOCK['platforms'].get(target)
    if not assets: raise ValueError('Unsupported toolkit platform: '+target)
    if out.exists():
        try: return verify_existing(out,target)
        except (OSError,ValueError,KeyError,TypeError) as error: raise ValueError('Destination exists but verification failed; preserved unchanged: '+str(error)) from error
    out.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.tutor-tools-',dir=out.parent) as temp:
        root=pathlib.Path(temp); package=root/'package'; package.mkdir()
        for asset in assets:
            extract(archive(asset,cache,offline),root,asset['folder'])
        sdk=root/assets[0]['folder']; runtime=root/assets[1]['folder']
        for source,destination in sdk_components(target): copy_inside(sdk,source,package/destination)
        copy_inside(runtime,'wasmtime',package/'runtime/wasmtime')
        copy_inside(runtime,'LICENSE',package/'licenses/Wasmtime-LICENSE')
        licenses=DESKTOP/'scope-extension/resources/licenses/tutor-wasi'
        for source in sorted(licenses.iterdir()):
            if source.is_file(): copy_inside(licenses,source.name,package/'licenses'/source.name)
        required=['WASI-SDK-LICENSE','LLVM-LICENSE','Libedit-COPYING','SOURCES.json']
        if any(not (package/'licenses'/n).is_file() for n in required): raise ValueError('Missing committed license material')
        files=[{'path':p.relative_to(package).as_posix(),'size':p.stat().st_size,'sha256':digest(p)} for p in sorted(package.rglob('*')) if p.is_file()]
        manifest={'schema':1,'version':LOCK['version'],'platform':target,'archives':assets,'files':files,'totalBytes':sum(f['size'] for f in files)}
        (package/'toolkit.json').write_text(json.dumps(manifest,indent=2)+'\n')
        package.rename(out)
        return manifest

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform',default='darwin' if platform.system()=='Darwin' else platform.system().lower())
    parser.add_argument('--arch',default='arm64' if platform.machine() in ['arm64','aarch64'] else 'x64')
    parser.add_argument('--archive-dir',type=pathlib.Path,default=DESKTOP/'.tools/tutor-downloads')
    parser.add_argument('--out',type=pathlib.Path)
    parser.add_argument('--offline',action='store_true')
    args=parser.parse_args();target=args.platform+'-'+args.arch
    try:
        result=prepare(target,args.archive_dir,args.out or DESKTOP/'scope-extension/resources/wasi'/target,args.offline)
        print(json.dumps({'platform':target,'version':result['version'],'bytes':result['totalBytes'],'files':len(result['files'])}))
    except (OSError,ValueError,tarfile.TarError) as error: parser.exit(1,str(error)+'\n')
