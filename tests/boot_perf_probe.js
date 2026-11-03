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
    if (r.exceptionDetails) return 'EXC: ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 250);
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/' });
  await sleep(13000);

  // 在浏览器里直接计时 B.run（主线程，不走 Worker）
  console.log('=== 主线 B.run 计时 ===');
  console.log(await ev(`(async () => {
    const B = window.DACBootstrap;
    if (!B) return 'no DACBootstrap';
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const n = 400, p = 11, X = [], y = [];
    for (let i = 0; i < n; i++) {
      const r = [];
      for (let j = 0; j < p; j++) r.push(rnd() * 10 + Math.sin(i / 7 + j));
      X.push(r); y.push(Math.floor(rnd() * 6));
    }
    const names = Array.from({ length: p }, (_, j) => 'x' + j);
    const t0 = performance.now();
    const res = B.run({ X, y, n, names, labels: ['a','b','c'], yName: 'y' },
      { task: 'cluster', B: 20, seed: 42, k: 3, fraction: 1, replacement: true, method: 'iid' });
    const ms = Math.round(performance.now() - t0);
    return JSON.stringify({ ms, okCount: res.okCount, failed: res.failed, ari: +res.summary.cluster.ari.mean.toFixed(3) });
  })()`));

  // 走 Worker 的 WK.run 计时
  console.log('\n=== WK.run（Worker）计时 ===');
  console.log(await ev(`(async () => {
    const S = window.__dacState();
    const names = S.factors.slice();
    const data = { X: S.rows.map(r => names.map(f => r[S.columns.indexOf(f)])),
                   y: S.rows.map(r => r[S.columns.indexOf(S.target)]),
                   n: S.rows.length, names, labels: ['a','b','c'], yName: S.target };
    const opt = { task: 'cluster', B: 20, seed: 42, k: 3, fraction: 1, replacement: true, method: 'iid' };
    const t0 = performance.now();
    let res;
    try {
      res = await window.__WK.run('bootstrapStability', { data, opt }, { timeoutMs: 600000 });
    } catch (e) {
      return 'WK failed: ' + e.message;
    }
    const ms = Math.round(performance.now() - t0);
    return JSON.stringify({ ms, okCount: res.okCount, failed: res.failed, ari: res.summary ? +res.summary.cluster.ari.mean.toFixed(3) : null });
  })()`));

  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
