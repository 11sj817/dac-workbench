const http = require('http');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function j(p) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9337' + p, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const DL = 'D:\\reverse\\_dl';
if (!fs.existsSync(DL)) fs.mkdirSync(DL, { recursive: true });
// 清空
for (const f of fs.readdirSync(DL)) { try { fs.unlinkSync(path.join(DL, f)); } catch (e) { } }

(async () => {
  const list = await j('/json/list');
  const page = list.find(t => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pend = new Map();
  const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  await new Promise(r => ws.onopen = r);
  const ev = async (e) => {
    let w = /^\s*\(/.test(e) ? e
      : (/\bawait\b/.test(e) ? (/\breturn\b/.test(e) ? `(async()=>{${e}})()` : `(async()=>{return (${e});})()`)
        : (/\breturn\b/.test(e) ? `(()=>{${e}})()` : (/\bvar\b/.test(e) || /;\s*$/.test(e) ? `(()=>{${e}})()` : `(()=>{return (${e});})()`)));
    const r = await send('Runtime.evaluate', { expression: w, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 200);
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/?auto=1' });
  await sleep(16000);

  console.log('分析状态:', await ev("document.getElementById('status').textContent"));
  const h0 = await ev("return window.__dacFingerprint ? (await window.__dacFingerprint(window.__S ? window.__S.columns : ['x'], [[1]])).hash : 'no-fn';");

  // 先切到「导出报告」tab，按钮在那里
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='report'||x.textContent.includes('导出报告')); if(b)b.click(); return 'ok';");
  await sleep(2500);
  const btnNames = await ev("return JSON.stringify([...document.querySelectorAll('#pane button')].map(b=>b.textContent.trim()).filter(t=>t.includes('项目')));");
  console.log('含"项目"的按钮:', btnNames);
  // 点「导出项目 JSON」
  const clicked = await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.trim()==='导出项目 JSON'); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  console.log('导出按钮:', clicked);
  await sleep(4000);
  const files = fs.readdirSync(DL);
  console.log('下载文件:', files);

  if (files.length) {
    const raw = fs.readFileSync(path.join(DL, files[0]), 'utf8');
    let proj = null;
    try { proj = JSON.parse(raw); } catch (e) { console.log('JSON 解析失败:', e.message); }
    if (proj) {
      console.log('\n=== 项目文件 ===');
      console.log('format:', proj.format);
      console.log('dataset.hash:', proj.dataset && proj.dataset.hash);
      console.log('dataset.hashAlg:', proj.dataset && proj.dataset.hashAlg);
      console.log('dataset.hashVersion:', proj.dataset && proj.dataset.hashVersion);
      console.log('dataset.hashBytes:', proj.dataset && proj.dataset.hashBytes);
      console.log('dataset.data 是否打包:', proj.dataset && proj.dataset.data !== null);
      console.log('config.hash:', proj.config && proj.config.hash);
      console.log('runId:', proj.runId);
      console.log('app.buildDigest:', proj.app && proj.app.buildDigest);
      console.log('app.version:', proj.app && proj.app.version);
    }
  }
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
