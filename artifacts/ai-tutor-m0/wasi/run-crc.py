#!/usr/bin/env python3
import hashlib,json,pathlib,platform,subprocess,urllib.request
assert platform.system()=="Darwin" and platform.machine()=="arm64", "This probe runs only on macOS arm64"
root=pathlib.Path(__file__).resolve().parent
sdk=root/'cache/wasi-sdk-34.0-arm64-macos'; runner=root/'cache/wasmtime-v50.0.0-aarch64-macos/wasmtime'
unity=root/'cache/unity-b6763fbd';unity.mkdir(exist_ok=True)
sources=json.loads((root/'unity-manifest.json').read_text())
for source in sources:
 file,url=source['file'],source['url']
 dest=unity/pathlib.Path(file).name
 if not dest.exists():dest.write_bytes(urllib.request.urlopen(url).read())
 assert hashlib.sha256(dest.read_bytes()).hexdigest()==source['sha256'],file
out=root/'out';out.mkdir(exist_ok=True)
results=[]
for name,extra,expected in [('correct',[],0),('wrong-polynomial',['-DCRC_POLY=0x07'],1)]:
 artifact=out/(name+'.wasm')
 compile=subprocess.run([str(sdk/'bin/clang'),'--target=wasm32-wasip1','-ffile-prefix-map='+str(root)+'=.','-std=c11','-O1','-mexception-handling','-mllvm','-wasm-enable-sjlj','-mllvm','-wasm-use-legacy-eh=false','-I'+str(unity),str(root/'crc_test.c'),str(unity/'unity.c'),'-lsetjmp','-o',str(artifact),*extra],capture_output=True,text=True,timeout=60)
 assert compile.returncode==0,compile.stderr
 run=subprocess.run([str(runner),'run','-W','fuel=10000000','-W','max-memory-size=67108864','-W','exceptions=y',str(artifact)],capture_output=True,text=True,timeout=5)
 assert run.returncode==expected,(name,run.returncode,run.stdout,run.stderr)
 results.append({'name':name,'expectedExit':expected,'exitCode':run.returncode,'stdout':run.stdout,'stderr':run.stderr,'wasmBytes':artifact.stat().st_size,'sha256':hashlib.sha256(artifact.read_bytes()).hexdigest()})
 print(name,run.returncode,run.stdout,flush=True)
(root/'results/crc.json').write_text(json.dumps({'unityCommit':'b6763fbd9cedfacaa89e2ad9fd00d615a234e355','sources':sources,'tests':results},indent=2)+'\n')
