/* 走真实聊天 UI 的流式路径（不是测试钩子）
 * mock fetch → 点「发送」→ 观察气泡是否逐字、思考块是否出现、状态栏是否计时
 */
const http = require('http');
const fs = require('fs');
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
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/' });
  await sleep(14000);

  // 载入 + 分析
  await ev("var s=document.getElementById('dsSelect'); var o=[...s.options].find(o=>o.value==='iris'); if(o){s.value='iris'; s.dispatchEvent(new Event('change'));} return 'ok';");
  await sleep(3500);
  await ev("window.__dacRun(); return 'ok';");
  await sleep(4500);
  console.log('分析:', await ev("document.getElementById('status').textContent"));

  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='ai'); if(b)b.click(); return 'ok';");
  await sleep(2500);

  // 配 AI + 装 mock fetch
  await ev(`(() => {
    const S = window.__dacState();
    S.ai = Object.assign({}, S.ai, { provider:'deepseek', model:'deepseek-chat', key:'sk-test', baseURL:'https://api.deepseek.com/v1' });
    const enc = new TextEncoder();
    const think = '先看轮廓系数，再看规则支持度。';
    const body = '【结论】这批数据支持三类情境。\\n【依据】\\n- 轮廓系数 0.442\\n- 规则 4 条\\n【局限】相关不等于因果。\\n【下一步】补做时间切分。';
    window.__mockCalls = 0;
    window.fetch = async () => {
      window.__mockCalls++;
      const parts = [];
      for (const ch of think) parts.push('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: ch } }] }) + '\\n\\n');
      for (const ch of body) parts.push('data: ' + JSON.stringify({ choices: [{ delta: { content: ch } }] }) + '\\n\\n');
      parts.push('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { completion_tokens: 60 } }) + '\\n\\n');
      parts.push('data: [DONE]\\n\\n');
      let k = 0;
      const stream = new ReadableStream({
        async pull(c) {
          if (k >= parts.length) { c.close(); return; }
          await new Promise(r => setTimeout(r, 12));
          c.enqueue(enc.encode(parts[k++]));
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    return 'ok';
  })()`);

  // 点发送
  const t0 = Date.now();
  await ev("var t=document.querySelector('#pane textarea'); if(!t) return 'no-textarea'; t.value='这批数据能写进论文吗'; var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.trim()==='发送'); if(!b) return 'no-send'; b.click(); return 'sent';");

  // 采样气泡状态
  const samples = [];
  for (let i = 0; i < 26; i++) {
    await sleep(120);
    // 只取聊天流里的气泡（页面底部那个 out 也是 .ai-msg，会干扰）
    const s = await ev(`(() => {
      const busyEl = document.querySelector('.ai-msg.busy');
      const scope = busyEl || [...document.querySelectorAll('.ai-msg')].find(x => x.querySelector('[data-text]'));
      if (!scope) return JSON.stringify({ busy:false, bodyLen:0, status:null, think:null });
      const dt = scope.querySelector('[data-text]');
      const stEl = [...scope.querySelectorAll('div')].find(d => /^(等待响应|思考中|生成中|完成|已停止)/.test(d.textContent||''));
      const th = scope.querySelector('.ai-think summary');
      return JSON.stringify({
        busy: scope.classList.contains('busy'),
        bodyLen: dt ? dt.dataset.text.length : 0,
        status: stEl ? stEl.textContent : null,
        think: th ? th.textContent : null
      });
    })()`);
    samples.push({ t: Date.now() - t0, s: String(s) });
  }
  console.log('\n=== 采样（时间 / 气泡状态）===');
  let prevLen = -1;
  samples.forEach(x => {
    try {
      const o = JSON.parse(x.s);
      if (o.bodyLen !== prevLen || x.t < 600) {
        console.log(`  ${String(x.t).padStart(5)}ms  len=${String(o.bodyLen).padStart(3)}  busy=${o.busy}  ${o.status ? '「'+String(o.status).slice(0,34)+'」' : ''}`);
        prevLen = o.bodyLen;
      }
    } catch (e) { }
  });

  await sleep(2500);
  const final = await ev(`(() => {
    const S = window.__dacState();
    const chat = (S.extra && S.extra.chat) || [];
    const last = chat[chat.length-1];
    const bubbles = document.querySelectorAll('.ai-msg');
    return JSON.stringify({
      mockCalls: window.__mockCalls,
      chatLen: chat.length,
      lastRole: last ? last.role : null,
      lastHasReasoning: !!(last && last.reasoning),
      lastMeta: last ? last.meta : null,
      lastContentLen: last ? last.content.length : 0,
      domBubbles: bubbles.length,
      thinkInDom: !!document.querySelector('.ai-think')
    });
  })()`);
  console.log('\n=== 最终状态 ===');
  console.log('  ' + String(final));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('D:/reverse/dac-reverse-research/evidence/v63_chat_stream.png', Buffer.from(shot.data, 'base64'));
  console.log('  截图: evidence/v63_chat_stream.png');

  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
