/* 主题对比度实测 + 截图 */
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
const OUT = 'D:\\reverse\\dac-reverse-research\\evidence';
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

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

  // 载入 iris 并分析
  await ev("var s=document.getElementById('dsSelect'); var o=[...s.options].find(o=>o.value==='iris'); if(o){s.value='iris'; s.dispatchEvent(new Event('change'));} return 'ok';");
  await sleep(3500);
  await ev("window.__dacRun(); return 'ok';");
  await sleep(4500);
  console.log('分析:', await ev("document.getElementById('status').textContent"));

  // 去 AI 页，生成一条流式气泡（mock）
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='ai'); if(b)b.click(); return 'ok';");
  await sleep(2500);
  await ev(`(() => { const S = window.__dacState();
    S.ai = Object.assign({}, S.ai, { provider:'deepseek', model:'deepseek-chat', key:'sk-test', baseURL:'https://api.deepseek.com/v1' });
    return 'ok'; })()`);

  // 灌一条带思考的对话记录，直接看渲染
  await ev(`(() => {
    const S = window.__dacState();
    S.extra.chat = [
      { role:'user', content:'这批数据的异质性主要体现在哪些变量上？' },
      { role:'assistant',
        content:'【结论】这批数据支持三类情境，花瓣长与花瓣宽是主要区分变量。\\n\\n【依据】\\n- 轮廓系数 0.442（结构清晰）\\n- 规则 4 条，最高置信度 100.0%\\n- 严格 CV OOF 77.3%\\n\\n【局限】样本仅 150 条，相关不等于因果。\\n\\n【下一步】补做分组切分与嵌套验证。',
        reasoning:'先看轮廓系数是否够高，再看规则支持度，最后检查严格 CV 与训练精度的差距。',
        meta:'2841ms · 格式完整 · 数字溯源通过' }
    ];
    return 'ok';
  })()`);
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='profile'); if(b)b.click(); return 'ok';");
  await sleep(800);
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='ai'); if(b)b.click(); return 'ok';");
  await sleep(2500);

  const measure = async (tag) => {
    const r = await ev(`(() => {
      const g = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : null; };
      const lum = c => {
        const m = c.match(/\\d+/g); if (!m) return null;
        const [r,g2,b] = m.slice(0,3).map(Number).map(v => { v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); });
        return 0.2126*r + 0.7152*g2 + 0.0722*b;
      };
      const ratio = (fg,bg) => { const a=lum(fg), b=lum(bg); if(a===null||b===null) return null;
        const hi=Math.max(a,b), lo=Math.min(a,b); return +((hi+0.05)/(lo+0.05)).toFixed(2); };
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      const rootBg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      const aiBg = g('.ai-msg','backgroundColor'), aiFg = g('.ai-msg','color');
      const bubble = document.querySelectorAll('.card div[style*="border-radius"]');
      const userB = bubble.length ? bubble[0] : null;
      return JSON.stringify({
        isLight: document.body.classList.contains('light'),
        varBg: rootBg,
        aiMsg: { bg: aiBg, fg: aiFg, contrast: ratio(aiFg, aiBg) },
        think: (()=>{ const e=document.querySelector('.ai-think'); if(!e) return null;
          const cs=getComputedStyle(e); return { bg: cs.backgroundColor, fg: getComputedStyle(e.querySelector('pre')||e).color,
            contrast: ratio(getComputedStyle(e.querySelector('pre')||e).color, cs.backgroundColor) }; })()
      });
    })()`);
    console.log(`\n[${tag}] ${String(r).slice(0, 420)}`);
    return r;
  };

  // 强制深色
  await ev("document.body.classList.remove('light'); localStorage.setItem('dac-theme','dark'); return 'ok';");
  await sleep(900);
  await measure('深色');
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + '\\v63_ai_dark.png', Buffer.from(shot1.data, 'base64'));
  console.log('  截图: evidence\\v63_ai_dark.png');

  // 浅色
  await ev("document.body.classList.add('light'); localStorage.setItem('dac-theme','light'); return 'ok';");
  await sleep(900);
  await measure('浅色');
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT + '\\v63_ai_light.png', Buffer.from(shot2.data, 'base64'));
  console.log('  截图: evidence\\v63_ai_light.png');

  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
