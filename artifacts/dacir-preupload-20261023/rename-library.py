from pathlib import Path
import re,json,hashlib,shutil
r=Path('/Users/wangwei/Model/dacir-templates')
a=Path('/Users/wangwei/Model/k210-studio/artifacts/dacir-preupload-20261023')
backup=a/'before-generic-names'
assert not backup.exists()
shutil.copytree(r,backup)
base=r/'templates/temperature-humidity/drivers/nun-dx/NUN_DX_STM32'
dirs={'DX_common':'common','DX_control':'control','DX_debug':'debug','DX_device':'devices','DX_driver':'peripherals'}
special={'DX_common_headfile':'embedded','DX_common_typedef':'types','DX_config':'driver_config','DX_common_interrupt':'interrupts','DX_debug':'debug','DX_device_0.9_i2c_oled':'ssd1306','DX_device_i2c_mpu6050':'mpu6050'}
paths={}; stems={}; tokens={}
for p in base.rglob('*'):
 if not p.is_file():continue
 rel=p.relative_to(base)
 stem=special.get(p.stem,re.sub(r'^DX_(?:common|control|device|driver)_','',p.stem))
 new=Path(dirs[rel.parts[0]])/(stem+p.suffix)
 paths[str(rel)]=str(new); stems[p.stem]=stem
 if p.suffix=='.h':
  m=re.search(r'^#ifndef\s+(\S+)',p.read_text(),re.M)
  if m:tokens[m[1]]='EMBEDDED_'+re.sub(r'[^A-Za-z0-9]','_',str(new)).upper()
assert len(paths)==len(set(paths.values()))
tokens.update({'DX_GPIO_Init':'gpio_init','DX_GPIO_SetHigh':'gpio_set_high','DX_GPIO_SetLow':'gpio_set_low','DX_GPIO_Toggle':'gpio_toggle','DX_GPIO_Read':'gpio_read','DX_GPIO_Test':'gpio_test','DX_Delay_Init':'delay_init','DX_Delay_ms':'delay_wait_ms','DX_Delay_us':'delay_wait_us','DX_assert':'debug_assert','DX_log':'debug_log'})
for p in base.rglob('*'):
 if not p.is_file():continue
 for x in re.findall(r'\b(?:DX_|dx_)\w+\b',p.read_text()):
  if x in tokens or x in stems:continue
  if x.startswith('dx_'):tokens[x]=x[3:]
  elif x.startswith('DX_USE_'):tokens[x]=x.replace('DX_USE_','DEVICE_ENABLE_',1)
  elif x.startswith('DX_TIM'):tokens[x]=x.replace('DX_TIM','TIMER',1)
  elif x.isupper():tokens[x]='GPIO_'+x[3:]
rx=re.compile(r'\b(?:'+ '|'.join(re.escape(x) for x in sorted(tokens,key=len,reverse=True))+r')\b')
def transform(s):
 for old,new in sorted(stems.items(),key=lambda kv:len(kv[0]),reverse=True):
  s=s.replace(old+'.h',new+'.h').replace(old+'.c',new+'.c')
 s=rx.sub(lambda m:tokens[m[0]],s)
 s=s.replace('DX_driver 驱动层','底层外设驱动层').replace('DX_device','设备层')
 return s
for t in (r/'templates').iterdir():
 old=t/'drivers/nun-dx'; new=t/'drivers/embedded'; old.rename(new)
 lib=new/'NUN_DX_STM32'
 for oldpath,newpath in paths.items():
  source=lib/oldpath;dest=new/newpath;dest.parent.mkdir(parents=True,exist_ok=True)
  dest.write_text(transform(source.read_text()))
 shutil.rmtree(lib)
 for d in ('src','include'):
  for p in (t/d).rglob('*'):
   if p.is_file():p.write_text(transform(p.read_text()).replace('the independently versioned library is untouched.','driver feature selection.'))
 p=t/'README.md'
 if p.exists():p.write_text(transform(p.read_text()).replace('drivers/nun-dx/','drivers/embedded/'))
 p=t/'components.lock.json';data=json.loads(p.read_text());data['distribution']['libraryRoot']='drivers/embedded';data['distribution']['changes'].append('Renamed library directories, files, include guards, feature macros and public symbols to functional generic names; original copyright and license notices retained.');p.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
p=r/'adapter/CMakeLists.txt';s=p.read_text().replace('Original sources are unchanged.','Uses the generic library layout.').replace('set(DX "${CMAKE_CURRENT_SOURCE_DIR}/drivers/nun-dx/NUN_DX_STM32")','set(EMBEDDED "${CMAKE_CURRENT_SOURCE_DIR}/drivers/embedded")').replace('${DX}/DX_driver/','${EMBEDDED}/peripherals/').replace('${DX}/DX_device/','${EMBEDDED}/devices/').replace('foreach(NAME font font16 fifo interrupt)','foreach(NAME font font16 fifo interrupts)').replace('${DX}/DX_common/DX_common_${NAME}.c','${EMBEDDED}/common/${NAME}.c');p.write_text(s)
for p in [r/'README.md',r/'licenses/NOTICE.md']:
 p.write_text(p.read_text().replace('drivers/nun-dx/','drivers/embedded/'))
p=r/'licenses/NOTICE.md';p.write_text(p.read_text()+'\nOn 2026-10-23 this distribution renamed library directories, source files, include guards, feature macros and symbols to generic functional names. These naming changes do not change authorship or license terms.\n')
# Keep modification notices without reattributing existing code.
for t in (r/'templates').iterdir():
 for p in (t/'drivers/embedded').rglob('*'):
  if p.suffix in ('.c','.h'):
   p.write_text('/* Modified 2026-10-23: generic file and API names; original license retained. */\n'+p.read_text())
# Local migration evidence; not shipped as a compatibility layer.
(a/'generic-naming-map.json').write_text(json.dumps({'paths':paths,'identifiers':tokens},indent=2)+'\n')
print(f'Renamed {len(paths)} library files per template and {len(tokens)} identifiers.')
