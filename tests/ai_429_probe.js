/* AI 429 Retry-After 处理（第 15 点）
 * 在浏览器里 mock fetch，验证：
 *   1) 429 会重试（不再被当成"客户端错误不重试"）
 *   2) 等待时间按 Retry-After，而不是固定 800ms
 *   3) 重试用尽后，错误消息里带上"该等多久"
 *   4) 其他 4xx（401）仍然不重试
 */
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

  console.log('='.repeat(66));
  console.log('AI 429 Retry-After 处理');
  console.log('='.repeat(66));

  // 先把 AI 配置塞进去（callLLM 从 aiCfg() 读）
  await ev(`(() => {
    const S = window.__dacState();
    S.ai = Object.assign({}, S.ai, {
      provider: 'deepseek', model: 'deepseek-chat',
      key: 'sk-test-not-real', baseURL: 'https://api.deepseek.com/v1'
    });
    return 'ok';
  })()`);

  // 通过 AI 页的调用链测试：拦截 fetch
  const r = await ev(`(async () => {
    const realFetch = window.fetch;
    const log = [];
    window.__calls = log;

    // ---- 场景 A：前两次 429（Retry-After: 1 秒），第三次成功 ----
    let n = 0;
    window.fetch = async (url, opt) => {
      n++;
      log.push({ n, t: Date.now() });
      if (n < 3) {
        return new Response('{"error":"rate limited"}', {
          status: 429,
          headers: { 'Retry-After': '1' }
        });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '好的，这是回答。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const t0 = Date.now();
    let resA = null, errA = null;
    try {
      resA = await window.__callLLMTest(
        [{ role: 'user', content: '测试 429' }],
        { retries: 3 }
      );
    } catch (e) { errA = e.message; }
    const msA = Date.now() - t0;
    const gapsA = log.slice(1).map((x, i) => x.t - log[i].t);

    window.fetch = realFetch;

    return JSON.stringify({
      calls: log.length,
      gapsMs: gapsA,
      ok: !!resA,
      content: resA ? String(resA.content || '').slice(0, 30) : null,
      err: errA,
      totalMs: msA
    });
  })()`);
  console.log('\n【A】429 ×2（Retry-After: 1s）→ 成功');
  console.log('  ' + String(r));

  let A = null;
  try { A = JSON.parse(r); } catch (e) { }
  if (A) {
    console.log(`  调用次数 ${A.calls}（期望 3）`);
    console.log(`  间隔 ${JSON.stringify(A.gapsMs)} ms（期望都 ≥1000，且 <2000）`);
    console.log(`  结果 ${A.ok ? '成功，内容「' + A.content + '」' : '失败：' + A.err}`);
    const gapsOk = (A.gapsMs || []).every(x => x >= 950 && x < 2500);
    console.log(`  ${A.calls === 3 ? '✅' : '❌'} 重试了 429`);
    console.log(`  ${gapsOk ? '✅' : '❌'} 等待时间按 Retry-After（不是固定 800ms）`);
    console.log(`  ${A.ok ? '✅' : '❌'} 最终成功`);
  } else {
    console.log('  ❌ 无法解析结果');
  }

  // ---- 场景 B：一直 429，重试用尽 → 错误消息带等待提示 ----
  const r2 = await ev(`(async () => {
    const realFetch = window.fetch;
    let n = 0;
    window.fetch = async () => {
      n++;
      return new Response('{"error":"rate limited"}', { status: 429, headers: { 'Retry-After': '2' } });
    };
    let err = null;
    try {
      await window.__callLLMTest(
        [{ role: 'user', content: '测试 429 一直' }],
        { retries: 2 }
      );
    } catch (e) { err = e.message; }
    window.fetch = realFetch;
    return JSON.stringify({ calls: n, err });
  })()`);
  console.log('\n【B】一直 429，重试用尽');
  console.log('  ' + String(r2));
  let B = null;
  try { B = JSON.parse(r2); } catch (e) { }
  if (B) {
    console.log(`  调用次数 ${B.calls}（期望 2）`);
    console.log(`  ${B.calls === 2 ? '✅' : '❌'} 按 retries 次数重试`);
    console.log(`  ${/等待 2 秒|Retry-After/.test(B.err || '') ? '✅' : '❌'} 错误消息说明了该等多久`);
    console.log(`  消息：${String(B.err || '').split('\n').slice(-1)[0].slice(0, 90)}`);
  }

  // ---- 场景 C：401 不重试 ----
  const r3 = await ev(`(async () => {
    const realFetch = window.fetch;
    let n = 0;
    window.fetch = async () => { n++; return new Response('{"error":"bad key"}', { status: 401 }); };
    let err = null;
    try {
      await window.__callLLMTest(
        [{ role: 'user', content: 'x' }],
        { retries: 3 }
      );
    } catch (e) { err = e.message; }
    window.fetch = realFetch;
    return JSON.stringify({ calls: n, err: String(err || '').slice(0, 80) });
  })()`);
  console.log('\n【C】401（Key 错）');
  console.log('  ' + String(r3));
  let C2 = null;
  try { C2 = JSON.parse(r3); } catch (e) { }
  if (C2) {
    console.log(`  调用次数 ${C2.calls}（期望 1，不重试）`);
    console.log(`  ${C2.calls === 1 ? '✅' : '❌'} 401 不重试`);
  }

  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
