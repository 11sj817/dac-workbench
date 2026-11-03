const http = require('http');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function j(p) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9337' + p, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
(async () => {
  const list = await j('/json/list');
  const page = list.find(t => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pend = new Map();
  const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      console.log('CONSOLE-ERR:', m.params.args.map(a => String(a.value || a.description || '')).join(' ').slice(0, 300));
  };
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
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/?auto=1' });
  await sleep(16000);
  console.log('分析:', await ev("document.getElementById('status').textContent"));

  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='scene'); if(b)b.click(); return 'ok';");
  await sleep(2200);
  const btns = await ev("return JSON.stringify([...document.querySelectorAll('#pane button')].map(b=>b.textContent.trim()).filter(t=>t.includes('查看样本')));");
  console.log('下钻按钮:', btns);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('查看样本')); if(b)b.click(); return 'ok';");
  await sleep(1800);
  const rows = await ev("var ts=[...document.querySelectorAll('#pane table')]; if(!ts.length) return 'no-table'; var t=ts[ts.length-1]; return [...t.rows].slice(0,4).map(r=>[...r.cells].map(c=>c.innerText.trim()).join(' | ')).join('\\n');");
  console.log('\n=== 下钻样本（前 4 行）===');
  console.log(String(rows));
  const cnt = await ev("var d=[...document.querySelectorAll('#pane div')].find(x=>x.textContent.includes('匹配')); return d? d.textContent.trim() : 'none';");
  console.log('\n计数:', cnt);

  await ev("var i=document.querySelector('#pane input[placeholder*=rowId]'); if(i){i.value='1-10'; i.dispatchEvent(new Event('input')); } return 'ok';");
  await sleep(1200);
  const cnt2 = await ev("var d=[...document.querySelectorAll('#pane div')].find(x=>x.textContent.includes('匹配')); return d? d.textContent.trim() : 'none';");
  console.log('过滤 1-10 后:', cnt2);

  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
