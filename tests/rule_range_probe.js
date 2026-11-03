/* CART 规则反解到原始量纲（第 18 点） */
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
    if (r.exceptionDetails) return 'EXC: ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 220);
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/' });
  await sleep(14000);
  console.log('初始:', await ev("document.getElementById('status').textContent"));
  // 选 iris
  console.log('选数据集:', await ev("var s=document.getElementById('dsSelect'); if(!s) return 'no-select'; var o=[...s.options].find(o=>o.value==='iris'); if(o){s.value='iris'; s.dispatchEvent(new Event('change'));} return 'ok';"));
  await sleep(4000);
  console.log('加载后:', await ev("document.getElementById('status').textContent"));
  await ev("window.__dacRun(); return 'ok';");
  await sleep(5000);
  console.log('分析后:', await ev("document.getElementById('status').textContent"));

  console.log('\n=== 校准切点 ===');
  console.log(await ev("var s=window.__dacState(); if(!s.res) return 'no-res'; return JSON.stringify(Object.entries(s.res.calibration.factors).map(([k,v])=>({f:k, th:v.thresholds.map(x=>+x.toFixed(3))})));"));

  console.log('\n=== 规则（条件 / 原始区间）===');
  console.log(String(await ev(`var s=window.__dacState(); if(!s.res) return 'no-res';
    return s.res.tree.rules.map((r,i)=>'R'+(i+1)+'  '+(r.conditions||[]).map((c,k)=>{
      const rg = r.condRanges && r.condRanges[k];
      return rg ? c+'（'+rg+'）' : c;
    }).join(' 且 ')+'  →  '+r.then).join('\\n');`)));

  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='rules'); if(b)b.click(); return 'ok';");
  await sleep(2500);
  console.log('\n=== 页面显示 ===');
  console.log(String(await ev("var p=document.querySelector('#pane'); var m=p.innerText.match(/IF[^\\n]*/g); return m? m.slice(0,3).join('\\n---\\n') : 'none';")).slice(0, 900));
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
