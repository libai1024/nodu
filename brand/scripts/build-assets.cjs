// Original Nodu vector artwork. Run with Node.js and the sharp package available.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const out = path.resolve(__dirname, '../assets');
fs.mkdirSync(out, { recursive: true });

const mark = '<path d="M18 80V22H35V30C40 24 48 20 58 20C75 20 84 31 84 49V57H66V49C66 40 62 36 54 36C43 36 36 44 36 55V80Z"/><circle cx="75" cy="75" r="9"/>';
const lettering = '<path d="M0 90V32H14V39C19 33 26 30 35 30C50 30 58 40 58 55V90H43V57C43 48 39 43 31 43S15 48 15 58V90Z"/><path fill-rule="evenodd" d="M96 30C115 30 127 42 127 61S115 92 96 92S65 80 65 61S77 30 96 30ZM96 44C86 44 80 50 80 61S86 78 96 78S112 72 112 61S106 44 96 44Z"/><path fill-rule="evenodd" d="M183 6H198V90H184V83C179 89 172 92 163 92C146 92 135 80 135 61S146 30 163 30C171 30 178 33 183 38ZM166 44C156 44 150 50 150 61S156 78 166 78S183 72 183 61S176 44 166 44Z"/><path d="M211 32H226V66C226 75 230 79 238 79C247 79 253 73 253 64V32H268V90H254V83C249 89 242 92 232 92C218 92 211 82 211 67Z"/>';

function svg(body, {box='0 0 100 100', title='Nodu', color='currentColor'} = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" role="img" aria-label="${title}"><title>${title}</title><g fill="${color}">${body}</g></svg>\n`;
}
function write(name, content) { fs.writeFileSync(path.join(out, name), content); }

const variants = [
  {id:'01', name:'起点', type:'字形与圆点', rationale:'开放的小写 n 代表入门的入口，分离圆点代表第一次点亮的结果。两部分在小尺寸下仍清晰。', body:mark},
  {id:'02', name:'台阶', type:'实心几何', rationale:'两级向上的台阶，把先完成一个小项目、再逐步进阶的过程压缩为一个轮廓。', body:'<path d="M18 82V54H42V30H66V18H82V82Z"/>'},
  {id:'03', name:'积木', type:'模块点阵', rationale:'六个等尺寸模块组成向上的构建节奏；适合教学与组件库的辅助图案。', body:[[18,64],[42,64],[66,64],[42,40],[66,40],[66,16]].map(([x,y])=>`<rect x="${x}" y="${y}" width="18" height="18" rx="4"/>`).join('')},
  {id:'04', name:'路径', type:'连续线形', rationale:'一条路径经过两个转折，表达编写、构建与运行的连续动作。', body:'<path d="M22 78V54H50V26H78" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>'},
  {id:'05', name:'起跑门', type:'几何与线形', rationale:'开启的门框与向前的短横，表达低门槛入口和第一个可见的进展。', body:'<path d="M22 80V20H64V38M22 80H64V64" fill="none" stroke="currentColor" stroke-width="13" stroke-linejoin="round"/><rect x="46" y="45" width="38" height="12" rx="6"/>'},
  {id:'06', name:'汇合', type:'节点网络', rationale:'两个输入连向一个结果，表示不同开发板共享熟悉的开发流程。', body:'<path d="M26 26V49Q26 54 32 54H72M26 78V59Q26 54 32 54" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round"/><circle cx="26" cy="24" r="11"/><circle cx="26" cy="78" r="11"/><circle cx="76" cy="54" r="13"/>'}
];
for (const v of variants) write(`exploration-${v.id}.svg`, svg(v.body, {title:`Nodu · ${v.name}`}));
write('explorations.json', JSON.stringify(variants.map(({body,...v})=>({...v,file:`exploration-${v.id}.svg`,recommended:v.id==='01'})),null,2)+'\n');
write('mark.svg', svg(mark, {title:'Nodu 起点标志'}));
write('mark-dark.svg', svg(mark, {color:'#244BB0',title:'Nodu 深色标志'}));
write('mark-light.svg', svg(mark, {color:'#8EACFF',title:'Nodu 浅色标志'}));
write('wordmark.svg', svg(lettering, {box:'0 0 268 100',title:'nodu 定制字标'}));
write('logo.svg', svg(mark+`<g transform="translate(118 0)">${lettering}</g>`, {box:'0 0 408 100',title:'Nodu 横向组合标志'}));
write('logo-dark.svg', svg(`<g fill="#244BB0">${mark}</g><g transform="translate(118 0)" fill="#181D20">${lettering}</g>`, {box:'0 0 408 100',title:'Nodu 浅底组合标志'}));
write('logo-light.svg', svg(`<g fill="#8EACFF">${mark}</g><g transform="translate(118 0)" fill="#F3F3EE">${lettering}</g>`, {box:'0 0 408 100',title:'Nodu 深底组合标志'}));
write('app-icon.svg', svg(`<rect x="4" y="4" width="92" height="92" rx="22" fill="#181D20"/><g fill="#8EACFF" transform="translate(8 8) scale(.84)">${mark}</g>`, {title:'Nodu 应用图标'}));
write('app-icon-light.svg', svg(`<rect x="4" y="4" width="92" height="92" rx="22" fill="#8EACFF"/><g fill="#181D20" transform="translate(8 8) scale(.84)">${mark}</g>`, {title:'Nodu 浅蓝应用图标'}));

(async()=>{
  for(const size of [16,24,32,64,128,256,512,1024]) {
    await sharp(Buffer.from(fs.readFileSync(path.join(out,'app-icon.svg')))).resize(size,size).png().toFile(path.join(out,`app-icon-${size}.png`));
  }
  for(const [input,output,width] of [['mark-dark.svg','mark-1024.png',1024],['logo-dark.svg','logo-dark-2040.png',2040],['logo-light.svg','logo-light-2040.png',2040]]) {
    await sharp(Buffer.from(fs.readFileSync(path.join(out,input)))).resize({width}).png().toFile(path.join(out,output));
  }
  // Four environments in one exact, vector-authored identity board; labels use the local presentation page.
  const board = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000"><rect width="1600" height="1000" fill="#F3F3EE"/><rect x="800" width="800" height="500" fill="#181D20"/><rect y="500" width="800" height="500" fill="#8EACFF"/><rect x="800" y="500" width="800" height="500" fill="#fff"/><g transform="translate(140 180) scale(1.3)" fill="#181D20">${mark}<g transform="translate(118 0)">${lettering}</g></g><g transform="translate(1100 140) scale(2.1)" fill="#8EACFF">${mark}</g><g transform="translate(290 640) scale(2.1)" fill="#181D20">${mark}</g><g transform="translate(910 680) scale(1.45)" fill="#181D20"><g transform="translate(0 -10) scale(.9)">${mark}</g><g transform="translate(108 -10) scale(.9)">${lettering}</g></g></svg>`;
  write('identity-board.svg',board);
  await sharp(Buffer.from(board)).png().toFile(path.join(out,'identity-board.png'));
  console.log('Nodu vector master, six explorations and transparent PNG exports created.');
})();
