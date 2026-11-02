/* ============================================================
 * DAC Workbench · 交互层
 * 步骤：1 数据 → 2 变量 → 3 校准 → 4 分析 → 5 结果
 * ============================================================ */
(function () {
  'use strict';
  const C = window.DACCore;
  const $ = s => document.querySelector(s);
  const el = (t, a = {}, kids = []) => {
    const n = document.createElement(t);
    for (const k in a) {
      if (k === 'class') n.className = a[k];
      else if (k === 'html') n.innerHTML = a[k];
      else if (k === 'text') n.textContent = a[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), a[k]);
      else n.setAttribute(k, a[k]);
    }
    (Array.isArray(kids) ? kids : [kids]).forEach(k => k && n.appendChild(k));
    return n;
  };
  const PAL = ['#4c9aff', '#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#f472b6'];
  const fmt = (v, d = 3) => {
    if (v === null || v === undefined || Number.isNaN(v)) return '-';
    if (typeof v !== 'number') return v;
    if (Number.isInteger(v)) return String(v);
    return Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(d);
  };
  const pct = v => (v * 100).toFixed(1) + '%';

  const S = {
    columns: [], rows: [], numeric: [],
    target: null, factors: [],
    params: { lowPct: 25, highPct: 75, drops: 500, levels: 3, k: 3, treeDepth: 3, netThreshold: 0.2, seed: 42 },
    res: null, extra: {}, tab: 'guide', step: 1, busy: false
  };

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  }
  const tip = $('#tip');
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.classList.add('on');
    tip.style.left = Math.min(x + 12, window.innerWidth - 240) + 'px';
    tip.style.top = (y + 16) + 'px';
  }
  function hideTip() { tip.classList.remove('on'); }

  /* ---------------- 步骤 ---------------- */
  function setStep(n) {
    S.step = n;
    [...document.querySelectorAll('#steps li')].forEach(li => {
      const v = +li.dataset.step;
      li.classList.toggle('on', v === n);
      li.classList.toggle('done', v < n);
    });
    ['1', '2', '3', '4'].forEach(i => {
      const p = $('#panel-' + i);
      if (p) p.style.display = (String(n) === i) ? '' : 'none';
    });
    if (n === 5) { document.querySelectorAll('#panel-2,#panel-3,#panel-4').forEach(p => p.style.display = 'none'); }
  }
  document.querySelectorAll('#steps li').forEach(li => li.onclick = () => {
    const v = +li.dataset.step;
    if (v >= 2 && !S.columns.length) return toast('请先导入数据');
    if (v >= 4 && !S.res) { setStep(3); return toast('先完成校准，再点「运行完整分析」'); }
    if (v === 5 && !S.res) return toast('还没有结果，先在第 4 步运行分析');
    setStep(v); setTab(v === 5 ? 'profile' : 'guide');
  });

  /* ---------------- 数据载入 ---------------- */
  $('#drop').onclick = () => $('#file').click();
  $('#file').onchange = e => { if (e.target.files[0]) loadFile(e.target.files[0]); };
  ['dragover', 'dragenter'].forEach(ev => $('#drop').addEventListener(ev, e => {
    e.preventDefault(); $('#drop').classList.add('hot');
  }));
  ['dragleave', 'drop'].forEach(ev => $('#drop').addEventListener(ev, e => {
    e.preventDefault(); $('#drop').classList.remove('hot');
  }));
  $('#drop').addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });

  async function loadFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    $('#dsInfo').textContent = '解析中…';
    try {
      let parsed;
      if (ext === 'csv' || ext === 'txt') {
        const text = await file.text();
        parsed = C.parseCSV(text);
      } else if (ext === 'xlsx' || ext === 'xls') {
        if (ext === 'xls') throw new Error('旧版 .xls 请另存为 .xlsx 或 .csv');
        const buf = await file.arrayBuffer();
        parsed = await C.parseXLSX(buf);
      } else throw new Error('只支持 .xlsx / .csv');
      applyData(parsed, file.name);
    } catch (e) {
      $('#dsInfo').textContent = '解析失败';
      toast('解析失败：' + e.message, 5000);
    }
  }

  const DS = window.__DATASETS__ || {};
  (function initDatasets() {
    const sel = $('#dsSelect');
    if (!sel) return;
    Object.entries(DS).forEach(([k, v]) => {
      sel.appendChild(el('option', { value: k, text: v.name }));
    });
    sel.onchange = () => {
      const d = DS[sel.value];
      if (!d) return;
      applyData({ columns: d.columns, rows: d.rows }, d.name, d.desc + ' · 来源：' + d.source);
    };
  })();

  function loadSample(key) {
    const k = key || Object.keys(DS)[0];
    const d = DS[k];
    if (!d) return toast('示例数据未加载');
    const sel = $('#dsSelect');
    if (sel) sel.value = k;
    applyData({ columns: d.columns, rows: d.rows }, d.name, d.desc + ' · 来源：' + d.source);
  }

  function applyData(parsed, name, desc) {
    if (!parsed.columns.length) return toast('文件里没有读到表格');
    S.columns = parsed.columns;
    S.rows = parsed.rows;
    S.numeric = C.numericCols(S.columns, S.rows);
    if (S.numeric.length < 2) return toast('至少需要 2 个数值列', 5000);

    const prof = C.profile(S.columns, S.rows);
    $('#dsInfo').innerHTML = `<b>${name}</b><br>${parsed.rows.length} 行 · ${parsed.columns.length} 列 · 数值列 ${S.numeric.length} 个`
      + (desc ? `<br><span class="muted">${desc}</span>` : '');
    $('#status').textContent = `${parsed.rows.length} 行已就绪`;
    const tag = $('#dsTag');
    if (tag) { tag.textContent = name.slice(0, 22); tag.classList.add('live'); }

    const t = $('#target'); t.innerHTML = '';
    S.numeric.forEach(c => t.appendChild(el('option', { value: c, text: c })));
    t.value = S.numeric[S.numeric.length - 1];
    t.onchange = renderFactors;

    S.target = t.value;
    renderFactors();
    setStep(2);
    S.tab = 'profile';
    setTab('profile');
    renderProfileDirect(prof);
    toast('数据已载入');
  }

  function renderFactors() {
    const box = $('#factors'); box.innerHTML = '';
    const tgt = $('#target').value;
    S.numeric.filter(c => c !== tgt).forEach(c => {
      const cb = el('input', { type: 'checkbox', value: c });
      cb.checked = true;
      cb.style.marginRight = '7px';
      box.appendChild(el('label', { class: 'row', style: 'margin:5px 0;cursor:pointer' },
        [cb, el('span', { text: c })]));
    });
    $('#facCount').textContent = '(' + (S.numeric.length - 1) + ' 个)';
  }
  const pickedFactors = () => [...document.querySelectorAll('#factors input:checked')].map(i => i.value);

  /* ---------------- 参数 ---------------- */
  const bind = (id, out, fmtFn) => {
    const s = $('#' + id);
    s.oninput = () => { if (out) $('#' + out).textContent = fmtFn ? fmtFn(s.value) : s.value; };
  };
  bind('low', 'vLow', v => v + '%');
  bind('high', 'vHigh', v => v + '%');
  bind('drops', 'vDrops');
  bind('levels', 'vLevels');
  bind('k', 'vK');
  bind('depth', 'vDepth');
  bind('net', 'vNet', v => (v / 100).toFixed(2));

  ['low', 'high', 'drops', 'levels', 'k', 'depth', 'net', 'seed'].forEach(id => {
    const n = $('#' + id);
    n.addEventListener('input', () => { if (S.res) schedule(); });
    n.addEventListener('change', () => { if (S.res) schedule(); });
  });

  let debounceTimer = null;
  function schedule() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => run(), 400);
  }

  /* ---------------- 运行 ---------------- */
  $('#next2').onclick = () => {
    if (pickedFactors().length === 0) return toast('至少选一个条件变量');
    setStep(3); setTab('calib'); run();
  };
  $('#next3').onclick = () => { setStep(4); setTab('scene'); run(); };
  $('#btnRun').onclick = () => run();

  function readParams() {
    return {
      lowPct: +$('#low').value, highPct: +$('#high').value,
      drops: +$('#drops').value, levels: +$('#levels').value,
      k: +$('#k').value, treeDepth: +$('#depth').value,
      netThreshold: +$('#net').value / 100, seed: +$('#seed').value || 42
    };
  }

  function run() {
    if (!S.columns.length) return toast('先导入数据');
    const factors = pickedFactors();
    if (!factors.length) return toast('至少选一个条件变量');
    S.target = $('#target').value;
    S.factors = factors;
    S.params = readParams();
    $('#loadbar').classList.add('on');
    const t0 = performance.now();
    setTimeout(() => {
      try {
        S.res = compute();
        S.extra = {};
        setTab(S.tab === 'guide' ? 'profile' : S.tab);
        if (S.step === 3) setStep(3); else if (S.step >= 4) setStep(5);
        const dt = ((performance.now() - t0) / 1000).toFixed(2);
        $('#status').textContent = `完成 · ${dt}s`;
        toast(`分析完成 ${dt}s`);
      } catch (e) {
        console.error(e);
        toast('计算失败：' + e.message, 6000);
      }
      $('#loadbar').classList.remove('on');
    }, 20);
  }

  function compute() {
    const { target, factors, params } = S;
    const idxT = S.columns.indexOf(target);
    const idxF = factors.map(f => S.columns.indexOf(f));
    const keep = S.rows.filter(r => C.isNum(r[idxT]) && idxF.every(j => C.isNum(r[j])));
    const yv = keep.map(r => r[idxT]);
    const X = keep.map(r => idxF.map(j => r[j]));

    const cal = {};
    factors.forEach((f, i) => { cal[f] = C.calibrate(X.map(r => r[i]), params); });
    const calY = C.calibrate(yv, params);
    const levels = params.levels;
    const labels = C.LEVEL_LABELS[levels];

    // 聚类
    const km = C.kmeans(X, params.k, { seed: params.seed });
    const sil = C.silhouette(km.Z, km.labels);
    const stats = [];
    for (let c = 0; c < params.k; c++) {
      const members = [];
      km.labels.forEach((l, i) => { if (l === c) members.push(i); });
      if (!members.length) { stats.push({ name: 'S' + (c + 1), n: 0, mean: {} }); continue; }
      const mean = { };
      factors.forEach((f, j) => { mean[f] = members.reduce((s, i) => s + X[i][j], 0) / members.length; });
      mean[target] = members.reduce((s, i) => s + yv[i], 0) / members.length;
      stats.push({ name: 'S' + (c + 1), n: members.length, mean });
    }

    // 决策树（用校准后的等级）
    const Xc = keep.map((_, i) => factors.map(f => cal[f].codes[i]));
    const yc = calY.codes.slice();
    const tree = C.cart(Xc, yc, factors, labels, { maxDepth: params.treeDepth, minLeaf: Math.max(10, Math.round(keep.length / 40)) });

    // 网络
    const net = C.network(S.columns, S.rows, factors.concat([target]), params.netThreshold);

    // PCA
    const pc = C.pca(X, km.labels, yv);

    const single = {};
    factors.forEach((f, j) => { single[f] = C.pearson(X.map(r => r[j]), yv); });

    // 交叉验证
    const minLeaf = Math.max(10, Math.round(keep.length / 40));
    const cv = C.crossValidate(Xc, yc, factors, labels, { maxDepth: params.treeDepth, minLeaf }, 5);

    // 情境自动命名
    const baseMean = {};
    factors.forEach((f, k) => { baseMean[f] = C.mean(X.map(r => r[k])); });
    baseMean[target] = C.mean(yv);
    const scenNames = C.nameScenarios(stats, factors, target, baseMean);

    // 贝叶斯网络（离散化后的数据）
    const discrete = keep.map((_, i) => factors.map(f => cal[f].codes[i]).concat([calY.codes[i]]));
    const allNames = factors.concat([target]);
    let bn = null, sens = null;
    try {
      bn = C.bnLearn(discrete, allNames, levels);
      sens = factors.map(f => ({ f, rows: C.bnSensitivity(bn, f, levels) }));
    } catch (e) { console.warn('BN failed', e); }

    const res = {
      meta: { target, factors, rows: S.rows.length, usedRows: keep.length, params },
      profile: C.profile(S.columns, S.rows),
      corr: C.corrMatrix(S.columns, S.rows),
      calibration: { factors: cal, target: calY, labels },
      scenarios: { k: params.k, silhouette: sil, stats, labels: km.labels, names: scenNames, baseMean },
      tree: Object.assign({}, tree, { single, cv }),
      net: Object.assign({}, net, { threshold: params.netThreshold }),
      pca: pc,
      bn, sens
    };
    res.report = C.report(res);
    return res;
  }

  /* ---------------- 结论摘要 ---------------- */
  function updateSummary() {
    const box = $('#summary');
    if (!box) return;
    const r = S.res;
    if (!r) { box.style.display = 'none'; return; }
    box.style.display = '';
    const L = [];
    const prof = r.profile;
    const miss = prof.columns.reduce((a, c) => a + c.missing, 0);
    const out = prof.columns.reduce((a, c) => a + (c.outliers || 0), 0);
    L.push(`<b>${prof.rows}</b> 条样本 / <b>${prof.cols}</b> 个变量；缺失 ${miss} 个、IQR 异常值 ${out} 个。`);

    const sc = r.scenarios;
    const ranked = sc.stats.filter(x => x.n > 0).slice().sort((a, b) => b.mean[r.meta.target] - a.mean[r.meta.target]);
    if (ranked[0]) {
      const nm = (sc.names && sc.names[sc.stats.indexOf(ranked[0])]) || {};
      L.push(`分型 k=${sc.k}（轮廓 ${(sc.silhouette || 0).toFixed(2)}）：<b>${ranked[0].name}</b>${nm.tag ? '「' + nm.tag + '」' : ''} 的 ${r.meta.target} 最高（均值 ${ranked[0].mean[r.meta.target].toFixed(3)}）。`);
    }

    const rules = r.tree.rules.slice().sort((a, b) => b.support * b.confidence - a.support * a.confidence);
    if (rules[0]) {
      L.push(`最强规则：${rules[0].conditions.map(c => `<code>${c}</code>`).join(' 且 ') || '无分裂'} → <b>${r.meta.target} = ${rules[0].then}</b>（n=${rules[0].support}，置信度 ${(rules[0].confidence * 100).toFixed(1)}%）。`);
    }

    if (r.tree.cv) {
      const gap = r.tree.accuracy - r.tree.cv.mean;
      L.push(`泛化能力：训练 ${(r.tree.accuracy * 100).toFixed(1)}% vs 5 折 CV ${(r.tree.cv.mean * 100).toFixed(1)}%（差 ${(gap * 100).toFixed(1)} 个百分点${gap > 0.08 ? '，<span class="warnline">存在过拟合迹象</span>' : ''}）。`);
    }

    if (r.sens && r.sens.length) {
      const lv = r.calibration.target.levels - 1;
      const scored = r.sens.map(({ f, rows }) => ({
        f, spread: Math.max(...rows.map(x => x.posterior[lv])) - Math.min(...rows.map(x => x.posterior[lv]))
      })).sort((a, b) => b.spread - a.spread);
      if (scored[0]) {
        L.push(`机制强度：<b>${scored[0].f}</b> 最关键——固定在不同等级时，${r.meta.target} 最高档的概率相差 <b>${(scored[0].spread * 100).toFixed(1)}</b> 个百分点。`);
      }
    }

    box.innerHTML = `<h4>结论摘要 · 自动生成（数字全部来自本地计算）</h4><ul>${L.map(x => `<li>${x}</li>`).join('')}</ul>`;
  }

  /* ---------------- Tab ---------------- */
  $('#tabs').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    setTab(b.dataset.tab);
  };
  function setTab(t) {
    S.tab = t;
    [...document.querySelectorAll('#tabs button')].forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    renderTab();
  }
  function renderTab() {
    updateSummary();
    const pane = $('#pane');
    if (!S.res && S.tab !== 'guide') {
      pane.innerHTML = '<div class="muted">先导入数据并运行分析。</div>';
      return;
    }
    switch (S.tab) {
      case 'guide': return renderGuide();
      case 'profile': return renderProfileDirect(S.res ? S.res.profile : C.profile(S.columns, S.rows));
      case 'corr': return renderCorr();
      case 'calib': return renderCalib();
      case 'scene': return renderScene();
      case 'rules': return renderRules();
      case 'net': return renderNet();
      case 'bn': return renderBN();
      case 'robust': return renderRobust();
      case 'ai': return renderAI();
      case 'report': return renderReport();
    }
  }

  /* ---------------- 渲染：指引 ---------------- */
  function renderGuide() {
    $('#pane').innerHTML = `
      <h3 style="margin-top:0">按 DAC 的四步走（和原站流程一致，但每一步都能看到为什么）</h3>
      <div class="grid2">
        <div class="rule"><b>① 导入</b><br>拖入 xlsx 或 csv。前 n-1 列是条件变量，最后一列是决策变量。<br>
          <span class="muted">对应书 3.1–3.2：数据来源与采集</span></div>
        <div class="rule"><b>② 选变量</b><br>指定 y 与若干 x。系统会自动做数据体检（缺失/异常/偏度）。<br>
          <span class="muted">对应书 3.3：描述性统计与相关性分析</span></div>
        <div class="rule"><b>③ 云模型校准</b><br>用 25/75 分位定标，把连续变量映射成「低/中/高」等级。<br>
          <span class="muted">对应书 3.4：正态云模型与数据校准过程</span></div>
        <div class="rule"><b>④ 分析</b><br>KMeans 分型 → CART 出规则 → 相关网络看结构。<br>
          <span class="muted">对应书 4/5/6 章；注意书第 6 章用贝叶斯网络，这里只到相关网络</span></div>
      </div>
      <div class="hint" style="margin-top:14px">
        <b>没有数据？</b>点左侧「载入示例」，用 1000 条虚构企业数据跑一遍，30 秒看完整个流程。<br>
        <b>想验证结论稳不稳？</b>改分位数（25/75 → 30/70）或 k 值，看规则和分型怎么变——这就是稳健性检验。
      </div>`;
  }

  /* ---------------- 渲染：体检 ---------------- */
  function renderProfileDirect(prof) {
    if (!prof) return;
    const pane = $('#pane');
    pane.innerHTML = '';
    pane.appendChild(el('div', { class: 'stat' }, [
      el('div', { html: `<span>样本量</span><b>${prof.rows}</b>` }),
      el('div', { html: `<span>变量数</span><b>${prof.cols}</b>` }),
      el('div', { html: `<span>数值列</span><b>${prof.columns.filter(c => c.numeric).length}</b>` }),
      el('div', { html: `<span>提示</span><b>${prof.warnings.length}</b>` })
    ]));
    const tb = el('table');
    const head = el('thead', { html: '<tr><th>变量</th><th>类型</th><th>缺失</th><th>中位数</th><th>标准差</th><th>异常值</th><th>偏度</th></tr>' });
    tb.appendChild(head);
    const body = el('tbody');
    let sortKey = null, sortAsc = false;
    const drawRows = () => {
      body.innerHTML = '';
      const arr = prof.columns.slice();
      if (sortKey) {
        arr.sort((a, b) => {
          let x = a[sortKey], y = b[sortKey];
          if (x === undefined) x = -Infinity;
          if (y === undefined) y = -Infinity;
          return sortAsc ? (x > y ? 1 : -1) : (x < y ? 1 : -1);
        });
      }
      arr.forEach(c => body.appendChild(el('tr', { html:
         `<td>${c.name}</td>
         <td><span class="pill ${c.numeric ? 'ok' : 'warn'}">${c.numeric ? '数值' : '文本'}</span></td>
       <td>${c.missing}</td><td>${fmt(c.median)}</td><td>${fmt(c.std)}</td>
         <td>${c.outliers ?? '-'}</td><td>${fmt(c.skew, 2)}</td>` })));
    };
    drawRows();
    [...head.querySelectorAll('th')].forEach((th, i) => {
      const keys = ['name', 'dtype', 'missing', 'median', 'std', 'outliers', 'skew'];
      th.onclick = () => {
        sortKey = keys[i];
        sortAsc = !sortAsc;
        drawRows();
        toast('按 ' + th.textContent + (sortAsc ? ' 升序' : ' 降序'));
      };
    });
    tb.appendChild(body);
    pane.appendChild(tb);
    if (prof.warnings.length) {
      pane.appendChild(el('h3', { text: '体检提示', style: 'margin-top:16px;color:#f59e0b' }));
      prof.warnings.forEach(w => pane.appendChild(el('div', { class: 'rule', text: w })));
    }
  }

  /* ---------------- 渲染：相关 ---------------- */
  function renderCorr() {
    const pane = $('#pane'), cm = S.res.corr;
    pane.innerHTML = '';
    const names = cm.columns.map(c => S.columns[c]);
    const n = names.length;
    const cell = Math.min(72, Math.floor(660 / n));
    const W = cell * n + 120, H = cell * n + 40;
    const g = mkSvg(W, H);
    const color = v => {
      const a = Math.min(1, Math.abs(v));
      return v >= 0 ? `rgba(76,154,255,${0.15 + a * 0.85})` : `rgba(239,68,68,${0.15 + a * 0.85})`;
    };
    for (let i = 0; i < n; i++) {
      const t = mkText(14, 26 + i * cell + cell / 2 + 4, names[i], '#8aa0b4', 11, 'end');
      g.appendChild(t);
      const t2 = mkText(120 + i * cell + cell / 2, 18, names[i], '#8aa0b4', 11, 'middle');
      g.appendChild(t2);
      for (let j = 0; j < n; j++) {
        const v = cm.matrix[i][j];
        const r = mkRect(120 + j * cell, 26 + i * cell, cell - 2, cell - 2, color(v));
        r.style.cursor = 'pointer';
        r.addEventListener('mousemove', e => showTip(`${names[i]} × ${names[j]}<br><b>r = ${v.toFixed(3)}</b>`, e.clientX, e.clientY));
        r.addEventListener('mouseleave', hideTip);
        g.appendChild(r);
        if (cell >= 46) g.appendChild(mkText(120 + j * cell + cell / 2, 26 + i * cell + cell / 2 + 4, v.toFixed(2), '#0b1016', 10, 'middle'));
      }
    }
    pane.appendChild(el('div', { class: 'muted', html: '相关系数矩阵（Pearson）。悬停看数值。<b>相关不等于因果</b>。' }));
    pane.appendChild(g);
    const pairs = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push({ a: names[i], b: names[j], r: cm.matrix[i][j] });
    pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
    pane.appendChild(el('h3', { text: '最强关联前 8 对', style: 'margin-top:16px' }));
    const tb = el('table');
    tb.appendChild(el('thead', { html: '<tr><th>变量对</th><th>r</th><th>|r|</th></tr>' }));
    const b = el('tbody');
    pairs.slice(0, 8).forEach(p => b.appendChild(el('tr', { html: `<td>${p.a} × ${p.b}</td><td>${p.r.toFixed(3)}</td><td>${Math.abs(p.r).toFixed(3)}</td>` })));
    tb.appendChild(b); pane.appendChild(tb);
  }

  /* ---------------- 渲染：校准 ---------------- */
  function renderCalib() {
    const pane = $('#pane'), cal = S.res.calibration;
    pane.innerHTML = '';
    pane.appendChild(el('div', { class: 'muted', html:
      `云模型：Ex = 分位区间中点，En = 半区间/(3×等级数)，He = En/10，云滴 <b>${S.res.meta.params.drops}</b> 次 Monte Carlo。` }));
    const names = Object.keys(cal.factors);
    const tb = el('table');
    tb.appendChild(el('thead', { html: '<tr><th>变量</th><th>等级分布</th><th>切点</th><th>平均隶属度</th><th>歧义率</th></tr>' }));
    const body = el('tbody');
    names.concat('__y__').forEach(n => {
      const c = n === '__y__' ? cal.target : cal.factors[n];
      const label = n === '__y__' ? cal.target && S.res.meta.target + '（y）' : n;
      const maxC = Math.max(...c.counts);
      const bars = c.counts.map((v, i) =>
        `<div style="display:inline-block;width:52px;margin-right:4px">
           <div class="bar"><i style="width:${Math.round(100 * v / Math.max(1, maxC))}%;background:${PAL[i]}"></i></div>
           <span class="muted" style="font-size:10.5px">${v}</span></div>`).join('');
      body.appendChild(el('tr', { html:
        `<td>${label}</td><td style="text-align:left">${bars}</td>
         <td>${c.thresholds.map(t => t.toFixed(2)).join(' / ')}</td>
         <td>${c.meanMu.toFixed(3)}</td><td>${pct(c.ambiguousRate)}</td>` }));
    });
    tb.appendChild(body); pane.appendChild(tb);

    const first = names[0];
    if (first) {
      const c = cal.factors[first];
      const W = 700, H = 220, pad = 36;
      const lo = Math.min(...c.clouds.map(x => x.ex - 3 * x.en));
      const hi = Math.max(...c.clouds.map(x => x.ex + 3 * x.en));
      const g = mkSvg(W, H);
      g.appendChild(mkLine(pad, H - pad, W - pad, H - pad, '#22313f'));
      g.appendChild(mkLine(pad, pad, pad, H - pad, '#22313f'));
      c.clouds.forEach((cl, i) => {
        let d = '';
        for (let t = 0; t <= 120; t++) {
          const x = lo + (hi - lo) * t / 120;
          const mu = Math.exp(-((x - cl.ex) ** 2) / (2 * cl.en ** 2));
          const px = pad + (x - lo) / (hi - lo || 1) * (W - pad * 2);
          const py = H - pad - mu * (H - pad * 2);
          d += (t ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
        }
        g.appendChild(mkPath(d, PAL[i]));
        g.appendChild(mkText(pad + (cl.ex - lo) / (hi - lo || 1) * (W - pad * 2), H - 12,
          `${cl.label} (Ex=${cl.ex.toFixed(2)})`, PAL[i], 11, 'middle'));
      });
      pane.appendChild(el('h3', { text: `隶属度函数：${first}`, style: 'margin-top:18px' }));
      pane.appendChild(g);
      pane.appendChild(el('div', { class: 'muted',
        text: '三条曲线的交点就是等级切点。曲线越窄，该等级越"挑剔"；越宽，越容易吸收样本。' }));
    }
  }

  /* ---------------- 渲染：分型 ---------------- */
  function renderScene() {
    const pane = $('#pane'), sc = S.res.scenarios, pc = S.res.pca;
    pane.innerHTML = '';
    pane.appendChild(el('div', { class: 'stat' }, [
      el('div', { html: `<span>聚类 k</span><b>${sc.k}</b>` }),
      el('div', { html: `<span>轮廓系数</span><b>${fmt(sc.silhouette, 3)}</b>` }),
      el('div', { html: `<span>PC1 解释</span><b>${pct(pc.explained[0])}</b>` }),
      el('div', { html: `<span>有效样本</span><b>${S.res.meta.usedRows}</b>` })
    ]));
    const ok = sc.silhouette > 0.5 ? ['ok', '分型清晰'] : sc.silhouette > 0.3 ? ['warn', '可接受'] : ['bad', '偏弱，换个 k 试试'];
    pane.appendChild(el('div', { class: 'muted', html:
      `轮廓系数判定：<span class="pill ${ok[0]}">${ok[1]}</span> —— >0.5 好，0.3~0.5 可接受，<0.3 建议调整变量或 k。` }));

    const W = 700, H = 360, pad = 34;
    const pts = pc.points;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const g = mkSvg(W, H);
    g.appendChild(mkRect(pad, pad, W - pad * 2, H - pad * 2, 'none', '#22313f'));
    pts.forEach(p => {
      const cx = pad + (p.x - x0) / (x1 - x0 || 1) * (W - pad * 2);
      const cy = H - pad - (p.y - y0) / (y1 - y0 || 1) * (H - pad * 2);
      const c = mkCircle(cx, cy, 3.1, PAL[p.c % PAL.length]);
      c.style.cursor = 'pointer';
      c.addEventListener('mousemove', e => showTip(`情境 S${p.c + 1}<br>${S.res.meta.target} = ${p.v.toFixed(3)}`, e.clientX, e.clientY));
      c.addEventListener('mouseleave', hideTip);
      g.appendChild(c);
    });
    g.appendChild(mkText(W / 2, H - 8, `PC1 (${pct(pc.explained[0])})`, '#8aa0b4', 11, 'middle'));
    pane.appendChild(el('h3', { text: '情境分布（PCA 主成分平面）', style: 'margin-top:16px' }));
    pane.appendChild(g);
    pane.appendChild(el('div', { class: 'legend', html: sc.stats.map((s, i) =>
      `<span><i style="background:${PAL[i % PAL.length]}"></i>${s.name}（n=${s.n}）</span>`).join('') }));

    const cols = ['情境', '自动命名', '样本', ...S.res.meta.factors, S.res.meta.target];
    const tb = el('table');
    tb.appendChild(el('thead', { html: '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr>' }));
    const b = el('tbody');
    sc.stats.forEach((s, i) => {
      const nm = (sc.names && sc.names[i]) || { tag: '', perf: '' };
      b.appendChild(el('tr', { html:
        `<td>${s.name}</td>
         <td style="text-align:left"><span class="pill ok">${nm.tag || '-'}</span> <span class="muted">${nm.perf || ''}</span></td>
         <td>${s.n}</td>` +
        S.res.meta.factors.map(f => `<td>${fmt(s.mean[f], 2)}</td>`).join('') +
        `<td><b>${fmt(s.mean[S.res.meta.target], 3)}</b></td>` }));
    });
    tb.appendChild(b);
    pane.appendChild(el('h3', { text: '各情境变量均值', style: 'margin-top:16px' }));
    pane.appendChild(tb);
    pane.appendChild(el('div', { class: 'muted', style: 'margin-top:8px',
      text: '「自动命名」取偏离总体均值最大的两个变量；读法：同一列在不同情境间差异越大，说明该变量越能区分情境。' }));

    // 肘部 / 轮廓曲线（懒算）
    if (!S.extra.elbow) {
      pane.appendChild(el('div', { class: 'muted', style: 'margin-top:18px', html: '正在计算 k=2~6 的肘部与轮廓曲线…' }));
      setTimeout(() => {
        try {
          const idxT = S.columns.indexOf(S.res.meta.target);
          const idxF = S.res.meta.factors.map(f => S.columns.indexOf(f));
          const keep = S.rows.filter(x => C.isNum(x[idxT]) && idxF.every(j => C.isNum(x[j])));
          const X = keep.map(x => idxF.map(j => x[j]));
          S.extra.elbow = C.elbowCurve(X, [2, 3, 4, 5, 6], S.res.meta.params.seed);
        } catch (e) { S.extra.elbow = []; console.error(e); }
        renderScene();
      }, 30);
      return;
    }
    const el2 = S.extra.elbow;
    if (el2 && el2.length) {
      const W = 700, H = 190, pad = 40;
      const g = mkSvg(W, H);
      const maxSil = Math.max(...el2.map(e => e.silhouette || 0));
      const minInertia = Math.min(...el2.map(e => e.inertia));
      const maxInertia = Math.max(...el2.map(e => e.inertia));
      g.appendChild(mkLine(pad, H - pad, W - pad, H - pad, '#22313f'));
      g.appendChild(mkLine(pad, pad, pad, H - pad, '#22313f'));
      const X = i => pad + (i / Math.max(1, el2.length - 1)) * (W - pad * 2);
      const Y = v => H - pad - v * (H - pad * 2);
      let d1 = '', d2 = '';
      el2.forEach((e, i) => {
        const sil = e.silhouette || 0;
        const norm = maxInertia > minInertia ? 1 - (e.inertia - minInertia) / (maxInertia - minInertia) : 0;
        d1 += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(sil).toFixed(1);
        d2 += (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(norm).toFixed(1);
        g.appendChild(mkText(X(i), H - pad + 16, 'k=' + e.k, '#8aa0b4', 11, 'middle'));
        g.appendChild(mkCircle(X(i), Y(sil), 3.2, '#22d3ee'));
        g.appendChild(mkCircle(X(i), Y(norm), 3.2, '#4c9aff'));
      });
      g.appendChild(mkPath(d1, '#22d3ee'));
      g.appendChild(mkPath(d2, '#4c9aff'));
      pane.appendChild(el('h3', { text: '聚类数选择：轮廓系数 vs 惯性（归一化）', style: 'margin-top:20px' }));
      pane.appendChild(g);
      pane.appendChild(el('div', { class: 'legend', html:
        '<span><i style="background:#22d3ee"></i>轮廓系数（越高越好）</span>' +
        '<span><i style="background:#4c9aff"></i>惯性归一化（越低越好，找拐点）</span>' }));
      const bestK = el2.slice().sort((a, b2) => (b2.silhouette || 0) - (a.silhouette || 0))[0];
      if (bestK) {
        pane.appendChild(el('div', { class: 'rule', style: 'margin-top:10px',
          html: `按轮廓系数，<b>k=${bestK.k}</b> 最优（${(bestK.silhouette || 0).toFixed(3)}）。当前用的是 k=${sc.k}，可以在左侧拖到 ${bestK.k} 试试。` }));
      }
    }
  }

  /* ---------------- 渲染：规则 ---------------- */
  function renderRules() {
    const pane = $('#pane'), t = S.res.tree;
    pane.innerHTML = '';
    pane.appendChild(el('div', { class: 'stat' }, [
      el('div', { html: `<span>训练精度</span><b>${pct(t.accuracy)}</b>` }),
      el('div', { html: `<span>规则条数</span><b>${t.rules.length}</b>` }),
      el('div', { html: `<span>叶节点</span><b>${t.leaves}</b>` }),
      el('div', { html: `<span>树深度</span><b>${S.res.meta.params.treeDepth}</b>` })
    ]));
    pane.appendChild(el('div', { class: 'muted',
      text: '精度只说明"规则能复现这份数据"，不说明因果。规矩和变量重要性都来自 CART（书第 5 章）。' }));

    pane.appendChild(el('h3', { text: '变量重要性（Gini 下降）', style: 'margin-top:16px' }));
    t.importances.forEach(im => {
      pane.appendChild(el('div', { class: 'row', html: `<span>${im.name}</span><b>${pct(im.value)}</b>` }));
      pane.appendChild(el('div', { class: 'bar' }, [el('i', { style: `width:${Math.max(2, im.value * 100)}%` })]));
    });

    pane.appendChild(el('h3', { text: '单因素相关（对照）', style: 'margin-top:18px' }));
    const tb = el('table');
    tb.appendChild(el('thead', { html: '<tr><th>变量</th><th>与 y 的 Pearson r</th><th>树中重要性</th></tr>' }));
    const b = el('tbody');
    S.res.meta.factors.forEach(f => {
      const imp = (t.importances.find(i => i.name === f) || { value: 0 }).value;
      b.appendChild(el('tr', { html: `<td>${f}</td><td>${fmt(t.single[f], 3)}</td><td>${pct(imp)}</td>` }));
    });
    tb.appendChild(b); pane.appendChild(tb);
    pane.appendChild(el('div', { class: 'muted', style: 'margin-top:6px',
      text: '若某变量 r 很弱但重要性很高，说明它是"组合条件"起作用的——这正是单因素分析会漏掉的。' }));

    pane.appendChild(el('h3', { text: `条件组合规则（${t.rules.length} 条，按支持度排序）`, style: 'margin-top:18px' }));
    const rules = t.rules.slice().sort((a, b2) => b2.support * b2.confidence - a.support * a.confidence);
    rules.forEach((r, i) => {
      pane.appendChild(el('div', { class: 'rule', html:
        `<b>R${i + 1}</b> IF ${r.conditions.map(c => `<code>${c}</code>`).join(' 且 ') || '（无分裂）'}
         → THEN <code>${S.res.meta.target} = ${r.then}</code>
         <div class="meta">支持度 n=${r.support}（${pct(r.support / S.res.meta.usedRows)}）· 置信度 ${pct(r.confidence)} · 分布 ${r.distribution.join('/')}</div>` }));
    });
  }

  /* ---------------- 渲染：网络 ---------------- */
  function renderNet() {
    const pane = $('#pane'), net = S.res.net;
    pane.innerHTML = '';
    if (!net.nodes.length) { pane.innerHTML = '<div class="muted">没有满足阈值的边，把阈值调低一点。</div>'; return; }
    pane.appendChild(el('div', { class: 'muted', html:
      `|r| ≥ ${net.threshold} 剪枝后保留 <b>${net.edges.length}</b> 条边。<b>点击节点</b>可高亮它的连线。` }));

    const W = 700, H = 420, cx = W / 2, cy = H / 2, R = 145;
    const g = mkSvg(W, H);
    const pos = {};
    net.nodes.forEach((n, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / net.nodes.length;
      pos[n.id] = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
    });
    const edgeEls = [];
    net.edges.forEach(e => {
      const [x1, y1] = pos[e.source], [x2, y2] = pos[e.target];
      const line = mkLine(x1, y1, x2, y2, e.weight > 0 ? '#4c9aff' : '#ef4444');
      line.setAttribute('stroke-width', Math.max(1, Math.abs(e.weight) * 6));
      line.setAttribute('opacity', 0.55);
      line.style.cursor = 'pointer';
      line.addEventListener('mousemove', ev => showTip(`${e.source} — ${e.target}<br><b>r = ${e.weight.toFixed(3)}</b>`, ev.clientX, ev.clientY));
      line.addEventListener('mouseleave', hideTip);
      g.appendChild(line);
      edgeEls.push({ el: line, e });
    });
    net.nodes.forEach(n => {
      const [x, y] = pos[n.id];
      const rr = 9 + Math.min(15, n.strength * 4);
      const c = mkCircle(x, y, rr, '#16222e', '#22d3ee', 1.8);
      c.style.cursor = 'pointer';
      c.addEventListener('click', () => focusNode(n.id));
      c.addEventListener('mousemove', ev => showTip(`${n.id}<br>度 ${n.degree} · 强度 ${n.strength.toFixed(2)}`, ev.clientX, ev.clientY));
      c.addEventListener('mouseleave', hideTip);
      g.appendChild(c);
      g.appendChild(mkText(x, y - rr - 7, n.id, '#dfe9f3', 11.5, 'middle'));
    });
    pane.appendChild(g);
    pane.appendChild(el('div', { class: 'legend', html:
      '<span><i style="background:#4c9aff"></i>正相关</span><span><i style="background:#ef4444"></i>负相关</span><span>节点大小 = 关联强度</span>' }));

    function focusNode(id) {
      edgeEls.forEach(({ el: line, e }) => {
        const on = e.source === id || e.target === id;
        line.setAttribute('opacity', on ? 0.95 : 0.08);
        line.setAttribute('stroke-width', on ? Math.max(2, Math.abs(e.weight) * 8) : 1);
      });
      const n = net.nodes.find(x => x.id === id);
      const rel = net.edges.filter(e => e.source === id || e.target === id)
        .sort((a, b2) => Math.abs(b2.weight) - Math.abs(a.weight));
      let box = document.getElementById('nodeInfo');
      if (!box) { box = el('div', { class: 'node-info', id: 'nodeInfo' }); pane.appendChild(box); }
      box.innerHTML = `<b>${id}</b> · 度 ${n.degree} · 强度 ${n.strength.toFixed(3)}<br>` +
        rel.map(e => {
          const other = e.source === id ? e.target : e.source;
          return `<span class="muted">${other}</span> r = ${e.weight.toFixed(3)}`;
        }).join('<br>');
    }

    const tb = el('table');
    tb.appendChild(el('thead', { html: '<tr><th>节点</th><th>度</th><th>关联强度</th></tr>' }));
    const b = el('tbody');
    net.nodes.forEach(n => b.appendChild(el('tr', { html: `<td>${n.id}</td><td>${n.degree}</td><td>${n.strength.toFixed(3)}</td>` })));
    tb.appendChild(b);
    pane.appendChild(el('h3', { text: '节点中心性', style: 'margin-top:16px' }));
    pane.appendChild(tb);
    pane.appendChild(el('div', { class: 'rule', style: 'margin-top:12px',
      text: '注意：边来自 Pearson 相关，代表"共同变动"。书第 6 章的影响路径用贝叶斯网络 + 灵敏度分析，那才是能推断的；这里只到相关网络。' }));
  }


  /* ---------------- 渲染：贝叶斯网络 ---------------- */
  function renderBN() {
    const pane = $('#pane'), r = S.res;
    if (!r.bn) {
      pane.innerHTML = '<div class="muted">贝叶斯网络未生成（变量或等级过多时会被跳过）。</div>';
      return;
    }
    const bn = r.bn, names = bn.names, levels = bn.levels, L = r.calibration.labels;
    pane.innerHTML = '';
    pane.appendChild(el('div', { class: 'muted', html:
      `结构学习：爬山法 + BIC 评分（父节点上限 2）；参数学习：极大似然 + 拉普拉斯平滑。
       共 <b>${bn.edges.length}</b> 条有向边。` }));

    // 结构图
    const W = 700, H = 430, cx = W / 2, cy = H / 2, R = 150;
    const g = mkSvg(W, H);
    const defs = mk('defs', {});
    const marker = mk('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    marker.appendChild(mk('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#22d3ee' }));
    defs.appendChild(marker); g.appendChild(defs);

    const pos = {};
    names.forEach((n, i) => {
      const a = -Math.PI / 2 + i * 2 * Math.PI / names.length;
      pos[n] = [cx + R * Math.cos(a), cy + R * Math.sin(a)];
    });
    bn.edges.forEach(e => {
      const [x1, y1] = pos[e.from], [x2, y2] = pos[e.to];
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const curve = `M ${x1} ${y1} Q ${mx + (cx - mx) * 0.35} ${my + (cy - my) * 0.35} ${x2} ${y2}`;
      g.appendChild(mk('path', { d: curve, fill: 'none', stroke: '#22d3ee', 'stroke-width': 1.8, 'marker-end': 'url(#arrow)', opacity: 0.75 }));
    });
    names.forEach((n, i) => {
      const [x, y] = pos[n];
      const isTarget = n === r.meta.target;
      g.appendChild(mkCircle(x, y, isTarget ? 26 : 21, isTarget ? '#12283d' : '#16222e', isTarget ? '#f59e0b' : '#22d3ee', 1.8));
      g.appendChild(mkText(x, y + 4, n.slice(0, 2), '#dfe9f3', 12, 'middle'));
      g.appendChild(mkText(x, y - 30, n, '#8aa0b4', 10.5, 'middle'));
    });
    pane.appendChild(g);

    // 目标先验
    const prior = C.bnInfer(bn, {});
    pane.appendChild(el('h3', { text: `${r.meta.target} 的先验分布（无证据）`, style: 'margin-top:14px' }));
    pane.appendChild(barRow(L, prior.posterior));

    // 敏感度：变量 × 等级 → 目标为"最高档"的概率
    pane.appendChild(el('h3', { text: '敏感度分析：单个变量固定在不同等级时，目标最高档的概率', style: 'margin-top:20px' }));
    const tb = el('table');
    tb.appendChild(el('thead', { html:
      '<tr><th>变量</th>' + L.map(l => `<th>固定为「${l}」</th>`).join('') + '<th>变化幅度</th></tr>' }));
    const b = el('tbody');
    (r.sens || []).forEach(({ f, rows }) => {
      const vals = rows.map(x => x.posterior[levels - 1]);
      const spread = Math.max(...vals) - Math.min(...vals);
      const cells = vals.map((v, i) => {
        const isMax = v === Math.max(...vals), isMin = v === Math.min(...vals);
        const color = isMax ? '#34d399' : isMin ? '#ef4444' : '#dfe9f3';
        return `<td style="color:${color};font-weight:${isMax || isMin ? 600 : 400}">${(v * 100).toFixed(1)}%</td>`;
      }).join('');
      b.appendChild(el('tr', { html: `<td>${f}</td>${cells}<td>${(spread * 100).toFixed(1)} pp</td>` }));
    });
    tb.appendChild(b);
    pane.appendChild(tb);
    pane.appendChild(el('div', { class: 'muted', style: 'margin-top:8px', html:
      `读法：把「融资约束」固定在“低”时，${r.meta.target} 为「${L[levels - 1]}」的概率是多少。
       <b>变化幅度（pp）越大，说明这个变量越关键</b>。` }));

    // 逐变量条形对比
    const top = (r.sens || []).slice().sort((a, c) => {
      const sp = x => Math.max(...x.rows.map(v => v.posterior[levels - 1])) - Math.min(...x.rows.map(v => v.posterior[levels - 1]));
      return sp(c) - sp(a);
    })[0];
    if (top) {
      pane.appendChild(el('h3', { text: `影响最大：${top.f}`, style: 'margin-top:20px' }));
      top.rows.forEach((row, i) => {
        pane.appendChild(el('div', { class: 'row', html:
          `<span>${top.f} = ${L[i]}</span><b>${(row.posterior[levels - 1] * 100).toFixed(1)}%</b>` }));
        pane.appendChild(el('div', { class: 'bar' }, [
          el('i', { style: `width:${Math.max(2, row.posterior[levels - 1] * 100)}%;background:${PAL[i]}` })]));
      });
    }

    pane.appendChild(el('div', { class: 'rule', style: 'margin-top:16px', html:
      '<b>注意</b>：结构来自数据的 BIC 评分，边方向代表"条件依赖"的最优解释，<b>不等于因果</b>。' +
      '书第 6 章用 Netica 做同样的事（结构学习 + 参数学习 + 灵敏度分析），这里在浏览器里复现了核心三步。' }));
  }

  function barRow(labels, probs) {
    const wrap = el('div', {});
    labels.forEach((l, i) => {
      wrap.appendChild(el('div', { class: 'row', html: `<span>${l}</span><b>${(probs[i] * 100).toFixed(1)}%</b>` }));
      wrap.appendChild(el('div', { class: 'bar' }, [
        el('i', { style: `width:${Math.max(1, probs[i] * 100)}%;background:${PAL[i]}` })]));
    });
    return wrap;
  }

  /* ---------------- 渲染：稳健性 ---------------- */
  function renderRobust() {
    const pane = $('#pane'), r = S.res;
    pane.innerHTML = '';
    pane.appendChild(el('div', { class: 'stat' }, [
      el('div', { html: `<span>交叉验证</span><b>${r.tree.cv ? pct(r.tree.cv.mean) : '-'}</b>` }),
      el('div', { html: `<span>CV 标准差</span><b>±${r.tree.cv ? pct(r.tree.cv.std) : '-'}</b>` }),
      el('div', { html: `<span>训练精度</span><b>${pct(r.tree.accuracy)}</b>` }),
      el('div', { html: `<span>折数</span><b>${r.tree.cv ? r.tree.cv.folds : '-'}</b>` })
    ]));
    pane.appendChild(el('div', { class: 'muted', html:
      '训练精度只说明“能拟合”，交叉验证才说明“能泛化”。两者差距过大 = 过拟合。' }));

    if (!S.extra.robust) {
      pane.appendChild(el('div', { class: 'muted', style: 'margin-top:16px', html: '正在跑 7 组参数变体…' }));
      setTimeout(() => {
        try {
          const idxT = S.columns.indexOf(r.meta.target);
          const idxF = r.meta.factors.map(f => S.columns.indexOf(f));
          const keep = S.rows.filter(x => C.isNum(x[idxT]) && idxF.every(j => C.isNum(x[j])));
          const X = keep.map(x => idxF.map(j => x[j]));
          const yv = keep.map(x => x[idxT]);
          S.extra.robust = C.robustness(X, yv, r.meta.factors, r.calibration.labels, r.meta.params);
        } catch (e) { S.extra.robust = []; console.error(e); }
        renderRobust();
      }, 30);
      return;
    }

    const runs = S.extra.robust;
    const base = runs[0];
    const tb = el('table');
    tb.appendChild(el('thead', { html:
      '<tr><th>变体</th><th>分位</th><th>等级</th><th>树深</th><th>精度</th><th>规则数</th><th>最强规则</th><th>与基准一致</th></tr>' }));
    const b = el('tbody');
    runs.forEach(x => {
      const same = base && x.top && base.top && x.top.then === base.top.then;
      b.appendChild(el('tr', { html:
        `<td>${x.label}</td>
         <td>${x.params.lowPct}/${x.params.highPct}</td>
         <td>${x.params.levels}</td>
         <td>${x.params.treeDepth}</td>
         <td>${x.error ? '<span class="pill bad">失败</span>' : pct(x.accuracy)}</td>
         <td>${x.rules ?? '-'}</td>
         <td>${x.top ? x.top.then + '（' + pct(x.top.confidence) + '）' : '-'}</td>
         <td>${x === base ? '—' : (same ? '<span class="pill ok">一致</span>' : '<span class="pill warn">改变</span>')}</td>` }));
    });
    tb.appendChild(b);
    pane.appendChild(tb);

    const changed = runs.filter(x => x !== base && x.top && base.top && x.top.then !== base.top.then).length;
    const verdict = changed === 0
      ? ['ok', '全部变体给出同一方向的主规则——结论稳健，可以写进论文。']
      : changed <= 2
        ? ['warn', `${changed} 个变体改变了主规则方向——需要在论文里说明参数敏感性。`]
        : ['bad', `${changed} 个变体改变了主规则——结论不稳，建议重新考虑分位点或变量选择。`];
    pane.appendChild(el('div', { class: 'rule', style: 'margin-top:14px;border-left-color:' +
      (verdict[0] === 'ok' ? '#34d399' : verdict[0] === 'warn' ? '#f59e0b' : '#ef4444'),
      html: `<span class="pill ${verdict[0]}">稳健性判定</span> ${verdict[1]}` }));
    pane.appendChild(el('div', { class: 'muted', style: 'margin-top:8px',
      text: '这就是审稿人最常问的那句“换个参数结论还成立吗”，现在一键就能回答。' }));
  }


  /* ---------------- AI 助手（可选 API 接入） ---------------- */
  const AI_KEY = 'dac-workbench-ai';
  const PROVIDERS = {
    deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    dashscope: { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    custom: { name: '自定义', base: '', model: '' }
  };
  function aiCfg() {
    try { return JSON.parse(localStorage.getItem(AI_KEY) || '{}'); } catch (e) { return {}; }
  }
  function aiSave(c) { localStorage.setItem(AI_KEY, JSON.stringify(c)); }

  async function callLLM(messages) {
    const c = aiCfg();
    if (!c.key) throw new Error('还没填 API Key（在下面「接入设置」里填）');
    const base = (c.baseURL || PROVIDERS[c.provider || 'deepseek'].base).replace(/\/+$/, '');
    const model = c.model || PROVIDERS[c.provider || 'deepseek'].model;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key },
        body: JSON.stringify({ model, messages, temperature: 0.25, max_tokens: 1400 }),
        signal: ctrl.signal
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error('HTTP ' + res.status + '：' + t.slice(0, 220));
      }
      const j = await res.json();
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    } finally { clearTimeout(timer); }
  }

  /* 从结果里收集所有出现过的数字，用于校验模型有没有编数 */
  function collectNumbers(obj, set) {
    set = set || new Set();
    if (typeof obj === 'number' && isFinite(obj)) set.add(Math.abs(obj));
    else if (Array.isArray(obj)) obj.forEach(o => collectNumbers(o, set));
    else if (obj && typeof obj === 'object') Object.values(obj).forEach(o => collectNumbers(o, set));
    return set;
  }
  function auditNumbers(text, res) {
    const allow = [...collectNumbers(res)];
    const nums = (text.match(/\d+(?:\.\d+)?/g) || []).map(Number);
    const bad = [];
    nums.forEach(n => {
      if (n <= 4) return;                       // 等级/小整数放过
      const cands = [n, n / 100, n * 100];
      const hit = cands.some(x => allow.some(y => Math.abs(y - x) <= Math.max(0.02, Math.abs(y) * 0.02)));
      if (!hit) bad.push(n);
    });
    return [...new Set(bad)].slice(0, 6);
  }

  function renderAI() {
    const pane = $('#pane'), r = S.res, cfg = aiCfg();
    pane.innerHTML = '';
    if (!r) {
      pane.innerHTML = '<div class="muted">先跑一次分析，AI 才能基于真实结果给建议。</div>';
      return;
    }
    pane.appendChild(el('div', { class: 'muted', html:
      'AI 只做两件事：<b>推荐参数</b> 和 <b>写文字</b>。所有数字必须来自本地计算，模型编造的数字会被标红。' }));

    // 接入设置
    const box = el('div', { class: 'card', style: 'margin-top:12px;background:#0f1a24' });
    box.appendChild(el('h3', { text: '接入设置（存在浏览器本地，不上传）', style: 'margin-bottom:10px;font-size:12px' }));
    const grid = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:8px' });
    const selP = el('select', {});
    Object.entries(PROVIDERS).forEach(([k, v]) => {
      const o = el('option', { value: k, text: v.name });
      if ((cfg.provider || 'deepseek') === k) o.selected = true;
      selP.appendChild(o);
    });
    const inBase = el('input', { type: 'text', placeholder: 'Base URL', value: cfg.baseURL || PROVIDERS[cfg.provider || 'deepseek'].base });
    const inModel = el('input', { type: 'text', placeholder: 'model', value: cfg.model || PROVIDERS[cfg.provider || 'deepseek'].model });
    const inKey = el('input', { type: 'password', placeholder: 'sk-...', value: cfg.key || '' });
    selP.onchange = () => {
      const v = PROVIDERS[selP.value];
      inBase.value = v.base; inModel.value = v.model;
    };
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: '服务商' }), selP]));
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: '模型' }), inModel]));
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: 'Base URL' }), inBase]));
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: 'API Key' }), inKey]));
    box.appendChild(grid);
    const saveRow = el('div', { style: 'display:flex;gap:8px;margin-top:9px' });
    const bSave = el('button', { class: 'mini', text: '保存设置' });
    bSave.onclick = () => {
      aiSave({ provider: selP.value, baseURL: inBase.value.trim(), model: inModel.value.trim(), key: inKey.value.trim() });
      toast('已保存到本地浏览器');
    };
    const bClear = el('button', { class: 'ghost mini', text: '清除 Key' });
    bClear.onclick = () => { aiSave({}); toast('已清除'); renderAI(); };
    saveRow.appendChild(bSave); saveRow.appendChild(bClear);
    if (cfg.key) saveRow.appendChild(el('span', { class: 'chip', text: '已配置 · ' + (cfg.model || '') }));
    box.appendChild(saveRow);
    pane.appendChild(box);

    // 操作
    const acts = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:14px 0' });
    const out = el('div', { class: 'ai-msg', text: '点上面的按钮试试。没有 Key 也能用「本地模板」。' });
    const mk = (label, fn) => { const b = el('button', { class: 'mini', text: label }); b.onclick = () => fn(b, out); return b; };

    const brief = () => {
      const p2 = r.meta.params;
      return {
        target: r.meta.target, factors: r.meta.factors,
        rows: r.meta.rows, used: r.meta.usedRows,
        columns: r.profile.columns.map(c => ({ name: c.name, missing: c.missing, outliers: c.outliers || 0 })),
        params: p2,
        silhouette: r.scenarios.silhouette,
        cv: r.tree.cv ? { mean: r.tree.cv.mean, std: r.tree.cv.std } : null,
        accuracy: r.tree.accuracy,
        importances: r.tree.importances.slice(0, 5),
        rules: r.tree.rules.slice(0, 5).map(x => ({ if: x.conditions, then: x.then, n: x.support, conf: x.confidence })),
        sens: (r.sens || []).map(({ f, rows }) => ({ var: f, probs: rows.map(x => +(x.posterior[x.posterior.length - 1] * 100).toFixed(1)) }))
      };
    };

    // 1) 生成分析方案
    acts.appendChild(mk('🤖 让 AI 给参数建议', async (btn, out) => {
      btn.disabled = true; out.className = 'ai-msg'; out.textContent = '思考中…';
      try {
        const b = brief();
        const prompt = `你是一位管理学研究方法顾问。以下是用户数据的体检结果与当前分析参数：
${JSON.stringify(b, null, 1)}

请只输出 JSON，不要解释，格式：
{"target":"","factors":[""],"lowPct":25,"highPct":75,"levels":3,"k":3,"treeDepth":3,"netThreshold":0.2,"reason":"一句话说明为什么这样选"}
要求：factors 必须来自 columns；k 在 2-6；treeDepth 1-4；levels 2-4；netThreshold 0.1-0.5。`;
        const txt = await callLLM([{ role: 'user', content: prompt }]);
        const m = /\{[\s\S]*\}/.exec(txt);
        if (!m) throw new Error('模型没有返回 JSON：' + txt.slice(0, 200));
        const plan = JSON.parse(m[0]);
        out.className = 'ai-msg';
        out.textContent = '建议：' + JSON.stringify(plan, null, 2);
        const applyBtn = el('button', { class: 'mini', text: '应用这组参数并重跑' });
        applyBtn.style.marginTop = '10px';
        applyBtn.onclick = () => {
          if (plan.factors) {
            document.querySelectorAll('#factors input').forEach(i => { i.checked = plan.factors.includes(i.value); });
          }
          if (plan.target) $('#target').value = plan.target;
          if (plan.lowPct) { $('#low').value = plan.lowPct; $('#vLow').textContent = plan.lowPct + '%'; }
          if (plan.highPct) { $('#high').value = plan.highPct; $('#vHigh').textContent = plan.highPct + '%'; }
          if (plan.levels) { $('#levels').value = plan.levels; $('#vLevels').textContent = plan.levels; }
          if (plan.k) { $('#k').value = plan.k; $('#vK').textContent = plan.k; }
          if (plan.treeDepth) { $('#depth').value = plan.treeDepth; $('#vDepth').textContent = plan.treeDepth; }
          if (plan.netThreshold) { $('#net').value = Math.round(plan.netThreshold * 100); $('#vNet').textContent = plan.netThreshold.toFixed(2); }
          run();
          toast('已应用 AI 建议的参数');
        };
        out.appendChild(applyBtn);
      } catch (e) {
        out.className = 'ai-msg err';
        out.textContent = '调用失败：' + e.message + '\n\n（没有 Key 也可以点「本地模板」离线生成）';
      }
      btn.disabled = false;
    }));

    // 2) 解读结果
    acts.appendChild(mk('📝 让 AI 解读结果', async (btn, out) => {
      btn.disabled = true; out.className = 'ai-msg'; out.textContent = '写作中…';
      try {
        const b = brief();
        const prompt = `你是论文写作助手。下面是一次数据分析的真实结果（JSON）：
${JSON.stringify(b, null, 1)}

请用中文写 3 段：
1) 数据与分型：样本、情境划分、各情境特征；
2) 条件组合规则：挑 2 条最重要的规则，说明业务含义；
3) 机制与边界：哪个变量最关键（给出概率变化），并声明"相关不等于因果"。
要求：只能使用 JSON 里出现过的数字；不要编造变量名；语气客观。`;
        const txt = await callLLM([{ role: 'user', content: prompt }]);
        out.className = 'ai-msg';
        out.textContent = txt;
        const bad = auditNumbers(txt, r);
        const note = el('div', { class: 'hint', style: 'margin-top:8px' });
        note.innerHTML = bad.length
          ? `<b style="color:#f59e0b">数字校验未通过</b>：以下数字在计算结果里找不到对应值，请人工核对 → ${bad.join(', ')}`
          : '<b style="color:#34d399">数字校验通过</b>：文中所有数字都能在计算结果里找到来源。';
        out.appendChild(note);
      } catch (e) {
        out.className = 'ai-msg err';
        out.textContent = '调用失败：' + e.message;
      }
      btn.disabled = false;
    }));

    // 3) 本地模板（离线可用）
    acts.appendChild(mk('⚡ 本地模板（不联网）', (btn, out) => {
      const L = r.calibration.labels;
      const lv = r.calibration.target.levels - 1;
      const sc = r.scenarios;
      const top = sc.stats.filter(x => x.n > 0).slice().sort((a, b) => b.mean[r.meta.target] - a.mean[r.meta.target])[0];
      const rules = r.tree.rules.slice().sort((a, b) => b.support * b.confidence - a.support * a.confidence).slice(0, 2);
      const sens = (r.sens || []).map(({ f, rows }) => ({
        f, spread: Math.max(...rows.map(x => x.posterior[lv])) - Math.min(...rows.map(x => x.posterior[lv])),
        hi: rows[0].posterior[lv], lo: rows[rows.length - 1].posterior[lv]
      })).sort((a, b) => b.spread - a.spread)[0];
      const txt =
`【1. 数据与分型】
本次分析使用 ${r.meta.usedRows} 条有效样本，${r.meta.factors.length} 个条件变量，因变量为「${r.meta.target}」。
按 ${r.meta.params.lowPct}/${r.meta.params.highPct} 分位做云模型校准（${r.meta.params.levels} 级）后，KMeans 将其划分为 ${sc.k} 类情境，轮廓系数 ${(sc.silhouette || 0).toFixed(3)}。
其中「${top.name}」的 ${r.meta.target} 均值最高，为 ${top.mean[r.meta.target].toFixed(3)}。

【2. 条件组合规则】
决策树（深度 ${r.meta.params.treeDepth}，5 折交叉验证 ${r.tree.cv ? (r.tree.cv.mean * 100).toFixed(1) : '-'}%）给出 ${r.tree.rules.length} 条规则，其中支持度最高的是：
${rules.map(x => `IF ${x.conditions.join(' 且 ')} → ${r.meta.target} = ${x.then}（n=${x.support}，置信度 ${(x.confidence * 100).toFixed(1)}%）`).join('\n')}

【3. 机制与边界】
敏感度分析显示，${sens ? `「${sens.f}」对结果影响最大：固定为「${L[0]}」时 ${r.meta.target} 处于「${L[lv]}」的概率为 ${(sens.hi * 100).toFixed(1)}%，固定为「${L[L.length - 1]}」时降为 ${(sens.lo * 100).toFixed(1)}%，相差 ${(sens.spread * 100).toFixed(1)} 个百分点。` : '各变量影响差异不明显。'}
需要说明：上述结论基于观察数据的条件依赖，相关不等于因果；若要论证因果，需借助工具变量、双重差分或断点回归等识别策略。`;
      out.className = 'ai-msg';
      out.textContent = txt;
    }));

    pane.appendChild(acts);
    pane.appendChild(out);
    pane.appendChild(el('div', { class: 'hint', style: 'margin-top:12px', html:
      '<b>为什么不让 AI 直接算？</b>大模型会编数。这里的做法是：<b>计算交给确定性代码，文字交给模型</b>，' +
      '并对模型输出做<b>数字溯源校验</b>——每个数字必须能在结果里找到出处。' }));
  }

  /* ---------------- 渲染：报告 ---------------- */
  function renderReport() {
    const pane = $('#pane'), r = S.res;
    pane.innerHTML = '';
    const bar = el('div', { style: 'display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap' });
    const b1 = el('button', { class: 'ghost mini', text: '下载 Markdown' });
    b1.onclick = () => download(`DAC报告_${stamp()}.md`, r.report, 'text/markdown');
    const b2 = el('button', { class: 'ghost mini', text: '下载 JSON' });
    b2.onclick = () => download(`DAC结果_${stamp()}.json`, JSON.stringify(r, null, 2), 'application/json');
    const b3 = el('button', { class: 'ghost mini', text: '打印 / 存 PDF' });
    b3.onclick = () => window.print();
    const b4 = el('button', { class: 'ghost mini', text: '导出校准后数据 CSV' });
    b4.onclick = () => {
      const r2 = S.res;
      const head = ['样本', ...r2.meta.factors.map(f => f + '_等级'), r2.meta.target + '_等级'];
      const idxT = S.columns.indexOf(r2.meta.target);
      const idxF = r2.meta.factors.map(f => S.columns.indexOf(f));
      const keep = S.rows.filter(x => C.isNum(x[idxT]) && idxF.every(j => C.isNum(x[j])));
      const L = r2.calibration.labels;
      const rows = keep.map((x, i) => {
        const codes = r2.meta.factors.map(f => r2.calibration.factors[f].codes[i]).concat([r2.calibration.target.codes[i]]);
        return [i + 1, ...codes.map(c => L[c] ?? c)];
      });
      download(`DAC校准数据_${stamp()}.csv`, '\ufeff' + C.toCSV(head, rows), 'text/csv');
    };
    const b5 = el('button', { class: 'ghost mini', text: '复制参数快照' });
    b5.onclick = () => {
      const p2 = S.res.meta.params;
      const txt = JSON.stringify({ target: S.res.meta.target, factors: S.res.meta.factors, params: p2 }, null, 2);
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('参数已复制，可直接粘进论文方法部分'));
      else { download('params.json', txt, 'application/json'); }
    };
    bar.appendChild(b1); bar.appendChild(b2); bar.appendChild(b3); bar.appendChild(b4); bar.appendChild(b5);
    pane.appendChild(bar);
    pane.appendChild(el('div', { class: 'muted', html:
      `参数快照：分位 ${r.meta.params.lowPct}/${r.meta.params.highPct} · 云滴 ${r.meta.params.drops} · 等级 ${r.meta.params.levels} · k=${r.meta.params.k} · 深度 ${r.meta.params.treeDepth} · 阈值 ${r.meta.params.netThreshold} · 种子 ${r.meta.params.seed}` }));
    pane.appendChild(el('pre', { text: r.report }));
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type: type + ';charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

  /* ---------------- SVG 小工具 ---------------- */
  function mkSvg(w, h) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', `0 0 ${w} ${h}`);
    s.setAttribute('width', '100%');
    s.style.maxWidth = w + 'px';
    return s;
  }
  function mk(tag, attrs) {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  const mkRect = (x, y, w, h, fill, stroke) => mk('rect', { x, y, width: w, height: h, fill: fill || 'none', stroke: stroke || 'none' });
  const mkLine = (x1, y1, x2, y2, stroke) => mk('line', { x1, y1, x2, y2, stroke: stroke || '#22313f', 'stroke-width': 1 });
  const mkCircle = (cx, cy, r, fill, stroke, sw) => mk('circle', { cx, cy, r, fill: fill || 'none', stroke: stroke || 'none', 'stroke-width': sw || 0 });
  const mkPath = (d, stroke) => mk('path', { d, fill: 'none', stroke, 'stroke-width': 2 });
  function mkText(x, y, text, fill, size, anchor) {
    const t = mk('text', { x, y, fill: fill || '#dfe9f3', 'font-size': size || 12, 'text-anchor': anchor || 'start' });
    t.textContent = text;
    return t;
  }

  /* ---------------- 启动 ---------------- */
  renderGuide();
  const Q = new URLSearchParams(location.search);
  if (Q.has('demo') || location.hash === '#demo' || Q.has('auto')) {
    setTimeout(() => loadSample(), 150);
  }
  if (Q.has('auto')) {
    setTimeout(() => $('#next2').click(), 900);
    setTimeout(() => $('#next3').click(), 1700);
    setTimeout(() => $('#btnRun').click(), 2600);
    setTimeout(() => { const t = Q.get('tab'); if (t && S.res) setTab(t); }, 4200);
  }
})();
