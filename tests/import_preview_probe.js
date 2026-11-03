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

// 分号 CSV：含引号内逗号、空行、行宽不齐
const CSV = [
  '房间数;房龄;距离;价格',
  '7.5;20;3.2;320',
  '6.1;35;1.8;210',
  '"8,2";10;4.1;450',
  '',
  '5.4;50;0.9;150',
  '9.0;5;5.0'
].join('\n');

(async () => {
  const list = await j('/json/list');
  const page = list.find(t => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pend = new Map();
  const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  await new Promise(r => ws.onopen = r);
  const ev = async (e) => {
    let w = /^\s*\(/.test(e) ? e : (/\breturn\b/.test(e) ? `(()=>{${e}})()` : (/\bvar\b/.test(e) || /;\s*$/.test(e) ? `(()=>{${e}})()` : `(()=>{return (${e});})()`));
    const r = await send('Runtime.evaluate', { expression: w, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 160);
    return r.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  const errs = []; ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(1); });
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/' });
  await sleep(13000);

  await send('Runtime.evaluate', { expression: `window.__CSV__ = ${JSON.stringify(CSV)};` });
  const injected = await ev("var inp=document.getElementById('file'); if(!inp) return 'no-input'; var dt=new DataTransfer(); dt.items.add(new File([window.__CSV__], 'test_semicolon.csv', {type:'text/csv'})); inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true})); return 'injected';");
  console.log('注入文件:', injected);
  await sleep(3000);

  const preview = await ev("var d=document.getElementById('dsInfo'); return d? d.innerText : '';");
  console.log('\n=== 预览面板 ===');
  console.log(String(preview).slice(0, 480).replace(/\n/g, ' | '));
  console.log('\n检测分隔符:', await ev("var s=document.getElementById('impDelim'); return s? s.value : 'no-select';"));

  // 手动切成逗号，验证覆盖生效
  await ev("var s=document.getElementById('impDelim'); if(s){s.value=','; s.dispatchEvent(new Event('change'));} return 'ok';");
  await sleep(1500);
  const changed = await ev("var d=document.getElementById('dsInfo'); return d? d.innerText.slice(0,180) : '';");
  console.log('\n改成逗号后:', String(changed).replace(/\n/g, ' | ').slice(0, 200));

  // 切回自动
  await ev("var s=document.getElementById('impDelim'); if(s){s.value=''; s.dispatchEvent(new Event('change'));} return 'ok';");
  await sleep(1500);

  const ok = await ev("var b=document.getElementById('impOk'); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  console.log('\n确认导入:', ok);
  await sleep(2500);
  console.log('导入后:', String(await ev("var d=document.getElementById('dsInfo'); return d? d.innerText.slice(0,180) : '';")).replace(/\n/g, ' | '));
  console.log('状态:', await ev("document.getElementById('status').textContent"));
  console.log('\nconsole 错误:', errs.length);
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
