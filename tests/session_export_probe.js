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
const DL = 'D:\\reverse\\_dl_sess';
if (!fs.existsSync(DL)) fs.mkdirSync(DL, { recursive: true });
for (const f of fs.readdirSync(DL)) { try { fs.unlinkSync(path.join(DL, f)); } catch (e) { } }

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
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/?auto=1' });
  await sleep(15000);

  console.log('分析:', await ev("document.getElementById('status').textContent"));

  // 生成一次本地模板（不产生 AI 日志），并伪造一条 AI 日志验证渲染
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='ai'); if(b)b.click(); return 'ok';");
  await sleep(2000);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('本地模板')); if(b)b.click(); return 'ok';");
  await sleep(2500);

  // 注入一条真实形状的 AI 日志（模拟一次成功 + 一次失败）
  await ev(`(() => {
    const S = window.__dacState();
    S.projectName = '会话导出测试';
    S.aiLog = [
      { at: new Date(Date.now()-60000).toISOString(), role:'assistant', ok:true,
        q: '这批数据的异质性主要体现在哪些变量上？',
        a: '【1. 数据与分型】\\n本次分析使用 150 条有效样本。\\n\\n【2. 条件组合规则】\\n花瓣长是主要区分变量。\\n\\n【3. 机制与边界】\\n相关不等于因果。\\n\\n【4. 下一步】\\n可补做时间切分。',
        provider:'deepseek', model:'deepseek-chat', ms: 2340 },
      { at: new Date(Date.now()-30000).toISOString(), role:'assistant', ok:false,
        q: '帮我写一段结论', a: '', error: 'HTTP 401：API Key 无效', provider:'deepseek', model:'deepseek-chat', ms: 410 }
    ];
    return 'ok';
  })()`);

  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='report'); if(b)b.click(); return 'ok';");
  await sleep(2500);
  const btns = await ev("return JSON.stringify([...document.querySelectorAll('#pane button')].map(b=>b.textContent.trim()).filter(t=>t.includes('导出')));");
  console.log('导出按钮:', btns);

  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('导出会话')); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  await sleep(5000);
  const files = fs.readdirSync(DL);
  console.log('下载文件:', files);

  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
