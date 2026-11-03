const http = require('http');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const KEY = process.argv[2] || '';
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
  // Runtime.evaluate 不支持顶层 return。三种情况：
  //   1) 已是 IIFE          → 原样
  //   2) 含 return          → 包函数
  //   3) 多语句（含 var/;） → 包函数，返回 undefined
  //   4) 单表达式           → return (expr)
  const ev = async (e) => {
    let wrapped;
    if (/^\s*\(/.test(e)) wrapped = e;
    else if (/\breturn\b/.test(e)) wrapped = `(()=>{${e}})()`;
    else if (/\bvar\b/.test(e) || /;\s*$/.test(e)) wrapped = `(()=>{${e}})()`;
    else wrapped = `(()=>{return (${e});})()`;
    const r = await send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      return 'EXC: ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 120);
    }
    return r.result.value;
  };
  await send('Page.enable'); await send('Network.enable'); await send('Runtime.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  const errs = [];
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map(a => a.value || a.description || '').join(' ')); });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/?v=8100' });
  await sleep(13000);

  // 打开 AI 页
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='ai'); if(b)b.click();");
  await sleep(1500);
  console.log('1. AI 页(未跑分析):', (await ev("document.querySelector('#pane').innerText.slice(0,80)")).replace(/\n/g, ' | '));

  // 展开设置
  await ev("var d=document.querySelector('#pane details'); if(d) d.open=true; return 'ok';");
  await sleep(500);

  // 选智谱
  const provs = await ev("return JSON.stringify([...document.querySelectorAll('#pane select')[0].options].map(o=>o.value));");
  console.log('2. 服务商列表:', provs);
  const pick = await ev("var s=document.querySelectorAll('#pane select')[0]; var o=[...s.options].find(o=>o.value==='zhipu'); if(o){s.value='zhipu'; s.dispatchEvent(new Event('change')); return 'ok';} return 'no-zhipu';");
  console.log('3. 选智谱:', pick);
  await sleep(1200);
  const base = await ev("var i=[...document.querySelectorAll('#pane input')].find(x=>x.value.includes('bigmodel')||x.value.includes('api')); return i? i.value : '?';");
  console.log('4. Base URL:', base);

  // 填 key
  await ev(`var p=document.querySelectorAll('#pane input[type=password]')[0]; if(p){p.value=${JSON.stringify(KEY)}; p.dispatchEvent(new Event('input'));} return 'ok';`);
  await sleep(400);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent==='保存设置'); if(b)b.click(); return 'ok';");
  await sleep(800);
  const masked = await ev("var c=[...document.querySelectorAll('#pane .chip')].find(x=>x.textContent.includes('已设置')); return c? c.textContent : '未设置';");
  console.log('5. Key 掩码:', masked);

  // 获取模型
  const bm = await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('获取')); if(!b){return 'no-btn';} b.click(); return 'clicked';");
  console.log('6. 获取模型:', bm);
  await sleep(6000);
  const modelOpts = await ev("var s=[...document.querySelectorAll('#pane select')].find(s=>[...s.options].some(o=>o.value.includes('glm'))); return s? JSON.stringify([...s.options].map(o=>o.value).slice(0,8)) : 'none';");
  console.log('7. 模型选项:', modelOpts);

  // 测试连接
  const bt = await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent==='测试连接'); if(!b)return 'no-btn'; b.click(); return 'clicked';");
  console.log('8. 测试连接:', bt);
  for (let i = 0; i < 15; i++) {
    await sleep(1500);
    const t = await ev("document.querySelector('#pane').innerText");
    const m = t.match(/[^\n]*(ms|HTTP|失败|成功|可用)[^\n]*/g);
    if (m && m.some(x => x.includes('ms') || x.includes('失败') || x.includes('HTTP'))) { console.log('9. 结果:', m.slice(-2).join(' / ').slice(0, 150)); break; }
  }

  // 发一条聊天
  const ta = await ev("var t=document.querySelector('#pane textarea'); if(!t)return 'no-ta'; t.value='用一句话说明什么是过拟合'; return 'ok';");
  if (ta === 'ok') {
    await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent==='发送'); if(b)b.click(); return 'ok';");
    for (let i = 0; i < 20; i++) {
      await sleep(2000);
      const n = await ev("var p=document.querySelector('#pane'); var b=[...p.querySelectorAll('div')].filter(d=>d.style.maxWidth==='88%'); return b.length;");
      if (n >= 2) { console.log('10. 聊天回复: 已收到'); break; }
      if (i === 19) console.log('10. 聊天回复: 超时');
    }
  }

  console.log('11. console 错误:', errs.length, errs.slice(0, 2).join(' || ').slice(0, 200));
  ws.close(); process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
