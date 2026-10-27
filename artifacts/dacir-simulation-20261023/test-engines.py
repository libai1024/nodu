from pathlib import Path
import sys,json,time,hashlib,importlib.util,traceback
ROOT=Path('/Users/wangwei/Project/FC/STM32_Study_Studio')
OUT=Path(__file__).resolve().parent
sys.path[:0]=[str(ROOT),str(ROOT/'demo')]
from contracts import validate_wiring
P=OUT/'projects/f103-template-sim'
elf=P/'build/debug/firmware.elf'
def latest(s):
    samples=[]
    for line in s.get('uart','').splitlines():
        try:
            obj=json.loads(line)
            if obj.get('event')=='sample': samples.append(obj)
        except (ValueError,AttributeError): pass
    return samples[-1] if samples else {}
def run(engine):
    out=OUT/('engine-'+engine);out.mkdir(exist_ok=False)
    spec=importlib.util.spec_from_file_location('accept_'+engine,ROOT/('engines/picsimlab-qemu/demo/session.py' if engine=='qemu' else 'engines/renode/demo/session.py'))
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    session=(mod.QemuDemoSession if engine=='qemu' else mod.RenodeDemoSession)(max_seconds=600)
    circuit=json.loads((P/'circuit.json').read_text())
    report={'engine':engine,'elf':str(elf),'sha256':hashlib.sha256(elf.read_bytes()).hexdigest(),'checks':[]}
    def wait(temp,hum):
        deadline=time.monotonic()+140
        while time.monotonic()<deadline:
            s=session.snapshot();v=latest(s)
            if v.get('temperature_tenths')==temp and v.get('humidity_tenths')==hum and v.get('oled_status')==0 and v.get('dht_status')==0:return s
            if s.get('error'):raise RuntimeError(s['error'])
            time.sleep(.2)
        (out/'timeout.json').write_text(json.dumps(s,ensure_ascii=False))
        raise TimeoutError(str(v))
    def save(name,s):
        (out/(name+'.json')).write_text(json.dumps(s,ensure_ascii=False))
        assert s.get('display_on') and any(s.get('framebuffer') or []),'OLED blank'
        report['checks'].append({'name':name,'sample':latest(s),'oled_nonblank':True})
        print(engine,name,latest(s),flush=True)
    try:
        session.start(elf,out/'session',temperature=24,humidity=55,circuit=validate_wiring(circuit['connections'],circuit['components']))
        s=wait(260,550);save('baseline',s);before=s['framebuffer']
        next(c for c in circuit['components'] if c['id']=='dht')['properties'].update(temperature=31,humidity=65)
        session.update_circuit(validate_wiring(circuit['connections'],circuit['components']))
        s=wait(330,650);save('changed-input',s)
        assert s['framebuffer']!=before,'OLED did not change'
        report['image_id']=session.image_id;report['status']='PASS'
    except Exception as e:
        report.update(status='FAIL',error=repr(e));traceback.print_exc()
    finally:
        session.stop();(out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    return report
r=[run(x) for x in ['qemu','renode']]
(OUT/'engines-summary.json').write_text(json.dumps(r,ensure_ascii=False,indent=2))
sys.exit(0 if all(x['status']=='PASS' for x in r) else 1)
