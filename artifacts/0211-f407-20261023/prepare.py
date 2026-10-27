import json,subprocess,pathlib
root=pathlib.Path(__file__).resolve().parent
repo=root.parents[1]
child=subprocess.Popen([str(repo/'desktop/scope-extension/resources/bin/darwin-arm64/nodu-embedded'),'--resources',str(repo/'desktop/scope-extension/resources/stm32'),'--toolkit',str(repo/'desktop/.tools/stm32/darwin'),'--data-dir',str(root/'device-state')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
seq=0
log=(root/'preflight.jsonl').open('w')
def call(method,args={}):
 global seq
 seq+=1; child.stdin.write(json.dumps({'id':seq,'method':method,'args':args})+'\n');child.stdin.flush()
 while True:
  line=child.stdout.readline();assert line;log.write(line);log.flush();r=json.loads(line)
  if r.get('id')==seq:
   if 'error' in r:raise RuntimeError(r)
   return r['result']
try:
 p=root/'projects/f407-e2e'
 if not p.exists():call('createProject',{'parent':str(p.parent),'name':p.name,'board':'chip-f407zg','template':'uart-hello','method':'stlink'})
 source=p/'Core/Src/main.c';s=source.read_text().replace('    uint32_t count = 0;','    extern volatile uint32_t nodu_loop_count;').replace('(unsigned long)count','(unsigned long)nodu_loop_count').replace('        count++;','        nodu_loop_count++;')
 s=s.replace('int main(void)','volatile uint32_t nodu_loop_count = 0;\n\nint main(void)');source.write_text(s)
 probes=call('listProbes');(root/'probes.json').write_text(json.dumps(probes,indent=2));print('PROBES',probes,flush=True)
 identity=call('identify',{'path':str(p)});(root/'f407-identity.json').write_text(json.dumps(identity,indent=2));print('AUTO IDENTITY',identity,flush=True)
 result=call('build',{'path':str(p)});(root/'build.json').write_text(json.dumps(result,indent=2));assert result['ok'];print('BUILD OK',flush=True)
finally:
 child.stdin.close();child.wait(timeout=10);log.close()
