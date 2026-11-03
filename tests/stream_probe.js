/* 流式输出 + 思考过程 + 停止 + 主题对比度（V6.3 验收）
 * 用 mock SSE 在浏览器里真跑一遍，不依赖真实 API
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
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      console.log('CONSOLE-ERR:', m.params.args.map(a => String(a.value || a.description || '')).join(' ').slice(0, 200));
  };
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
  await sleep(14000);

  console.log('='.repeat(70));
  console.log('V6.3 流式 / 思考 / 停止 / 主题');
  console.log('='.repeat(70));

  // 配置 AI
  await ev(`(() => { const S = window.__dacState();
    S.ai = Object.assign({}, S.ai, { provider:'deepseek', model:'deepseek-chat', key:'sk-test-not-real', baseURL:'https://api.deepseek.com/v1' });
    return 'ok'; })()`);

  // ---- 1. 流式：mock SSE，逐块吐字 ----
  const r1 = await ev(`(async () => {
    const realFetch = window.fetch;
    const chunks = [];
    const think = '先看轮廓系数，再看规则支持度。';
    const body = '【结论】这批数据支持三类情境。\\n【依据】轮廓系数 0.442，规则 4 条。\\n【局限】相关不等于因果。\\n【下一步】补做时间切分。';
    let i = 0;
    window.fetch = async () => {
      const enc = new TextEncoder();
      const parts = [];
      for (const ch of think) parts.push('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: ch } }] }) + '\\n\\n');
      for (const ch of body) parts.push('data: ' + JSON.stringify({ choices: [{ delta: { content: ch } }] }) + '\\n\\n');
      parts.push('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\\n\\n');
      parts.push('data: [DONE]\\n\\n');
      let k = 0;
      const stream = new ReadableStream({
        async pull(c) {
          if (k >= parts.length) { c.close(); return; }
          await new Promise(r => setTimeout(r, 4));
          c.enqueue(enc.encode(parts[k++]));
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const seen = [];
    const t0 = Date.now();
    let res = null, err = null;
    try {
      res = await window.__callLLMStreamTest([{ role:'user', content:'x' }], {
        onDelta: d => seen.push({ t: Date.now()-t0, c: d.content ? d.content.length : 0, r: d.reasoning ? d.reasoning.length : 0 })
      });
    } catch (e) { err = e.message; }
    window.fetch = realFetch;
    return JSON.stringify({
      ok: !!res, err,
      contentLen: res ? res.content.length : 0,
      reasoningLen: res ? (res.reasoning || '').length : 0,
      firstTokenMs: res ? res.firstTokenMs : null,
      streamed: res ? res.streamed : null,
      deltas: seen.length,
      totalMs: Date.now() - t0,
      head: res ? res.content.slice(0, 24) : null
    });
  })()`);
  console.log('\n【1】流式增量');
  console.log('  ' + String(r1).slice(0, 400));
  let R1 = null; try { R1 = JSON.parse(r1); } catch (e) { }
  if (R1) {
    console.log(`  ${R1.ok ? '✅' : '❌'} 成功`);
    console.log(`  ${R1.deltas > 40 ? '✅' : '❌'} 收到 ${R1.deltas} 个增量（逐字）`);
    console.log(`  ${R1.reasoningLen > 0 ? '✅' : '❌'} 思考过程 ${R1.reasoningLen} 字`);
    console.log(`  ${R1.firstTokenMs !== null && R1.firstTokenMs < 800 ? '✅' : '❌'} 首字 ${R1.firstTokenMs}ms`);
    console.log(`  内容开头：「${R1.head}」`);
  }

  // ---- 2. 非流式回退：中转站忽略 stream ----
  const r2 = await ev(`(async () => {
    const realFetch = window.fetch;
    window.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: '完整答案' }, finish_reason: 'stop' }], usage: {}
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    let res = null, err = null;
    try { res = await window.__callLLMStreamTest([{role:'user',content:'x'}], {}); } catch (e) { err = e.message; }
    window.fetch = realFetch;
    return JSON.stringify({ ok: !!res, streamed: res ? res.streamed : null, content: res ? res.content : null, err });
  })()`);
  console.log('\n【2】中转站返回 JSON 而非 SSE');
  console.log('  ' + String(r2));
  let R2 = null; try { R2 = JSON.parse(r2); } catch (e) { }
  if (R2) {
    console.log(`  ${R2.ok && R2.streamed === false ? '✅' : '❌'} 正确识别为非流式并接住`);
  }

  // ---- 3. 停止：abort 时保留已收到内容 ----
  const r3 = await ev(`(async () => {
    const realFetch = window.fetch;
    const enc = new TextEncoder();
    window.fetch = async () => {
      let k = 0;
      const stream = new ReadableStream({
        async pull(c) {
          if (k >= 200) { c.close(); return; }
          await new Promise(r => setTimeout(r, 10));
          c.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '字' } }] }) + '\\n\\n'));
          k++;
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const ab = new AbortController();
    setTimeout(() => ab.abort(), 260);
    let err = null, partialLen = 0, aborted = false;
    try {
      await window.__callLLMStreamTest([{role:'user',content:'x'}], { signal: ab.signal });
    } catch (e) { err = e.message; aborted = !!e.aborted; partialLen = (e.partial || '').length; }
    window.fetch = realFetch;
    return JSON.stringify({ aborted, partialLen, err });
  })()`);
  console.log('\n【3】点「停止」');
  console.log('  ' + String(r3));
  let R3 = null; try { R3 = JSON.parse(r3); } catch (e) { }
  if (R3) {
    console.log(`  ${R3.aborted ? '✅' : '❌'} 正确标记为已停止`);
    console.log(`  ${R3.partialLen > 0 ? '✅' : '❌'} 保留已收到的 ${R3.partialLen} 字`);
  }

  // ---- 4. 主题对比度 ----
  await ev("var s=document.getElementById('dsSelect'); var o=[...s.options].find(o=>o.value==='iris'); if(o){s.value='iris'; s.dispatchEvent(new Event('change'));} return 'ok';");
  await sleep(3500);
  await ev("window.__dacRun(); return 'ok';");
  await sleep(4000);
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='ai'); if(b)b.click(); return 'ok';");
  await sleep(2500);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('本地模板')); if(b)b.click(); return 'ok';");
  await sleep(1500);

  const contrast = async (label) => {
    const r = await ev(`(() => {
      const pick = sel => { const e = document.querySelector(sel); if (!e) return null;
        const cs = getComputedStyle(e); return { bg: cs.backgroundColor, fg: cs.color, border: cs.borderColor }; };
      const msg = document.querySelector('.ai-msg');
      const chat = document.querySelector('.card');
      const body = document.body;
      return JSON.stringify({
        bodyBg: getComputedStyle(body).backgroundColor,
        aiMsg: msg ? { bg: getComputedStyle(msg).backgroundColor, fg: getComputedStyle(msg).color } : null,
        chatCard: chat ? { bg: getComputedStyle(chat).backgroundColor } : null
      });
    })()`);
    console.log(`\n【4${label}】` + String(r).slice(0, 260));
    return r;
  };
  await contrast(' 深色主题');

  await ev("var b=[...document.querySelectorAll('header button, #themeBtn, button')].find(x=>/浅色|主题|light/i.test(x.textContent)); if(b)b.click(); return b? 'clicked' : 'no-btn';");
  await sleep(1800);
  const isLight = await ev("return document.body.classList.contains('light');");
  console.log('\n  切到浅色:', isLight);
  await contrast(' 浅色主题');

  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
