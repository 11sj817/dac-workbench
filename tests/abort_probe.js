/* 定向诊断：abort 是否真的生效 */
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
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/' });
  await sleep(14000);
  await ev(`(() => { const S = window.__dacState();
    S.ai = Object.assign({}, S.ai, { provider:'deepseek', model:'deepseek-chat', key:'sk-test', baseURL:'https://api.deepseek.com/v1' });
    return 'ok'; })()`);

  const r = await ev(`(async () => {
    const realFetch = window.fetch;
    const enc = new TextEncoder();
    let pulled = 0;
    window.fetch = async () => {
      const stream = new ReadableStream({
        async pull(c) {
          pulled++;
          if (pulled > 300) { c.close(); return; }
          await new Promise(r => setTimeout(r, 20));
          c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '字' } }] }) + '\\n\\n'));
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const ab = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ab.abort(), 400);
    let err = null, ok = null, partialLen = 0, aborted = false;
    try {
      ok = await window.__callLLMStreamTest([{role:'user',content:'x'}], { signal: ab.signal });
    } catch (e) { err = e.message; aborted = !!e.aborted; partialLen = (e.partial || '').length; }
    window.fetch = realFetch;
    return JSON.stringify({ aborted, partialLen, err, okContentLen: ok ? ok.content.length : null,
      pulled, elapsed: Date.now()-t0, signalAborted: ab.signal.aborted });
  })()`);
  console.log('abort 诊断:', String(r));
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
