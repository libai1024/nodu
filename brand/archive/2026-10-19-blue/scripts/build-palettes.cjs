// Color studies reuse the exact Nodu master geometry; they do not alter the mark.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { execFileSync } = require('node:child_process');
const root=path.resolve(__dirname,'../assets');
const palettes=[
  {id:'blue',name:'蓝色',label:'BLUE',brand:'#4F7CFF',onDark:'#8EACFF',deep:'#244BB0',soft:'#E8EEFF',primary:true},
  {id:'orange',name:'暖橙',label:'ORANGE',brand:'#E98A42',onDark:'#FFB477',deep:'#9C4B1F',soft:'#F8E9DC'},
  {id:'violet',name:'紫色',label:'VIOLET',brand:'#8B78E6',onDark:'#B6A8FF',deep:'#5C43A8',soft:'#EEE9FB'},
];
const group=svg=>svg.match(/<g fill="currentColor">([\s\S]*)<\/g><\/svg>/)[1];
const mark=group(fs.readFileSync(path.join(root,'mark.svg'),'utf8'));
const lettering=group(fs.readFileSync(path.join(root,'wordmark.svg'),'utf8'));
function ico(dir){
  const entries=[16,32,64,256].map(size=>({size,data:fs.readFileSync(path.join(dir,`app-icon-${size}.png`))}));
  const head=Buffer.alloc(6+16*entries.length);head.writeUInt16LE(1,2);head.writeUInt16LE(entries.length,4);let offset=head.length;
  entries.forEach(({size,data},i)=>{const p=6+16*i;head[p]=head[p+1]=size===256?0:size;head.writeUInt16LE(1,p+4);head.writeUInt16LE(32,p+6);head.writeUInt32LE(data.length,p+8);head.writeUInt32LE(offset,p+12);offset+=data.length;});
  fs.writeFileSync(path.join(dir,'Nodu.ico'),Buffer.concat([head,...entries.map(e=>e.data)]));
}
(async()=>{
  for(const p of palettes){
    const dir=path.join(root,p.id);fs.mkdirSync(dir,{recursive:true});
    for(const file of ['mark-dark.svg','mark-light.svg','logo-dark.svg','logo-light.svg','app-icon.svg','app-icon-light.svg']){
      let s=fs.readFileSync(path.join(root,file),'utf8').replaceAll('#8EACFF',p.onDark).replaceAll('#244BB0',p.deep).replaceAll('#182C26','#181D20');
      fs.writeFileSync(path.join(dir,file),s);
    }
    for(const size of [16,24,32,64,128,256,512,1024]) await sharp(path.join(dir,'app-icon.svg')).resize(size,size).png().toFile(path.join(dir,`app-icon-${size}.png`));
    for(const name of ['logo-dark','logo-light']) await sharp(path.join(dir,name+'.svg')).resize({width:2040}).png().toFile(path.join(dir,name+'-2040.png'));
    ico(dir);
    const set=path.join(dir,'Nodu.iconset');fs.mkdirSync(set,{recursive:true});
    for(const size of [16,32,128,256,512]){
      fs.copyFileSync(path.join(dir,`app-icon-${size}.png`),path.join(set,`icon_${size}x${size}.png`));
      fs.copyFileSync(path.join(dir,`app-icon-${size*2}.png`),path.join(set,`icon_${size}x${size}@2x.png`));
    }
    if(process.platform==='darwin') execFileSync('/usr/bin/iconutil',['-c','icns','-o',path.join(dir,'Nodu.icns'),set]);
  }
  fs.writeFileSync(path.join(root,'palettes.json'),JSON.stringify(palettes,null,2)+'\n');
  let board='<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1050" viewBox="0 0 1600 1050"><rect width="1600" height="1050" fill="#F3F3EE"/>';
  palettes.forEach((p,i)=>{
    const x=32+i*528;
    board+=`<g transform="translate(${x} 32)"><rect width="512" height="986" fill="${p.soft}"/><rect width="512" height="520" fill="#181D20"/><g transform="translate(121 110) scale(2.7)" fill="${p.onDark}">${mark}</g><g transform="translate(94 568) scale(1.2)" fill="#181D20">${lettering}</g><text x="256" y="766" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="24" font-weight="500" fill="${p.deep}">${p.label}</text><g transform="translate(140 822)"><rect width="232" height="44" rx="5" fill="${p.deep}"/><text x="116" y="29" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="16" fill="#FFFFFF">Run example</text></g><text x="256" y="935" text-anchor="middle" font-family="monospace" font-size="18" fill="${p.deep}">${p.brand}</text></g>`;
  });
  board+='</svg>';
  fs.writeFileSync(path.join(root,'palette-comparison.svg'),board);
  await sharp(Buffer.from(board)).png().toFile(path.join(root,'palette-comparison.png'));
  console.log('Three color studies exported with unchanged mark and wordmark geometry.');
})();
