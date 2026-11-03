/* 线上最终验收（第 22/23 点）
 * 目标：在 https://11sj817.github.io/dac-workbench/ 上跑完整用户路径
 * 上传 → 选择 → 主分析 → 严格 CV → 嵌套 → Bootstrap → GLM → 报告 → 会话 → 项目重开
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SITE = 'https://11sj817.github.io/dac-workbench/';
const CSV = 'D:\\reverse\\_wine_upload.csv';
const DL = 'D:\\reverse\\_dl_live';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function j(p) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9337' + p, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
if (!fs.existsSync(DL)) fs.mkdirSync(DL, { recursive: true });
for (const f of fs.readdirSync(DL)) { try { fs.unlinkSync(path.join(DL, f)); } catch (e) { } }

const buf = fs.readFileSync(CSV);
const fileHash = crypto.createHash('sha256').update(buf).digest('hex');
const csvText = buf.toString('utf8');

const R = { site: SITE, csvHash: fileHash, steps: [], errors: [] };
let T0 = Date.now();
const mark = (name, extra) => {
  const e = Object.assign({ step: name, at: Date.now() - T0 }, extra || {});
  R.steps.push(e);
  console.log(`[${String(Date.now() - T0).padStart(6)}ms] ${name}` + (extra ? '  ' + JSON.stringify(extra).slice(0, 260) : ''));
};

(async () => {
  const list = await j('/json/list');
  const page = list.find(t => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0; const pend = new Map();
  const send = (m, p) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      R.errors.push(String(m.params.args.map(a => a.value || a.description || '').join(' ')).slice(0, 300));
    }
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
  const waitFor = async (test, maxMs) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 90000)) {
      const s = await ev(test);
      if (s && s !== 'busy' && s !== 'null' && s !== 'false') return s;
      await sleep(900);
    }
    return 'TIMEOUT';
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  T0 = Date.now();
  await send('Page.navigate', { url: SITE });
  await sleep(16000);
  mark('线上页面加载');

  // ---- 0. 版本核对 ----
  const build = await ev("return window.__BUILD__ ? JSON.stringify(window.__BUILD__) : 'none';");
  mark('线上 __BUILD__', { build });
  const appVer = await ev("return (window.__dacState && window.__dacState()) ? 'state-ok' : 'no-state';");
  mark('调试入口', { appVer });

  // ---- 1. 上传 ----
  await send('Runtime.evaluate', { expression: `window.__CSV__ = ${JSON.stringify(csvText)};` });
  const up = await ev("var inp=document.getElementById('file'); if(!inp) return 'no-input'; var dt=new DataTransfer(); dt.items.add(new File([window.__CSV__], 'wine_quality.csv', {type:'text/csv'})); inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true})); return 'ok';");
  mark('上传文件', { up });
  await sleep(3000);
  const prev = await ev("var d=document.getElementById('dsInfo'); return d? d.innerText.replace(/\\n/g,' | ').slice(0,140) : '';");
  mark('导入预览', { prev });
  const ok = await ev("var b=document.getElementById('impOk'); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  mark('确认导入', { ok });
  await sleep(3000);
  const shape = await ev("var s=window.__dacState(); return JSON.stringify({rows:s.rows.length, cols:s.columns.length, target:s.target, factors:(s.factors||[]).length});");
  mark('导入完成', { shape });

  // ---- 2. 主分析 ----
  await ev("window.__dacRun(); return 'ok';");
  await sleep(2500);
  const s1 = await waitFor("document.getElementById('status').textContent.search('完成')>=0 ? document.getElementById('status').textContent : 'busy'", 60000);
  mark('主分析', { status: s1 });
  const sum = await ev("var s=document.getElementById('summary'); return s? s.innerText.replace(/\\n/g,' | ').slice(0,160) : '';");
  mark('摘要', { head: sum });

  // ---- 3. 严格 CV ----
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='quality'); if(b)b.click(); return 'ok';");
  await sleep(2500);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('运行严格')); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  const st = await waitFor("var s=window.__dacState(); var q=s.extra&&s.extra.quality; return (q&&q.strict)? JSON.stringify({ok:q.strict.ok, acc:q.strict.oof?+q.strict.oof.accuracy.toFixed(3):null, n:q.strict.oof?q.strict.oof.n:null, bal:q.strict.oof?+q.strict.oof.balancedAccuracy.toFixed(3):null, split:q.strict.splitKind, base:q.strict.oof&&q.strict.oof.baseline?+q.strict.oof.baseline.accuracy.toFixed(3):null}) : 'busy'", 150000);
  mark('严格 CV', { result: st });

  // ---- 4. 嵌套验证 ----
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('嵌套验证')); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  const nest = await waitFor("var s=window.__dacState(); var q=s.extra&&s.extra.quality; return (q&&q.nested)? (q.nested.ok? JSON.stringify({nest:+(q.nested.nestedAccuracy||0).toFixed(3), plain:+(q.nested.plainAccuracy||0).toFixed(3), opt:+(q.nested.optimism||0).toFixed(3), k:q.nested.k, grid:q.nested.grid}) : 'FAIL:'+(q.nested.reason||'')) : 'busy'", 300000);
  mark('嵌套验证', { result: nest });

  // ---- 5. Bootstrap ----
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='boot'); if(b)b.click(); return 'ok';");
  await sleep(2500);
  await ev("var p=document.querySelector('#pane'); var ins=[...p.querySelectorAll('input[type=number]')]; if(ins[0]){ins[0].value='20'; ins[0].dispatchEvent(new Event('change'));} return 'ok';");
  await sleep(600);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>/开始 Bootstrap/.test(x.textContent)); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  const boot = await waitFor("var s=window.__dacState(); var b=s.extra&&s.extra.boot; if(!b||!b.result) return 'busy'; var r=b.result; return JSON.stringify({ok:r.okCount, B:r.B, failed:r.failed, ari: r.summary&&r.summary.cluster&&r.summary.cluster.ari? +r.summary.cluster.ari.mean.toFixed(3):null})", 180000);
  mark('Bootstrap', { result: boot });

  // ---- 6. GLM ----
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='glm'); if(b)b.click(); return 'ok';");
  await sleep(2500);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('拟合')); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  const glm = await waitFor("var s=window.__dacState(); var g=s.extra&&s.extra.glm; if(!g) return 'busy'; if(g.fit) return JSON.stringify({family:g.fit.family, n:g.fit.n, aic:+g.fit.aic.toFixed(2)}); return 'REJECTED: '+String(g.error||'').slice(0,80)", 90000);
  mark('GLM', { result: glm });

  // ---- 7. 报告 / 会话 / 项目 ----
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='report'); if(b)b.click(); return 'ok';");
  await sleep(3000);
  const rbtns = await ev("return JSON.stringify([...document.querySelectorAll('#pane button')].map(b=>b.textContent.trim()).filter(t=>t.includes('导出')));");
  mark('导出按钮', { btns: rbtns });
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('Word 报告')); if(b)b.click(); return 'ok';");
  await sleep(4000);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('导出会话')); if(b)b.click(); return 'ok';");
  await sleep(4000);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.trim()==='导出项目（含数据）'); if(b)b.click(); return 'ok';");
  await sleep(6000);
  const files = fs.readdirSync(DL);
  mark('下载文件', { files });

  // ---- 8. 项目重开 ----
  const projName = files.find(f => f.endsWith('.json'));
  if (projName) {
    const raw = fs.readFileSync(path.join(DL, projName), 'utf8');
    const proj = JSON.parse(raw);
    mark('项目文件', {
      format: proj.format,
      hash: proj.dataset ? String(proj.dataset.hash).slice(0, 16) : null,
      hashAlg: proj.dataset ? proj.dataset.hashAlg : null,
      hasData: !!(proj.dataset && proj.dataset.data),
      runId: proj.runId
    });
    // 先换成 iris 清空，再导入
    await ev("var s=document.getElementById('dsSelect'); var o=[...s.options].find(o=>o.value==='iris'); if(o){s.value='iris'; s.dispatchEvent(new Event('change'));} return 'ok';");
    await sleep(4000);
    await send('Runtime.evaluate', { expression: `window.__PROJ__ = ${JSON.stringify(raw)};` });
    await ev("var f=new File([window.__PROJ__],'reopen.json',{type:'application/json'}); window.__dacImportProject(f); return 'fed';");
    await sleep(5000);
    const after = await ev("var s=window.__dacState(); return JSON.stringify({rows:s.rows.length, cols:s.columns.length, target:s.target, verified: s.projVerified? String(s.projVerified.hash).slice(0,16):null, mismatch: s.projMismatch?'YES':null, warn: s.projWarn||null});");
    mark('项目重开', { state: after });
    await ev("window.__dacRun(); return 'ok';");
    await sleep(3000);
    const s5 = await waitFor("document.getElementById('status').textContent.search('完成')>=0 ? document.getElementById('status').textContent : 'busy'", 60000);
    mark('重开后重跑', { status: s5 });
  }

  R.totalMs = Date.now() - T0;
  R.errorCount = R.errors.length;
  fs.writeFileSync('D:\\reverse\\_live_accept.json', JSON.stringify(R, null, 2), 'utf8');
  console.log('\n=== 记录已写 D:\\reverse\\_live_accept.json ===');
  console.log('总耗时', (R.totalMs / 1000).toFixed(1) + 's | console 错误', R.errors.length);
  R.errors.slice(0, 5).forEach(e => console.log('  ', e));
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
