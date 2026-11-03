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
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/' });
  await sleep(13000);

  console.log('1. __BUILD__:', await ev("return window.__BUILD__ ? JSON.stringify({digest: window.__BUILD__.digest, commit: String(window.__BUILD__.sourceCommit).slice(0,8)}) : 'missing';"));
  console.log('2. 指纹函数:', await ev("return typeof window.__dacFingerprint;"));

  const r = await ev(`(async () => {
    const fp = window.__dacFingerprint;
    const cols = ['a','b','c'];
    const base = [[1,2,3],[4,5,6],[7,8,9]];

    const h0 = await fp(cols, base);

    // 改第 2 行（索引 1）
    const m2 = base.map(r => r.slice());
    m2[1][1] = 999;
    const h2 = await fp(cols, m2);

    // 改第 3 行
    const m3 = base.map(r => r.slice());
    m3[2][0] = -1;
    const h3 = await fp(cols, m3);

    // 只改列名
    const hc = await fp(['a','b','X'], base);

    // 只改类型（同一个值 1 vs "1"）
    const ht = await fp(cols, [[1,2,3],[4,5,6],[7,8,9]]);
    const hs = await fp(cols, [['1',2,3],[4,5,6],[7,8,9]]);

    // 缺失 vs 0
    const hn = await fp(cols, [[null,2,3],[4,5,6],[7,8,9]]);
    const hz = await fp(cols, [[0,2,3],[4,5,6],[7,8,9]]);

    // 确定性
    const again = await fp(cols, base);

    return JSON.stringify({
      alg: h0.alg, hash: h0.hash.slice(0,16), rows: h0.rows, bytes: h0.bytes,
      same: h0.hash === again.hash,
      changeRow2: h0.hash !== h2.hash,
      changeRow3: h0.hash !== h3.hash,
      changeColName: h0.hash !== hc.hash,
      numVsStr: ht.hash !== hs.hash,
      nullVsZero: hn.hash !== hz.hash
    });
  })()`);
  console.log('3. 指纹行为:', r);

  // 配置指纹
  console.log('4. 配置指纹:', await ev("var c=window.__dacConfigFingerprint? window.__dacConfigFingerprint() : null; return c? JSON.stringify({alg:c.alg, hash:c.hash.slice(0,16)}) : 'missing';"));

  console.log('\nconsole 错误:', errs.length);
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
