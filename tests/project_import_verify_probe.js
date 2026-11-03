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
  const errs = []; ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(1); });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/?auto=1' });
  await sleep(16000);

  // 捕获 toast 文本
  await ev(`
    window.__TOASTS__ = [];
    if (!window.__origToastPatched) {
      window.__origToastPatched = true;
      const mo = new MutationObserver(() => {
        document.querySelectorAll('.toast, #toast, .toasts > div').forEach(el => {
          const t = el.textContent.trim();
          if (t && window.__TOASTS__.indexOf(t) < 0) window.__TOASTS__.push(t);
        });
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
    return 'ok';
  `);

  const st = await ev("var s=window.__dacState(); return JSON.stringify({rows: s.rows.length, cols: s.columns.length, target: s.target});");
  console.log('当前数据:', st);

  // ---- A. hash 一致的项目 → 应提示通过 ----
  const good = await ev(`(async () => {
    const S = window.__dacState();
    const fp = await window.__dacFingerprint(S.columns, S.rows);
    const proj = { format:'dac-project/2.7', dataset:{ columns: S.columns, data: S.rows, hash: fp.hash, hashAlg: fp.alg } };
    const file = new File([JSON.stringify(proj)], 'good.json', {type:'application/json'});
    window.__dacImportProject(file);
    return fp.hash.slice(0,16);
  })()`);
  console.log('\n[A] 喂入 hash 一致的项目，指纹:', good);
  await sleep(3500);
  let toasts = await ev("return JSON.stringify(window.__TOASTS__);");
  console.log('    toast:', String(toasts).slice(0, 300));

  // ---- B. hash 不一致的项目 → 应警告 ----
  await ev("window.__TOASTS__ = []; return 'cleared';");
  const bad = await ev(`(async () => {
    const S = window.__dacState();
    const proj = { format:'dac-project/2.7', dataset:{ columns: S.columns, data: S.rows, hash: 'deadbeef'.repeat(8), hashAlg: 'SHA-256' } };
    const file = new File([JSON.stringify(proj)], 'bad.json', {type:'application/json'});
    window.__dacImportProject(file);
    return 'deadbeef…';
  })()`);
  console.log('\n[B] 喂入 hash 不一致的项目:', bad);
  await sleep(3500);
  toasts = await ev("return JSON.stringify(window.__TOASTS__);");
  console.log('    toast:', String(toasts).slice(0, 400));
  const mismatch = await ev("return window.__dacState().projMismatch ? JSON.stringify(window.__dacState().projMismatch) : 'null';");
  console.log('    projMismatch:', String(mismatch).slice(0, 200));
  const vs = await ev("return JSON.stringify(window.__dacState().projVerified || null);");
  console.log('    projVerified(A 的遗留，B 应已清? 不清):', String(vs).slice(0, 150));

  // ---- C. 旧项目（无 hash）→ 应说明无法校验 ----
  await ev("window.__TOASTS__ = []; return 'cleared';");
  await ev(`(async () => {
    const S = window.__dacState();
    const proj = { format:'dac-project/2.6', dataset:{ columns: S.columns, data: S.rows } };
    const file = new File([JSON.stringify(proj)], 'old.json', {type:'application/json'});
    window.__dacImportProject(file);
    return 'ok';
  })()`);
  await sleep(3000);
  toasts = await ev("return JSON.stringify(window.__TOASTS__);");
  console.log('\n[C] 旧项目（无 hash） toast:', String(toasts).slice(0, 300));
  const warn = await ev("return window.__dacState().projWarn || 'null';");
  console.log('    projWarn:', String(warn).slice(0, 150));

  console.log('\nconsole 错误:', errs.length);
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
