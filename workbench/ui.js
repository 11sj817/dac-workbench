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

  /* ---------------- XSS 防护：所有动态文本必须过这里 ---------------- */
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"'`]/g, c => ESC_MAP[c]);
  }
  /* 安全文本节点：任何"可能是用户数据"的地方优先用它 */
  function txt(tag, value, attrs) {
    const n = el(tag, attrs || {});
    n.textContent = value === null || value === undefined ? '' : String(value);
    return n;
  }

  /* ---------------- Web Worker 调度器 ---------------- */
  /* 调试钩子：便于在控制台查看 Worker 状态（不暴露任何密钥） */
  const WK = {
    worker: null,
    url: null,
    seq: 0,
    pending: new Map(),
    supported: typeof Worker !== 'undefined' && !!window.__WORKER_SRC__,
    fallbackNotified: false,

    ensure() {
      if (this.worker) return this.worker;
      if (!this.supported) return null;
      try {
        const blob = new Blob([window.__WORKER_SRC__], { type: 'application/javascript' });
        this.url = URL.createObjectURL(blob);
        this.worker = new Worker(this.url);
        this.worker.onmessage = ev => this._onMsg(ev.data);
        this.worker.onerror = e => {
          this.pending.forEach(t => { clearTimeout(t.timer); t.reject(new Error('Worker 崩溃: ' + (e.message || 'unknown'))); });
          this.pending.clear();
          this.worker = null;
        };
        return this.worker;
      } catch (e) {
        this.supported = false;
        return null;
      }
    },

    _onMsg(m) {
      const t = this.pending.get(m.id);
      if (!t) return;
      // 非终态消息（start / progress / pong）只做进度通知，不能清 pending
      if (m.status === 'start' || m.status === 'pong') return;
      if (m.status === 'progress') { if (t.onProgress) t.onProgress(m.progress); return; }
      clearTimeout(t.timer);
      this.pending.delete(m.id);
      if (m.status === 'done') t.resolve(m.result);
      else if (m.status === 'error') t.reject(new Error(m.error || '计算失败'));
    },

    run(task, payload, opts) {
      const o = opts || {};
      return new Promise((resolve, reject) => {
        const w = this.ensure();
        if (!w) {
          if (!this.fallbackNotified) {
            this.fallbackNotified = true;
            toast('当前环境不支持 Web Worker，已降级为主线程计算（大样本可能卡顿）', 5000);
          }
          return reject(new Error('NO_WORKER'));
        }
        // 防重复：同一任务已有在跑就拒绝（避免双触发吃内存）
        if (this.pending.size > 0 && o.exclusive !== false) {
          for (const [, t] of this.pending) {
            if (t.task === task) return reject(new Error('已有同类任务在运行，请等待或取消'));
          }
        }
        const id = ++this.seq;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error('计算超时（' + ((o.timeoutMs || 120000) / 1000) + 's），已中断'));
        }, o.timeoutMs || 120000);
        this.pending.set(id, { resolve, reject, timer, onProgress: o.onProgress, task });
        w.postMessage({ id, task, payload });
      });
    },

    cancelAll() {
      this.pending.forEach(t => { clearTimeout(t.timer); t.reject(new Error('已取消')); });
      this.pending.clear();
      if (this.worker) { this.worker.terminate(); this.worker = null; }
      if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    }
  };
  window.__WK = WK;   // 调试用

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
    res: null, extra: {}, tab: 'guide', step: 1, busy: false,
    rowsWork: null, rowsRaw: null,
    roles: {}, sheets: null, sheetIdx: 0
  };

  /* 底部状态栏 */
  function setBusy(on, text) {
    let bar = document.getElementById('statusbar');
    if (!bar) return;
    bar.classList.toggle('on', !!on);
    const label = bar.querySelector('.sb-text');
    if (label) label.textContent = text || (on ? '计算中…' : '就绪');
  }

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
  function gotoStep(v) {
    if (v >= 2 && !S.columns.length) { toast('请先导入数据'); scrollTop(); return; }
    if (v >= 4 && !S.res) {
      // 不给结果就跳第 4/5 步 → 停在参数页，明确告诉用户
      setStep(3); setTab('guide');
      toast('还没有分析结果：先在第 4 步点「运行完整分析」');
      scrollTop(); return;
    }
    setStep(v);
    setTab(v === 5 ? 'profile' : 'guide');
    scrollTop();
  }
  function scrollTop() {
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
  }
  document.querySelectorAll('#steps li').forEach(li => {
    li.onclick = () => gotoStep(+li.dataset.step);
    li.style.cursor = 'pointer';
  });
  // 键盘快捷键：1~5 切换步骤，Esc 回第 1 步
  document.addEventListener('keydown', e => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key >= '1' && e.key <= '5') gotoStep(+e.key);
    else if (e.key === 'Escape') gotoStep(1);
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
        const sheets = await C.parseXLSXAll(buf);
        const usable = sheets.filter(sh => !sh.empty);
        if (!usable.length) throw new Error('这个工作簿里没有可读的数据表');
        S.sheets = usable;
        S.sheetIdx = 0;
        parsed = { columns: usable[0].columns, rows: usable[0].rows };
        if (usable.length > 1) {
          toast(`检测到 ${usable.length} 个工作表，可在下方切换`);
        }
      } else throw new Error('只支持 .xlsx / .csv');
      S.fileName = file.name;
      applyData(parsed, file.name);
    } catch (e) {
      $('#dsInfo').textContent = '解析失败';
      toast('解析失败：' + e.message, 5000);
    }
  }

  const DS = window.__DATASETS__ || {};
  (function bindDsBadge() {
    const tag = document.getElementById('dsTag');
    if (!tag) return;
    tag.style.cursor = 'pointer';
    tag.title = '点击重新选择数据';
    tag.onclick = () => { gotoStep(1); toast('在第 1 步可以换一份数据或拖入文件'); };
  })();
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

  /** 清空所有分析产物（换数据时必须调用，否则旧结果会残留） */
  function resetAnalysis(keepTab) {
    S.res = null;
    S.extra = {};
    S.target = null;
    S.factors = [];
    S.rowsWork = null;
    if (!keepTab) S.tab = 'guide';
    const st = $('#status');
    if (st) st.textContent = '等待运行';
  }

  function applyData(parsed, name, desc) {
    if (!parsed.columns.length) return toast('文件里没有读到表格');
    resetAnalysis();
    S.columns = parsed.columns;
    S.rows = parsed.rows;
    S.rowsRaw = parsed.rows.map(r => r.slice());
    S.rowsWork = null;
    S.numeric = C.numericCols(S.columns, S.rows);
    if (S.numeric.length < 2) return toast('至少需要 2 个数值列', 5000);

    // 初始化变量角色：最后一列 target，其余按类型自动判定
    S.roles = {};
    const lastIdx = S.columns.length - 1;
    S.columns.forEach((c2, j) => {
      const col = parsed.rows.map(r => r[j]);
      const t = (window.DACPre ? window.DACPre.inferType(col, { name: c2 }) : 'num');
      S.roles[c2] = (j === lastIdx) ? 'target'
        : t === 'id' ? 'id'
        : t === 'empty' ? 'exclude'
        : (t === 'cat' || t === 'binary') ? 'cat' : 'num';
    });
    const prof = C.profile(S.columns, S.rows);
    $('#dsInfo').innerHTML = `<b>${esc(name)}</b><br>${parsed.rows.length} 行 · ${parsed.columns.length} 列 · 数值列 ${S.numeric.length} 个`
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
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
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


  /* ---------------- 变量角色 / 工作表 ---------------- */
  const ROLE_OPTS = [
    ['target', '目标变量 y'], ['num', '数值型 x'], ['cat', '分类型 x'],
    ['id', 'ID（不参与计算）'], ['weight', '权重'], ['group', '分组'],
    ['time', '时间'], ['exclude', '排除']
  ];

  function openRolePanel() {
    const back = el('div', {
      style: 'position:fixed;inset:0;background:#000a;z-index:60;display:flex;align-items:center;justify-content:center;padding:20px'
    });
    const box = el('div', {
      style: 'background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;max-width:720px;width:100%;max-height:86vh;overflow:auto'
    });
    box.appendChild(el('h3', { text: '变量角色', style: 'margin:0 0 4px;color:var(--acc)' }));
    box.appendChild(el('div', { class: 'muted', style: 'margin-bottom:10px',
      text: 'ID / 权重 / 分组 / 时间 / 排除 的列不参与建模。目标变量必须唯一。' }));

    // 工作表切换
    if (S.sheets && S.sheets.length > 1) {
      const sel = el('select', {});
      S.sheets.forEach((sh, i) => {
        const o = el('option', { value: String(i), text: `${sh.name}（${sh.rows.length} 行）` });
        if (i === S.sheetIdx) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => {
        const i = +sel.value;
        S.sheetIdx = i;
        const sh = S.sheets[i];
        back.remove();
        applyData({ columns: sh.columns, rows: sh.rows }, `${S.fileName || '上传文件'} · ${sh.name}`);
        toast('已切换到工作表：' + sh.name);
      };
      box.appendChild(el('div', { style: 'margin-bottom:12px' }, [
        el('div', { class: 'muted', text: '工作表' }), sel
      ]));
    }

    const tb = el('table');
    tb.appendChild(el('thead', { html: '<tr><th>变量</th><th>角色</th><th>类型</th><th>缺失</th></tr>' }));
    const body = el('tbody');
    const prof = C.profile(S.columns, S.rows);
    S.columns.forEach((c2, j) => {
      const sel = el('select', { style: 'padding:4px 6px;font-size:12px' });
      ROLE_OPTS.forEach(([v, label]) => {
        const o = el('option', { value: v, text: label });
        if (S.roles[c2] === v) o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = () => {
        if (sel.value === 'target') {
          // 目标唯一
          Object.keys(S.roles).forEach(k => { if (S.roles[k] === 'target') S.roles[k] = 'num'; });
        }
        S.roles[c2] = sel.value;
        renderRoleTable();
      };
      const pc = prof.columns[j] || {};
      body.appendChild(el('tr', { html:
        `<td>${esc(c2)}</td><td></td>
         <td><span class="pill ${pc.numeric ? 'ok' : 'warn'}">${pc.numeric ? '数值' : '文本'}</span></td>
         <td>${pc.missing ?? 0}</td>` }));
      body.lastChild.children[1].appendChild(sel);
    });
    tb.appendChild(body);
    box.appendChild(tb);

    const applyRoleTable = () => {
      // 同步到分析用的 target / factors
      const tgt = S.columns.find(c2 => S.roles[c2] === 'target');
      if (tgt) $('#target').value = tgt;
      renderFactors();
      const usable = new Set(['num', 'cat']);
      document.querySelectorAll('#factors input').forEach(inp => {
        inp.checked = usable.has(S.roles[inp.value]);
      });
    };
    function renderRoleTable() { /* 简化：不做整表重绘，直接同步 */ applyRoleTable(); }

    const row = el('div', { style: 'display:flex;gap:8px;margin-top:14px;justify-content:flex-end' });
    const bReset = el('button', { class: 'ghost', text: '按类型重新识别' });
    bReset.onclick = () => {
      const lastIdx = S.columns.length - 1;
      S.columns.forEach((c2, j) => {
        const col = S.rows.map(r => r[j]);
        const t = (window.DACPre ? window.DACPre.inferType(col, { name: c2 }) : 'num');
        S.roles[c2] = (j === lastIdx) ? 'target' : t === 'id' ? 'id' : t === 'empty' ? 'exclude'
          : (t === 'cat' || t === 'binary') ? 'cat' : 'num';
      });
      back.remove();
      openRolePanel();
    };
    const bOk = el('button', { text: '应用并关闭' });
    bOk.onclick = () => { applyRoleTable(); back.remove(); toast('变量角色已应用'); };
    row.appendChild(bReset); row.appendChild(bOk);
    box.appendChild(row);

    back.appendChild(box);
    back.onclick = e => { if (e.target === back) back.remove(); };
    document.body.appendChild(back);
  }

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
  document.addEventListener('click', e => {
    if (e.target && e.target.id === 'btnRoles') openRolePanel();
  });

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
        try {
          const rr = S.res;
          histPush({
            at: new Date().toISOString(),
            dataset: S.fileName || (S.sheets ? S.sheets[S.sheetIdx].name : '内置示例'),
            target: rr.meta.target, k: rr.meta.params.k,
            cv: rr.tree.cv ? rr.tree.cv.mean : null,
            sil: rr.scenarios.silhouette,
            rules: rr.tree.rules.length,
            params: rr.meta.params
          });
        } catch (e) { /* 历史记录失败不影响分析 */ }
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

    // 特征泄漏检测：某条件变量与目标几乎线性相关时，模型会"抄答案"
    const leakFeatures = [];
    factors.forEach((f, i) => {
      const rr = C.pearson(X.map(r => r[i]), yv);
      if (Number.isFinite(rr) && Math.abs(rr) > 0.95) leakFeatures.push({ name: f, r: rr });
    });

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
      bn, sens,
      leakFeatures
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
    if (r.leakFeatures && r.leakFeatures.length) {
      L.push('<span class="warnline"><b>⚠ 疑似特征泄漏</b>：' +
        r.leakFeatures.map(x => `${esc(x.name)} 与目标 r=${x.r.toFixed(3)}`).join('、') +
        ' —— 这些变量几乎等同于目标本身，模型的高准确率是「抄答案」而非真实预测力。' +
        '请确认它们是否在因果上先于目标发生。</span>');
    }
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
    // 结果区顶部固定工具条：随时能重跑或换数据
    const oldBar = document.getElementById('resultBar');
    if (oldBar) oldBar.remove();
    if (S.res) {
      const bar = el('div', { id: 'resultBar', class: 'resultbar' });
      const b1 = el('button', { class: 'ghost mini', text: '↻ 重跑分析' });
      b1.onclick = () => { setStep(4); scrollTop(); toast('参数页已打开，可调整后重跑'); };
      const b2 = el('button', { class: 'ghost mini', text: '⇄ 换一份数据' });
      b2.onclick = () => gotoStep(1);
      const b3 = el('button', { class: 'ghost mini', text: '⎘ 导出报告' });
      b3.onclick = () => { setTab('report'); scrollTop(); };
      bar.appendChild(el('span', { class: 'muted', style: 'font-size:12px',
        text: `当前结果：${S.meta ? '' : ''}${S.columns.length} 列 · ${S.rows.length} 行` }));
      bar.appendChild(el('div', { class: 'grow' }));
      bar.appendChild(b1); bar.appendChild(b2); bar.appendChild(b3);
      pane.parentNode.insertBefore(bar, pane);
    }
    if (!S.res && S.tab !== 'guide') {
      pane.innerHTML = '<div class="muted">先导入数据并运行分析。</div>';
      return;
    }
    switch (S.tab) {
      case 'guide': return renderGuide();
      case 'profile': return renderProfileDirect(S.res ? S.res.profile : C.profile(S.columns, S.rows));
      case 'quality': return renderQuality();
      case 'corr': return renderCorr();
      case 'calib': return renderCalib();
      case 'scene': return renderScene();
      case 'rules': return renderRules();
      case 'net': return renderNet();
      case 'bn': return renderBN();
      case 'robust': return renderRobust();
      case 'boot': return renderBootstrap();
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
         `<td>${esc(c.name)}</td>
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

    // 若指定了权重列，补一张加权均值对照
    const wCol = S.columns.find(c => S.roles[c] === 'weight');
    if (wCol) {
      const wi = S.columns.indexOf(wCol);
      const wv = S.rows.map(r => r[wi]);
      const rowsW = prof.columns.map((c, j) => {
        const vals = S.rows.map(r => r[j]);
        const wm = C.weightedMean(vals, wv);
        const raw = c.mean;
        return { name: c.name, raw, wm, diff: (wm !== null && Number.isFinite(wm) && raw !== undefined)
          ? (wm - raw) / (Math.abs(raw) > 1e-9 ? Math.abs(raw) : 1) : null };
      }).filter(x => Number.isFinite(x.wm));
      if (rowsW.length) {
        const tw = el('table');
        tw.appendChild(el('thead', { html: '<tr><th>变量</th><th>普通均值</th><th>加权均值</th><th>相对差异</th></tr>' }));
        const bw = el('tbody');
        rowsW.forEach(x => bw.appendChild(el('tr', { html:
          `<td>${esc(x.name)}</td><td>${fmt(x.raw, 3)}</td><td><b>${fmt(x.wm, 3)}</b></td>
           <td>${x.diff === null ? '-' : (x.diff * 100).toFixed(1) + '%'}</td>` })));
        tw.appendChild(bw);
        pane.appendChild(el('h3', { text: `加权均值对照（权重列：${esc(wCol)}）`, style: 'margin-top:16px' }));
        pane.appendChild(tw);
        pane.appendChild(el('div', { class: 'muted', style: 'margin-top:6px',
          text: '差异越大，说明样本代表性偏倚越明显；加权均值更接近总体真值。' }));
      }
    }

    if (S.res && S.res.leakFeatures && S.res.leakFeatures.length) {
      pane.appendChild(el('div', { class: 'hint', style: 'border-color:#5a2020;color:#fca5a5;margin-top:12px',
        html: '<b>疑似特征泄漏</b>：' + S.res.leakFeatures.map(x => `<code>${esc(x.name)}</code>（r=${x.r.toFixed(3)}）`).join('、') +
          '<br>这些变量与目标几乎线性相关，可能是目标的另一种度量（如「第一次成绩」预测「最终成绩」）。' +
          '若它们不是真正的先决因素，应从模型中剔除。' }));
    }
    if (prof.warnings.length) {
      pane.appendChild(el('h3', { text: '体检提示', style: 'margin-top:16px;color:#f59e0b' }));
      prof.warnings.forEach(w => pane.appendChild(el('div', { class: 'rule', text: w })));
    }
  }


  /* ---------------- 渲染：数据质量与预处理 ---------------- */
  const workingRows = () => (S.rowsWork && S.rowsWork.length ? S.rowsWork : S.rows);

  function renderQuality() {
    const pane = $('#pane');
    const P = window.DACPre;
    pane.innerHTML = '';
    if (!P) { pane.innerHTML = '<div class="muted">预处理模块未加载。</div>'; return; }
    const WR = workingRows();
    if (!WR.length) { pane.innerHTML = '<div class="muted">先导入数据。</div>'; return; }

    const names = S.columns;
    /* WR 已在上方定义 */
    const diag = P.diagnoseMissing(WR, names);
    const q = S.extra.quality || (S.extra.quality = {
      strategy: 'median', knnK: 5, weighted: true, fallback: 'median',
      k: 5, seed: 42, strict: null, audit: null, preview: null
    });

    /* --- 顶部指标 --- */
    pane.appendChild(el('div', { class: 'stat' }, [
      el('div', { html: `<span>样本 × 变量</span><b>${diag.n} × ${diag.p}</b>` }),
      el('div', { html: `<span>总缺失率</span><b>${pct(diag.overallRate)}</b>` }),
      el('div', { html: `<span>完整样本</span><b>${diag.completeRows}</b>` }),
      el('div', { html: `<span>完全缺失列</span><b>${diag.allMissingCols.length}</b>` })
    ]));

    const ctrl = el('div', { style: 'display:flex;gap:8px;margin:10px 0;flex-wrap:wrap;align-items:center' });
    const btnInject = el('button', { class: 'ghost mini', text: '注入 10% 模拟缺失' });
    btnInject.onclick = () => {
      let a = (q.seed || 42) >>> 0;
      const rnd = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const base = S.rowsRaw || S.rows;
      const rows = base.map(r => r.slice());
      let cnt = 0;
      S.numeric.forEach(name => {
        const j = S.columns.indexOf(name);
        if (j < 0) return;
        for (let i = 0; i < rows.length; i++) {
          if (rnd() < 0.10) { rows[i][j] = null; cnt++; }
        }
      });
      S.rowsWork = rows;
      q.preview = null; q.strict = null; q.audit = null;
      toast('已注入 ' + cnt + ' 个缺失单元格（仅影响本页演示）');
      renderQuality();
    };
    ctrl.appendChild(btnInject);
    if (S.rowsWork) {
      const btnRestore = el('button', { class: 'ghost mini', text: '恢复原始数据' });
      btnRestore.onclick = () => {
        S.rowsWork = null;
        q.preview = null; q.strict = null; q.audit = null;
        toast('已恢复');
        renderQuality();
      };
      ctrl.appendChild(btnRestore);
      ctrl.appendChild(el('span', { class: 'pill warn', text: '当前为模拟缺失数据' }));
    }
    pane.appendChild(ctrl);

    const warn = [];
    if (diag.allMissingCols.length) warn.push(`完全缺失列：${diag.allMissingCols.join('、')}`);
    if (diag.highMissingCols.length) warn.push(`缺失 > 50%：${diag.highMissingCols.join('、')}`);
    if (diag.completeRows === 0 && diag.totalMissing > 0) warn.push('没有任何完整样本 —— 若选「完整案例删除」会得到空数据集');
    warn.forEach(w => pane.appendChild(el('div', { class: 'hint', style: 'border-color:#5a4a1a;color:#f5c66b', text: w })));

    /* --- 缺失矩阵 --- */
    pane.appendChild(el('h3', { text: '缺失矩阵（抽样 ≤200×40，红 = 缺失）', style: 'margin-top:16px' }));
    const pat = diag.pattern || [];
    if (!pat.length || !pat[0].length) {
      pane.appendChild(el('div', { class: 'muted', text: '无数据' }));
    } else {
      const cw = Math.max(2, Math.min(8, Math.floor(680 / pat[0].length)));
      const ch = Math.max(1.5, Math.min(4, Math.floor(220 / pat.length)));
      const g = mkSvg(pat[0].length * cw + 4, pat.length * ch + 4);
      pat.forEach((row, i) => {
        row.forEach((v, j) => {
          g.appendChild(mkRect(2 + j * cw, 2 + i * ch, cw - 0.5, ch - 0.5, v ? '#ef4444' : '#22313f'));
        });
      });
      pane.appendChild(el('div', { style: 'overflow:auto;max-height:260px' }, [g]));
    }

    /* --- 各列缺失率 --- */
    const tb = el('table');
    tb.appendChild(el('thead', { html: '<tr><th>变量</th><th>缺失</th><th>缺失率</th><th>有效</th><th>状态</th></tr>' }));
    const bd = el('tbody');
    diag.perCol.forEach(c => {
      const st = c.allMissing ? '<span class="pill bad">全缺失</span>'
        : c.rate > 0.5 ? '<span class="pill warn">高缺失</span>'
        : c.missing > 0 ? '<span class="pill info">有缺失</span>'
        : '<span class="pill ok">完整</span>';
      bd.appendChild(el('tr', { html:
        `<td>${esc(c.name)}</td><td>${c.missing}</td>
         <td><div class="bar" style="width:90px;display:inline-block;vertical-align:middle">
           <i style="width:${Math.round(c.rate * 100)}%;background:${c.rate > 0.5 ? '#ef4444' : '#f59e0b'}"></i></div>
           <span class="muted"> ${pct(c.rate)}</span></td>
         <td>${c.valid}</td><td>${st}</td>` }));
    });
    tb.appendChild(bd);
    pane.appendChild(el('h3', { text: '各变量缺失情况', style: 'margin-top:16px' }));
    pane.appendChild(tb);

    /* --- 缺失机制说明 --- */
    pane.appendChild(el('div', { class: 'rule', style: 'margin-top:14px;border-left-color:#f59e0b;cursor:default', html:
      '<b>缺失机制</b>：MCAR（完全随机）／MAR（可观测变量可解释）／MNAR（与缺失值本身有关）。<br>' +
      '<span class="muted">仅凭缺失比例无法判定机制，需要结合研究设计与数据收集过程。本工具不做自动判定。</span>' }));

    /* --- 填补设置 --- */
    pane.appendChild(el('h3', { text: '填补方案', style: 'margin-top:20px' }));
    const stratSel = el('select', {});
    [['median', '中位数填补（推荐，抗异常值）'], ['mean', '均值填补'],
     ['mode', '众数填补'], ['knn', 'KNN 填补（Gower 距离，支持混合类型）'],
     ['none', '不填补（仅完整案例）']].forEach(([v, label]) => {
      const o = el('option', { value: v, text: label });
      if (q.strategy === v) o.selected = true;
      stratSel.appendChild(o);
    });
    stratSel.onchange = () => { q.strategy = stratSel.value; q.preview = null; renderQuality(); };

    const row1 = el('div', { style: 'display:flex;gap:10px;align-items:center;margin:8px 0;flex-wrap:wrap' }, [
      el('div', { style: 'flex:1;min-width:220px' }, [el('div', { class: 'muted', text: '策略' }), stratSel])
    ]);

    const kIn = el('input', { type: 'number', value: q.knnK, min: '1', max: '20' });
    kIn.onchange = () => { q.knnK = Math.max(1, +kIn.value || 5); q.preview = null; };
    const wChk = el('input', { type: 'checkbox' });
    wChk.checked = q.weighted;
    wChk.onchange = () => { q.weighted = wChk.checked; q.preview = null; };
    if (q.strategy === 'knn') {
      row1.appendChild(el('div', { style: 'width:110px' }, [el('div', { class: 'muted', text: 'K 值' }), kIn]));
      row1.appendChild(el('label', { class: 'row', style: 'width:130px;margin-top:16px' }, [wChk, el('span', { text: '距离加权' })]));
    }
    pane.appendChild(row1);

    pane.appendChild(el('div', { class: 'hint', html:
      '所有填补参数只在<b>训练折</b>上拟合，验证折仅做 transform。目标变量缺失样本<b>直接排除</b>，绝不用均值填补标签。' }));

    /* --- 预览 --- */
    const previewBox = el('div', { style: 'margin-top:10px' });
    const btnPrev = el('button', { class: 'mini', text: '预览填补效果（不改变数据）' });
    btnPrev.onclick = () => {
      btnPrev.disabled = true;
      setTimeout(() => {
        try {
          const numIdx = names.map((n, j) => j).filter(j => S.numeric.includes(names[j]));
          const types = numIdx.map(j => P.inferType(WR.map(r => r[j]), { name: names[j] }));
          const model = P.fitImputer(WR, names, {
            strategy: q.strategy === 'none' ? 'median' : q.strategy,
            knn: { k: q.knnK, weighted: q.weighted }, fallback: q.fallback
          });
          const out = P.transformImputer(WR, model, S.rows);
          const after = P.diagnoseMissing(out.matrix, names);
          q.preview = {
            model,
            beforeRate: diag.overallRate, afterRate: after.overallRate,
            filled: out.log.filledPerColumn.reduce((a, b) => a + b, 0),
            fallbacks: out.log.fallbackReasons.length,
            perCol: out.log.filledPerColumn,
            strategies: model.strategies.slice()
          };
        } catch (e) { q.preview = { error: e.message }; }
        btnPrev.disabled = false;
        renderQuality();
      }, 20);
    };
    previewBox.appendChild(btnPrev);
    if (q.preview) {
      if (q.preview.error) {
        previewBox.appendChild(el('div', { class: 'hint', style: 'border-color:#5a2020;color:#fca5a5', text: '填补失败：' + q.preview.error }));
      } else {
        const pv = q.preview;
        previewBox.appendChild(el('div', { class: 'stat', style: 'margin-top:10px' }, [
          el('div', { html: `<span>缺失率 前→后</span><b>${pct(pv.beforeRate)} → ${pct(pv.afterRate)}</b>` }),
          el('div', { html: `<span>填补单元格</span><b>${pv.filled}</b>` }),
          el('div', { html: `<span>回退次数</span><b>${pv.fallbacks}</b>` })
        ]));
        const tb2 = el('table');
        tb2.appendChild(el('thead', { html: '<tr><th>变量</th><th>策略</th><th>填补数</th><th>填补值</th></tr>' }));
        const b2 = el('tbody');
        names.forEach((n, j) => {
          if (!pv.perCol[j]) return;
          const fill = pv.model.fillValues[j];
          b2.appendChild(el('tr', { html:
            `<td>${esc(n)}</td><td>${esc(pv.strategies[j])}</td><td>${pv.perCol[j]}</td>
             <td>${fill === null ? '-' : fmt(fill, 3)}</td>` }));
        });
        tb2.appendChild(b2);
        previewBox.appendChild(tb2);
      }
    }
    pane.appendChild(previewBox);

    /* --- 严格无泄漏 CV --- */
    pane.appendChild(el('h3', { text: '严格无泄漏交叉验证', style: 'margin-top:24px' }));
    pane.appendChild(el('div', { class: 'muted', html:
      '每折内部：填补 → 分位数 → 离散化 → 建模，全部只用训练折；验证折只做 transform。' }));

    const kv = el('input', { type: 'number', value: q.k, min: '2', max: '10' });
    kv.onchange = () => { q.k = Math.max(2, +kv.value || 5); };
    const sv = el('input', { type: 'number', value: q.seed });
    sv.onchange = () => { q.seed = +sv.value || 42; };
    pane.appendChild(el('div', { style: 'display:flex;gap:10px;margin:10px 0;flex-wrap:wrap' }, [
      el('div', { style: 'width:100px' }, [el('div', { class: 'muted', text: '折数 K' }), kv]),
      el('div', { style: 'width:120px' }, [el('div', { class: 'muted', text: '随机种子' }), sv])
    ]));

    const btnRun = el('button', { class: 'mini', text: '运行严格 CV + 泄漏审计' });
    const outBox = el('div', { style: 'margin-top:10px' });
    btnRun.onclick = async () => {
      btnRun.disabled = true;
      btnRun.textContent = '计算中…';
      setBusy(true, '严格交叉验证计算中…');
      const cancelBtn = document.getElementById('sb-cancel');
      if (cancelBtn) cancelBtn.style.display = '';
      try {
          const target = S.target || names[names.length - 1];
          const idxT = names.indexOf(target);
          const factorIdx = names.map((n, j) => j).filter(j => j !== idxT && S.numeric.includes(names[j]));
          if (factorIdx.length < 1) throw new Error('至少需要一个数值型条件变量');
          const rawX = WR.map(r => factorIdx.map(j => r[j]));
          const yv = WR.map(r => r[idxT]);
          const fnames = factorIdx.map(j => names[j]);
          const levels = S.params.levels || 3;
          const cvOpts = {
            k: q.k, seed: q.seed,
            impute: q.strategy, knn: { k: q.knnK, weighted: q.weighted },
            lowPct: S.params.lowPct || 25, highPct: S.params.highPct || 75,
            levels, drops: Math.min(400, S.params.drops || 400),
            treeDepth: S.params.treeDepth || 3,
            minLeaf: Math.max(10, Math.round(WR.length / 40))
          };
          const gCol = names.find(n => S.roles[n] === 'group');
          const groups = gCol ? WR.map(r2 => r2[names.indexOf(gCol)]) : null;
          let cv;
          try {
            cv = await WK.run('strictCV',
              { rawX, yRaw: yv, names: fnames, labels: C.LEVEL_LABELS[levels], opts: cvOpts, groups },
              { onProgress: p2 => setBusy(true, '严格交叉验证 ' + p2 + '%'), timeoutMs: 240000 });
          } catch (e2) {
            if (e2.message !== 'NO_WORKER') throw e2;
            cv = C.crossValidateStrict(rawX, yv, fnames, C.LEVEL_LABELS[levels], cvOpts, groups);
          }
          q.strict = cv;
          q.audit = cv.ok ? C.leakageAudit(cv, rawX, fnames) : null;
        } catch (e) {
          q.strict = { ok: false, reason: e.message };
          q.audit = null;
        }
        const cb2 = document.getElementById('sb-cancel');
        if (cb2) cb2.style.display = 'none';
        setBusy(false, '就绪');
        btnRun.disabled = false;
        btnRun.textContent = '运行严格 CV + 泄漏审计';
        renderQuality();
    };
    outBox.appendChild(btnRun);
    pane.appendChild(outBox);

    if (q.strict) {
      const cv = q.strict;
      if (!cv.ok) {
        pane.appendChild(el('div', { class: 'hint', style: 'border-color:#5a2020;color:#fca5a5', text: '无法完成：' + cv.reason }));
      } else {
        pane.appendChild(el('div', { class: 'stat', style: 'margin-top:14px' }, [
          el('div', { html: `<span>测试准确率</span><b>${pct(cv.mean)}</b>` }),
          el('div', { html: `<span>平衡准确率</span><b>${pct(cv.oof.balancedAccuracy)}</b>` }),
          el('div', { html: `<span>Macro-F1</span><b>${pct(cv.oof.macroF1)}</b>` }),
          el('div', { html: `<span>训练-测试差距</span><b>${(cv.gap * 100).toFixed(1)} pp</b>` })
        ]));
        pane.appendChild(el('div', { class: 'muted', html:
          `排除目标缺失样本 <b>${cv.excludedByTarget.length}</b> 条；共 ${cv.k} 折。` }));

        const t3 = el('table');
        t3.appendChild(el('thead', { html:
          '<tr><th>折</th><th>训练 n</th><th>验证 n</th><th>训练准确率</th><th>验证准确率</th><th>平衡准确率</th><th>Macro-F1</th></tr>' }));
        const b3 = el('tbody');
        cv.perFold.forEach(f => b3.appendChild(el('tr', { html:
          `<td>${f.fold}</td><td>${f.nTrain}</td><td>${f.nTest}</td>
           <td>${pct(f.trainAccuracy)}</td><td>${pct(f.testAccuracy)}</td>
           <td>${pct(f.balancedAccuracy)}</td><td>${pct(f.macroF1)}</td>` })));
        t3.appendChild(b3);
        pane.appendChild(el('h3', { text: '各折结果（每折独立预处理）', style: 'margin-top:16px' }));
        pane.appendChild(t3);

        // 混淆矩阵
        const cm = cv.oof.confusion;
        const L = C.LEVEL_LABELS[S.params.levels || 3];
        const t4 = el('table');
        t4.appendChild(el('thead', { html: '<tr><th>真实 \\ 预测</th>' + L.map(x => `<th>${x}</th>`).join('') + '</tr>' }));
        const b4 = el('tbody');
        cm.forEach((row, i) => b4.appendChild(el('tr', { html:
          `<td>${L[i]}</td>` + row.map((v, j) => `<td style="color:${i === j ? '#34d399' : v ? '#fca5a5' : '#5d7387'}">${v}</td>`).join('') })));
        t4.appendChild(b4);
        pane.appendChild(el('h3', { text: '合并混淆矩阵（OOF）', style: 'margin-top:16px' }));
        pane.appendChild(t4);
      }
    }

    /* --- 泄漏审计 --- */
    if (q.audit) {
      const a = q.audit;
      pane.appendChild(el('h3', { text: '泄漏审计', style: 'margin-top:24px' }));
      pane.appendChild(el('div', { class: 'rule', style:
        'border-left-color:' + (a.ok ? '#34d399' : '#ef4444') + ';cursor:default',
        html: `<span class="pill ${a.ok ? 'ok' : 'bad'}">${a.verdict}</span>
               <span class="muted">　失败项 ${a.failedCount} / 共 ${a.items.length}</span>` }));
      const t5 = el('table');
      t5.appendChild(el('thead', { html: '<tr><th>检查项</th><th>状态</th><th>依据</th></tr>' }));
      const b5 = el('tbody');
      a.items.forEach(it => {
        const cls = it.status === 'PASS' ? 'ok' : it.status === 'FAIL' ? 'bad' : 'warn';
        b5.appendChild(el('tr', { html:
          `<td>${it.name}</td><td><span class="pill ${cls}">${it.status}</span></td>
           <td style="text-align:left" class="muted">${it.evidence}</td>` }));
      });
      t5.appendChild(b5);
      pane.appendChild(t5);
      pane.appendChild(el('div', { class: 'muted', style: 'margin-top:8px',
        text: '审计基于每折的实际执行记录（重算训练折统计量并比对），不是"点了严格模式就算通过"。' }));
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
    pairs.slice(0, 8).forEach(p => b.appendChild(el('tr', { html: `<td>${esc(p.a)} × ${esc(p.b)}</td><td>${p.r.toFixed(3)}</td><td>${Math.abs(p.r).toFixed(3)}</td>` })));
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
        `<td>${esc(label)}</td><td style="text-align:left">${bars}</td>
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
        `<td>${esc(s.name)}</td>
         <td style="text-align:left"><span class="pill ok">${esc(nm.tag || '-')}</span> <span class="muted">${esc(nm.perf || '')}</span></td>
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
        `<b>R${i + 1}</b> IF ${r.conditions.map(c => `<code>${esc(c)}</code>`).join(' 且 ') || '（无分裂）'}
         → THEN <code>${esc(S.res.meta.target)} = ${esc(r.then)}</code>
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
      box.innerHTML = `<b>${esc(id)}</b> · 度 ${n.degree} · 强度 ${n.strength.toFixed(3)}<br>` +
        rel.map(e => {
          const other = e.source === id ? e.target : e.source;
          return `<span class="muted">${esc(other)}</span> r = ${e.weight.toFixed(3)}`;
        }).join('<br>');
    }

    const tb = el('table');
    tb.appendChild(el('thead', { html: '<tr><th>节点</th><th>度</th><th>关联强度</th></tr>' }));
    const b = el('tbody');
    net.nodes.forEach(n => b.appendChild(el('tr', { html: `<td>${esc(n.id)}</td><td>${n.degree}</td><td>${n.strength.toFixed(3)}</td>` })));
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
      b.appendChild(el('tr', { html: `<td>${esc(f)}</td>${cells}<td>${(spread * 100).toFixed(1)} pp</td>` }));
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
    const cv = r.tree.cv;
    const L = r.calibration.labels;
    pane.appendChild(el('div', { class: 'stat' }, [
      el('div', { html: `<span>测试集准确率（CV 均值）</span><b>${cv ? pct(cv.mean) : '-'}</b>` }),
      el('div', { html: `<span>平衡准确率</span><b>${cv && cv.oof ? pct(cv.oof.balancedAccuracy) : '-'}</b>` }),
      el('div', { html: `<span>Macro-F1</span><b>${cv && cv.oof ? pct(cv.oof.macroF1) : '-'}</b>` }),
      el('div', { html: `<span>训练-测试差距</span><b>${cv && cv.gap !== undefined ? (cv.gap * 100).toFixed(1) + ' pp' : '-'}</b>` })
    ]));
    pane.appendChild(el('div', { class: 'muted', html:
      `训练 ${cv ? pct(cv.trainMean) : '-'} vs 测试 ${cv ? pct(cv.mean) : '-'} —— 差距大说明过拟合；` +
      `平衡准确率与 Accuracy 差距大说明类别不平衡下 Accuracy 有欺骗性。` }));

    if (cv && cv.warning) {
      pane.appendChild(el('div', { class: 'hint', style: 'border-color:#5a4a1a;color:#f5c66b',
        html: '<b>样本量警告</b>：' + cv.warning }));
    }

    // 混淆矩阵
    if (cv && cv.oof && cv.oof.confusion) {
      const cm = cv.oof.confusion;
      const tb0 = el('table');
      tb0.appendChild(el('thead', { html: '<tr><th>真实 \\ 预测</th>' + L.map(l => `<th>${l}</th>`).join('') + '<th>合计</th></tr>' }));
      const b0 = el('tbody');
      cm.forEach((row, i) => {
        const tot = row.reduce((a, b2) => a + b2, 0);
        const isDiag = (j) => j === i;
        b0.appendChild(el('tr', { html:
          `<td>${L[i]}</td>` +
          row.map((v, j) => `<td style="color:${isDiag(j) ? '#34d399' : (v > 0 ? '#fca5a5' : '#5d7387')};font-weight:${isDiag(j) ? 600 : 400}">${v}</td>`).join('') +
          `<td>${tot}</td>` }));
      });
      tb0.appendChild(b0);
      pane.appendChild(el('h3', { text: `混淆矩阵（合并各折测试集，n=${cv.oof.n}）`, style: 'margin-top:16px' }));
      pane.appendChild(tb0);
      pane.appendChild(el('div', { class: 'muted', style: 'margin-top:6px',
        text: '对角线是预测正确的样本；非对角线上数量越大，说明越容易混淆。' }));
    }

    // 每类指标
    if (cv && cv.oof && cv.oof.perClass) {
      const tb1 = el('table');
      tb1.appendChild(el('thead', { html: '<tr><th>类别</th><th>支持度</th><th>Precision</th><th>Recall</th><th>F1</th></tr>' }));
      const b1 = el('tbody');
      cv.oof.perClass.forEach(c => b1.appendChild(el('tr', { html:
        `<td>${L[c.cls]}</td><td>${c.support}</td>
         <td>${pct(c.precision)}</td><td>${pct(c.recall)}</td><td>${pct(c.f1)}</td>` })));
      tb1.appendChild(b1);
      pane.appendChild(el('h3', { text: '各类别独立评价', style: 'margin-top:16px' }));
      pane.appendChild(tb1);
    }

    // 每折
    if (cv && cv.perFold && cv.perFold.length) {
      const tb2 = el('table');
      tb2.appendChild(el('thead', { html:
        '<tr><th>折</th><th>训练 n</th><th>测试 n</th><th>训练准确率</th><th>测试准确率</th><th>平衡准确率</th><th>Macro-F1</th></tr>' }));
      const b2 = el('tbody');
      cv.perFold.forEach(f => b2.appendChild(el('tr', { html:
        `<td>${f.fold}</td><td>${f.nTrain}</td><td>${f.nTest}</td>
         <td>${pct(f.trainAccuracy)}</td><td>${pct(f.testAccuracy)}</td>
         <td>${pct(f.balancedAccuracy)}</td><td>${pct(f.macroF1)}</td>` })));
      tb2.appendChild(b2);
      pane.appendChild(el('h3', { text: '各折明细（分层 K 折）', style: 'margin-top:16px' }));
      pane.appendChild(tb2);
      pane.appendChild(el('div', { class: 'muted', style: 'margin-top:6px',
        text: `分层保证每折的类别比例与总体一致；折数 ${cv.k}，标准差 ±${(cv.std * 100).toFixed(1)} pp。` }));
    }

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



  /* ---------------- Bootstrap 稳定性实验室 ---------------- */
  function bootState() {
    if (!S.extra.boot) {
      S.extra.boot = {
        task: 'cluster', B: 200, seed: 42, method: 'iid', fraction: 1, replacement: true,
        k: 3, maxDepth: 3, threshold: 0.6, result: null, diag: null, error: null, busy: false
      };
    }
    return S.extra.boot;
  }

  function renderBootstrap() {
    const pane = $('#pane');
    const BS = window.DACBootstrap;
    pane.innerHTML = '';
    if (!BS) { pane.innerHTML = '<div class="muted">Bootstrap 引擎未加载。</div>'; return; }
    if (!S.rows.length) { pane.innerHTML = '<div class="muted">先导入数据。</div>'; return; }
    const q = bootState();

    /* 说明 */
    pane.appendChild(el('div', { class: 'muted', html:
      'Bootstrap 用重复重采样估计<b>结构稳定性</b>，回答的是「换个样本，结论还一样吗」。' +
      '它<b>不是</b>准确率，也<b>不是</b>因果证据。' }));

    /* 实验设置 */
    const grid = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin:12px 0' });

    const selTask = el('select', {});
    [['cluster', 'KMeans 聚类稳定性'], ['rules', 'CART 规则稳定性'], ['bn', '贝叶斯网络结构稳定性']]
      .forEach(([v, l]) => { const o = el('option', { value: v, text: l }); if (q.task === v) o.selected = true; selTask.appendChild(o); });
    selTask.onchange = () => { q.task = selTask.value; q.result = null; renderBootstrap(); };

    const selMethod = el('select', {});
    [['iid', '行级 IID（默认）'], ['group', '分组 Cluster（整组抽）'],
     ['stratified', '分层 Stratified'], ['weighted', '加权 Weighted']]
      .forEach(([v, l]) => { const o = el('option', { value: v, text: l }); if (q.method === v) o.selected = true; selMethod.appendChild(o); });
    selMethod.onchange = () => { q.method = selMethod.value; };

    const inB = el('input', { type: 'number', value: q.B, min: '10', max: '2000', step: '10' });
    inB.onchange = () => { q.B = Math.max(10, Math.min(2000, +inB.value || 200)); };
    const inSeed = el('input', { type: 'number', value: q.seed });
    inSeed.onchange = () => { q.seed = +inSeed.value || 42; };
    const inK = el('input', { type: 'number', value: q.k, min: '2', max: '8' });
    inK.onchange = () => { q.k = Math.max(2, +inK.value || 3); };
    const inFrac = el('input', { type: 'number', value: q.fraction, min: '0.1', max: '1', step: '0.1' });
    inFrac.onchange = () => { q.fraction = Math.max(0.1, Math.min(1, +inFrac.value || 1)); };
    const inThr = el('input', { type: 'number', value: q.threshold, min: '0.1', max: '1', step: '0.05' });
    inThr.onchange = () => { q.threshold = Math.max(0.1, Math.min(1, +inThr.value || 0.6)); };

    const cell = (label, node, w) => el('div', { style: 'width:' + (w || 130) + 'px' },
      [el('div', { class: 'muted', text: label }), node]);
    grid.appendChild(cell('任务', selTask, 210));
    grid.appendChild(cell('抽样方法', selMethod, 190));
    grid.appendChild(cell('重采样次数 B', inB, 120));
    grid.appendChild(cell('随机种子', inSeed, 100));
    if (q.task === 'cluster') grid.appendChild(cell('聚类数 k', inK, 90));
    if (q.task === 'bn') grid.appendChild(cell('边频率阈值', inThr, 100));
    grid.appendChild(cell('抽样比例', inFrac, 100));
    pane.appendChild(grid);

    /* 分组/权重提示 */
    const gCol = S.columns.find(c => S.roles[c] === 'group');
    const wCol = S.columns.find(c => S.roles[c] === 'weight');
    if ((q.method === 'group' && !gCol) || (q.method === 'weighted' && !wCol)) {
      pane.appendChild(el('div', { class: 'hint', style: 'border-color:#5a4a1a;color:#f5c66b',
        text: q.method === 'group'
          ? '还没指定分组列。请到「变量角色」把某一列设为「分组」，否则会退化为行级抽样。'
          : '还没指定权重列。请到「变量角色」把某一列设为「权重」。' }));
    }
    pane.appendChild(el('div', { class: 'muted', html:
      `当前：${gCol ? '分组列 = <b>' + esc(gCol) + '</b>' : '无分组列'}；` +
      `${wCol ? '权重列 = <b>' + esc(wCol) + '</b>' : '无权重列'}` }));

    /* 运行 */
    const runRow = el('div', { style: 'display:flex;gap:8px;margin:14px 0;align-items:center' });
    const btnRun = el('button', { class: 'mini', text: '开始 Bootstrap 实验' });
    const bar = el('div', { class: 'bar', style: 'width:200px;display:none' }, [el('i', { style: 'width:0%' })]);
    btnRun.onclick = async () => {
      btnRun.disabled = true;
      bar.style.display = '';
      q.error = null;
      setBusy(true, 'Bootstrap 计算中…');
      try {
        const task = S.target || S.columns[S.columns.length - 1];
        const idxT = S.columns.indexOf(task);
        // 注意：不要用 map 的形参在 filter 里引用（作用域已结束，会 ReferenceError）
        const factorIdx = S.columns.map((_, j) => j).filter(j => {
          const nm = S.columns[j];
          return j !== idxT && S.roles[nm] !== 'id' && S.roles[nm] !== 'exclude' && S.numeric.includes(nm);
        });
        if (!factorIdx.length) throw new Error('没有可用的数值型条件变量');
        const data = {
          X: S.rows.map(r => factorIdx.map(j => r[j])),
          y: S.rows.map(r => r[idxT]),
          names: factorIdx.map(j => S.columns[j]),
          labels: C.LEVEL_LABELS[S.params.levels || 3],
          yName: task,
          groups: gCol ? S.rows.map(r => r[S.columns.indexOf(gCol)]) : null,
          weights: wCol ? S.rows.map(r => r[S.columns.indexOf(wCol)]) : null
        };
        const opt = {
          task: q.task, B: q.B, seed: q.seed, method: q.method, fraction: q.fraction,
          replacement: q.replacement, k: q.k, maxDepth: q.maxDepth,
          levels: S.params.levels || 3, drops: Math.min(200, S.params.drops || 200),
          bnThreshold: q.threshold, impute: 'median'
        };
        let res;
        try {
          res = await WK.run('bootstrapStability', { data, opt }, {
            onProgress: p2 => { bar.querySelector('i').style.width = p2 + '%'; setBusy(true, 'Bootstrap ' + p2 + '%'); },
            timeoutMs: 600000
          });
        } catch (e) {
          if (e.message !== 'NO_WORKER') throw e;
          res = window.DACBootstrap.run(data, opt, p2 => { bar.querySelector('i').style.width = p2 + '%'; });
        }
        q.result = res;
        q.diag = window.DACBootstrap.diagnose(res);
      } catch (e) {
        q.error = e.message;
      }
      bar.style.display = 'none';
      setBusy(false, '就绪');
      btnRun.disabled = false;
      renderBootstrap();
    };
    runRow.appendChild(btnRun);
    runRow.appendChild(bar);
    if (q.result) runRow.appendChild(el('span', { class: 'chip',
      text: `上次：${q.result.okCount}/${q.result.B} 次成功 · ${(q.result.elapsedMs / 1000).toFixed(1)}s` }));
    pane.appendChild(runRow);

    if (q.error) {
      pane.appendChild(el('div', { class: 'hint', style: 'border-color:#5a2020;color:#fca5a5', text: '失败：' + q.error }));
      return;
    }
    if (!q.result) {
      pane.appendChild(el('div', { class: 'hint', html:
        '建议：先跑 <b>B=100</b> 看大概，正式结论用 <b>B=500</b>。' +
        '聚类稳定性看 ARI（≥0.75 稳定）；规则稳定性看频率（≥50% 才算常见）；' +
        '网络稳定性看边频率（但方向频繁翻转说明结构不可信）。' }));
      return;
    }

    /* 诊断 */
    const dg = q.diag;
    pane.appendChild(el('h3', { text: '稳定性诊断', style: 'margin-top:18px' }));
    pane.appendChild(el('div', { class: 'rule', style:
      'border-left-color:' + (dg.ok ? '#34d399' : '#f59e0b') + ';cursor:default',
      html: `<span class="pill ${dg.ok ? 'ok' : 'warn'}">${dg.ok ? '结构稳定' : '存在不稳定项'}</span>` }));
    const tbd = el('table');
    tbd.appendChild(el('thead', { html: '<tr><th>检查</th><th>状态</th><th>依据</th></tr>' }));
    const bd = el('tbody');
    dg.items.forEach(it => {
      const cls = it.status === 'PASS' ? 'ok' : it.status === 'FAIL' ? 'bad' : it.status === 'WARNING' ? 'warn' : 'info';
      bd.appendChild(el('tr', { html:
        `<td>${esc(it.name)}</td><td><span class="pill ${cls}">${it.status}</span></td>
         <td style="text-align:left" class="muted">${esc(it.detail)}</td>` }));
    });
    tbd.appendChild(bd);
    pane.appendChild(tbd);

    const sum = q.result.summary;

    /* ---- 聚类 ---- */
    if (sum.cluster) {
      const c = sum.cluster;
      pane.appendChild(el('h3', { text: '聚类结构稳定性', style: 'margin-top:20px' }));
      pane.appendChild(el('div', { class: 'stat' }, [
        el('div', { html: `<span>平均 ARI</span><b>${c.ari.mean.toFixed(3)}</b>` }),
        el('div', { html: `<span>ARI 95% 区间</span><b>${c.ari.p05.toFixed(3)} ~ ${c.ari.p95.toFixed(3)}</b>` }),
        el('div', { html: `<span>平均 NMI</span><b>${c.nmi.mean.toFixed(3)}</b>` }),
        el('div', { html: `<span>空簇出现率</span><b>${(c.emptyRate * 100).toFixed(1)}%</b>` })
      ]));

      // ARI 直方图
      const vals = c.ari.values;
      if (vals.length > 1) {
        const bins = 20, W = 660, H = 150, pad = 28;
        const min = Math.min(...vals, -0.2), max = Math.max(...vals, 1);
        const counts = new Array(bins).fill(0);
        vals.forEach(v => {
          const k = Math.min(bins - 1, Math.max(0, Math.floor((v - min) / (max - min || 1) * bins)));
          counts[k]++;
        });
        const maxC = Math.max(...counts);
        const g = mkSvg(W, H);
        g.appendChild(mkLine(pad, H - pad, W - pad, H - pad, '#22313f'));
        counts.forEach((cnt, i) => {
          const bw = (W - pad * 2) / bins;
          const bh = (cnt / maxC) * (H - pad * 2);
          g.appendChild(mkRect(pad + i * bw + 1, H - pad - bh, bw - 2, bh, '#4c9aff'));
        });
        g.appendChild(mkText(pad, H - 8, min.toFixed(2), '#8aa0b4', 10, 'start'));
        g.appendChild(mkText(W - pad, H - 8, max.toFixed(2), '#8aa0b4', 10, 'end'));
        g.appendChild(mkText(W / 2, 14, `ARI 分布（${vals.length} 对）`, '#8aa0b4', 11, 'middle'));
        pane.appendChild(g);
      }

      // 共聚类热力图（采样）
      const n = q.result.n;
      const step = Math.max(1, Math.ceil(n / 60));
      const side = Math.ceil(n / step);
      const cellPx = Math.max(2, Math.floor(360 / side));
      const cv = document.createElement('canvas');
      cv.width = side * cellPx; cv.height = side * cellPx;
      const ctx = cv.getContext('2d');
      const co = c.coCluster.matrix;
      for (let a = 0; a < side; a++) {
        for (let bb = 0; bb < side; bb++) {
          const i = a * step, j = bb * step;
          const v = co[i * n + j];
          let col = '#16222e';
          if (!Number.isNaN(v)) {
            const t2 = Math.max(0, Math.min(1, v));
            col = `rgb(${Math.round(20 + t2 * 40)},${Math.round(40 + t2 * 180)},${Math.round(60 + t2 * 195)})`;
          }
          ctx.fillStyle = col;
          ctx.fillRect(bb * cellPx, a * cellPx, cellPx, cellPx);
        }
      }
      pane.appendChild(el('h3', { text: '共聚类矩阵（越亮 = 越常被分到同簇）', style: 'margin-top:16px' }));
      const wrap = el('div', { style: 'overflow:auto;max-width:100%' });
      wrap.appendChild(cv);
      pane.appendChild(wrap);
      pane.appendChild(el('div', { class: 'muted', style: 'margin-top:6px',
        text: '暗块表示「从未共同参与评价」的样本对（分母为 0），不等于「不同簇」。' }));

      // 样本稳定性排名
      const stab = c.stability.map((v, i) => ({ i, v })).filter(x => Number.isFinite(x.v))
        .sort((a2, b2) => b2.v - a2.v);
      if (stab.length) {
        const t2 = el('table');
        t2.appendChild(el('thead', { html: '<tr><th>排名</th><th>样本序号</th><th>同簇稳定性</th></tr>' }));
        const b2 = el('tbody');
        stab.slice(0, 8).concat(stab.slice(-8)).forEach((x, k) => {
          const rank = k < 8 ? k + 1 : stab.length - (16 - k) + 1;
          b2.appendChild(el('tr', { html:
            `<td>${rank}</td><td>#${x.i + 1}</td><td>${x.v.toFixed(3)}</td>` }));
        });
        t2.appendChild(b2);
        pane.appendChild(el('h3', { text: '样本层面：最稳 / 最不稳', style: 'margin-top:16px' }));
        pane.appendChild(t2);
      }
    }

    /* ---- 规则 ---- */
    if (sum.rules) {
      const r2 = sum.rules;
      pane.appendChild(el('h3', { text: 'CART 规则稳定性', style: 'margin-top:20px' }));
      pane.appendChild(el('div', { class: 'stat' }, [
        el('div', { html: `<span>不同规则数</span><b>${r2.ruleCount}</b>` }),
        el('div', { html: `<span>≥50% 出现</span><b>${r2.stableRules}</b>` }),
        el('div', { html: `<span>训练准确率均值</span><b>${(r2.accuracyMean * 100).toFixed(1)}%</b>` }),
        el('div', { html: `<span>根节点变量数</span><b>${r2.rootVar.length}</b>` })
      ]));
      const t3 = el('table');
      t3.appendChild(el('thead', { html: '<tr><th>规则</th><th>出现次数</th><th>频率</th></tr>' }));
      const b3 = el('tbody');
      r2.rules.slice(0, 15).forEach(x => b3.appendChild(el('tr', { html:
        `<td style="text-align:left"><code>${esc(x.sig)}</code></td><td>${x.count}</td>
         <td><div class="bar" style="width:80px;display:inline-block"><i style="width:${Math.round(x.freq * 100)}%"></i></div> ${(x.freq * 100).toFixed(1)}%</td>` })));
      t3.appendChild(b3);
      pane.appendChild(t3);
      const t4 = el('table');
      t4.appendChild(el('thead', { html: '<tr><th>根节点变量</th><th>频率</th></tr>' }));
      const b4 = el('tbody');
      r2.rootVar.forEach(x => b4.appendChild(el('tr', { html: `<td>${esc(x.name)}</td><td>${(x.freq * 100).toFixed(1)}%</td>` })));
      t4.appendChild(b4);
      pane.appendChild(el('h3', { text: '根节点变量频率（最能解释目标的分裂）', style: 'margin-top:16px' }));
      pane.appendChild(t4);
    }

    /* ---- 网络 ---- */
    if (sum.bn) {
      const bn = sum.bn;
      pane.appendChild(el('h3', { text: '贝叶斯网络结构稳定性', style: 'margin-top:20px' }));
      pane.appendChild(el('div', { class: 'stat' }, [
        el('div', { html: `<span>成功学习次数</span><b>${bn.okCount}</b>` }),
        el('div', { html: `<span>候选边</span><b>${bn.edges.length}</b>` }),
        el('div', { html: `<span>方向不稳定</span><b>${bn.unstable}</b>` }),
        el('div', { html: `<span>共识边</span><b>${bn.consensus.edges.length}</b>` })
      ]));
      const t5 = el('table');
      t5.appendChild(el('thead', { html: '<tr><th>边</th><th>正向频率</th><th>反向频率</th><th>判读</th></tr>' }));
      const b5 = el('tbody');
      bn.topEdges.forEach(e => {
        const dir = e.freq > 0.1 && e.revFreq > 0.1;
        b5.appendChild(el('tr', { html:
          `<td>${esc(e.from)} → ${esc(e.to)}</td><td>${(e.freq * 100).toFixed(1)}%</td>
           <td>${(e.revFreq * 100).toFixed(1)}%</td>
           <td>${dir ? '<span class="pill warn">方向不稳</span>' : '<span class="pill ok">方向稳定</span>'}</td>` }));
      });
      t5.appendChild(b5);
      pane.appendChild(t5);
      if (bn.consensus.dropped > 0) {
        pane.appendChild(el('div', { class: 'hint', style: 'border-color:#5a4a1a;color:#f5c66b',
          text: `共识网络构建时有 ${bn.consensus.dropped} 条高频边因会形成有向环而被丢弃——这正说明该结构在重采样下不稳定。` }));
      }
      pane.appendChild(el('div', { class: 'rule', style: 'margin-top:12px;border-left-color:#f59e0b;cursor:default',
        html: '<b>解释边界</b>：边频率只表示「这个结构在重采样中多常被选中」，<b>不代表因果成立的概率</b>。' }));
    }
  }

  /* ---------------- AI 助手（可选 API 接入） ---------------- */
  const AI_KEY = 'dac-workbench-ai';
  const PROVIDERS = {
    deepseek: {
      name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-flash',
      // 服务商实际接受的模型名以 /models 接口为准，这里只是常见候选
      models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner']
    },
    openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
    dashscope: { name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
      models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
    moonshot: { name: '月之暗面 Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k',
      models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0905-preview'] },
    zhipu: { name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash',
      models: ['glm-4-flash', 'glm-4-plus', 'glm-4-air'] },
    siliconflow: { name: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct',
      models: ['Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3'] },
    relay: { name: '中转站（自定义）', base: '', model: '', models: [] },
    custom: { name: '自定义', base: '', model: '', models: [] }
  };

  /** 拉取服务商实际可用的模型列表（GET /models，OpenAI 兼容） */
  async function fetchModels(base, key) {
    const b = String(base || '').replace(/\/+$/, '');
    if (!b) throw new Error('先填 Base URL');
    if (!key) throw new Error('先填 API Key');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(b + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: ctrl.signal });
      const txt = await res.text();
      if (!res.ok) throw new Error('HTTP ' + res.status + '：' + txt.slice(0, 200));
      let j;
      try { j = JSON.parse(txt); } catch (e) { throw new Error('返回不是 JSON：' + txt.slice(0, 120)); }
      const arr = j.data || j.models || [];
      return arr.map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
    } finally { clearTimeout(timer); }
  }

  function diagnose(e) {
    const m = String(e && e.message || e);
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) {
      return '浏览器直连被拦（CORS 或网络）。这个服务商可能不允许前端直调，换 DeepSeek 官方，或用支持 CORS 的中转站。';
    }
    if (/\b401\b/.test(m)) return 'Key 无效或已过期（401）。';
    // DeepSeek 这类服务商会在 400 里直接告诉你能用哪些模型
    if (/\b400\b/.test(m) && /model/i.test(m)) {
      const sup = /supported API model names are ([^.)]+)/i.exec(m);
      if (sup) return `模型名不对。该服务商实际支持：<code>${esc(sup[1].replace(/,\s*/g, '</code> <code>'))}</code> —— 改成其中之一即可（点「获取可用模型」可自动列出）。`;
      return '模型名不被接受（400）。点「获取可用模型」看服务商实际提供哪些。';
    }
    if (/\b403\b/.test(m)) return 'Key 没有该模型权限，或地区受限（403）。';
    if (/\b404\b/.test(m)) return 'Base URL 或模型名不对（404）。检查是不是漏了 /v1。';
    if (/\b429\b/.test(m)) return '触发限流或余额不足（429）。';
    if (/\b5\d\d\b/.test(m)) return '服务端错误，稍后再试。';
    return '未知错误，看下面的原始信息。';
  }
  const AI_SESSION = 'dac-workbench-ai-session';
  /**
   * 读取配置：会话存储优先。
   * 注意：localStorage / sessionStorage 都不是密钥保险箱，只能防"顺手翻看"，
   * 无法防同源 XSS 或本机恶意程序。界面必须如实告知。
   */
  function aiCfg() {
    try {
      const sess = sessionStorage.getItem(AI_SESSION);
      if (sess) return JSON.parse(sess);
      return JSON.parse(localStorage.getItem(AI_KEY) || '{}');
    } catch (e) { return {}; }
  }
  function aiSave(c) {
    try {
      if (c.persist) {
        localStorage.setItem(AI_KEY, JSON.stringify(c));
        sessionStorage.removeItem(AI_SESSION);
      } else {
        sessionStorage.setItem(AI_SESSION, JSON.stringify(c));
        localStorage.removeItem(AI_KEY);
      }
    } catch (e) { /* 隐私模式下可能失败 */ }
  }
  function maskKey(k) {
    if (!k) return '（未设置）';
    if (k.length <= 10) return '****';
    return k.slice(0, 4) + '…' + k.slice(-4) + `（长度 ${k.length}）`;
  }

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
  /* 允许"派生数字"：模型常做差值、比值、占比这类合法运算 */
  function expandNumbers(base) {
    const set = new Set(base);
    const arr = [...base].filter(x => x > 0 && x < 1e6).slice(0, 60);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        set.add(Math.abs(a - b));                       // 差值
        set.add(Math.abs((a - b) / (a || 1) * 100));    // 差值占比
        set.add(a / b);                                 // 比值
        set.add(b / a);
      }
    }
    return set;
  }

  function auditNumbers(text, res) {
    const base = collectNumbers(res);
    // 数组长度也常被引用（"11 个因素"）
    [res && res.meta && res.meta.factors,
     res && res.tree && res.tree.rules,
     res && res.profile && res.profile.columns,
     res && res.calibration && res.calibration.labels].forEach(a => {
      if (Array.isArray(a)) base.add(a.length);
    });
    const allow = [...expandNumbers(base)];
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
      modelHints.innerHTML = '';
      if (v.models && v.models.length) {
        modelHints.appendChild(el('span', { text: '常见模型：' }));
        const sel = el('select', { style: 'margin-left:4px;font-size:11px;padding:2px 4px' });
        sel.appendChild(el('option', { value: '', text: '— 选一个 —' }));
        v.models.forEach(id => sel.appendChild(el('option', { value: id, text: id })));
        sel.onchange = () => { if (sel.value) inModel.value = sel.value; };
        modelHints.appendChild(sel);
      }
    };
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: '服务商' }), selP]));
    // 模型：输入框 + 一键拉取可用列表
    const modelRow = el('div', { style: 'display:flex;gap:6px' });
    modelRow.appendChild(inModel);
    const bModels = el('button', { class: 'ghost mini', text: '获取', title: '调用 GET /models 列出该 Key 可用的模型', style: 'white-space:nowrap' });
    modelRow.appendChild(bModels);
    const modelHints = el('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' });
    bModels.onclick = async () => {
      bModels.disabled = true;
      bModels.textContent = '…';
      modelHints.textContent = '正在查询…';
      try {
        const list = await fetchModels(inBase.value.trim(), inKey.value.trim());
        if (!list.length) { modelHints.textContent = '该接口没有返回模型列表'; }
        else {
          modelHints.innerHTML = '';
          modelHints.appendChild(el('span', { text: `可用 ${list.length} 个：` }));
          const sel = el('select', { style: 'margin-left:4px;font-size:11px;padding:2px 4px' });
          sel.appendChild(el('option', { value: '', text: '— 选一个 —' }));
          list.forEach(id => {
            const o = el('option', { value: id, text: id });
            if (id === inModel.value.trim()) o.selected = true;
            sel.appendChild(o);
          });
          sel.onchange = () => { if (sel.value) inModel.value = sel.value; };
          modelHints.appendChild(sel);
          // 当前填的值不在列表里就立刻提示
          if (inModel.value.trim() && !list.includes(inModel.value.trim())) {
            modelHints.appendChild(el('div', { style: 'color:#f5c66b;margin-top:3px',
              text: `⚠ 当前填的「${inModel.value.trim()}」不在可用列表里，很可能会 400` }));
          }
        }
      } catch (e) {
        modelHints.textContent = '查询失败：' + diagnose(e);
      }
      bModels.disabled = false;
      bModels.textContent = '获取';
    };
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: '模型' }), modelRow, modelHints]));
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: 'Base URL' }), inBase]));
    grid.appendChild(el('div', {}, [el('div', { class: 'muted', text: 'API Key' }), inKey]));
    box.appendChild(grid);
    const saveRow = el('div', { style: 'display:flex;gap:8px;margin-top:9px' });
    const bSave = el('button', { class: 'mini', text: '保存设置' });
    bSave.onclick = () => {
      aiSave({ provider: selP.value, baseURL: inBase.value.trim(), model: inModel.value.trim(),
               key: inKey.value.trim(), persist: persistChk.checked });
      toast(persistChk.checked ? '已保存到 localStorage（长期）' : '已保存到当前会话（关闭页面即失效）');
    };
    const bClear = el('button', { class: 'ghost mini', text: '清除 Key' });
    bClear.onclick = () => { aiSave({}); toast('已清除'); renderAI(); };
    const persistChk = el('input', { type: 'checkbox' });
    persistChk.checked = !!cfg.persist;
    const persistRow = el('label', { class: 'row', style: 'justify-content:flex-start;gap:8px;margin-top:6px' }, [
      persistChk,
      el('span', { text: '记住 Key（写入 localStorage，下次打开仍在）' })
    ]);
    const riskHint = el('div', { class: 'hint', style: 'border-color:#5a4a1a;color:#f5c66b', html:
      '<b>安全提示</b>：浏览器存储<b>不是密钥保险箱</b> —— 同源脚本、浏览器扩展、本机恶意程序都能读到。' +
      '不勾选时 Key 只存在于当前标签页会话，关闭页面即消失。' });

    const bTest = el('button', { class: 'ghost mini', text: '测试连接' });
    const testOut = el('div', { class: 'hint', style: 'display:none' });
    bTest.onclick = async () => {
      bTest.disabled = true;
      bTest.textContent = '测试中…';
      testOut.style.display = '';
      testOut.innerHTML = '正在请求…';
      aiSave({ provider: selP.value, baseURL: inBase.value.trim(), model: inModel.value.trim(),
               key: inKey.value.trim(), persist: persistChk.checked });
      const t0 = performance.now();
      try {
        const txt = await callLLM([{ role: 'user', content: '只回复两个字：可用' }]);
        const ms = Math.round(performance.now() - t0);
        testOut.style.borderColor = '#1f4a3c';
        testOut.innerHTML = `<b style="color:#34d399">连接成功</b> · 延迟 ${ms}ms · 模型 ${inModel.value || '(默认)'}<br>
          <span class="muted">返回：${(txt || '').slice(0, 60)}</span>`;
      } catch (e) {
        testOut.style.borderColor = '#5a2020';
        testOut.innerHTML = `<b style="color:#ef4444">连接失败</b><br>${diagnose(e)}<br>
          <span class="muted" style="word-break:break-all">${String(e.message).slice(0, 200)}</span>`;
      }
      bTest.disabled = false;
      bTest.textContent = '测试连接';
    };
    saveRow.appendChild(bSave); saveRow.appendChild(bTest); saveRow.appendChild(bClear);
    if (cfg.key) saveRow.appendChild(el('span', { class: 'chip', text: maskKey(cfg.key) }));
    box.appendChild(saveRow);
    box.appendChild(persistRow);
    box.appendChild(riskHint);
    box.appendChild(testOut);
    pane.appendChild(box);

    // 发送前预览：让用户先看清要把什么发给第三方
    const preview = el('div', { class: 'hint', style: 'display:none' });
    const bPreview = el('button', { class: 'ghost mini', text: '👁 预览将发送的内容' });
    bPreview.onclick = () => {
      const payload = JSON.stringify({
        target: r.meta.target, factors: r.meta.factors,
        rows: r.meta.rows, used: r.meta.usedRows, params: r.meta.params,
        silhouette: r.scenarios.silhouette,
        cv: r.tree.cv ? { mean: r.tree.cv.mean, std: r.tree.cv.std } : null,
        accuracy: r.tree.accuracy,
        importances: r.tree.importances.slice(0, 5),
        rules: r.tree.rules.slice(0, 3).map(x => ({ if: x.conditions, then: x.then, n: x.support, conf: x.confidence })),
        sens: (r.sens || []).map(({ f, rows }) => ({ var: f, probs: rows.map(x => +(x.posterior[x.posterior.length - 1] * 100).toFixed(1)) }))
      }, null, 1);
      preview.style.display = '';
      preview.innerHTML = '';
      preview.appendChild(el('div', { style: 'margin-bottom:6px', html:
        '<b>即将发送给 ' + esc((aiCfg().baseURL || 'API 服务商')) + '</b>　' +
        '<span class="muted">仅含聚合统计量，<b>不含</b>原始行数据、不含缺失值明细</span>' }));
      preview.appendChild(el('pre', { style: 'max-height:220px;font-size:11px', text: payload }));
    };

    // 操作
    const acts = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin:14px 0' });
    acts.appendChild(bPreview);
    acts.appendChild(preview);
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

    /* ---------- 聊天模式（多轮，带上下文） ---------- */
    const SYS_PROMPT = [
      '你是 DAC（数据驱动分析方法）的科研分析助手。用户给你的是**已经算好的**分析结果，不是原始数据。',
      '',
      '硬性规则：',
      '1. 只能使用给定 JSON 中出现的数字。不得编造、不得估算、不得写"大约/左右"。',
      '2. 不得自己重新计算统计量（相关系数、准确率、p 值等）。',
      '3. 稳定性 ≠ 准确率；相关 ≠ 因果；边频率 ≠ 因果概率。',
      '4. 若结果里有 leakFeatures（疑似特征泄漏），必须在最前面指出。',
      '5. 未做统计检验时，不要用"显著"这个词。',
      '',
      '输出结构（严格遵守，中文，不要多余的客套）：',
      '【结论】一到两句，直接说这批数据支持什么结论。',
      '【依据】2~4 条，每条必须带一个来自 JSON 的具体数值，例如「轮廓系数 0.204（偏弱）」。',
      '【局限】至少 1 条，说明这次分析**不能**证明什么。',
      '【下一步】1~2 条可执行建议（调参数 / 补数据 / 换方法）。'
    ].join('\n');

    const chat = S.extra.chat || (S.extra.chat = []);
    const chatCard = el('div', { class: 'card', style: 'margin-top:14px;background:#0f1a24' });
    chatCard.appendChild(el('h3', { text: '对话（可追问，带上下文）', style: 'margin-bottom:8px;font-size:12px' }));

    const stream = el('div', {
      style: 'max-height:440px;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:4px 2px;margin-bottom:10px'
    });
    const renderChat = () => {
      stream.innerHTML = '';
      if (!chat.length) {
        stream.appendChild(el('div', { class: 'muted', style: 'text-align:center;padding:24px 0', html:
          '还没有对话。可以直接问，例如：<br>' +
          '「这组结论能写进论文吗」「k=3 和 k=4 该选哪个」「为什么轮廓只有 0.2」' }));
      }
      chat.forEach(m => {
        const isUser = m.role === 'user';
        const row = el('div', { style: 'display:flex;justify-content:' + (isUser ? 'flex-end' : 'flex-start') });
        const bubble = el('div', {
          style: 'max-width:88%;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.7;' +
            'white-space:pre-wrap;word-break:break-word;' +
            (isUser
              ? 'background:#1b4a72;border:1px solid #2a6ea8;color:#eaf4ff;border-bottom-right-radius:4px'
              : 'background:#131f2b;border:1px solid var(--line);color:var(--txt);border-bottom-left-radius:4px')
        });
        bubble.textContent = m.content;
        if (m.meta) {
          bubble.appendChild(el('div', { class: 'muted',
            style: 'font-size:11px;margin-top:7px;border-top:1px dashed var(--line);padding-top:5px',
            text: m.meta }));
        }
        row.appendChild(bubble);
        stream.appendChild(row);
      });
      stream.scrollTop = stream.scrollHeight;
    };
    renderChat();
    chatCard.appendChild(stream);

    const inputRow = el('div', { style: 'display:flex;gap:8px;align-items:flex-end' });
    const ta = el('textarea', {
      rows: '2', placeholder: '问点什么…（Enter 发送，Shift+Enter 换行）',
      style: 'flex:1;resize:vertical;min-height:46px;padding:10px 12px;background:#0b141d;' +
        'border:1px solid var(--line);border-radius:9px;color:var(--txt);font-size:13px;font-family:inherit'
    });
    const bSend = el('button', { class: 'mini', text: '发送' });
    inputRow.appendChild(ta);
    inputRow.appendChild(bSend);
    chatCard.appendChild(inputRow);

    const send = async (text) => {
      const q2 = String(text || '').trim();
      if (!q2) return;
      chat.push({ role: 'user', content: q2 });
      renderChat();
      bSend.disabled = true;
      bSend.textContent = '…';
      ta.value = '';
      try {
        // 结果 JSON 只挂在最后一条用户消息上，避免每轮重复传大 payload
        const ctx = '\n\n【分析结果 JSON】\n' + JSON.stringify(brief(), null, 1);
        const hist = chat.slice(-8, -1).map(m => ({ role: m.role, content: m.content }));
        const msgs = [{ role: 'system', content: SYS_PROMPT }]
          .concat(hist)
          .concat([{ role: 'user', content: q2 + ctx }]);
        const t0 = performance.now();
        const txt2 = await callLLM(msgs);
        const ms = Math.round(performance.now() - t0);
        let bad = [];
        try { bad = auditNumbers(txt2, r) || []; } catch (e) { bad = []; }
        const meta = `${ms}ms · ` + (bad.length
          ? `${bad.length} 个数字未在结果中找到：${bad.slice(0, 4).join(', ')}`
          : '数字溯源通过');
        chat.push({ role: 'assistant', content: txt2, meta });
      } catch (e) {
        chat.push({ role: 'assistant', content: '⚠ ' + diagnose(e) + '\n' + String(e.message).slice(0, 320), meta: '请求失败' });
      }
      bSend.disabled = false;
      bSend.textContent = '发送';
      renderChat();
    };
    bSend.onclick = () => send(ta.value);
    ta.onkeydown = e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(ta.value); }
    };

    const quick = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:9px' });
    [
      ['这能写进论文吗', '按审稿人视角评估：这份分析能支撑什么结论、有哪些硬伤、还缺什么。'],
      ['解读这份结果', '把这份结果写成一段能放进论文的中文，不要夸大，不要用"显著"。'],
      ['为什么稳定性不高', '结合轮廓系数、CV、规则数量，解释稳定性偏低的可能原因。'],
      ['下一步做什么', '基于当前结果，给出 3 条最值得做的后续分析，按性价比排序。']
    ].forEach(([label, prompt]) => {
      const b = el('button', { class: 'ghost mini', text: label });
      b.onclick = () => send(prompt);
      quick.appendChild(b);
    });
    const bClearChat = el('button', { class: 'ghost mini', text: '清空对话' });
    bClearChat.onclick = () => { chat.length = 0; renderChat(); };
    quick.appendChild(bClearChat);
    chatCard.appendChild(quick);
    pane.appendChild(chatCard);

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
    const bX = el('button', { class: 'ghost mini', text: '导出 Excel（xlsx）' });
    bX.onclick = async () => {
      try {
        const r2 = S.res;
        const idxT = S.columns.indexOf(r2.meta.target);
        const idxF = r2.meta.factors.map(f => S.columns.indexOf(f));
        const keep = S.rows.filter(x => C.isNum(x[idxT]) && idxF.every(j => C.isNum(x[j])));
        const L2 = r2.calibration.labels;
        const head = ['样本', ...r2.meta.factors.map(f => f + '_等级'), r2.meta.target + '_等级'];
        const rows = keep.map((x, i) => {
          const codes = r2.meta.factors.map(f => r2.calibration.factors[f].codes[i])
            .concat([r2.calibration.target.codes[i]]);
          return [i + 1, ...codes.map(c => L2[c] ?? c)];
        });
        const buf = await C.toXLSX(head, rows, 'DAC校准数据');
        const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `DAC校准数据_${stamp()}.xlsx` });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast('Excel 已生成');
      } catch (e) { toast('导出失败：' + e.message, 5000); }
    };
    const bP1 = el('button', { class: 'ghost mini', text: '导出项目 JSON' });
    bP1.onclick = () => exportProject(false);
    const bP2 = el('button', { class: 'ghost mini', text: '导出项目（含数据）' });
    bP2.onclick = () => exportProject(true);
    const bP3 = el('button', { class: 'ghost mini', text: '导入项目' });
    bP3.onclick = () => {
      const inp = el('input', { type: 'file', accept: '.json' });
      inp.onchange = () => { if (inp.files[0]) importProjectFile(inp.files[0]); };
      inp.click();
    };
    const b5 = el('button', { class: 'ghost mini', text: '复制参数快照' });
    b5.onclick = () => {
      const p2 = S.res.meta.params;
      const txt = JSON.stringify({ target: S.res.meta.target, factors: S.res.meta.factors, params: p2 }, null, 2);
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('参数已复制，可直接粘进论文方法部分'));
      else { download('params.json', txt, 'application/json'); }
    };
    bar.appendChild(b1); bar.appendChild(b2); bar.appendChild(b3); bar.appendChild(b4); bar.appendChild(bX);
    bar.appendChild(bP1); bar.appendChild(bP2); bar.appendChild(bP3); bar.appendChild(b5);
    pane.appendChild(bar);
    pane.appendChild(el('div', { class: 'muted', html:
      `参数快照：分位 ${r.meta.params.lowPct}/${r.meta.params.highPct} · 云滴 ${r.meta.params.drops} · 等级 ${r.meta.params.levels} · k=${r.meta.params.k} · 深度 ${r.meta.params.treeDepth} · 阈值 ${r.meta.params.netThreshold} · 种子 ${r.meta.params.seed}` }));
    pane.appendChild(el('pre', { text: r.report }));
    renderHistory(pane);
  }

  /* ---------------- 历史版本（localStorage） ---------------- */
  const HIST_KEY = 'dac-history-v1';
  const HIST_MAX = 20;

  function histLoad() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch (e) { return []; }
  }
  function histSave(list) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); }
    catch (e) { toast('历史记录已满或浏览器存储受限', 4000); }
  }
  function histPush(entry) {
    const list = histLoad();
    list.unshift(entry);
    histSave(list);
  }
  function histClear() { localStorage.removeItem(HIST_KEY); }

  function renderHistory(pane) {
    const list = histLoad();
    pane.appendChild(el('h3', { text: `历史记录（${list.length} / ${HIST_MAX}）`, style: 'margin-top:22px' }));
    if (!list.length) {
      pane.appendChild(el('div', { class: 'muted', text: '还没有记录。每次运行分析后会自动存一条快照（仅参数与指标，不含数据）。' }));
      return;
    }
    const tb = el('table');
    tb.appendChild(el('thead', { html:
      '<tr><th>时间</th><th>数据集</th><th>目标</th><th>k</th><th>CV 准确率</th><th>轮廓</th><th>规则</th><th>操作</th></tr>' }));
    const body = el('tbody');
    list.forEach((h, i) => {
      const d = new Date(h.at);
      const time = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const tr = el('tr', { html:
        `<td>${time}</td><td>${esc(h.dataset || '-')}</td><td>${esc(h.target || '-')}</td>
         <td>${h.k ?? '-'}</td><td>${h.cv != null ? (h.cv * 100).toFixed(1) + '%' : '-'}</td>
         <td>${h.sil != null ? h.sil.toFixed(3) : '-'}</td><td>${h.rules ?? '-'}</td><td></td>` });
      const btn = el('button', { class: 'ghost mini', text: '恢复参数' });
      btn.onclick = () => {
        if (h.params) {
          const pp = h.params;
          const setV = (id, val, labelId, fmt2) => {
            if (val == null) return;
            $('#' + id).value = val;
            if (labelId) $('#' + labelId).textContent = fmt2 ? fmt2(val) : val;
          };
          setV('low', pp.lowPct, 'vLow', v => v + '%');
          setV('high', pp.highPct, 'vHigh', v => v + '%');
          setV('drops', pp.drops, 'vDrops');
          setV('levels', pp.levels, 'vLevels');
          setV('k', pp.k, 'vK');
          setV('depth', pp.treeDepth, 'vDepth');
          if (pp.netThreshold != null) {
            $('#net').value = Math.round(pp.netThreshold * 100);
            $('#vNet').textContent = pp.netThreshold.toFixed(2);
          }
          if (pp.seed != null) $('#seed').value = pp.seed;
          toast('参数已恢复，请点「运行完整分析」重新计算');
        }
      };
      tr.lastChild.appendChild(btn);
      body.appendChild(tr);
    });
    tb.appendChild(body);
    pane.appendChild(tb);
    const bClear = el('button', { class: 'ghost mini', text: '清空历史', style: 'margin-top:8px' });
    bClear.onclick = () => { histClear(); renderTab(); toast('已清空'); };
    pane.appendChild(bClear);
  }

  /* ---------------- 项目管理（版本化 JSON） ---------------- */
  const PROJ_VERSION = 'dac-project/2.6';

  function projectSnapshot(includeData) {
    const r = S.res;
    return {
      format: PROJ_VERSION,
      name: (S.projectName || '未命名项目'),
      createdAt: new Date().toISOString(),
      app: { name: 'DAC Workbench', version: '2.6', algo: 'v2.1+' },
      dataset: {
        name: S.fileName || (S.sheets ? S.sheets[S.sheetIdx].name : '内置示例'),
        rows: S.rows.length, cols: S.columns.length,
        columns: S.columns.slice(),
        // 默认不打包原始数据，避免项目文件失控膨胀与隐私外泄
        data: includeData ? S.rowsRaw || S.rows : null,
        hash: (() => {
          const str = JSON.stringify(S.columns) + '|' + S.rows.length + '|' +
            (S.rows[0] ? JSON.stringify(S.rows[0]) : '');
          let h = 5381;
          for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
          return 'h' + h.toString(16);
        })()
      },
      roles: S.roles,
      selections: { target: S.target, factors: S.factors },
      params: S.params,
      results: r ? {
        usedRows: r.meta.usedRows,
        silhouette: r.scenarios.silhouette,
        accuracy: r.tree.accuracy,
        cv: r.tree.cv ? { mean: r.tree.cv.mean, std: r.tree.cv.std, k: r.tree.cv.k } : null,
        importances: r.tree.importances.slice(0, 8),
        rules: r.tree.rules.slice(0, 12),
        edges: r.net.edges.slice(0, 30),
        bnEdges: r.bn ? r.bn.edges : null,
        sens: (r.sens || []).map(({ f, rows }) => ({
          var: f, probs: rows.map(x => +(x.posterior ? x.posterior[x.posterior.length - 1] * 100 : 0).toFixed(1))
        }))
      } : null
    };
  }

  function exportProject(includeData) {
    const proj = projectSnapshot(includeData);
    const name = (proj.name || 'project').replace(/[\\/:*?"<>|]/g, '_');
    download(`DAC项目_${name}_${stamp()}.json`, JSON.stringify(proj, null, 2), 'application/json');
    toast(includeData ? '已导出（含数据）' : '已导出（不含原始数据，仅参数与结果）', 4000);
  }

  function importProjectFile(file) {
    file.text().then(txt => {
      let proj;
      try { proj = JSON.parse(txt); } catch (e) { throw new Error('不是合法 JSON'); }
      if (!proj.format || !String(proj.format).startsWith('dac-project/')) {
        throw new Error('不是 DAC 项目文件（缺少 format 标识）');
      }
      const [major] = String(proj.format).split('/');
      if (!proj.format.startsWith('dac-project/2.')) {
        throw new Error('项目版本不兼容：' + proj.format + '（当前支持 2.x）');
      }
      // 恢复
      if (proj.dataset && Array.isArray(proj.dataset.data)) {
        S.columns = proj.dataset.columns.slice();
        S.rows = proj.dataset.data.map(r => r.slice());
        S.rowsRaw = S.rows.map(r => r.slice());
        S.numeric = C.numericCols(S.columns, S.rows);
        toast('已恢复数据（' + S.rows.length + ' 行）');
      } else if (proj.dataset && Array.isArray(proj.dataset.columns)) {
        if (!S.columns.length) {
          toast('项目未含数据；请先导入同名列的数据集，再应用参数', 6000);
        }
      }
      if (proj.roles) S.roles = Object.assign({}, proj.roles);
      if (proj.selections) {
        if (proj.selections.target) S.target = proj.selections.target;
        if (Array.isArray(proj.selections.factors)) S.factors = proj.selections.factors.slice();
      }
      if (proj.params) {
        const pp = proj.params;
        if (pp.lowPct) { $('#low').value = pp.lowPct; $('#vLow').textContent = pp.lowPct + '%'; }
        if (pp.highPct) { $('#high').value = pp.highPct; $('#vHigh').textContent = pp.highPct + '%'; }
        if (pp.drops) { $('#drops').value = pp.drops; $('#vDrops').textContent = pp.drops; }
        if (pp.levels) { $('#levels').value = pp.levels; $('#vLevels').textContent = pp.levels; }
        if (pp.k) { $('#k').value = pp.k; $('#vK').textContent = pp.k; }
        if (pp.treeDepth) { $('#depth').value = pp.treeDepth; $('#vDepth').textContent = pp.treeDepth; }
        if (pp.netThreshold) { $('#net').value = Math.round(pp.netThreshold * 100); $('#vNet').textContent = pp.netThreshold.toFixed(2); }
        if (pp.seed) $('#seed').value = pp.seed;
      }
      S.projectName = proj.name || S.projectName;
      S.extra = {};
      setStep(4);
      setTab('profile');
      if (S.rows.length && S.target) run();
      toast('项目已导入：' + (proj.name || '未命名'), 5000);
    }).catch(e => toast('导入失败：' + e.message, 6000));
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
  /* Worker 状态显示 + 取消按钮 */
  (function initWorkerUI() {
    const badge = document.getElementById('sb-worker');
    if (!badge) return;
    if (!WK.supported) {
      badge.textContent = '不可用（降级主线程）';
      badge.style.color = '#f59e0b';
    } else {
      try { WK.ensure(); badge.textContent = '已启用'; } catch (e) { badge.textContent = '初始化失败'; }
    }
    const cancel = document.getElementById('sb-cancel');
    if (cancel) cancel.onclick = () => { WK.cancelAll(); setBusy(false, '已取消'); cancel.style.display = 'none'; };
  })();

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
