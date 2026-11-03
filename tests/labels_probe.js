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
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  const errs = []; ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(1); });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/?auto=1' });
  await sleep(16000);
  console.log('分析:', await ev("document.getElementById('status').textContent"));

  // 规则里的 then 值
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='rules'); if(b)b.click(); return 'ok';");
  await sleep(2200);
  const rules = await ev("var p=document.querySelector('#pane'); var m=p.innerText.match(/THEN[^\\n]*/g); return m? JSON.stringify(m.slice(0,4)) : 'none';");
  console.log('\n规则 THEN 值:', rules);

  // 本地模板
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='ai'); if(b)b.click(); return 'ok';");
  await sleep(2000);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('本地模板')); if(b)b.click(); return 'ok';");
  await sleep(3000);
  const out = await ev("var p=document.querySelector('#pane'); var d=[...p.querySelectorAll('div')].filter(x=>x.innerText&&x.innerText.includes('条件组合规则')); return d.length? d[d.length-1].innerText.slice(0,420) : 'not-found';");
  console.log('\n=== 本地模板（条件组合规则段）===');
  console.log(String(out).slice(0, 400));

  // 有序目标（wine）应仍是低/中/高
  await ev("var s=document.getElementById('dsSelect'); var o=[...s.options].find(o=>o.value==='wine'); if(o){s.value='wine'; s.dispatchEvent(new Event('change'));} return 'ok';");
  await sleep(3500);
  await ev("var b=document.getElementById('btnRun'); if(b)b.click(); return 'ok';");
  for (let i = 0; i < 20; i++) { await sleep(1500); const t = await ev("document.getElementById('status').textContent"); if (t.includes('完成')) break; }
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='rules'); if(b)b.click(); return 'ok';");
  await sleep(2200);
  const rules2 = await ev("var p=document.querySelector('#pane'); var m=p.innerText.match(/THEN[^\\n]*/g); return m? JSON.stringify(m.slice(0,3)) : 'none';");
  console.log('\n=== wine（有序）规则 THEN 值 ===');
  console.log(rules2);

  console.log('\nconsole 错误:', errs.length);
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
