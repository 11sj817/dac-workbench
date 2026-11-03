/* 完整用户路径验收（第 19 点）
 * 上传公开数据 → 选择 → 主分析 → 严格 CV → Bootstrap → GLM → 报告下载 → 项目重开
 * 记录：文件 hash、行数/列数、目标、设置、结果、耗时、错误
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function j(p) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9337' + p, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const DL = 'D:\\reverse\\_dl_e2e';
if (!fs.existsSync(DL)) fs.mkdirSync(DL, { recursive: true });
for (const f of fs.readdirSync(DL)) { try { fs.unlinkSync(path.join(DL, f)); } catch (e) { } }

const CSV_PATH = 'D:\\reverse\\_wine_upload.csv';
const buf = fs.readFileSync(CSV_PATH);
const fileHash = crypto.createHash('sha256').update(buf).digest('hex');
const csvText = buf.toString('utf8');
const dataLines = csvText.trim().split('\n');
const nRows = dataLines.length - 1;
const nCols = dataLines[0].split(',').length;

const REC = { file: CSV_PATH, fileHash, rows: nRows, cols: nCols, steps: [] };
const mark = (name, extra) => {
  const t = Date.now();
  REC.steps.push(Object.assign({ step: name, at: t - T0 }, extra || {}));
  console.log(`[${String(t - T0).padStart(6)}ms] ${name}` + (extra ? '  ' + JSON.stringify(extra).slice(0, 200) : ''));
};
let T0 = Date.now();

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
      REC.steps.push({ step: 'CONSOLE_ERROR', text: String(m.params.args.map(a => a.value || a.description || '').join(' ')).slice(0, 300) });
  };
  await new Promise(r => ws.onopen = r);
  const ev = async (e) => {
    let w = /^\s*\(/.test(e) ? e
      : (/\bawait\b/.test(e) ? (/\breturn\b/.test(e) ? `(async()=>{${e}})()` : `(async()=>{return (${e});})()`)
        : (/\breturn\b/.test(e) ? `(()=>{${e}})()` : (/\bvar\b/.test(e) || /;\s*$/.test(e) ? `(()=>{${e}})()` : `(()=>{return (${e});})()`)));
    const r = await send('Runtime.evaluate', { expression: w, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXC: ' + String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '').slice(0, 220);
    return r.result.value;
  };
  const waitDone = async (label, maxMs, prev) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 90000)) {
      const s = await ev("document.getElementById('status').textContent");
      // 需要「完成/失败/出错」且与上次不同，否则会立刻返回旧状态
      if (/完成|失败|出错/.test(s) && s !== prev) return s;
      await sleep(800);
    }
    return 'TIMEOUT';
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  T0 = Date.now();
  await send('Page.navigate', { url: 'http://127.0.0.1:8788/' });
  await sleep(13000);
  mark('页面加载');

  // ---------- 1. 上传 ----------
  await send('Runtime.evaluate', { expression: `window.__CSV__ = ${JSON.stringify(csvText)};` });
  const injected = await ev("var inp=document.getElementById('file'); if(!inp) return 'no-input'; var dt=new DataTransfer(); dt.items.add(new File([window.__CSV__], 'wine_quality.csv', {type:'text/csv'})); inp.files=dt.files; inp.dispatchEvent(new Event('change',{bubbles:true})); return 'ok';");
  mark('上传文件', { injected });
  await sleep(2500);

  const preview = await ev("var d=document.getElementById('dsInfo'); return d? d.innerText.slice(0,200) : '';");
  mark('导入预览', { preview: String(preview).replace(/\n/g, ' | ').slice(0, 160) });

  const delim = await ev("var s=document.getElementById('impDelim'); return s? s.value : 'no';");
  mark('检测分隔符', { sel: delim });

  const ok = await ev("var b=document.getElementById('impOk'); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  mark('确认导入', { ok });
  await sleep(2500);

  const shape = await ev("var s=window.__dacState(); return JSON.stringify({rows: s.rows.length, cols: s.columns.length, target: s.target, factors: s.factors.length});");
  mark('导入完成', { shape });

  // ---------- 2. 选择目标与因子 ----------
  const auto = await ev("var s=window.__dacState(); return JSON.stringify({target: s.target, factors: s.factors});");
  mark('自动选中的目标/因子', { auto: String(auto).slice(0, 200) });

  // ---------- 3. 主分析 ----------
  const btnDiag = await ev("var b=document.getElementById('btnRun'); return b? JSON.stringify({exists:true, hasOnclick:!!b.onclick, visible:b.offsetParent!==null, text:b.textContent.trim()}) : 'missing';");
  mark('btnRun 状态', { diag: btnDiag });
  await ev("if (window.__dacRun) window.__dacRun(); else { var b=document.getElementById('btnRun'); if(b)b.click(); } return 'ok';");
  await sleep(2000);
  const s1 = await waitDone('主分析', 90000, '');
  mark('主分析', { status: s1 });

  const sum = await ev("var s=document.getElementById('summary'); return s? s.innerText.slice(0,300) : '';");
  mark('摘要', { head: String(sum).replace(/\n/g, ' | ').slice(0, 180) });

  // ---------- 4. 严格 CV ----------
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='quality'); if(b)b.click(); return 'ok';");
  await sleep(2000);
  const qBtns = await ev("return JSON.stringify([...document.querySelectorAll('#pane button')].map(b=>b.textContent.trim()).slice(0,12));");
  mark('质量页按钮', { btns: qBtns });
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('运行严格')); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  await sleep(2500);
  const s2 = await waitDone('严格CV', 120000, await ev("document.getElementById('status').textContent"));
  const st = await ev("var st=window.__dacState(); var q=st.extra&&st.extra.quality; return q&&q.strict? JSON.stringify({ok:q.strict.ok, oof:q.strict.oof?{acc:+q.strict.oof.accuracy.toFixed(3), n:q.strict.oof.n, bal:+q.strict.oof.balancedAccuracy.toFixed(3)}:null, gap:q.strict.gap?+q.strict.gap.toFixed(3):null}) : 'none';");
  mark('严格 CV', { status: s2, result: st });

  // ---------- 5. Bootstrap ----------
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='boot'); if(b)b.click(); return 'ok';");
  await sleep(2000);
  const bootCfg = await ev("var p=document.querySelector('#pane'); var sels=[...p.querySelectorAll('select')]; return JSON.stringify(sels.map(s=>s.value));");
  mark('Bootstrap 页配置', { sels: bootCfg });
  await ev("var p=document.querySelector('#pane'); var ins=[...p.querySelectorAll('input[type=number]')]; if(ins[0]){ins[0].value='20'; ins[0].dispatchEvent(new Event('change'));} return 'ok';");
  await sleep(600);
  const bBtns = await ev("return JSON.stringify([...document.querySelectorAll('#pane button')].map(b=>b.textContent.trim()).slice(0,12));");
  mark('Bootstrap 页按钮', { btns: bBtns });
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>/开始 Bootstrap|运行/.test(x.textContent)); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  await sleep(3000);
  const s3 = await waitDone('Bootstrap', 180000, await ev("document.getElementById('status').textContent"));
  const bt = await ev("var st=window.__dacState(); var b=st.extra&&st.extra.boot; if(!b||!b.result) return 'none'; var r=b.result; return JSON.stringify({okCount:r.okCount, B:r.B, failed:r.failed, ari: r.summary&&r.summary.cluster&&r.summary.cluster.ari? +r.summary.cluster.ari.mean.toFixed(3):null, oob: r.summary&&r.summary.rules&&r.summary.rules.oob? {acc:+(r.summary.rules.oob.accuracy||0).toFixed(3), cov:+(r.summary.rules.oob.coverage||0).toFixed(3)}:null});");
  mark('Bootstrap', { status: s3, result: bt });

  // ---------- 6. GLM ----------
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='glm'); if(b)b.click(); return 'ok';");
  await sleep(2000);
  const gBtns = await ev("return JSON.stringify([...document.querySelectorAll('#pane button')].map(b=>b.textContent.trim()).slice(0,14));");
  mark('GLM 页按钮', { btns: gBtns });
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>/拟合|运行 GLM|估计/.test(x.textContent)); if(!b) return 'no-btn'; b.click(); return 'clicked';");
  await sleep(3000);
  const s4 = await waitDone('GLM', 60000, await ev("document.getElementById('status').textContent"));
  const g = await ev("var st2=window.__dacState(); var st=st2.extra&&st2.extra.glm; if(!st||!st.fit) return 'none'; var f=st.fit; return JSON.stringify({family:f.family, n:f.n, aic:+f.aic.toFixed(2), bic:+f.bic.toFixed(2), dev:+f.deviance.toFixed(2), coefs:(f.coefs||[]).slice(0,4).map(c=>({n:c.name, b:+c.beta.toFixed(4), p:+c.p.toFixed(4)}))});");
  mark('GLM', { status: s4, result: g });

  // ---------- 7. 报告下载 ----------
  await ev("var b=[...document.querySelectorAll('#tabs button')].find(x=>x.dataset.tab==='report'); if(b)b.click(); return 'ok';");
  await sleep(2500);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.includes('Word')); if(b)b.click(); return 'ok';");
  await sleep(4000);
  await ev("var b=[...document.querySelectorAll('#pane button')].find(x=>x.textContent.trim()==='导出项目（含数据）'); if(b)b.click(); return 'ok';");
  await sleep(5000);
  const files = fs.readdirSync(DL);
  mark('下载文件', { files });

  // ---------- 8. 项目重开 ----------
  let reopen = null;
  const projFile = files.find(f => f.endsWith('.json'));
  if (projFile) {
    const raw = fs.readFileSync(path.join(DL, projFile), 'utf8');
    const proj = JSON.parse(raw);
    mark('项目文件', {
      format: proj.format,
      hash: proj.dataset && String(proj.dataset.hash).slice(0, 16),
      hashAlg: proj.dataset && proj.dataset.hashAlg,
      hasData: !!(proj.dataset && proj.dataset.data),
      runId: proj.runId
    });
    // 重开：先换到别的数据集清空，再导入
    await ev("var s=document.getElementById('dsSelect'); var o=[...s.options].find(o=>o.value==='iris'); if(o){s.value='iris'; s.dispatchEvent(new Event('change'));} return 'ok';");
    await sleep(3500);
    await send('Runtime.evaluate', { expression: `window.__PROJ__ = ${JSON.stringify(raw)};` });
    await ev(`(async () => {
      const f = new File([window.__PROJ__], 'reopen.json', {type:'application/json'});
      window.__dacImportProject(f);
      return 'fed';
    })()`);
    await sleep(4000);
    const after = await ev("var s=window.__dacState(); return JSON.stringify({rows: s.rows.length, cols: s.columns.length, target: s.target, verified: s.projVerified? String(s.projVerified.hash).slice(0,16):null, mismatch: s.projMismatch?'YES':null});");
    mark('项目重开', { state: after });
    reopen = after;

    // 重开后重跑，比较关键指标
    await ev("if (window.__dacRun) window.__dacRun(); return 'ok';");
    const s5 = await waitDone('重开后重跑', 90000, '');
    const sum2 = await ev("var s=document.getElementById('summary'); return s? s.innerText.slice(0,200) : '';");
    mark('重开后重跑', { status: s5, head: String(sum2).replace(/\n/g, ' | ').slice(0, 160) });
  }

  REC.totalMs = Date.now() - T0;
  fs.writeFileSync('D:\\reverse\\_e2e_record.json', JSON.stringify(REC, null, 2), 'utf8');
  console.log('\n=== 记录已写 D:\\reverse\\_e2e_record.json ===');
  console.log('总耗时:', (REC.totalMs / 1000).toFixed(1) + 's');
  const errs = REC.steps.filter(s => s.step === 'CONSOLE_ERROR');
  console.log('console 错误:', errs.length);
  errs.slice(0, 3).forEach(e => console.log('  ', e.text));
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
