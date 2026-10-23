#!/usr/bin/env python3
import hashlib,json,pathlib,platform,tarfile,urllib.request
assert platform.system()=="Darwin" and platform.machine()=="arm64", "This probe downloads only macOS arm64 assets"
root=pathlib.Path(__file__).resolve().parent
cache=root/'cache';cache.mkdir(exist_ok=True)
assets=[
('wasi-sdk-34.0-arm64-macos.tar.gz','https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-arm64-macos.tar.gz','9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9'),
('wasmtime-v50.0.0-aarch64-macos.tar.xz','https://github.com/bytecodealliance/wasmtime/releases/download/v50.0.0/wasmtime-v50.0.0-aarch64-macos.tar.xz','323dc098dc0455d60f396c404627e967b7033ffcfa29abfffb243126cf82c9d6')]
report=[]
for name,url,sha in assets:
 target=cache/name
 if not target.exists():
  with urllib.request.urlopen(url) as r,target.open('wb') as f:
   while chunk:=r.read(1024*1024):f.write(chunk)
 actual=hashlib.sha256(target.read_bytes()).hexdigest();assert actual==sha,(name,actual)
 folder=cache/name.removesuffix('.tar.gz').removesuffix('.tar.xz')
 if not folder.exists():
  with tarfile.open(target) as t:
   for member in t.getmembers():
    resolved=(cache/member.name).resolve();assert resolved.is_relative_to(cache)
   t.extractall(cache,filter='data')
 report.append({'name':name,'url':url,'sha256':actual,'archiveBytes':target.stat().st_size,'unpackedFileBytes':sum(p.stat().st_size for p in folder.rglob('*') if p.is_file())})
 print(name,'verified',flush=True)
(root/'results/tools.json').write_text(json.dumps(report,indent=2)+'\n')
