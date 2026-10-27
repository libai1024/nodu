import json,time,uuid,urllib.request
from pathlib import Path
out=Path(__file__).resolve().parent
url='http://127.0.0.1:23981/api/studio/'
pid='25e8010b-73f6-4e14-a14c-5eb949c37bb4'
def get():
 s=json.load(urllib.request.urlopen(url+'state',timeout=10));assert s['project']['projectId']==pid;return s
def call(route,data):
 p=get()['project'];data={**data,'expectedProjectId':pid,'expectedRevision':p['revision'],'operationId':str(uuid.uuid4())}
 r=urllib.request.Request(url+route,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 return json.load(urllib.request.urlopen(r,timeout=40))
def wait(text,label):
 end=time.monotonic()+50
 while time.monotonic()<end:
  s=get()
  if text in s['simulation'].get('uart',''):
   (out/(label+'.json')).write_text(json.dumps(s,ensure_ascii=False,indent=2));print('PASS',label,flush=True);return s
  if s['simulation']['status']!='running':raise RuntimeError(s['simulation'])
  time.sleep(1)
 raise AssertionError((label,get()['simulation'].get('uart')))
s=get();fid=s['simulation']['firmware']['id'];sha=s['simulation']['binarySHA256'];results=[]
def run(engine):
 s=call('firmware/run',{'firmwareId':fid,'targetId':'mcu','engineId':engine,'maxSeconds':180})
 assert s['simulation']['binarySHA256']==sha
 return s
wire={'id':'dht-data','from':'mcu.PB0','to':'dht.DATA'}
removed=False
try:
 call('environment',{'inputs':{'dht':{'temperature':24,'humidity':55}}})
 run('renode');wait('temperature=24.0 C humidity=55.0%RH status=OK','06-renode-baseline')
 call('simulation/uart',{'text':'?','componentId':'uart'})
 wait('ACK NODU_DHT11 v1','07-renode-ack')
 call('simulation/inputs',{'inputs':{'dht':{'temperature':31,'humidity':68}}})
 s=wait('temperature=31.0 C humidity=68.0%RH status=OK','08-renode-changed');results.append({'case':'renode-positive','runId':s['simulation']['runId'],'sha256':sha})
 call('simulation/stop',{})
 call('commands',{'command':'wire.remove','arguments':{'id':'dht-data'}});removed=True
 for engine in ['qemu','renode']:
  run(engine);s=wait('DHT11_ERROR=1','09-'+engine+'-disconnected');assert 'status=OK' not in s['simulation']['uart'];results.append({'case':engine+'-disconnected','runId':s['simulation']['runId'],'sha256':sha});call('simulation/stop',{})
finally:
 if get()['simulation']['status']=='running':call('simulation/stop',{})
 if removed:call('commands',{'command':'wire.add','arguments':{'wire':wire}})
call('environment',{'inputs':{'dht':{'temperature':24,'humidity':55}}})
run('renode');s=wait('temperature=24.0 C humidity=55.0%RH status=OK','10-restored');results.append({'case':'restored','runId':s['simulation']['runId'],'sha256':sha})
(out/'results.json').write_text(json.dumps(results,indent=2));print('COMPLETE; restored circuit running for desktop capture',flush=True)
