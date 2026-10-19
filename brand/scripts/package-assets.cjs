const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '../assets');
const sizes = [16,32,64,256];
const entries = sizes.map(size=>({size,data:fs.readFileSync(path.join(dir,`app-icon-${size}.png`))}));
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(1,2); header.writeUInt16LE(entries.length,4);
let offset = header.length;
entries.forEach(({size,data},index)=>{
  const p = 6 + 16*index;
  header[p] = size===256 ? 0 : size; header[p+1] = size===256 ? 0 : size;
  header.writeUInt16LE(1,p+4); header.writeUInt16LE(32,p+6);
  header.writeUInt32LE(data.length,p+8); header.writeUInt32LE(offset,p+12);
  offset += data.length;
});
fs.writeFileSync(path.join(dir,'Nodu.ico'),Buffer.concat([header,...entries.map(e=>e.data)]));
const iconset=path.join(dir,'Nodu.iconset'); fs.mkdirSync(iconset,{recursive:true});
for(const size of [16,32,128,256,512]) {
  fs.copyFileSync(path.join(dir,`app-icon-${size}.png`),path.join(iconset,`icon_${size}x${size}.png`));
  fs.copyFileSync(path.join(dir,`app-icon-${size*2}.png`),path.join(iconset,`icon_${size}x${size}@2x.png`));
}
console.log('Windows ICO and macOS iconset exported.');
