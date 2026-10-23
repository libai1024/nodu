# SPDX-License-Identifier: MIT
import base64,hashlib,io,json,tarfile,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parents[3]/'artifacts/ai-tutor-m0/ai-probe'
root.mkdir(parents=True,exist_ok=True)
out=[]
for name,version in [('@theia/ai-core','1.76.0'),('@theia/ai-chat','1.76.0'),('@theia/ai-chat-ui','1.76.0'),('@theia/ai-openai','1.76.0'),('@cline/ui','0.1.0')]:
 url=f'https://registry.npmjs.org/{name.replace("/","%2f")}/{version}'
 meta=json.load(urllib.request.urlopen(url))
 data=urllib.request.urlopen(meta['dist']['tarball']).read()
 integrity='sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()
 assert integrity==meta['dist']['integrity'],name
 target=root/'packages'/name.removeprefix('@').replace('/','-')
 target.mkdir(parents=True,exist_ok=True)
 with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as tar:
  size=0;files=0
  for member in tar.getmembers():
   if not member.isfile():continue
   parts=Path(member.name).parts
   assert parts[0]=='package' and '..' not in parts and not Path(member.name).is_absolute()
   dest=target.joinpath(*parts[1:]);dest.parent.mkdir(parents=True,exist_ok=True)
   dest.write_bytes(tar.extractfile(member).read());size+=member.size;files+=1
 out.append({'name':name,'version':version,'registry':url,'tarball':meta['dist']['tarball'],'integrity':integrity,'tarGzipBytes':len(data),'unpackedBytes':size,'files':files,'license':meta.get('license'),'dependencies':meta.get('dependencies',{}),'peerDependencies':meta.get('peerDependencies',{}),'exports':meta.get('exports',{}),'theiaExtensions':meta.get('theiaExtensions',[])})
(root/'packages.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
for p in out:print(p['name'],p['version'],p['tarGzipBytes'],p['unpackedBytes'],p['files'])
