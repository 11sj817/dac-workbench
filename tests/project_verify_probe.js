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

  // 1) 当前数据（iris）的指纹
  const hIris = await ev("return window.__dacFingerprint ? (await window.__dacFingerprint(window.__dacState().columns, window.__dacState().rows)).hash : 'no';");

  // 2) 切到 wine
  await ev("var s=document.getElementById('dsSelect'); var o=[...s.options].find(o=>o.value==='wine'); if(o){s.value='wine'; s.dispatchEvent(new Event('change'));} return 'ok';");
  await sleep(3500);
  await ev("var b=document.getElementById('btnRun'); if(b)b.click(); return 'ok';");
  for (let i = 0; i < 20; i++) { await sleep(1500); const t = await ev("document.getElementById('status').textContent"); if (t.includes('完成')) break; }
  const hWine = await ev("return window.__dacFingerprint ? (await window.__dacFingerprint(window.__dacState().columns, window.__dacState().rows)).hash : 'no';");

  console.log('iris 指纹:', String(hIris).slice(0, 16));
  console.log('wine 指纹:', String(hWine).slice(0, 16));
  console.log('两者不同:', hIris !== hWine);

  // 3) 用「含数据」的项目导出 + 导入，验证校验通过
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='report'); if(b)b.click(); return 'ok';");
  await sleep(2000);
  const projJson = await ev(`(async () => {
    // 直接构造一份「含数据」的项目快照，避免依赖下载
    const fp = await window.__dacFingerprint(window.__dacState().columns, window.__dacState().rows);
    return JSON.stringify({ format:'dac-project/2.7', dataset:{ columns: window.__dacState().columns, data: window.__dacState().rows, hash: fp.hash, hashAlg: fp.alg } });
  })()`);
  console.log('\n构造项目 JSON 长度:', String(projJson).length);

  // 4) 用错误 hash 的项目导入 → 应该提示不一致
  const badJson = (() => {
    const o = JSON.parse(projJson);
    o.dataset.hash = 'deadbeef'.repeat(8);
    return JSON.stringify(o);
  })();
  await ev(`window.__BAD_PROJ__ = ${JSON.stringify(badJson)}; return 'ok';`);
  const r = await ev(`(async () => {
    // 直接把错误 hash 的项目喂给导入逻辑（模拟用户拖入）
    const blob = new Blob([window.__BAD_PROJ__], {type:'application/json'});
    const file = new File([blob], 'bad.json', {type:'application/json'});
    // 借用页面里的导入入口
    const inp = [...document.querySelectorAll('input[type=file]')].find(i => i.id !== 'file');
    if (!inp) return 'no-import-input';
    const dt = new DataTransfer(); dt.items.add(file); inp.files = dt.files;
    inp.dispatchEvent(new Event('change', {bubbles:true}));
    return 'fed';
  })()`);
  console.log('喂入错误项目:', r);
  await sleep(3000);
  const toastText = await ev("var t=[...document.querySelectorAll('.toast, #toast, .toasts div')].map(x=>x.textContent).join(' | '); return t || '（无 toast）';");
  console.log('提示:', String(toastText).slice(0, 220));

  console.log('\nconsole 错误:', errs.length);
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
