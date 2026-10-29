// Live Windows network probes. No proxy, mirror rewriting, or disabled TLS checks.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const root = process.env.NODU_ACCEPTANCE_ROOT, output = path.join(root, 'network');
fs.mkdirSync(output, { recursive: true });
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'network-plan.json')));
const results = [];
function run(item) {
  const file = path.join(output, item.name + '.download'), started = Date.now();
  return new Promise(resolve => execFile('C:\\Windows\\System32\\curl.exe', [
    '--noproxy', '*', '--location', '--fail', '--silent', '--show-error',
    '--connect-timeout', '12', '--max-time', '90', '--output', file,
    '--write-out', '%{http_code}|%{size_download}|%{time_total}|%{url_effective}', item.url
  ], { timeout: 95000, windowsHide: true }, (error, stdout, stderr) => {
    const result = { ...item, elapsedMs: Date.now()-started, exitCode: error?.code ?? 0, curl: stdout.trim(), error: stderr.trim() };
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      result.bytes = bytes.length; result.actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      if (item.sha256) result.checksumMatches = result.actualSha256 === item.sha256 && bytes.length === item.expectedSize;
      if (item.name.includes('esp32') && item.name.includes('index') && !error) {
        try { const index=JSON.parse(bytes); result.validIndex=Array.isArray(index.packages); result.versions=index.packages?.flatMap(x=>x.platforms?.map(p=>p.version)||[]).slice(0,8); }
        catch(e){result.validIndex=false;result.parseError=e.message;}
      }
    }
    results.push(result); fs.writeFileSync(path.join(output,'results.json'), JSON.stringify({started:new Date().toISOString(),proxy:'curl --noproxy *',results},null,2));
    console.log(JSON.stringify(result)); resolve(result);
  }));
}
(async()=>{ for(let i=0;i<plan.length;i+=2) await Promise.all(plan.slice(i,i+2).map(run)); })().catch(e=>{console.error(e);process.exitCode=1});
