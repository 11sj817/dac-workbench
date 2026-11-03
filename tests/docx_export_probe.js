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
    if (r.exceptionDetails) return 'EXC: ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 220);
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  const errs = []; ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(1); });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/?auto=1' });
  await sleep(16000);

  console.log('分析状态:', await ev("document.getElementById('status').textContent"));

  // 切到报告页
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='report'); if(b)b.click(); return 'ok';");
  await sleep(2500);
  const btns = await ev("return JSON.stringify([...document.querySelectorAll('#pane button')].map(b=>b.textContent.trim()).filter(t=>t.includes('导出')||t.includes('Word')));");
  console.log('导出按钮:', btns);

  const clicked = await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('Word')); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  console.log('点击 Word 导出:', clicked);
  await sleep(5000);

  const files = fs.readdirSync(DL);
  console.log('下载文件:', files);
  console.log('\nconsole 错误:', errs.length);
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
