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

  /* ---------------- 导入预览（CSV） ----------------
   * 分隔符猜错会把整行读成一列，且错得"看起来正常"。
   * 所以先给预览 + 可覆盖，再让用户确认。
   * ------------------------------------------------- */
  function showImportPreview(file, text, parsed, forcedDelim) {
    const box = $('#dsInfo');
    if (!box) { applyData(parsed, file.name); return; }
    const m = parsed.meta || {};
    const DELIMS = [['自动', ''], ['逗号 ,', ','], ['分号 ;', ';'], ['Tab', '	'], ['竖线 |', '|']];
    const sel = DELIMS.map(([label, v]) =>
      `<option value="${v === '	' ? 'TAB' : v}"${((forcedDelim || '') === v) ? ' selected' : ''}>${label}</option>`
    ).join('');

    const head = parsed.columns.slice(0, 8);
    const rowsHtml = parsed.rows.slice(0, 5).map(r =>
      '<tr>' + r.slice(0, 8).map(v => `<td>${v === null ? '<span class="muted">∅</span>' : esc(String(v)).slice(0, 24)}</td>`).join('') + '</tr>'
    ).join('');

    box.innerHTML = `
      <div style="border:1px solid var(--line);border-radius:6px;padding:10px;margin-top:8px">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <b>导入预览</b>
          <span class="muted">${esc(file.name)} · ${m.dataRows || parsed.rows.length} 行 × ${parsed.columns.length} 列</span>
          <label class="muted" style="font-size:11.5px">分隔符
            <select id="impDelim" style="font-size:11.5px;padding:2px 4px">${sel}</select>
          </label>
          <span class="muted" style="font-size:11.5px">实际用：<b style="color:var(--acc2)">${({ ',': '逗号 ,', ';': '分号 ;', '\t': 'Tab', '|': '竖线 |' })[parsed.meta.delimiter] || parsed.meta.delimiter}</b></span>
        </div>
        ${(m.widthMismatch ? `<div class="hint" style="border-color:#5a4a1a;color:#f5c66b;margin-bottom:6px">
          ⚠ ${m.widthMismatch} 行的列数与表头不一致（已按表头宽度补齐/截断）</div>` : '')}
        ${(m.skippedBlank ? `<div class="muted" style="font-size:11.5px;margin-bottom:6px">跳过 ${m.skippedBlank} 个空行</div>` : '')}
        <div style="overflow-x:auto;max-height:170px;overflow-y:auto">
          <table style="font-size:11.5px"><thead><tr>${head.map(h => `<th style="text-align:left">${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${rowsHtml}</tbody></table>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="primary" id="impOk" style="padding:5px 12px">确认导入</button>
          <button class="ghost mini" id="impCancel">取消</button>
        </div>
      </div>`;

    const selEl = $('#impDelim');
    selEl.onchange = () => {
      const v = selEl.value === 'TAB' ? '	' : selEl.value;
      const re = C.parseCSV(text, v ? { delimiter: v } : undefined);
      showImportPreview(file, text, re, v);
    };
    $('#impOk').onclick = () => {
      S.fileName = file.name;
      applyData(parsed, file.name);
      // 把解析元信息挂到会话上，便于后续追溯
      S.importMeta = { file: file.name, delimiter: parsed.meta.delimiter, widthMismatch: parsed.meta.widthMismatch, skippedBlank: parsed.meta.skippedBlank, rowIds: parsed.meta.rowIds };
      toast(`已导入 ${parsed.rows.length} 行（分隔符 ${JSON.stringify(parsed.meta.delimiter)}）`);
    };
    $('#impCancel').onclick = () => { box.textContent = '已取消导入'; };
  }

  async function loadFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    $('#dsInfo').textContent = '解析中…';
    try {
      let parsed;
      if (ext === 'csv' || ext === 'txt') {
        const text = await file.text();
        parsed = C.parseCSV(text);
        // 先给预览，用户确认后再进分析
        showImportPreview(file, text, parsed, '');
        return;
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
      applyData({ columns: d.columns, rows: d.rows }, d.name, d.desc + ' · 来源：' + d.source, d);
    };
  })();

  function loadSample(key) {
    const k = key || Object.keys(DS)[0];
    const d = DS[k];
    if (!d) return toast('示例数据未加载');
    const sel = $('#dsSelect');
    if (sel) sel.value = k;
    applyData({ columns: d.columns, rows: d.rows }, d.name, d.desc + ' · 来源：' + d.source, d);
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

  function applyData(parsed, name, desc, meta) {
    if (!parsed.columns.length) return toast('文件里没有读到表格');
    resetAnalysis();
    // 数据集语义元数据（目标推荐、类型、排除列、说明）——决定"研究问题"是什么
    S.dsMeta = meta || null;
    S.columns = parsed.columns;
    S.rows = parsed.rows;
    S.rowsRaw = parsed.rows.map(r => r.slice());
    S.rowsWork = null;
    S.numeric = C.numericCols(S.columns, S.rows);
    if (S.numeric.length < 2) return toast('至少需要 2 个数值列', 5000);

    // 初始化变量角色：
    // 有元数据 → 用 recommendedTarget / roleHints / exclude
    // 无元数据（用户自己导入）→ 回退到"最后一列"，但界面明确提示需要确认
    S.roles = {};
    const recTarget = meta && meta.recommendedTarget && S.columns.includes(meta.recommendedTarget)
      ? meta.recommendedTarget : null;
    const targetName = recTarget || S.columns[S.columns.length - 1];
    const hints = (meta && meta.roleHints) || {};
    const excl = new Set((meta && meta.exclude) || []);
    S.columns.forEach((c2, j) => {
      const col = parsed.rows.map(r => r[j]);
      const t = (window.DACPre ? window.DACPre.inferType(col, { name: c2 }) : 'num');
      if (c2 === targetName) S.roles[c2] = 'target';
      else if (excl.has(c2)) S.roles[c2] = 'exclude';
      else if (hints[c2]) S.roles[c2] = hints[c2];
      else if (t === 'id') S.roles[c2] = 'id';
      else if (t === 'empty') S.roles[c2] = 'exclude';
      else if (t === 'cat' || t === 'binary') S.roles[c2] = 'cat';
      else S.roles[c2] = 'num';
    });
    const prof = C.profile(S.columns, S.rows);
    const metaLines = [];
    if (meta && meta.recommendedTarget) {
      metaLines.push(`<div style="margin-top:6px"><b>推荐目标</b>：${esc(meta.recommendedTarget)}` +
        `${meta.targetType ? ' <span class="pill info">' + esc(meta.targetType) + '</span>' : ''}` +
        `${meta.task ? ' · ' + esc(meta.task) : ''}</div>`);
    }
    if (meta && meta.note) {
      metaLines.push(`<div class="muted" style="margin-top:4px;font-size:11.5px">${esc(meta.note)}</div>`);
    }
    if (meta && meta.caveatPredictors && meta.caveatPredictors.length) {
      metaLines.push(`<div class="hint" style="margin-top:6px;border-color:#5a4a1a;color:#f5c66b">` +
        `⚠ <b>预测时点提醒</b>：${meta.caveatPredictors.map(esc).join('、')} 是否可用取决于预测发生在什么时候；` +
        `若目标是"提前预测"，这些变量尚未发生，必须排除。</div>`);
    }
    $('#dsInfo').innerHTML = `<b>${esc(name)}</b><br>${parsed.rows.length} 行 · ${parsed.columns.length} 列 · 数值列 ${S.numeric.length} 个`
      + metaLines.join('')
      + (desc ? `<br><span class="muted">${desc}</span>` : '');
    $('#status').textContent = `${parsed.rows.length} 行已就绪`;
    const tag = $('#dsTag');
    if (tag) { tag.textContent = name.slice(0, 22); tag.classList.add('live'); }

    const t = $('#target'); t.innerHTML = '';
    S.numeric.forEach(c => t.appendChild(el('option', { value: c, text: c })));
    // 目标来自角色定义（内置数据有 recommendedTarget），不再是"最后一列"
    const roleTarget = S.columns.find(c2 => S.roles[c2] === 'target');
    t.value = (roleTarget && S.numeric.includes(roleTarget))
      ? roleTarget
      : S.numeric[S.numeric.length - 1];
    t.onchange = renderFactors;

    S.target = t.value;
    renderFactors();
    // S.roles 才是持久状态；复选框只是它的视图。
    // 如果 UI 被重建导致 pickedFactors() 读不到，#btnRun 会拿空因子直接 return。
    S.factors = S.columns.filter(c => c !== S.target && (S.roles[c] === 'num' || S.roles[c] === 'cat'));
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
    const usable = new Set(['num', 'cat']);
    S.numeric.filter(c => c !== tgt && (S.roles[c] === undefined || usable.has(S.roles[c]))).forEach(c => {
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
    let factors = pickedFactors();
    if (!factors.length) {
      // 复选框读不到（例如面板被重建）时，回退到角色推导，而不是直接拒绝执行
      factors = (S.factors && S.factors.length)
        ? S.factors.slice()
        : S.columns.filter(c => c !== ($('#target') ? $('#target').value : S.target)
            && (S.roles[c] === 'num' || S.roles[c] === 'cat'));
    }
    if (!factors.length) return toast('至少选一个条件变量');
    // 参数读取也可能抛错（元素被重建等）；失败要让用户看见，而不是点了没反应
    try {
      S.target = ($('#target') && $('#target').value) || S.target;
      S.factors = factors;
      S.params = readParams();
    } catch (e) {
      $('#status').textContent = '参数读取失败';
      toast('参数读取失败：' + (e && e.message || e) + '（请刷新页面重试）', 8000);
      return;
    }
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
    // 记下「进入分析的样本」对应原始表里的哪一行 —— 下钻与导出要靠它
    const keepRawIdx = [];
    S.rows.forEach((r, i) => {
      if (C.isNum(r[idxT]) && idxF.every(j => C.isNum(r[j]))) keepRawIdx.push(i);
    });
    const keep = keepRawIdx.map(i => S.rows[i]);
    // 稳定 rowId：上传 CSV 用解析时的原始行号，内置数据用 1-based 行号
    const rowIds = keepRawIdx.map(i =>
      (S.importMeta && Array.isArray(S.importMeta.rowIds) && S.importMeta.rowIds[i] !== undefined)
        ? S.importMeta.rowIds[i] : (i + 1));
    const yv = keep.map(r => r[idxT]);
    const X = keep.map(r => idxF.map(j => r[j]));

    const cal = {};
    // 二分类条件变量只分 2 级：否则中间等级恒空，等级编码无意义
    const factorTypes = {};
    factors.forEach((f, i) => {
      const col = X.map(r => r[i]);
      const t = C.detectTargetType(col);
      factorTypes[f] = t.type;
      const lv = (t.type === 'binary') ? 2 : params.levels;
      cal[f] = C.calibrate(col, Object.assign({}, params, { levels: lv }));
      cal[f].levelsUsed = lv;
      cal[f].varType = t.type;
    });
    const calY = C.calibrate(yv, params);
    const levels = params.levels;
    // 无序类别不能套「低/中/高」——那等于给类别排了序
    const _tDet = C.detectTargetType(yv);
    const _declared = S.dsMeta && S.dsMeta.targetType;
    const _tType = (_declared && ['nominal','ordinal','binary','continuous','count','categorical'].indexOf(_declared) >= 0)
      ? _declared : _tDet.type;
    const _isNom = ['binary','categorical','nominal'].indexOf(_tType) >= 0;
    // 无序类别用「类别 1/2/3」；有序/连续仍用「低/中/高」
    const labels = _isNom
      ? Array.from({ length: levels }, (_, i) => '类别' + (i + 1))
      : C.LEVEL_LABELS[levels];

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
      stats.push({ name: 'S' + (c + 1), n: members.length, mean, rowIds: members.map(i => rowIds[i]) });
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
    const scenNames = C.nameScenarios(stats, factors, target, baseMean, (S.res && S.res.meta && S.res.meta.targetType && S.res.meta.targetType.type) || 'continuous');

    // 贝叶斯网络（离散化后的数据）
    const discrete = keep.map((_, i) => factors.map(f => cal[f].codes[i]).concat([calY.codes[i]]));
    const allNames = factors.concat([target]);
    let bn = null, sens = null, bnError = null;
    const stateSpace = C.bnStateSpace(allNames.length, levels);
    try {
      // 结构学习不受联合空间限制，先学结构
      bn = C.bnLearn(discrete, allNames, levels);
      // 精确推断才受限：超限就跳过敏感性，但保留网络结构
      if (stateSpace.ok) {
        sens = factors.map(f => ({ f, rows: C.bnSensitivity(bn, f, levels) }));
      } else {
        bnError = `联合状态空间 ${stateSpace.readable}（${stateSpace.vars} 个变量 × ${levels} 状态）` +
          `超出精确枚举上限 ${stateSpace.limit.toLocaleString()}，` +
          `已保留网络结构，但无法计算条件概率与敏感性。` +
          `要恢复推断：变量降到 ${stateSpace.maxVars} 个以内，或把等级数降到 2。`;
      }
    } catch (e) {
      bnError = 'BN 学习失败：' + ((e && e.message) || String(e));
    }

    const res = {
      meta: {
        target, factors, rows: S.rows.length, usedRows: keep.length, params,
        rowIds, keepRawIdx,
        // 目标类型决定后续能不能算 Pearson、能不能比均值 —— 必须一路带下去
        targetType: (function () {
          let detected = { type: 'continuous', levels: 0, reason: '' };
          try {
            const idx = S.columns.indexOf(target);
            detected = C.detectTargetType(S.rows.map(r => r[idx]));
          } catch (e) { }
          // detectTargetType 的 levels 是「取值数组」，统一成计数便于使用
          const nLevels = Array.isArray(detected.levels) ? detected.levels.length
            : (typeof detected.levels === 'number' ? detected.levels : 0);
          const out = Object.assign({}, detected, { levels: nLevels, levelValues: detected.levels });
          // 数据集元数据里声明的类型优先：有序等级不能被自动检测降级成无序
          const declared = S.dsMeta && S.dsMeta.targetType;
          const ALLOW = ['nominal', 'ordinal', 'binary', 'continuous', 'count', 'categorical'];
          if (declared && ALLOW.indexOf(declared) >= 0) {
            out.type = declared;
            out.declared = true;
          }
          return out;
        })()
      },
      profile: C.profile(S.columns, S.rows),
      corr: C.corrMatrix(S.columns, S.rows),
      calibration: { factors: cal, target: calY, labels },
      scenarios: { k: params.k, silhouette: sil, stats, labels: km.labels, names: scenNames, baseMean },
      tree: Object.assign({}, tree, { single, cv }),
      net: Object.assign({}, net, { threshold: params.netThreshold }),
      pca: pc,
      bn, sens, bnError, stateSpace,
      leakFeatures
    };
    // runId：把「这次结果」和「这份数据 + 这套配置」绑起来
    // 数据或配置一变，旧的 runId 就不该再被当成当前结果
    (async () => {
      try {
        const fp = await dataFingerprint(S.columns, S.rows);
        const cfg = configFingerprint();
        S.dataHash = fp.hash;
        S.configHash = cfg.hash;
        S.runId = (fp.hash.slice(0, 12) + '-' + cfg.hash.slice(0, 8));
        res.runId = S.runId;
        res.dataHash = S.dataHash;
        res.configHash = S.configHash;
      } catch (e) { /* 指纹失败不影响分析 */ }
    })();

    // 证据登记表：报告/AI/图表共用同一套 metricId
    // 注意：这里只做首次生成；严格CV/Bootstrap/GLM 完成后由 refreshDerived() 重算
    try { res.evidence = buildEvidence(res); } catch (e) { res.evidence = []; }
    let appendix = '';
    try { appendix = reportAppendix(res); } catch (e) { appendix = ''; }
    res.report = C.report(res) + appendix;
    res.reportWithEvidence = res.report + (res.evidence.length ? evidenceMarkdown(res.evidence) : '');
    return res;
  }

  /* ---------------- 证据登记表 ----------------
   * 每个对外出现的数字都在这里有一条记录：
   *   id          稳定标识（报告/AI/图表共用）
   *   value       原始值
   *   formatted   展示值（含单位/保留位）
   *   unit        单位
   *   denominator 分母（比率类必填，避免"67%"说不清是 67/100 还是 67/1000）
   *   stage       评价阶段（数据 / 训练 / 验证 / 严格CV / 稳定性 / 推断）
   *   method      计算方法
   *   valid       false 表示"有这个字段但不可用"（如未运行、超限）
   *   note        限制说明
   * ------------------------------------------ */
  function buildEvidence(res) {
    const out = [];
    const add = (id, label, value, o) => {
      const opt = o || {};
      const nf = (v, d) => (Number.isFinite(v) ? v.toFixed(d === undefined ? 2 : d) : '—');
      let formatted = opt.formatted;
      if (formatted === undefined) {
        if (typeof value === 'number') {
          // 整数不补小数位（150 而不是 150.00）
          const txt = Number.isInteger(value) ? String(value) : nf(value, opt.digits);
          formatted = txt + (opt.unit || '');
        } else {
          formatted = String(value);
        }
      }
      out.push({
        id, label, value,
        formatted,
        unit: opt.unit || '',
        denominator: opt.denominator === undefined ? null : opt.denominator,
        stage: opt.stage || '描述',
        method: opt.method || '',
        valid: opt.valid !== false,
        note: opt.note || ''
      });
    };

    /* ---- 数据 ---- */
    add('data.rows', '样本数', res.profile.rows, { unit: ' 条', stage: '数据' });
    add('data.cols', '变量数', res.profile.cols, { unit: ' 个', stage: '数据' });
    add('data.usedRows', '进入分析的样本', res.meta.usedRows, {
      unit: ' 条', stage: '数据',
      denominator: res.profile.rows,
      method: '剔除目标缺失行后剩余'
    });
    const miss = res.profile.columns.reduce((a, c) => a + c.missing, 0);
    add('data.missingCells', '缺失单元格', miss, { unit: ' 个', stage: '数据' });
    const outl = res.profile.columns.reduce((a, c) => a + (c.outliers || 0), 0);
    add('data.outliers', 'IQR 异常值', outl, {
      unit: ' 个', stage: '数据',
      method: '1.5×IQR 规则（两侧各算一次）'
    });

    /* ---- 泄漏筛查 ---- */
    const leak = res.leakFeatures || [];
    add('leak.count', '高相关特征数', leak.length, {
      unit: ' 个', stage: '数据',
      valid: true,
      method: '|r| > 0.95 与目标的相关',
      note: leak.length ? leak.map(x => `${x.name}(r=${x.r.toFixed(3)})`).join('、') + '——只是风险筛查，不等于确认泄漏' : '未发现'
    });

    /* ---- 聚类 ---- */
    add('cluster.k', '聚类数 k', res.scenarios.k, { unit: '', stage: '训练' });
    add('cluster.silhouette', '轮廓系数', res.scenarios.silhouette, {
      digits: 3, stage: '训练',
      method: '欧氏距离下的平均轮廓宽',
      note: '衡量当前距离/数据下的分离程度，不是准确率，也不证明模型最优'
    });

    /* ---- 规则 ---- */
    if (res.tree && res.tree.rules && res.tree.rules.length) {
      const r0 = res.tree.rules[0];
      add('rules.count', '规则数', res.tree.rules.length, { unit: ' 条', stage: '训练' });
      add('rules.topSupport', '最强规则支持数', r0.support, {
        unit: ' 条', stage: '训练',
        denominator: res.meta.usedRows,
        method: 'CART 叶节点样本数'
      });
      add('rules.topConfidence', '最强规则置信度', r0.confidence, {
        digits: 1, unit: '%', stage: '训练',
        formatted: (r0.confidence * 100).toFixed(1) + '%',
        denominator: r0.support,
        method: '叶节点内该类占比（训练内条件比例）',
        note: '不是置信区间，也不是未来可靠性'
      });
    }

    /* ---- 交叉验证 ---- */
    if (res.tree && res.tree.accuracy !== undefined) {
      add('cv.trainAcc', '训练准确率', res.tree.accuracy, {
        digits: 1, unit: '%', stage: '训练',
        formatted: (res.tree.accuracy * 100).toFixed(1) + '%',
        denominator: res.meta.usedRows
      });
    }
    if (res.tree && res.tree.cv) {
      add('cv.kfoldAcc', '普通 5 折准确率', res.tree.cv.mean, {
        digits: 1, unit: '%', stage: '验证（诊断性质）',
        formatted: (res.tree.cv.mean * 100).toFixed(1) + '%',
        method: '全量数据预校准后的 5 折（非严格验证）',
        note: '主报告应优先引用严格 CV 结果'
      });
    }
    // 预测时点：某些变量在"预测目标发生之前"根本还不存在
    const caveat = (S.dsMeta && S.dsMeta.caveatPredictors) || [];
    if (caveat.length && r.meta.factors.some(f => caveat.indexOf(f) >= 0)) {
      const used = r.meta.factors.filter(f => caveat.indexOf(f) >= 0);
      F.push({
        tag: '时点',
        text: `本次把 <b>${used.map(esc).join('、')}</b> 当成了预测变量。` +
          `<span class="warnline">如果研究任务是"在目标发生之前做预测"，这些变量当时还不存在，属于信息泄漏。</span>` +
          `<span class="muted">这不是靠相关系数判断的——要看数据是怎么采集的。若目标是"事后解释"，把它们放进来是合理的。</span>`
      });
    }

    const st = RES.strictOk();
    if (st && st.ok) {
      add('strictCV.oofAcc', '严格 CV · OOF 准确率', st.oof.accuracy, {
        digits: 1, unit: '%', stage: '严格CV',
        formatted: (st.oof.accuracy * 100).toFixed(1) + '%',
        denominator: st.oof.n,
        method: '每折独立填补/校准/建模，OOF 汇总'
      });
      add('strictCV.balancedAcc', '严格 CV · Balanced Acc', st.oof.balancedAccuracy, {
        digits: 1, unit: '%', stage: '严格CV',
        formatted: (st.oof.balancedAccuracy * 100).toFixed(1) + '%'
      });
      add('strictCV.gap', '训练-验证差', st.gap * 100, {
        digits: 1, unit: ' 个百分点', stage: '严格CV',
        method: '训练均值 − 验证均值'
      });
    } else {
      add('strictCV.oofAcc', '严格 CV · OOF 准确率', null, {
        stage: '严格CV', valid: false, formatted: '未运行',
        note: '不要据此推断泛化能力'
      });
    }

    /* ---- Bootstrap ---- */
    const bt = S.extra && S.extra.boot && S.extra.boot.result;
    if (bt && bt.okCount > 0) {
      add('boot.runs', 'Bootstrap 成功轮数', bt.okCount, {
        unit: ' 轮', stage: '稳定性', denominator: bt.B
      });
      if (bt.summary && bt.summary.cluster) {
        add('boot.ari', 'Bootstrap ARI 均值', (RES.bootAri(bt) || {}).mean, {
          digits: 3, stage: '稳定性',
          method: '各轮重采样聚类与参考划分的一致性',
          note: '结构稳定性，不是监督准确率，也不是因果概率'
        });
      }
      if (bt.summary && bt.summary.rules && bt.summary.rules.oob) {
        add('boot.oob', 'OOB 准确率', bt.summary.rules.oob.accuracy, {
          digits: 1, unit: '%', stage: '袋外验证',
          formatted: (bt.summary.rules.oob.accuracy * 100).toFixed(1) + '%',
          note: `覆盖率 ${(bt.summary.rules.oob.coverage * 100).toFixed(1)}%`
        });
      }
    } else {
      add('boot.runs', 'Bootstrap 成功轮数', null, { stage: '稳定性', valid: false, formatted: '未运行' });
    }

    /* ---- BN ---- */
    if (res.bn) {
      add('bn.edges', '贝叶斯网络边数', res.bn.edges.length, { unit: ' 条', stage: '推断' });
      if (res.bnError) {
        add('bn.infer', '精确推断', null, {
          stage: '推断', valid: false, formatted: '不可用', note: res.bnError
        });
      } else if (res.stateSpace) {
        add('bn.infer', '精确推断', res.stateSpace.total, {
          unit: ' 个联合状态', stage: '推断',
          formatted: res.stateSpace.readable,
          note: `上限 ${res.stateSpace.limit.toLocaleString()}`
        });
      }
    }

    return out;
  }

  /** 证据表 → Markdown（附在报告末尾） */
  /** 报告附录：把摘要的观察与机制转成 Markdown（导出时用） */
  function reportAppendix(r) {
    const strip = (h) => String(h).replace(/<[^>]+>/g, '').replace(/\*\*/g, '');
    const F = buildFindings(r);
    const M = buildMechanism(r);
    const L = [];
    L.push('');
    L.push('## 六、观察');
    L.push('');
    F.forEach((x, i) => L.push(`${i + 1}. **${x.tag}**：${strip(x.text)}`));
    L.push('');
    L.push('## 七、机制与口径');
    L.push('');
    M.forEach((x, i) => L.push(`${i + 1}. **${x.tag}**：${strip(x.text)}`));
    L.push('');
    L.push('## 八、局限');
    L.push('');
    L.push('- 以上是**相关与条件概率**，不是因果效应；P(Y|X) ≠ P(Y|do(X))。');
    L.push('- 轮廓系数、ARI、规则频率衡量的是**结构稳定性**，不是监督准确率。');
    L.push('- 决策树「叶内占比」是训练集内的条件比例，不是置信区间。');
    L.push('- 特征重要性依赖模型与编码，不是统计显著性，也不是因果贡献。');
    if (!RES.strictOk()) {
      L.push('- **严格交叉验证未运行**，本报告的泛化结论仅来自普通 CV（诊断性质）。');
    }
    L.push('');
    L.push('## 九、下一步');
    L.push('');
    L.push('1. 跑一次「严格 CV」（每折独立填补/校准/建模），用 OOF 指标替代训练指标。');
    L.push('2. 若样本存在分组（如同一企业/同一批次），启用分组切分避免同组跨折。');
    L.push('3. 对关键规则做 Bootstrap 稳定性检验，看规则在重采样下是否复现。');
    L.push('4. 需要因果结论时，另做识别设计（随机化 / IV / DID / 断点）。');
    L.push('');
    return L.join('\n');
  }

  function evidenceMarkdown(list) {
    if (!list || !list.length) return '';
    const L = [];
    L.push('');
    L.push('## 附：证据登记表');
    L.push('');
    L.push('报告中每个数字都能在此找到出处。`有效=否` 表示该项有字段但结果不可用。');
    L.push('');
    L.push('| ID | 指标 | 值 | 分母 | 阶段 | 方法 | 有效 | 限制 |');
    L.push('|---|---|---|---|---|---|---|---|');
    list.forEach(e => {
      const v = e.valid ? e.formatted : `**${e.formatted}**`;
      L.push(`| \`${e.id}\` | ${e.label} | ${v} | ${e.denominator === null ? '—' : e.denominator} | ${e.stage} | ${e.method || '—'} | ${e.valid ? '是' : '**否**'} | ${e.note || '—'} |`);
    });
    L.push('');
    return L.join('\n');
  }

  /* ---------------- 结论摘要 ---------------- */
  /* ---------------- 结果访问层（单一 schema） ----------------
   * 每个结果只有一个写入位置、一个读取入口。
   * 之前 strict 写入 S.extra.quality.strict 却从 S.extra.strict 读，
   * Bootstrap 写 cluster.ari.mean 却读 cluster.ariMean，导致结果永远显示"未运行"。
   * ------------------------------------------------------ */
  const RES = {
    /** 严格 CV；未运行返回 null，失败返回 {ok:false, reason} */
    strict() {
      const q = S.extra && S.extra.quality;
      return (q && q.strict) ? q.strict : null;
    },
    /** 严格 CV 成功且有 OOF 才返回，否则 null */
    strictOk() {
      const st = RES.strict();
      return (st && st.ok && st.oof) ? st : null;
    },
    strictState() {
      const st = RES.strict();
      if (!st) return 'not-run';
      if (st.ok) return 'ok';
      return 'failed';
    },
    /** Bootstrap 结果；未运行返回 null */
    boot() {
      const b = S.extra && S.extra.boot;
      return (b && b.result) ? b.result : null;
    },
    /** Bootstrap 聚类 ARI —— 兼容 ari:{mean} 与 ariMean 两种历史结构 */
    bootAri(bt) {
      const r = bt || RES.boot();
      if (!r || !r.summary || !r.summary.cluster) return null;
      const c = r.summary.cluster;
      if (c.ari && typeof c.ari === 'object' && typeof c.ari.mean === 'number') {
        return { mean: c.ari.mean, lo: c.ari.lo, hi: c.ari.hi };
      }
      if (typeof c.ariMean === 'number') {
        return { mean: c.ariMean, lo: c.ariLo, hi: c.ariHi };
      }
      return null;
    },
    /** Bootstrap 规则 OOB */
    bootOob(bt) {
      const r = bt || RES.boot();
      const o = r && r.summary && r.summary.rules && r.summary.rules.oob;
      return (o && typeof o.accuracy === 'number') ? o : null;
    },
    bootFailed(bt) {
      const r = bt || RES.boot();
      if (!r) return null;
      // 兼容 failed / failedCount / failCount
      const f = (typeof r.failed === 'number') ? r.failed
        : (typeof r.failedCount === 'number') ? r.failedCount
          : (typeof r.failCount === 'number') ? r.failCount : null;
      return f;
    },
    /** GLM 结果 */
    glm() {
      const g = S.extra && S.extra.glm;
      return (g && g.ok !== false) ? g : null;
    }
  };

  /* ---------------- 数据指纹 ----------------
   * 为什么不能只哈希首行：改第 2 行就查不出来。
   * 序列化规则（写死在版本号里，改格式必须升版本）：
   *   dac-data/1
   *   字段分隔    \u001F (US)
   *   记录分隔    \u001E (RS)
   *   缺失        \u0000 (NUL)
   *   数值        String(v)（整数不带小数点，如 1 而不是 1.0）
   *   类型        由 DACPre.inferType 推断后写进指纹
   * ------------------------------------------------- */
  const DATA_FP_VERSION = 'dac-data/1';

  function fnv1a64(str) {
    // 退化路径：crypto.subtle 不可用时用（明确标注为弱哈希）
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (h2 + c) >>> 0; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0'));
  }

  async function dataFingerprint(columns, rows) {
    const US = '\u001F', RS = '\u001E', NUL = '\u0000';
    const parts = [DATA_FP_VERSION, 'cols=' + columns.length, columns.join(US)];
    // 每列的类型（缺失/数值/文本）——schema 的一部分
    const types = columns.map((c, j) => {
      try { return window.DACPre ? window.DACPre.inferType(rows.map(r => r[j]), { name: c }) : '?'; }
      catch (e) { return '?'; }
    });
    parts.push('types=' + types.join(','));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const cells = new Array(columns.length);
      for (let j = 0; j < columns.length; j++) {
        const v = r[j];
        cells[j] = (v === null || v === undefined) ? NUL : String(v);
      }
      parts.push(cells.join(US));
    }
    const text = parts.join(RS);
    const bytes = new TextEncoder().encode(text);
    let alg = 'FNV1a-64', hash = fnv1a64(text);
    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      try {
        const buf = await crypto.subtle.digest('SHA-256', bytes);
        alg = 'SHA-256';
        hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) { /* 保留弱哈希 */ }
    }
    return {
      alg, hash,
      rows: rows.length, cols: columns.length,
      bytes: bytes.length,
      version: DATA_FP_VERSION,
      types
    };
  }

  /** 配置指纹：目标 + 因子 + 角色 + 参数（不含数据） */
  function configFingerprint() {
    const payload = {
      v: 'dac-config/1',
      target: S.target,
      factors: (S.factors || []).slice().sort(),
      roles: S.roles || {},
      params: S.params || {}
    };
    const text = JSON.stringify(payload);
    let alg = 'FNV1a-64', hash = fnv1a64(text);
    return { alg, hash, text: text.length };
  }

  // 暴露给测试与调试（也便于用户在控制台复核项目指纹）
  window.__dacFingerprint = dataFingerprint;
  window.__dacConfigFingerprint = configFingerprint;
  window.__dacState = () => S;          // 只读引用，便于控制台复核
  window.__dacRun = () => run();        // 便于测试与自动化；与点「运行完整分析」等价
  window.__dacImportProject = null;     // 由 importProjectFile 所在作用域填入

  /* ---------------- 派生结果刷新 ----------------
   * 证据表 / 报告 / 摘要都依赖「当前」的严格CV、Bootstrap、GLM 结果。
   * 这些是异步完成的，必须重算；否则会看到摘要 78.0% 而证据表写"未运行"。
   * ------------------------------------------------------ */
  function refreshDerived() {
    const r = S.res;
    if (!r) return;
    try { r.evidence = buildEvidence(r); } catch (e) { r.evidence = []; }
    try { r.report = C.report(r) + reportAppendix(r); } catch (e) { /* 报告失败不影响摘要 */ }
    try {
      r.reportWithEvidence = r.report + (r.evidence.length ? evidenceMarkdown(r.evidence) : '');
    } catch (e) { r.reportWithEvidence = r.report; }
    try { updateSummary(); } catch (e) { }
    // 若当前在报告页，重渲染以显示最新证据
    if (S.tab === 'report') { try { renderReport(); } catch (e) { } }
  }

  /* ---------------- 目标类型保护 ----------------
   * 无序类别（nominal/categorical/binary）不能：
   *   1) 用皮尔逊相关描述"线性关联"——编码 0/1/2 的数值差没有含义
   *   2) 比均值排名——"均值最高的类别"是伪命题
   *   3) 用 |r| > 0.95 判定特征泄漏——编码顺序会改变 r
   * 有序（ordinal）可以比均值，但要说明是有序的。
   * ------------------------------------------------------ */
  const NOMINAL_TYPES = ['binary', 'categorical', 'nominal'];

  function tgtInfo(r) {
    const t = (r && r.meta && r.meta.targetType) || {};
    const ty = t.type || 'continuous';
    const levels = Array.isArray(t.levels) ? t.levels.length : (t.levels || 0);
    return {
      type: ty,
      levels,
      reason: t.reason || '',
      nominal: NOMINAL_TYPES.indexOf(ty) >= 0,
      ordinal: ty === 'ordinal',
      label: ({ binary: '二分类', categorical: '无序类别', nominal: '无序类别',
        ordinal: '有序类别', count: '计数', continuous: '连续' })[ty] || ty
    };
  }

  /* ---------------- 结论解读：观察 + 机制 ----------------
   * 参考成熟产品的 findings / mechanism 两段式，但避开它们的三个错误：
   *   1) 分组高低不能取同一个索引
   *   2) 不能拿恒为常数的指标（如 He）做排名
   *   3) 每条都要带分母，不能只给百分比
   * ------------------------------------------------------ */

  /** 观察：这批数据支持什么、不支持什么 */
  function buildFindings(r) {
    const F = [];
    const prof = r.profile, tgt = r.meta.target;
    const miss = prof.columns.reduce((a, c) => a + c.missing, 0);
    const outl = prof.columns.reduce((a, c) => a + (c.outliers || 0), 0);

    F.push({
      tag: '样本',
      text: `<b>${prof.rows}</b> 条样本 / <b>${prof.cols}</b> 个变量；` +
        `进入分析 <b>${r.meta.usedRows}</b> 条（分母 ${prof.rows}）；` +
        `缺失 ${miss} 个单元格、IQR 异常候选 ${outl} 个。`
    });

    const TI = tgtInfo(r);
    const corr = r.corr;
    const corrNames = corr && (corr.columns || corr.names);
    if (TI.nominal) {
      // 无序类别的编码 0/1/2 是标签，不是数量：Pearson 没有意义，换编码顺序结论就变
      F.push({
        tag: '关联',
        text: `目标「${esc(tgt)}」是<b>${TI.label}</b>（${TI.levels} 个类别），` +
          `编码只是标签，没有大小顺序，因此<b>不用皮尔逊相关描述</b>，也不给类别排高低。` +
          `<span class="muted">换个编码顺序，r 就会变——用它做"线性关联"会得出伪结论。` +
          `要看组间差异请用「异质性」段的类别分布，或到统计建模里做多项/二项判别。</span>`
      });
    } else if (corr && corr.matrix && corrNames) {
      const idx = corrNames.indexOf(tgt);
      if (idx >= 0) {
        // 只保留本次选中的因子：取消勾选/被排除的列不能借相关矩阵"回流"
        const activeSet = new Set(r.meta.factors || []);
        const pairs = corrNames
          .map((n, j) => ({ n, r: corr.matrix[idx][j] }))
          .filter(x => x.n !== tgt && Number.isFinite(x.r) && activeSet.has(x.n))
          .sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
        if (pairs.length) {
          const top = pairs.slice(0, 3).map(x => `${esc(x.n)}(r=${x.r.toFixed(2)})`).join('、');
          F.push({
            tag: '关联',
            text: `与「${esc(tgt)}」线性关联最强的是 ${top}。` +
              (TI.ordinal
                ? `<span class="muted">目标是有序类别，Pearson 建立在"等级间隔相等"的假设上；` +
                  `这是相关系数，不是因果效应，也不代表预测价值。</span>`
                : `<span class="muted">这是相关系数，不是因果效应，也不代表预测价值。</span>`)
          });
        }
      }
    }

    const sc = r.scenarios;
    const valid = sc.stats.filter(x => x.n > 0);
    if (valid.length >= 2) {
      const sorted = valid.slice().sort((a, b) => b.mean[tgt] - a.mean[tgt]);
      const hi = sorted[0], lo = sorted[sorted.length - 1];
      const hiTag = (sc.names && sc.names[sc.stats.indexOf(hi)]) || {};
      const loTag = (sc.names && sc.names[sc.stats.indexOf(lo)]) || {};
      const hiName = hiTag.tag ? `${hi.name}「${hiTag.tag}」` : hi.name;
      const loName = loTag.tag ? `${lo.name}「${loTag.tag}」` : lo.name;
      if (TI.nominal) {
        // 无序类别：不排序、不比均值，只给各组规模与目标构成
        const sizes = valid.map(x => `${x.name} n=${x.n}`).join('、');
        F.push({
          tag: '异质性',
          text: `分成 <b>${sc.k}</b> 组（${sizes}）。` +
            `目标「${esc(tgt)}」是<b>${TI.label}</b>，<b>不比较各组的目标均值</b>——` +
            `类别均值取决于编码，没有解释意义。` +
            `<span class="muted">要看"哪个类别在哪个组更多"，请看下钻样本或做列联表检验（卡方/Fisher）。</span>`
        });
      } else {
        const hiV = hi.mean[tgt], loV = lo.mean[tgt];
        const tie = Math.abs(hiV - loV) < 1e-12;
        // 并列要如实说：不能把"所有组一样"写成"最高/最低"
        const tieCount = valid.filter(x => Math.abs(x.mean[tgt] - hiV) < 1e-12).length;
        if (tie) {
          F.push({
            tag: '异质性',
            text: `分成 <b>${sc.k}</b> 组（轮廓 ${(sc.silhouette || 0).toFixed(2)}，分母 ${valid.reduce((a, x) => a + x.n, 0)}）。` +
              `各组「${esc(tgt)}」均值<b>完全相同</b>（${hiV.toFixed(3)}），没有可以排序的高低。` +
              `<span class="muted">这通常意味着目标变量是类别编码、或聚类未按目标分层；不要据此比较组间差异。</span>`
          });
        } else {
          F.push({
            tag: '异质性',
            text: `分成 <b>${sc.k}</b> 组（轮廓 ${(sc.silhouette || 0).toFixed(2)}，分母 ${valid.reduce((a, x) => a + x.n, 0)}）。` +
              `「${esc(tgt)}」均值最高的是 <b>${esc(hiName)}</b>（${hiV.toFixed(3)}，n=${hi.n}），` +
              `最低的是 <b>${esc(loName)}</b>（${loV.toFixed(3)}，n=${lo.n}）` +
              (tieCount > 1 ? `；另有 ${tieCount - 1} 组并列最高` : '') + '。' +
              (TI.ordinal ? `<span class="muted">目标是有序类别，均值差可作参考，但假设了等级间隔相等。</span>`
                : `<span class="muted">组间差异说明不宜用单一模型笼统概括。</span>`)
          });
        }
      }
    }

    const st = RES.strictOk();
    if (st && st.ok) {
      F.push({
        tag: '泛化',
        text: `严格交叉验证（每折独立填补/校准/建模）：OOF 准确率 <b>${(st.oof.accuracy * 100).toFixed(1)}%</b>` +
          `（分母 ${st.oof.n}），Balanced ${(st.oof.balancedAccuracy * 100).toFixed(1)}%，` +
          `训练 ${(st.trainMean * 100).toFixed(1)}% vs 验证 ${(st.mean * 100).toFixed(1)}%（差 ${(st.gap * 100).toFixed(1)} 个百分点）。` +
          (st.gap > 0.08 ? '<span class="warnline">差距偏大，存在过拟合迹象。</span>' : '')
      });
    } else if (r.tree && r.tree.cv) {
      const gap = r.tree.accuracy - r.tree.cv.mean;
      F.push({
        tag: '泛化',
        text: `普通 5 折 CV：训练 ${(r.tree.accuracy * 100).toFixed(1)}% vs 验证 ${(r.tree.cv.mean * 100).toFixed(1)}%` +
          `（差 ${(gap * 100).toFixed(1)} 个百分点）。` +
          `<span class="muted">诊断性质的普通 CV，未做折内独立预处理；严格 CV 未运行。</span>`
      });
    }

    if (TI.nominal) {
      F.push({
        tag: '风险',
        text: `目标的 Pearson 泄漏筛查<b>不适用</b>（无序类别的编码顺序会改变 r），` +
          `因此本报告的「疑似特征泄漏」结论对这类目标不计入。` +
          `<span class="muted">真正的泄漏要结合来源、预测时点和研究任务判断：` +
          `例如"预测最终成绩却用第二次成绩做输入"，无论相关系数多少都是泄漏。</span>`
      });
    } else if (r.leakFeatures && r.leakFeatures.length) {
      F.push({
        tag: '风险',
        text: `<span class="warnline"><b>疑似特征泄漏</b></span>：` +
          r.leakFeatures.map(x => `${esc(x.name)}(r=${x.r.toFixed(3)})`).join('、') +
          ' 与目标几乎等同，模型的高准确率是「抄答案」，不是真实预测力。' +
          '请确认它们在因果上是否先于目标发生。'
      });
    } else {
      F.push({ tag: '风险', text: '未发现 |r|>0.95 的高相关特征。' });
    }

    return F;
  }

  /** 机制：具体规则 + 口径（口径不写清楚，别人无法复算） */
  function buildMechanism(r) {
    const M = [];
    const tgt = r.meta.target;

    const rules = (r.tree.rules || []).slice()
      .sort((a, b) => b.support * b.confidence - a.support * a.confidence);
    rules.slice(0, 3).forEach(rule => {
      const share = (rule.support / Math.max(1, r.meta.usedRows) * 100).toFixed(1);
      M.push({
        tag: '规则',
        text: `<b>IF</b> ${rule.conditions.map(c => `<code>${esc(c)}</code>`).join(' 且 ') || '（无分裂）'} ` +
          `<b>THEN</b> ${esc(tgt)} = <b>${esc(rule.then)}</b>` +
          `（n=${rule.support}，占 ${share}%，叶内该类占比 ${(rule.confidence * 100).toFixed(1)}%）` +
          `<span class="muted">——「叶内占比」是训练集内的条件比例，不是置信区间，也不代表未来可靠性。</span>`
      });
    });

    if (r.tree.importances && r.tree.importances.length) {
      const imp = r.tree.importances.slice(0, 4).map(x => `${esc(x.name)} ${(x.value * 100).toFixed(1)}%`).join('、');
      M.push({
        tag: '重要性',
        text: `决策树特征重要性：${imp}。` +
          `<span class="muted">重要性依赖模型与编码方式，不是因果效应，也不是统计显著性。</span>`
      });
    }

    if (r.net) {
      const deg = (r.net.nodes || []).slice().sort((a, b) => b.degree - a.degree)[0];
      M.push({
        tag: '网络',
        text: `相关网络：|r| ≥ ${r.meta.params.netThreshold} 剪枝后保留 <b>${r.net.edges.length}</b> 条边` +
          (deg ? `；连接最多的是「${esc(deg.id)}」（度 ${deg.degree}，强度 ${(deg.strength || 0).toFixed(2)}）` : '') +
          `。<span class="muted">网络是相关结构，边不代表因果方向。</span>`
      });
    }

    if (r.bn) {
      if (r.bnError) {
        M.push({ tag: 'BN', text: `贝叶斯网络：结构已学出 ${r.bn.edges.length} 条边，但精确推断不可用 —— ${esc(r.bnError)}` });
      } else {
        M.push({
          tag: 'BN',
          text: `贝叶斯网络：${r.bn.edges.length} 条有向边，联合状态空间 ${r.stateSpace ? r.stateSpace.readable : '?'}` +
            `（上限 ${r.stateSpace ? r.stateSpace.limit.toLocaleString() : '?'}），可做条件概率与敏感性。` +
            `<span class="muted">P(Y|X) 是条件概率，不等于干预效应 P(Y|do(X))。</span>`
        });
      }
    }

    if (r.sens && r.sens.length) {
      const lv = r.calibration.target.levels - 1;
      const scored = r.sens.map(({ f, rows }) => ({
        f, spread: Math.max(...rows.map(x => x.posterior[lv])) - Math.min(...rows.map(x => x.posterior[lv]))
      })).sort((a, b) => b.spread - a.spread);
      if (scored[0] && scored[0].spread > 0) {
        M.push({
          tag: '条件概率',
          text: `在给定网络下，固定「${esc(scored[0].f)}」在不同等级时，` +
            `${esc(tgt)} 最高档的后验概率相差 <b>${(scored[0].spread * 100).toFixed(1)}</b> 个百分点。` +
            `<span class="muted">这是条件依赖，不是「某个变量最关键」。</span>`
        });
      }
    }

    const prm = r.meta.params || {};
    const bits = [];
    if (prm.lowPct != null && prm.highPct != null) bits.push(`云校准：${prm.lowPct}/${prm.highPct} 分位、${prm.levels || '?'} 级、${prm.drops || '?'} 次云滴`);
    if (prm.k != null) bits.push(`聚类：KMeans++ k=${prm.k}`);
    if (prm.treeDepth != null) {
      bits.push(`树：CART(Gini) 深度 ${prm.treeDepth}` + (prm.minLeaf != null ? `、最小叶 ${prm.minLeaf}` : ''));
    }
    if (prm.netThreshold != null) bits.push(`网络 |r| ≥ ${prm.netThreshold}`);
    if (prm.seed != null) bits.push(`随机种子 ${prm.seed}`);
    M.push({
      tag: '口径',
      text: bits.join('；') + '。<span class="muted">同参数同种子可复算。</span>'
    });

    return M;
  }

  function updateSummary() {
    const box = $('#summary');
    if (!box) return;
    const r = S.res;
    if (!r) { box.style.display = 'none'; return; }
    box.style.display = '';

    const F = buildFindings(r);
    const M = buildMechanism(r);

    let html = '<h4>结论摘要 · 自动生成（数字全部来自本地计算）</h4>';
    html += '<div style="font-size:11.5px;color:var(--dim);margin:2px 0 6px">观察 · 这批数据支持什么、不支持什么</div>';
    html += '<ul>' + F.map(x => `<li><b style="color:var(--acc2)">${x.tag}</b>　${x.text}</li>`).join('') + '</ul>';
    if (M.length) {
      html += '<div style="font-size:11.5px;color:var(--dim);margin:10px 0 6px">机制 · 具体规则与计算口径</div>';
      html += '<ul>' + M.map(x => `<li><b style="color:var(--acc2)">${x.tag}</b>　${x.text}</li>`).join('') + '</ul>';
    }
    box.innerHTML = html;

    const nEv = (r.evidence || []).length;
    if (nEv) {
      const bar = el('div', { style: 'margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap' });
      const b = el('button', { class: 'ghost mini', text: `ⓘ 查看证据表（${nEv} 项）` });
      b.onclick = () => { setTab('report'); scrollTop(); };
      bar.appendChild(b);
      const bad = (r.evidence || []).filter(e => !e.valid).length;
      if (bad) bar.appendChild(el('span', { class: 'muted', style: 'font-size:11.5px',
        text: `${bad} 项不可用（未运行/超限），摘要里不会编造这些数` }));
      box.appendChild(bar);
    }
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
    // 只有真正依赖 DAC 主分析结果的页签才需要 S.res；
    // 数据质量 / 统计建模 / Bootstrap 是独立功能，不该被挡住
    // AI 页不依赖主分析：可以先配置接口、问方法论问题（复核报告第六节要求）
    const NEEDS_RES = ['corr', 'calib', 'scene', 'rules', 'net', 'bn', 'robust', 'report'];
    if (!S.res && NEEDS_RES.indexOf(S.tab) >= 0) {
      pane.innerHTML = '<div class="muted">这个页签需要先运行 DAC 分析（第 4 步）。<br>' +
        '若只想做统计建模，切到「统计建模」——它不依赖 DAC 结果。</div>';
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
      case 'glm': return renderGLM();
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
      refreshDerived();
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
      `云模型：Ex = 分位区间中点，En = 半区间/(3×等级数)，He = En/10 —— 三者均按分位数<b>构造</b>，不是从数据估计；He 与 En 成固定比例，不用于变量间排名。云滴 <b>${S.res.meta.params.drops}</b> 次 Monte Carlo。` }));
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

    // 低基数变量：只有 2 个取值却按多等级校准，中间等级必然为空
    const lowCard = names.filter(nm => {
      const j = S.columns.indexOf(nm);
      if (j < 0) return false;
      return new Set(S.rows.map(r2 => r2[j])).size <= 2;
    });
    if (lowCard.length) {
      pane.appendChild(el('div', { class: 'hint',
        style: 'border-color:#5a4a2a;color:#f5c66b;margin-top:10px', html:
        `<b>${lowCard.length} 个变量只有 2 个取值</b>（${lowCard.map(esc).join('、')}），` +
        '本质是分类变量，不该被切成「低/中/高」——中间等级必然为空。这不是数据错误，是方法不适用。<br>' +
        '· 已在统计建模里自动按二分类处理（2 级）<br>' +
        '· 若要做分类判别，用「统计建模 → Binomial 逻辑回归」比云等级更合适' }));
    }
    pane.appendChild(el('div', { class: 'muted', style: 'margin-top:8px;font-size:11.5px', html:
      '歧义率 = 隶属度前两名之差 < 0.1 的比例；越高说明该变量越难被清晰分级。' }));

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
      const tr = el('tr', { html:
        `<td>${esc(s.name)}</td>
         <td style="text-align:left"><span class="pill ok">${esc(nm.tag || '-')}</span> <span class="muted">${esc(nm.perf || '')}</span></td>
         <td>${s.n}</td>` +
        S.res.meta.factors.map(f => `<td>${fmt(s.mean[f], 2)}</td>`).join('') +
        // 无序类别不显示目标均值：类别均值取决于编码，没有解释意义
        (tgtInfo(S.res).nominal
          ? `<td><span class="muted">类别目标<br>不判高低</span></td>`
          : `<td><b>${fmt(s.mean[S.res.meta.target], 3)}</b></td>`) + `</tr>` });
      // 下钻：列出该情境的稳定 rowId，可筛选、可导出
      const td = el('td');
      const bD = el('button', { class: 'ghost mini', text: `查看样本(${s.n})` });
      const drill = el('div', { style: 'display:none;margin:6px 0 10px' });
      bD.onclick = () => {
        const show = drill.style.display === 'none';
        drill.style.display = show ? '' : 'none';
        if (!show || drill.dataset.built) return;
        drill.dataset.built = '1';
        const ids = s.rowIds || [];
        const inp = el('input', { placeholder: '按 rowId 过滤，逗号分隔或范围如 1-20', style: 'width:100%;margin-bottom:6px' });
        const cnt = el('div', { class: 'muted', style: 'margin-bottom:6px' });
        const t = el('table');
        const head = ['rowId', S.res.meta.target, ...S.res.meta.factors];
        t.appendChild(el('thead', { html: '<tr>' + head.map(h => `<th>${esc(h)}</th>`).join('') + '</tr>' }));
        const tb = el('tbody');
        t.appendChild(tb);
        const draw = () => {
          const txt = inp.value.trim();
          let keepIdx = new Set(ids);
          if (txt) {
            const want = new Set();
            txt.split(',').forEach(seg => {
              seg = seg.trim();
              const m2 = seg.match(/^(\d+)\s*-\s*(\d+)$/);
              if (m2) { for (let k = +m2[1]; k <= +m2[2]; k++) want.add(k); }
              else if (seg) want.add(+seg);
            });
            keepIdx = new Set(ids.filter(x => want.has(x)));
          }
          tb.innerHTML = '';
          const meta = S.res.meta;
          // rowId → 原始行下标
          const id2raw = new Map();
          (meta.rowIds || []).forEach((rid, k) => id2raw.set(rid, meta.keepRawIdx[k]));
          Array.from(keepIdx).slice(0, 200).forEach(rid => {
            const raw = id2raw.get(rid);
            const row = raw === undefined ? null : S.rows[raw];
            tb.appendChild(el('tr', { html: `<td>${rid}</td>` + (row
              ? head.slice(1).map(h => {
                  const j = S.columns.indexOf(h);
                  const v = j < 0 ? '' : row[j];
                  return `<td>${v === null ? '<span class="muted">∅</span>' : esc(String(v)).slice(0, 18)}</td>`;
                }).join('')
              : '<td colspan="9" class="muted">原始行不可用</td>') }));
          });
          cnt.textContent = `匹配 ${keepIdx.size} 条` + (keepIdx.size > 200 ? '（只显示前 200 条，导出为全部）' : '');
        };
        const bExp = el('button', { class: 'ghost mini', text: '导出这些样本 CSV' });
        bExp.onclick = () => {
          const ids2 = Array.from(new Set((s.rowIds || []))).filter(x => {
            const txt = inp.value.trim();
            if (!txt) return true;
            let hit = false;
            txt.split(',').forEach(seg => {
              seg = seg.trim();
              const m2 = seg.match(/^(\d+)\s*-\s*(\d+)$/);
              if (m2) { if (x >= +m2[1] && x <= +m2[2]) hit = true; }
              else if (+seg === x) hit = true;
            });
            return hit;
          });
          const meta = S.res.meta;
          const id2raw = new Map();
          (meta.rowIds || []).forEach((rid, k) => id2raw.set(rid, meta.keepRawIdx[k]));
          const head2 = ['rowId', ...S.columns];
          const rows2 = ids2.map(rid => {
            const raw = id2raw.get(rid);
            return [rid].concat(raw === undefined ? [] : S.rows[raw].slice());
          });
          const csv = C.toCSV(head2, rows2);
          download(`情境${s.name}_样本_${stamp()}.csv`, '﻿' + csv, 'text/csv');
          toast(`已导出 ${ids2.length} 条样本`);
        };
        inp.oninput = draw;
        drill.appendChild(inp);
        drill.appendChild(cnt);
        drill.appendChild(bExp);
        drill.appendChild(t);
        draw();
      };
      td.appendChild(bD);
      tr.appendChild(td);
      b.appendChild(tr);
      if (s.rowIds && s.rowIds.length) {
        const tr2 = el('tr');
        const td2 = el('td', { colspan: String(S.columns.length + 3) });
        td2.appendChild(drill);
        tr2.appendChild(td2);
        b.appendChild(tr2);
      }
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
      pane.innerHTML = '<div class="muted">贝叶斯网络未生成。</div>' +
        (r.bnError ? `<div class="hint" style="border-color:#5a2020;color:#fca5a5;margin-top:10px">${esc(r.bnError)}</div>` : '');
      return;
    }
    const bn = r.bn, names = bn.names, levels = bn.levels, L = r.calibration.labels;
    pane.innerHTML = '';
    pane.appendChild(el('div', { class: 'muted', html:
      `结构学习：爬山法 + BIC 评分（父节点上限 2）；参数学习：极大似然 + 拉普拉斯平滑。
       共 <b>${bn.edges.length}</b> 条有向边。` }));

    // 联合状态空间：结构可学，但超过上限时精确推断不可用，必须说清楚
    if (r.bnError) {
      pane.appendChild(el('div', { class: 'hint',
        style: 'border-color:#5a2020;color:#fca5a5;margin-top:10px', html:
        '<b>⚠ 精确推断不可用（结构已保留）</b><br>' + esc(r.bnError) }));
    } else if (r.stateSpace && r.stateSpace.ok) {
      pane.appendChild(el('div', { class: 'muted', style: 'margin-top:6px;font-size:11.5px', html:
        `联合状态空间 ${r.stateSpace.readable}（${r.stateSpace.vars} 变量 × ${r.stateSpace.levels} 状态），` +
        `在上限 ${r.stateSpace.limit.toLocaleString()} 以内，条件概率与敏感性可用。` }));
    }

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
      ? ['ok', '多次扰动后主规则方向一致——这是参数敏感性下的初步一致性，不等于统计显著性，也不等于可外推。']
      : changed <= 2
        ? ['warn', `${changed} 个变体改变了主规则方向——需要在论文里说明参数敏感性。`]
        : ['bad', `${changed} 个变体改变了主规则——结论不稳，建议重新考虑分位点或变量选择。`];
    pane.appendChild(el('div', { class: 'rule', style: 'margin-top:14px;border-left-color:' +
      (verdict[0] === 'ok' ? '#34d399' : verdict[0] === 'warn' ? '#f59e0b' : '#ef4444'),
      html: `<span class="pill ${verdict[0]}">稳健性判定</span> ${verdict[1]}` }));
    pane.appendChild(el('div', { class: 'muted', style: 'margin-top:8px',
      text: '这就是审稿人最常问的那句“换个参数结论还成立吗”，现在一键就能回答。' }));
  }




  /* ---------------- 统计建模（GLM） ---------------- */
  /**
   * 按目标类型推荐 GLM 分布。
   * 关键：多类无序目标没有对应的单参数 GLM —— 不推荐任何分布，返回 null，
   * 由 fit 阶段的适用性检查给出明确拒绝，而不是静默套 gaussian。
   */
  function recommendFamily(t) {
    if (!t) return 'gaussian';
    if (t.type === 'binary') return 'binomial';
    if (t.type === 'count') return 'poisson';
    if (t.type === 'categorical' || t.type === 'nominal') return null;   // K>2 类：不适用
    if (t.type === 'ordinal') return null;                                // 有序：应走有序模型
    return 'gaussian';
  }

  /**
   * GLM 适用性检查。返回 {ok, reason, hints[]}。
   * 宁可不给数，也不给一个方法上不成立的数。
   */
  function glmApplicability(yv, t, family) {
    const uniq = Array.from(new Set(yv.filter(Number.isFinite))).sort((a, b) => a - b);
    const K = uniq.length;
    const hints = [];
    if (K <= 1) {
      return { ok: false, reason: `目标只有 ${K} 个不同取值，无法做回归`, hints };
    }
    if (K === 2) {
      // 二分类：binomial 正确；gaussian/poisson 也能算但不推荐
      if (family && family !== 'binomial') {
        return {
          ok: true,
          warn: `目标是二分类，当前用 ${family}；通常应选 Binomial（logit）`,
          hints
        };
      }
      return { ok: true, hints };
    }
    // K > 2
    if (t && (t.type === 'categorical' || t.type === 'nominal')) {
      hints.push(`把 ${K} 个类别当成连续值回归，等于假设"类别 1 和类别 2 的距离等于类别 2 和类别 3"——这个假设没有依据。`);
      hints.push('可行做法：①在「变量角色」里把目标改成二分类（指定一个正类）；②改用多项 logit（本工具未实现）；③若类别本身有序，用有序 logit（本工具未实现）。');
      return { ok: false, reason: `目标是无序类别（${K} 类），单参数 GLM 不适用`, hints };
    }
    if (t && t.type === 'ordinal') {
      hints.push(`这 ${K} 个等级是有序的，但普通 gaussian 回归假设"等级间隔相等"，通常不成立。`);
      hints.push('可行做法：①按业务含义合并成二分类；②用有序 logit（本工具未实现）。若你接受"间隔相等"的近似，可以继续，但结论要标注这个假设。');
      return { ok: true, warn: `目标是有序等级（${K} 级），gaussian 假设等级间隔相等`, hints };
    }
    // count / continuous 但取值少
    if (K <= 5 && t && t.type === 'count') {
      hints.push(`${K} 个取值的计数目标，Poisson 可以，但样本稀疏时标准误可能偏大。`);
    }
    return { ok: true, hints };
  }

  function glmState() {
    if (!S.extra.glm) {
      S.extra.glm = { family: 'gaussian', response: '', xvars: [], reference: {}, fit: null, error: null, roc: null, cm: null, weightCol: '' };
    }
    return S.extra.glm;
  }

  function renderGLM() {
    const pane = $('#pane');
    const G = window.DACGLM;
    pane.innerHTML = '';
    if (!G) { pane.innerHTML = '<div class="muted">GLM 模块未加载。</div>'; return; }
    if (!S.rows.length) { pane.innerHTML = '<div class="muted">先导入数据。</div>'; return; }
    const q = glmState();
    if (q.weightCol === undefined) q.weightCol = '';

    pane.appendChild(el('div', { class: 'muted', html:
      '这里做的是 <b>统计推断</b>：参数估计、标准误、显著性、OR/IRR。' +
      '和 DAC 的探索性分析不同，GLM 会给出<b>总体参数</b>的推断区间。' }));

    /* 目标变量类型提示 */
    const types = {};
    S.columns.forEach((c, j) => {
      types[c] = C.detectTargetType(S.rows.map(r => r[j]));
    });

    /* 分布本身的数值风险（例如 Gamma inverse 的固有病态） */
    if (q.family && C.FAMILIES && C.FAMILIES[q.family] && C.FAMILIES[q.family].caveat) {
      const cb = el('div', { class: 'hint', style: 'margin:8px 0;border-color:#5a4a1a' });
      cb.innerHTML = '<b>⚠ ' + esc(C.FAMILIES[q.family].name) + ' 的数值风险</b>：'
        + esc(C.FAMILIES[q.family].caveat);
      pane.appendChild(cb);
    }

    /* 适用性提示：先把"能不能这么算"说清楚，再让人算 */
    if (S.res && S.res.meta && S.res.meta.target) {
      const tt = types[S.res.meta.target];
      if (tt) {
        const yvNow = S.rows.map(r => r[S.columns.indexOf(S.res.meta.target)]);
        const appNow = glmApplicability(yvNow, tt, q.family);
        if (!appNow.ok || appNow.warn) {
          const box = el('div', { class: 'hint', style: 'margin:10px 0;border-color:' + (appNow.ok ? '#5a4a1a' : '#7a2a2a') });
          box.innerHTML = '<b>' + (appNow.ok ? '⚠ 需要注意' : '✖ 当前目标不适合直接拟合') + '</b>：'
            + esc(appNow.reason || appNow.warn || '')
            + (appNow.hints && appNow.hints.length
              ? '<div class="muted" style="margin-top:6px">' + appNow.hints.map(h => '· ' + esc(h)).join('<br>') + '</div>'
              : '');
          pane.appendChild(box);
        }
      }
    }

    /* 选择 */
    const grid = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap;margin:12px 0' });
    const cell = (label, node, w) => el('div', { style: 'width:' + (w || 200) + 'px' },
      [el('div', { class: 'muted', text: label }), node]);

    const selResp = el('select', {});
    selResp.appendChild(el('option', { value: '', text: '— 选择目标变量 —' }));
    // 自变量也默认跟随主分析：用户在主分析里选过哪些因子，GLM 就用哪些
    if (!q.xvars.length && S.res && S.res.meta && Array.isArray(S.res.meta.factors)) {
      q.xvars = S.res.meta.factors.filter(f => f !== S.res.meta.target && S.numeric.indexOf(f) >= 0);
    }
    // 主分析已经确定了目标变量，GLM 不该再让用户重选一次
    if (!q.response && S.res && S.res.meta && S.res.meta.target && S.numeric.indexOf(S.res.meta.target) >= 0) {
      q.response = S.res.meta.target;
      const tt = types[q.response];
      if (tt) {
        q.family = recommendFamily(tt);
      }
    }
    S.numeric.forEach(c => {
      const t = types[c];
      const o = el('option', { value: c, text: `${c}（${t.type}）` });
      if (q.response === c) o.selected = true;
      selResp.appendChild(o);
    });
    selResp.onchange = () => {
      q.response = selResp.value;
      q.fit = null; q.error = null; q.roc = null; q.cm = null;
      // 自动推荐分布
      const t = types[q.response];
      if (t) {
        q.family = recommendFamily(t);
      }
      renderGLM();
    };

    const selFam = el('select', {});
    [['gaussian', 'Gaussian（正态 · identity）'],
     ['binomial', 'Binomial（二项 · logit）'],
     ['poisson', 'Poisson（泊松 · log）'],
     ['gamma', 'Gamma（伽马 · log）'],
     ['gamma-inverse', 'Gamma（伽马 · inverse）'],
     ['negbin', '负二项（log，θ 自动估计）']]
      .forEach(([v, l]) => { const o = el('option', { value: v, text: l }); if (q.family === v) o.selected = true; selFam.appendChild(o); });
    selFam.onchange = () => { q.family = selFam.value; q.fit = null; renderGLM(); };

    // 权重列（可选）：频率权重 = 该样本代表多少个体
    const selW = el('select', {});
    selW.appendChild(el('option', { value: '', text: '（不加权）' }));
    S.numeric.forEach(c => {
      const o = el('option', { value: c, text: c });
      if (q.weightCol === c) o.selected = true;
      selW.appendChild(o);
    });
    selW.onchange = () => { q.weightCol = selW.value; q.fit = null; };

    grid.appendChild(cell('目标变量', selResp, 240));
    grid.appendChild(cell('分布 / 链接', selFam, 280));
    grid.appendChild(cell('权重列（可选）', selW, 170));
    pane.appendChild(grid);

    if (q.response && types[q.response]) {
      const t = types[q.response];
      pane.appendChild(el('div', { class: 'hint', html:
        `<b>识别依据</b>：${esc(t.reason)}` +
        (q.family === 'binomial' && t.type !== 'binary' ? '<br><span style="color:#f59e0b">⚠ 当前目标不是二分类，Binomial 会拒绝拟合</span>' : '') +
        (q.family === 'poisson' && t.type !== 'count' ? '<br><span style="color:#f59e0b">⚠ 当前目标不像计数变量，Poisson 要求非负整数</span>' : '') }));
    }

    /* 自变量 */
    pane.appendChild(el('h3', { text: '自变量', style: 'margin-top:14px' }));
    const box = el('div', { style: 'border:1px solid var(--line);border-radius:8px;padding:8px;max-height:200px;overflow:auto' });
    S.numeric.filter(c => c !== q.response).forEach(c => {
      const t = types[c];
      const isCat = (t.type === 'categorical' || t.type === 'binary');
      const row = el('label', { class: 'row', style: 'justify-content:flex-start;gap:8px;margin:3px 0' });
      const chk = el('input', { type: 'checkbox' });
      chk.checked = q.xvars.includes(c);
      chk.onchange = () => {
        if (chk.checked) { if (!q.xvars.includes(c)) q.xvars.push(c); }
        else q.xvars = q.xvars.filter(v => v !== c);
        q.fit = null;
      };
      row.appendChild(chk);
      row.appendChild(el('span', { text: c }));
      row.appendChild(el('span', { class: 'pill ' + (isCat ? 'warn' : 'ok'),
        text: isCat ? `分类(${t.levels.length})` : '数值' }));
      box.appendChild(row);
    });
    pane.appendChild(box);

    /* 参考类别（分类自变量） */
    const catVars = q.xvars.filter(c => types[c] && (types[c].type === 'categorical' || types[c].type === 'binary'));
    if (catVars.length) {
      pane.appendChild(el('h3', { text: '参考类别（哑变量基准）', style: 'margin-top:14px' }));
      const rbox = el('div', { style: 'display:flex;gap:10px;flex-wrap:wrap' });
      catVars.forEach(c => {
        const sel = el('select', { style: 'font-size:12px;padding:3px 6px' });
        types[c].levels.forEach(lv => {
          const o = el('option', { value: String(lv), text: String(lv) });
          if (String(q.reference[c]) === String(lv)) o.selected = true;
          sel.appendChild(o);
        });
        sel.onchange = () => { q.reference[c] = sel.value; q.fit = null; };
        rbox.appendChild(el('div', {}, [el('div', { class: 'muted', style: 'font-size:11px', text: c }), sel]));
      });
      pane.appendChild(rbox);
    }

    /* 拟合 */
    const runRow = el('div', { style: 'display:flex;gap:8px;margin:14px 0;align-items:center' });
    const btn = el('button', { class: 'mini', text: '拟合模型' });
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = '拟合中…';
      setBusy(true, 'GLM 拟合中…');
      q.error = null;
      try {
        const idxT = S.columns.indexOf(q.response);
        if (idxT < 0) throw new Error(`目标变量「${q.response || '(未选)'}」不在当前数据里，请重新选择`);
        const yv = S.rows.map(r => r[idxT]);
        const badY = yv.findIndex(v => !Number.isFinite(v));
        if (badY >= 0) throw new Error(`目标变量第 ${badY + 1} 行不是有效数值：${JSON.stringify(yv[badY])}（GLM 要求因变量为数值）`);

        // 适用性检查：方法上不成立就不给数
        const app = glmApplicability(yv, types[q.response], q.family);
        q.applicability = app;
        if (!app.ok) {
          const detail = [app.reason].concat(app.hints || []).join('\n· ');
          throw new Error(detail);
        }
        const numCols = [], catCols = [];
        q.xvars.forEach(c => {
          const j = S.columns.indexOf(c);
          const t = types[c];
          if (t.type === 'categorical' || t.type === 'binary') {
            catCols.push({ name: c, idx: j, levels: t.levels.map(String), reference: q.reference[c] !== undefined ? String(q.reference[c]) : String(t.levels[0]) });
          } else {
            numCols.push({ name: c, idx: j });
          }
        });
        const family = q.family || selFam.value || 'gaussian';
        let wts = null;
        if (q.weightCol) {
          const wi = S.columns.indexOf(q.weightCol);
          if (wi < 0) throw new Error(`权重列「${q.weightCol}」不在当前数据里`);
          wts = rowsUse.map(r => r[wi]);
          if (wts.some(v => !Number.isFinite(v) || v <= 0)) {
            throw new Error('权重列必须全部为有限的正数');
          }
        }
        const payload = { rows: S.rows, y: yv, spec: { numCols, catCols }, family, weights: wts };
        // GLM 在主线程执行：样本量通常在千级以内，IRLS 只要几十毫秒；
        // 走 Worker 反而要克隆整张数据表，得不偿失
        if (!numCols.length && !catCols.length) throw new Error('至少选择一个自变量');

        // 缺失值处理：GLM 不做隐式删除，必须先补齐并记录
        const usedIdx = [idxT].concat(numCols.map(c => c.idx), catCols.map(c => c.idx));
        const isNull = v => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));
        let missCells = 0, missRows = 0;
        S.rows.forEach(r => {
          let rowHas = false;
          usedIdx.forEach(j => { if (isNull(r[j])) { missCells++; rowHas = true; } });
          if (rowHas) missRows++;
        });
        let rowsUse = S.rows;
        if (missCells > 0) {
          // 只用训练数据（此处为全量描述性建模）拟合填补器；分类列自动转众数
          const P = window.DACPre;
          if (!P) throw new Error('预处理模块未加载，无法处理缺失值');
          const im = P.fitImputer(S.rows, S.columns, { strategy: 'median', fallback: 'median' });
          rowsUse = P.transformImputer(S.rows, im, S.rows).matrix;
          const still = rowsUse.some(r => usedIdx.some(j => isNull(r[j])));
          if (still) throw new Error('填补后仍有缺失（该列可能整列为空），请先剔除该变量');
        }
        payload.rows = rowsUse;

        // 填补后再做数值校验
        for (const c of numCols) {
          const bad = rowsUse.findIndex(r => !Number.isFinite(r[c.idx]));
          if (bad >= 0) throw new Error(`变量「${c.name}」第 ${bad + 1} 行不是有效数值（${JSON.stringify(rowsUse[bad][c.idx])}）`);
        }
        const res = G.fit(payload);
        res.imputeInfo = missCells > 0
          ? { cells: missCells, rows: missRows, method: '中位数（分类列用众数）' }
          : null;
        q.fit = res;
      refreshDerived();   // GLM 完成也让证据表/报告同步
        if (family === 'binomial') {
          q.roc = G.roc(yv, res.mu);
          q.cm = G.confusion(yv, res.mu, q.roc.best.thr);
        }
      } catch (e) {
        q.error = e.message;
        q.fit = null;
      }
      setBusy(false, '就绪');
      btn.disabled = false; btn.textContent = '拟合模型';
      renderGLM();
    };
    runRow.appendChild(btn);
    pane.appendChild(runRow);

    if (q.error) {
      pane.appendChild(el('div', { class: 'hint', style: 'border-color:#5a2020;color:#fca5a5', text: '拟合失败：' + q.error }));
      return;
    }
    const f = q.fit;
    if (!f) return;

    /* 警告 */
    if (f.warnings && f.warnings.length) {
      f.warnings.forEach(w => {
        const isErr = w.level === 'error';
        pane.appendChild(el('div', { class: 'hint', style:
          'border-color:' + (isErr ? '#5a2020' : '#5a4a1a') + ';color:' + (isErr ? '#fca5a5' : '#f5c66b'),
          html: `<b>${isErr ? '⛔ 统计假设不成立' : '⚠ 注意'}</b>：${esc(w.text)}` }));
      });
    }

    /* 缺失值提示 */
    if (f.imputeInfo) {
      pane.appendChild(el('div', { class: 'hint', style: 'border-color:#5a4a1a;color:#f5c66b', html:
        `<b>缺失值已填补</b>：涉及 ${f.imputeInfo.cells} 个单元格 / ${f.imputeInfo.rows} 行，` +
        `策略 = ${esc(f.imputeInfo.method)}。<br>` +
        '<span class="muted">GLM 不做隐式删除——填补会低估标准误，样本缺失较多时结论宜保守。' +
        '若要严格起见，请先导出填补后的数据或改用完整案例。</span>' }));
    }

    /* 拟合摘要 */
    pane.appendChild(el('h3', { text: '模型摘要', style: 'margin-top:16px' }));
    const stats = [
      ['样本量 n', f.n], ['参数数 p', f.p], ['残差自由度', f.dfResid],
      ['收敛', f.converged ? '是（' + f.iterations + ' 次迭代）' : '否'],
      ['Deviance', f.deviance.toFixed(4)], ['Null deviance', f.nullDeviance.toFixed(4)],
      ['AIC', f.aic.toFixed(2)], ['BIC', f.bic.toFixed(2)],
      ['Pearson χ²', f.pearson.toFixed(2)],
      ['离散参数', f.dispersion.toFixed(4)]
    ];
    if (f.theta != null) stats.push(['NB 离散参数 θ', f.theta.toFixed(3)]);
    if (f.weighted) stats.push(['加权', '是（频率权重）']);
    if (f.r2 != null) stats.push(['R²', f.r2.toFixed(4)]);
    if (f.r2adj != null) stats.push(['调整 R²', f.r2adj.toFixed(4)]);
    if (f.rmse != null) stats.push(['RMSE', f.rmse.toFixed(4)]);
    const st = el('div', { class: 'stat' });
    stats.forEach(([k, v]) => st.appendChild(el('div', { html: `<span>${esc(k)}</span><b>${esc(String(v))}</b>` })));
    pane.appendChild(st);

    /* 系数表 */
    pane.appendChild(el('h3', { text: '系数', style: 'margin-top:18px' }));
    const isOR = f.family === 'binomial';
    const isIRR = f.family === 'poisson';
    const tb = el('table');
    tb.appendChild(el('thead', { html: '<tr><th>变量</th><th>估计</th><th>标准误</th><th>' +
      (f.family === 'gaussian' ? 't' : 'z') + '</th><th>p 值</th><th>95% CI</th>' +
      (isOR ? '<th>OR</th><th>OR 95% CI</th>' : '') + (isIRR ? '<th>IRR</th><th>IRR 95% CI</th>' : '') + '</tr>' }));
    const tb2 = el('tbody');
    f.coef.forEach(c => {
      const sig = c.p < 0.001 ? '***' : c.p < 0.01 ? '**' : c.p < 0.05 ? '*' : '';
      tb2.appendChild(el('tr', { html:
        `<td style="text-align:left">${esc(c.name)}</td>
         <td>${c.est.toFixed(4)}</td>
         <td>${c.se.toFixed(4)}</td>
         <td>${Number.isFinite(c.stat) ? c.stat.toFixed(2) : '-'}</td>
         <td style="color:${c.p < 0.05 ? '#34d399' : 'var(--dim)'}">${c.p < 0.0001 ? '<0.0001' : c.p.toFixed(4)} ${sig}</td>
         <td>[${c.lo.toFixed(3)}, ${c.hi.toFixed(3)}]</td>` +
        (isOR ? `<td><b>${c.exp.toFixed(3)}</b></td><td>[${c.expLo.toFixed(3)}, ${c.expHi.toFixed(3)}]</td>` : '') +
        (isIRR ? `<td><b>${c.exp.toFixed(3)}</b></td><td>[${c.expLo.toFixed(3)}, ${c.expHi.toFixed(3)}]</td>` : '') +
        '</tr>' }));
    });
    tb.appendChild(tb2);
    pane.appendChild(tb);
    pane.appendChild(el('div', { class: 'muted', style: 'margin-top:6px;font-size:11.5px',
      text: '显著性标记：*** p<0.001, ** p<0.01, * p<0.05。p 值基于正态近似（Gaussian 用 t）。' }));

    /* 编码说明 */
    if (f.codings && f.codings.length) {
      pane.appendChild(el('h3', { text: '分类变量编码', style: 'margin-top:16px' }));
      const t2 = el('table');
      t2.appendChild(el('thead', { html: '<tr><th>变量</th><th>参考类别</th><th>哑变量</th></tr>' }));
      const b2 = el('tbody');
      f.codings.forEach(c => b2.appendChild(el('tr', { html:
        `<td>${esc(c.name)}</td><td>${esc(c.reference)}</td><td>${c.dummies.map(d => esc(d)).join('、')}</td>` })));
      t2.appendChild(b2);
      pane.appendChild(t2);
    }

    /* 森林图（OR / IRR） */
    if (isOR || isIRR) {
      const terms = f.coef.slice(1).filter(c => Number.isFinite(c.exp));
      if (terms.length) {
        const W = 660, H = 40 + terms.length * 26, padL = 150, padR = 40;
        const g = mkSvg(W, H);
        const lo = Math.min(...terms.map(t => t.expLo), 0.5);
        const hi = Math.max(...terms.map(t => t.expHi), 2);
        const sx = v => padL + (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * (W - padL - padR);
        // 参考线 x=1
        g.appendChild(mkLine(sx(1), 20, sx(1), H - 12, '#3a5570', 1, '4 3'));
        g.appendChild(mkText(sx(1), H - 1, '1', '#5d7387', 10, 'middle'));
        terms.forEach((t, i) => {
          const y = 32 + i * 26;
          g.appendChild(mkText(padL - 8, y + 4, t.name, '#8aa0b4', 11, 'end'));
          g.appendChild(mkLine(sx(t.expLo), y, sx(t.expHi), y, '#4c9aff', 1.6));
          g.appendChild(mkCircle(sx(t.exp), y, 4.5, t.p < 0.05 ? '#34d399' : '#5d7387'));
          g.appendChild(mkText(W - padR + 6, y + 4, t.exp.toFixed(2), '#8aa0b4', 11, 'start'));
        });
        pane.appendChild(el('h3', { text: (isOR ? 'OR' : 'IRR') + ' 森林图（对数刻度）', style: 'margin-top:18px' }));
        pane.appendChild(g);
        pane.appendChild(el('div', { class: 'muted', style: 'margin-top:4px;text-align:center',
          text: '横线 = 95% 置信区间；点 = 点估计；绿色 = p<0.05；竖虚线 = 无效线（1）' }));
      }
    }

    /* Logistic：ROC + 混淆矩阵 */
    if (q.roc && q.cm) {
      pane.appendChild(el('h3', { text: '判别能力（Logistic）', style: 'margin-top:18px' }));
      pane.appendChild(el('div', { class: 'stat' }, [
        el('div', { html: `<span>AUC</span><b>${q.roc.auc.toFixed(3)}</b>` }),
        el('div', { html: `<span>最佳阈值</span><b>${q.roc.best.thr.toFixed(3)}</b>` }),
        el('div', { html: `<span>准确率</span><b>${(q.cm.acc * 100).toFixed(1)}%</b>` }),
        el('div', { html: `<span>敏感度 / 特异度</span><b>${(q.cm.sens * 100).toFixed(1)}% / ${(q.cm.spec * 100).toFixed(1)}%</b>` })
      ]));
      const W2 = 380, H2 = 300, pad2 = 40;
      const g2 = mkSvg(W2, H2);
      g2.appendChild(mkLine(pad2, H2 - pad2, W2 - pad2, H2 - pad2, '#3a5570'));
      g2.appendChild(mkLine(pad2, pad2, pad2, H2 - pad2, '#3a5570'));
      g2.appendChild(mkLine(pad2, H2 - pad2, W2 - pad2, pad2, '#22313f', 1, '3 3'));
      let d = '';
      q.roc.points.forEach((p, i) => {
        const x = pad2 + p.fpr * (W2 - pad2 * 2);
        const y = H2 - pad2 - p.tpr * (H2 - pad2 * 2);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
      });
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#4c9aff');
      path.setAttribute('stroke-width', '2');
      g2.appendChild(path);
      g2.appendChild(mkText(W2 / 2, H2 - 8, 'False Positive Rate', '#8aa0b4', 10, 'middle'));
      g2.appendChild(mkText(12, pad2 - 12, 'TPR', '#8aa0b4', 10, 'start'));
      g2.appendChild(mkText(W2 - pad2, pad2 - 8, `AUC ${q.roc.auc.toFixed(3)}`, '#34d399', 11, 'end'));
      pane.appendChild(el('div', { style: 'display:flex;gap:20px;flex-wrap:wrap;margin-top:10px' }, [g2]));

      const t3 = el('table');
      t3.appendChild(el('thead', { html: '<tr><th>真实 \\ 预测</th><th>0</th><th>1</th></tr>' }));
      const b3 = el('tbody');
      [[0, '0', q.cm.tn, q.cm.fn], [1, '1', q.cm.fp, q.cm.tp]].forEach(([_, lab, a2, b2]) => {
        b3.appendChild(el('tr', { html: `<td>${lab}</td><td style="color:${a2 ? '#34d399' : '#5d7387'}">${a2}</td><td style="color:${b2 ? '#34d399' : '#5d7387'}">${b2}</td>` }));
      });
      t3.appendChild(b3);
      pane.appendChild(t3);
    }

    /* VIF */
    if (f.diagnostics && f.diagnostics.vif && f.diagnostics.vif.length) {
      const vs = f.diagnostics.vif.filter(v => Number.isFinite(v.vif));
      if (vs.length) {
        pane.appendChild(el('h3', { text: '共线性（VIF）', style: 'margin-top:16px' }));
        const t4 = el('table');
        t4.appendChild(el('thead', { html: '<tr><th>变量</th><th>VIF</th><th>判读</th></tr>' }));
        const b4 = el('tbody');
        vs.forEach(v => {
          const tag = v.vif > 10 ? '<span class="pill bad">严重共线</span>'
            : v.vif > 5 ? '<span class="pill warn">需注意</span>' : '<span class="pill ok">正常</span>';
          b4.appendChild(el('tr', { html: `<td>${esc(v.name)}</td><td>${v.vif.toFixed(2)}</td><td>${tag}</td>` }));
        });
        t4.appendChild(b4);
        pane.appendChild(t4);
      }
    }

    pane.appendChild(el('div', { class: 'rule', style: 'margin-top:14px;border-left-color:#4c9aff;cursor:default', html:
      '<b>解释边界</b>：系数反映条件关联（控制其他变量后），<b>不等于因果效应</b>。' +
      '要论证因果，需要随机化、工具变量、DID 或断点回归等识别策略。' }));
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
     ['stratified', '分层 Stratified'], ['weighted', '加权 Weighted（多项重采样）'],
     ['pps', '系统 PPS（按规模等距）'], ['block', '块抽样 Block（时间依赖）']]
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
          weights: wCol ? S.rows.map(r => r[S.columns.indexOf(wCol)]) : null,
          // 分层变量：优先用角色标记为 strata 的列，否则用目标变量的原始类别
          strata: (function () {
            const sCol = S.columns.find(c => S.roles[c] === 'strata');
            if (sCol) return S.rows.map(r => r[S.columns.indexOf(sCol)]);
            const th = S.columns.indexOf(S.target);
            return th >= 0 ? S.rows.map(r => String(r[th])) : null;
          })()
        };
        // 校准参数必须从 UI 传下来，不能在引擎里写死 25/75
        const tgtTypeInfo = (S.res && S.res.meta && S.res.meta.targetType)
          || C.detectTargetType(S.rows.map(r => r[S.columns.indexOf(S.target)]));
        const opt = {
          task: q.task, B: q.B, seed: q.seed, method: q.method, fraction: q.fraction,
          replacement: q.replacement, k: q.k, maxDepth: q.maxDepth,
          levels: S.params.levels || 3, drops: Math.min(200, S.params.drops || 200),
          lowPct: S.params.lowPct, highPct: S.params.highPct,
          targetType: (tgtTypeInfo && tgtTypeInfo.type) || 'continuous',
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
  // cors: true 表示服务端返回 Access-Control-Allow-Origin，浏览器可直连；
  // false 表示浏览器会被 CORS 拦截，必须走中转站。
  // 实测（2026-11）：DeepSeek 返回完整 CORS 头；智谱 open.bigmodel.cn 不返回任何 Access-Control-*。
  const PROVIDERS = {
    deepseek: {
      name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-flash',
      cors: true,    // 实测：返回 Access-Control-Allow-Origin = 当前站点
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
      cors: false,   // 实测：OPTIONS 200 但无 Access-Control-* 头，浏览器无法直连
      models: ['glm-4-flash', 'glm-4.5', 'glm-4.6', 'glm-5', 'glm-5.1', 'glm-5.3-flash'] },
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
    // 故意不回显任何明文字符：截图/录屏/共享屏幕都不会泄漏 Key 片段
    if (!k) return '（未设置）';
    return `已设置 · ${k.length} 位 · ****`;
  }

  /** 本地模板回答：AI 不可用时至少给出可用的四段式，而不是空白 */
  function localTemplateAnswer(r) {
    if (!r) {
      return '【结论】当前还没有分析结果，无法给出数据结论。\n' +
        '【依据】无（主分析未运行）。\n' +
        '【局限】没有结果就没有依据，任何数字都不能引用。\n' +
        '【下一步】先导入数据并运行分析，再问这个问题。';
    }
    const F = buildFindings(r);
    const M = buildMechanism(r);
    const strip = (h) => String(h).replace(/<[^>]+>/g, '');
    const L = [];
    L.push('【结论】以下内容完全由本地计算生成，未经模型改写。');
    L.push('');
    L.push('【依据】');
    F.forEach(x => L.push(`· [${x.tag}] ${strip(x.text)}`));
    L.push('');
    L.push('【局限】');
    L.push('· 以上是相关与条件概率，不是因果效应；P(Y|X) ≠ P(Y|do(X))。');
    L.push('· 稳定性指标（轮廓、ARI、规则频率）不等于监督准确率。');
    if (!RES.strictOk()) L.push('· 严格交叉验证未运行，泛化能力无法断言。');
    L.push('');
    L.push('【下一步】');
    M.slice(0, 3).forEach(x => L.push(`· [${x.tag}] ${strip(x.text)}`));
    L.push('· 若要更稳的结论：跑一次严格 CV，或扩大样本后复算。');
    return L.join('\n');
  }

  /** 检查模型回答是否满足四段式 */
  function checkAnswerFormat(text) {
    const need = ['【结论】', '【依据】', '【局限】', '【下一步】'];
    const missing = need.filter(k => String(text || '').indexOf(k) < 0);
    return { ok: missing.length === 0, missing };
  }

  /**
   * 带重试的调用。
   * - 4xx（Key 错、参数错、模型名错）不重试，重试也没用
   * - 5xx / 超时 / 网络错误重试，退避 800ms → 1600ms
   */
  async function callLLMRetry(messages, opt) {
    const o = Object.assign({ retries: 2, retryDelay: 800 }, opt || {});
    let lastErr = null;
    let bumped = false;
    for (let i = 0; i < o.retries; i++) {
      try {
        return await callLLM(messages, o);
      } catch (e) {
        // 推理模型把 token 全用在 thinking 上：换大上限再试一次（只加一次，避免无限烧 token）
        const msg0 = String(e && e.message || '');
        if (!bumped && /推理过程、正文为空/.test(msg0)) {
          bumped = true;
          o.maxTokens = Math.max(RETRY_MAX_TOKENS, (o.maxTokens || 0));
          i--;                                  // 这一次不算失败
          continue;
        }
        lastErr = e;
        const msg = String(e && e.message || '');
        if (/HTTP 4\d\d/.test(msg)) throw e;                 // 客户端错误，不重试
        if (/没填 API Key/.test(msg)) throw e;
        if (i < o.retries - 1) {
          await new Promise(res => setTimeout(res, o.retryDelay * Math.pow(2, i)));
        }
      }
    }
    throw lastErr;
  }

  /** 各服务商的输出上限（推理型模型需留足 thinking 预算） */
  const MAX_TOKENS_BY_PROVIDER = {
    deepseek: 8000, zhipu: 8000, openai: 8000,
    dashscope: 6000, moonshot: 6000, siliconflow: 6000, relay: 8000, custom: 8000
  };
  // 推理型模型的 thinking 会先吃掉 token；正文为空时用这个上限再试一次
  const RETRY_MAX_TOKENS = 16000;

  /**
   * 调用 OpenAI 兼容接口，返回结构化结果而不是裸字符串。
   * 返回 { content, reasoning, finishReason, usage, requestId, warnings }
   */
  async function callLLM(messages, opt) {
    const c = aiCfg();
    if (!c.key) throw new Error('还没填 API Key（在「接入设置」里填）');
    const prov = c.provider || 'deepseek';
    const base = (c.baseURL || PROVIDERS[prov].base).replace(/\/+$/, '');
    const model = c.model || PROVIDERS[prov].model;
    const o = opt || {};
    const maxTokens = o.maxTokens || MAX_TOKENS_BY_PROVIDER[prov] || 3000;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs || 90000);
    let res;
    try {
      res = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key },
        body: JSON.stringify({
          model, messages,
          temperature: o.temperature === undefined ? 0.2 : o.temperature,
          max_tokens: maxTokens
        }),
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('请求超时（' + Math.round((o.timeoutMs || 90000) / 1000) + 's）或被取消');
      const msg = (e && e.message) ? e.message : String(e);
      if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        const provName = (PROVIDERS[prov] && PROVIDERS[prov].name) || prov;
        const noCors = (PROVIDERS[prov] && PROVIDERS[prov].cors === false);
        throw new Error(
          `网络请求失败（${provName}）：${msg}` +
          (noCors
            ? '\n这是 CORS 拦截，不是 Key 或参数问题：该服务商的接口不返回 Access-Control-Allow-Origin，浏览器无法直连。' +
              '解决办法：① 换成支持跨域的 DeepSeek；② 或配一个允许跨域的中转站（服务商选「relay」并填中转地址）。'
            : '\n可能是网络中断、Base URL 写错，或该服务商不允许浏览器直连（需中转站）。')
        );
      }
      throw new Error('网络请求失败：' + msg);
    }

    if (!res.ok) {
      clearTimeout(timer);
      const t = await res.text().catch(() => '');
      throw new Error('HTTP ' + res.status + '：' + t.slice(0, 300));
    }

    let j;
    const raw = await res.text().catch(() => '');
    clearTimeout(timer);
    try {
      j = JSON.parse(raw);
    } catch (e) {
      throw new Error('返回不是合法 JSON：' + raw.slice(0, 200));
    }

    const choice = j && j.choices && j.choices[0];
    if (!choice) {
      throw new Error('返回里没有 choices（原始：' + raw.slice(0, 200) + '）');
    }
    const msg = choice.message || {};
    const content = (msg.content || '').trim();
    const reasoning = (msg.reasoning_content || '').trim();
    const finish = choice.finish_reason;
    const usage = j.usage || {};
    const warnings = [];

    if (finish === 'length') {
      warnings.push(`输出被截断（finish_reason=length，用了 ${usage.completion_tokens || '?'} tokens）`);
    }

    if (!content) {
      if (reasoning) {
        throw new Error(
          `模型只输出了推理过程、正文为空（finish=${finish || '?'}，输出 ${usage.completion_tokens || 0} tokens）。` +
          '这是推理型模型的常见现象：token 被 thinking 消耗完。' +
          `本次请求 max_tokens=${o.maxTokens || maxTokens}，模型 ${model}。` +
          '已自动用更大上限重试过一次；仍为空请换非推理模型（如 deepseek-chat），或在「接入设置」里把模型改成普通对话模型。'
        );
      }
      throw new Error(
        `模型返回空正文（finish=${finish || '?'}，输出 ${usage.completion_tokens || 0} tokens）。` +
        '可能是模型拒答、参数不被接受或服务端异常。'
      );
    }

    return {
      content, reasoning: reasoning || null,
      finishReason: finish || null, usage,
      requestId: (j.id || j.request_id || null),
      warnings, model
    };
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
  /**
   * 统一构建发给 AI 的上下文。
   * 原则：
   *  · 只发聚合统计，绝不发原始行
   *  · 每个数字带 metricId + 阶段，便于审计时说清出处
   *  · 未运行的分析显式写"未运行"，不留空让人猜
   *  · 预览与实际请求走同一个函数，不可能出现"说的和发的不一致"
   */
  function buildAIContext(question) {
    const L = [];
    const metrics = [];
    const add = (id, label, value, unit, stage) => {
      metrics.push({ id, label, value, unit: unit || '', stage: stage || '' });
      return `${label} = ${value}${unit || ''}（${stage || '描述'}）`;
    };
    const has = (x) => x !== null && x !== undefined && Number.isFinite(x);
    const f2 = (x) => (has(x) ? x.toFixed(2) : '—');
    const pct = (x) => (has(x) ? (x * 100).toFixed(1) + '%' : '—');
    const r = S.res;

    /* ---- 1. 数据集与目标 ---- */
    L.push('【数据集】');
    const dsName = (S.dsMeta && S.dsMeta.name) || S.meta && S.meta.name || '（用户导入）';
    L.push(`名称：${dsName}`);
    L.push(`规模：${S.rows.length} 行 × ${S.columns.length} 列；数值列 ${S.numeric.length} 个`);
    if (S.dsMeta) {
      L.push(`推荐目标：${S.dsMeta.recommendedTarget}（类型 ${S.dsMeta.targetType}，任务 ${S.dsMeta.task}）`);
      if (S.dsMeta.note) L.push(`数据说明：${S.dsMeta.note}`);
      if (S.dsMeta.caveatPredictors && S.dsMeta.caveatPredictors.length) {
        L.push(`预测时点提醒：${S.dsMeta.caveatPredictors.join('、')} 是否可用取决于预测发生在何时`);
      }
    }
    L.push(`当前分析目标：${S.target || '（未选）'}`);

    /* ---- 2. 目标原始分布与校准分布 ---- */
    if (r && r.calibration && r.calibration.target) {
      const tg = r.calibration.target;
      L.push('');
      L.push('【目标变量分布】');
      L.push(`校准后等级计数：${tg.counts.join(' / ')}（共 ${tg.counts.reduce((a, b) => a + b, 0)} 条）`);
      add('target.counts', '目标等级计数', tg.counts.join('/'), '条', '校准后');
      const empty = tg.counts.filter(v => v === 0).length;
      if (empty > 0) L.push(`⚠ 有 ${empty} 个等级为空——等级划分可能不适用`);
      if (tg.thresholds) L.push(`切点：${tg.thresholds.map(t => (+t).toFixed(2)).join(' / ')}`);
    }

    /* ---- 3. 条件变量类型与低基数警示 ---- */
    if (r && r.meta && r.meta.factors && r.meta.factors.length) {
      L.push('');
      L.push('【条件变量】');
      const lowCard = [];
      r.meta.factors.forEach(f => {
        const j = S.columns.indexOf(f);
        if (j < 0) return;
        const u = new Set(S.rows.map(rr => rr[j])).size;
        if (u <= 2) lowCard.push(`${f}(${u} 个取值)`);
      });
      L.push(`条件变量个数：${r.meta.factors.length}`);
      if (lowCard.length) {
        L.push(`⚠ 低基数变量（≤2 个取值，仍按多等级校准，中间等级必然为空）：${lowCard.join('、')}`);
      }
    }

    /* ---- 4. 样本流向 ---- */
    L.push('');
    L.push('【样本流向】');
    const total = S.rows.length;
    let missingCells = 0, missingRows = 0;
    S.rows.forEach(rr => {
      let rowHas = false;
      S.columns.forEach((_, j) => {
        const v = rr[j];
        if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) { missingCells++; rowHas = true; }
      });
      if (rowHas) missingRows++;
    });
    L.push(`缺失：${missingCells} 个单元格，涉及 ${missingRows} 行`);
    add('data.missingCells', '缺失单元格', missingCells, '个', '描述');
    if (r && r.excludedByTarget) {
      L.push(`目标缺失排除：${r.excludedByTarget.length} 行`);
    }

    /* ---- 5. 严格交叉验证 ---- */
    L.push('');
    L.push('【严格交叉验证】');
    const strictCv = RES.strictOk();
    if (strictCv && strictCv.ok) {
      L.push(`折数：${strictCv.k}；分组：${strictCv.grouped ? '是' : '否'}`);
      L.push(`OOF 准确率：${pct(strictCv.oof.accuracy)}（n=${strictCv.oof.n}）`);
      L.push(`OOF Balanced Accuracy：${pct(strictCv.oof.balancedAccuracy)}；Macro-F1：${f2(strictCv.oof.macroF1)}`);
      L.push(`训练均值 ${pct(strictCv.trainMean)} vs 验证均值 ${pct(strictCv.mean)}（差 ${(strictCv.gap * 100).toFixed(1)} 个百分点）`);
      add('cv.oofAcc', 'OOF 准确率', pct(strictCv.oof.accuracy), '', '严格 CV');
      add('cv.gap', '训练-验证差', (strictCv.gap * 100).toFixed(1), '个百分点', '严格 CV');
      if (S.extra && S.extra.audit && S.extra.audit.items) {
        const fails = S.extra.audit.items.filter(i => i.status === 'FAIL');
        L.push(`泄漏审计：${fails.length === 0 ? '全部通过' : fails.map(f => f.name).join('、') + ' 未通过'}`);
        if (fails.length) add('audit.fail', '审计未通过项', fails.length, '项', '严格 CV');
      }
    } else {
      L.push('未运行（不要假设已有泛化结论）');
    }

    /* ---- 6. 普通 CV 与训练表现 ---- */
    if (r && r.cv) {
      L.push('');
      L.push('【普通 5 折 CV（诊断性质，非严格验证）】');
      L.push(`训练 ${pct(r.cv.trainAccuracy)} vs 测试 ${pct(r.cv.accuracy)}`);
    }

    /* ---- 7. Bootstrap 稳定性 ---- */
    L.push('');
    L.push('【Bootstrap 稳定性】');
    const bt = S.extra && S.extra.boot && S.extra.boot.result;
    if (bt && bt.okCount > 0) {
      L.push(`方法：${bt.method}${bt.blockType ? '/' + bt.blockType : ''}；B=${bt.B}；成功 ${bt.okCount} 次，失败 ${RES.bootFailed(bt) || 0} 次`);
      if (bt.summary && bt.summary.cluster) {
        L.push(`ARI 均值 ${f2((RES.bootAri(bt) || {}).mean)}（区间 ${f2((RES.bootAri(bt) || {}).lo)}~${f2((RES.bootAri(bt) || {}).hi)}）`);
        add('boot.ari', 'Bootstrap ARI 均值', f2((RES.bootAri(bt) || {}).mean), '', '稳定性');
      }
      if (bt.summary && bt.summary.rules && bt.summary.rules.oob) {
        const o = bt.summary.rules.oob;
        L.push(`OOB 准确率 ${pct(o.accuracy)}（覆盖率 ${pct(o.coverage)}，${o.runs} 轮）`);
        add('boot.oob', 'OOB 准确率', pct(o.accuracy), '', '袋外验证');
      }
      L.push('注意：ARI/规则频率衡量的是结构稳定性，不是监督准确率，也不是因果效应');
    } else {
      L.push('未运行');
    }

    /* ---- 8. 特征泄漏筛查 ---- */
    L.push('');
    L.push('【特征泄漏筛查】');
    const leak = S.extra && S.extra.leakFeatures;
    if (leak && leak.length) {
      L.push(`发现 ${leak.length} 个 |r| > 0.95 的特征：` +
        leak.map(x => `${x.name}(r=${f2(x.r)})`).join('、'));
      add('leak.count', '高相关特征数', leak.length, '个', '泄漏筛查');
      L.push('注意：高相关只是风险筛查，不等于确认泄漏——需结合业务时点判断');
    } else {
      L.push('未发现 |r| > 0.95 的特征（若未运行主分析，这里不代表"已检查"）');
    }

    /* ---- 9. 有效性与告警 ---- */
    L.push('');
    L.push('【结果有效性】');
    if (r) {
      const warns = [];
      if (r.cv && r.cv.trainAccuracy >= 0.99 && r.cv.accuracy >= 0.99) warns.push('训练与 CV 都接近 100%，高度可疑');
      if (r.calibration && r.calibration.target) {
        const c = r.calibration.target.counts;
        if (c.filter(v => v === 0).length > 0) warns.push('目标存在空等级');
      }
      L.push(warns.length ? warns.join('；') : '未见明显异常');
    } else {
      L.push('主分析未运行，除数据描述外的结论都不可得');
    }

    /* ---- 10. 证据索引（与报告、图表共用同一套 metricId）---- */
    if (r && r.evidence && r.evidence.length) {
      L.push('');
      L.push('【证据索引】');
      L.push('以下每个 ID 对应报告末尾证据表的一行；引用数字时优先带 ID：');
      r.evidence.slice(0, 14).forEach(e => {
        L.push(`· ${e.id} = ${e.valid ? e.formatted : '（不可用：' + (e.note || e.formatted) + '）'}` +
          (e.denominator !== null ? `（分母 ${e.denominator}，${e.stage}）` : `（${e.stage}）`));
      });
      if (r.evidence.length > 14) L.push(`· …共 ${r.evidence.length} 项，完整表见报告`);
    }

    /* ---- 11. 用户问题 ---- */
    if (question) {
      L.push('');
      L.push('【用户问题】');
      L.push(question);
    }

    return { text: L.join('\n'), metrics };
  }

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
      // V3.3：不再对小整数放行——AUC=0.99、p=0.003、类别数 3 都必须有出处
      // （等级标签 0/1/2 属于索引，由 base 里的 levels 长度覆盖）
      const cands = [n, n / 100, n * 100];
      const hit = cands.some(x => allow.some(y => Math.abs(y - x) <= Math.max(0.02, Math.abs(y) * 0.02)));
      if (!hit) bad.push(n);
    });
    return [...new Set(bad)].slice(0, 6);
  }

  /**
   * 从 AI 回答里找出它引用到的证据项。
   * 做法：把证据表里的格式化值/原始值都拿去匹配回答文本，命中即列出 metricId。
   * 这不是"验证 AI 说得对"，只是告诉读者"这段里出现的数字能对应到哪几条证据"。
   */
  function matchEvidence(text, list) {
    if (!text || !list || !list.length) return [];
    const hit = [];
    list.forEach(e => {
      if (e.valid === false) return;
      const forms = new Set();
      if (typeof e.value === 'number' && Number.isFinite(e.value)) {
        forms.add(String(e.value));
        forms.add(e.value.toFixed(1));
        forms.add(e.value.toFixed(2));
        forms.add(e.value.toFixed(3));
        if (Math.abs(e.value) <= 1) {
          forms.add((e.value * 100).toFixed(1));
          forms.add((e.value * 100).toFixed(0));
        }
      }
      if (e.formatted) forms.add(String(e.formatted).replace(/[^\d.\-]/g, ''));
      let ok = false;
      forms.forEach(f => {
        if (!f || f.length < 2) return;
        if (text.indexOf(f) >= 0) ok = true;
      });
      if (ok) hit.push(e);
    });
    return hit;
  }

  function renderAI() {
    const pane = $('#pane'), r = S.res, cfg = aiCfg();
    pane.innerHTML = '';
    // AI 页不依赖主分析：可以先配置、可以先问方法论问题
    pane.appendChild(el('div', { class: 'muted', html:
      'AI 只做两件事：<b>推荐参数</b> 和 <b>写文字</b>。所有数字必须来自本地计算，模型编造的数字会被标红。' +
      (r ? '' : '<br><b>当前还没有分析结果</b>——你仍可以配置接口、问方法论问题；涉及数据的结论会在跑完分析后才可用。') }));

    // 接入设置：已配置则默认折叠，避免把对话挤到首屏以下
    const cfgReady = !!(cfg && cfg.key);
    const boxWrap = el('details', { style: 'margin-top:12px' });
    if (!cfgReady) boxWrap.open = true;
    boxWrap.appendChild(el('summary', {
      style: 'cursor:pointer;font-size:12.5px;color:var(--dim);padding:6px 0;user-select:none',
      text: (cfgReady ? '接入设置（已配置 ' + esc(cfg.model || 'default') + ' · 点击展开修改）'
                      : '接入设置（还没填 Key，点这里配置）')
    }));
    const box = el('div', { class: 'card', style: 'margin-top:8px;background:#0f1a24' });
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
      testOut.className = 'testout';
      testOut.innerHTML = '正在请求…';
      aiSave({ provider: selP.value, baseURL: inBase.value.trim(), model: inModel.value.trim(),
               key: inKey.value.trim(), persist: persistChk.checked });
      const t0 = performance.now();
      try {
        const r0 = await callLLM([{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 200 });
        const txt = r0.content;
        const ms = Math.round(performance.now() - t0);
        testOut.style.borderColor = '#1f4a3c';
        testOut.className = 'testout ok';
    testOut.innerHTML = `<b style="color:#34d399">连接成功</b> · 延迟 ${ms}ms · 模型 ${inModel.value || '(默认)'}<br>
          <span class="muted">返回：${(txt || '').slice(0, 60)}</span>`;
      } catch (e) {
        testOut.style.borderColor = '#5a2020';
        testOut.className = 'testout bad';
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
    boxWrap.appendChild(box);
    pane.appendChild(boxWrap);

    // 服务商不支持浏览器直连时，提前说清楚，避免用户以为是 Key 写错
    const curProv = (aiCfg().provider || 'deepseek');
    if (PROVIDERS[curProv] && PROVIDERS[curProv].cors === false) {
      pane.appendChild(el('div', { class: 'hint', style: 'border-color:#5a4a2a;color:#f5c66b;margin-top:10px', html:
        `<b>${esc(PROVIDERS[curProv].name)} 不支持浏览器直连</b>：实测其接口不返回 <code>Access-Control-Allow-Origin</code>，` +
        '在浏览器里调用会被 CORS 拦截，表现为 <code>Failed to fetch</code>。<br>' +
        '这不是 Key 或参数问题。两条路：① 换成 <b>DeepSeek</b>（实测支持跨域直连）；' +
        '② 服务商选「<b>中转站（自定义）</b>」，填一个允许跨域的中转地址。' }));
    }

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
        const txt = (await callLLM([{ role: 'user', content: prompt }])).content;
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
3) 条件依赖：哪个变量在给定网络下与结果关联最强（给出条件概率差值），并说明这不是干预效应，P(Y|X) ≠ P(Y|do(X))。
要求：只能使用 JSON 里出现过的数字；不要编造变量名；语气客观。`;
        const txt = (await callLLM([{ role: 'user', content: prompt }])).content;
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
      const TI2 = tgtInfo(r);
      const top = TI2.nominal ? null
        : sc.stats.filter(x => x.n > 0).slice().sort((a, b) => b.mean[r.meta.target] - a.mean[r.meta.target])[0];
      const rules = r.tree.rules.slice().sort((a, b) => b.support * b.confidence - a.support * a.confidence).slice(0, 2);
      const sens = (r.sens || []).map(({ f, rows }) => ({
        f, spread: Math.max(...rows.map(x => x.posterior[lv])) - Math.min(...rows.map(x => x.posterior[lv])),
        hi: rows[0].posterior[lv], lo: rows[rows.length - 1].posterior[lv]
      })).sort((a, b) => b.spread - a.spread)[0];
      const txt =
`【1. 数据与分型】
本次分析使用 ${r.meta.usedRows} 条有效样本，${r.meta.factors.length} 个条件变量，因变量为「${r.meta.target}」。
按 ${r.meta.params.lowPct}/${r.meta.params.highPct} 分位做云模型校准（${r.meta.params.levels} 级）后，KMeans 将其划分为 ${sc.k} 类情境，轮廓系数 ${(sc.silhouette || 0).toFixed(3)}。
${TI2.nominal
  ? `目标「${r.meta.target}」是无序类别，不比较各情境的均值高低（编码顺序会改变结论）。`
  : `其中「${top.name}」的 ${r.meta.target} 均值最高，为 ${top.mean[r.meta.target].toFixed(3)}。`}

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
      '4. 上下文里有「证据索引」，每个 ID 对应报告的证据表。引用数字时优先写 ID（如 `strictCV.oofAcc`），' +
      '没有 ID 的数字视为无出处。' +
      '5. 上下文里已包含「严格交叉验证」「Bootstrap 稳定性」「特征泄漏筛查」「结果有效性」四节。' +
      '凡是标注"未运行"的项，你不能当作已完成；凡是高相关特征，只在最前面提示风险，不得直接断言泄漏。',
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
        // 上下文由 buildAIContext 统一构建（含严格 CV / Bootstrap / 泄漏筛查 / 有效性），
        // 只发聚合统计，不发原始行；结果 JSON 仅挂最后一条，避免重复传大 payload
        const ctxObj = buildAIContext(null);
        const ctx = '\n\n【分析上下文】\n' + ctxObj.text +
          '\n\n【结果 JSON】\n' + JSON.stringify(r ? brief() : { note: '主分析未运行' }, null, 1);
        const hist = chat.slice(-8, -1).map(m => ({ role: m.role, content: m.content }));
        const msgs = [{ role: 'system', content: SYS_PROMPT }]
          .concat(hist)
          .concat([{ role: 'user', content: q2 + ctx }]);
        const t0 = performance.now();
        let r2 = null, degraded = false;
        try {
          r2 = await callLLMRetry(msgs, { retries: 2 });
        } catch (e) {
          // AI 不可用：退回本地模板，但要说清楚
          r2 = { content: localTemplateAnswer(r), finishReason: 'local', usage: {} };
          degraded = true;
          r2.content = '⚠ AI 调用失败（' + String(e.message).slice(0, 160) + '）\n以下为本地模板结果：\n\n' + r2.content;
        }
        const txt2 = r2.content;
        const ms = Math.round(performance.now() - t0);
        let bad = [];
        try { bad = r ? (auditNumbers(txt2, r) || []) : []; } catch (e) { bad = []; }
        let refs = [];
        try { refs = matchEvidence(txt2, r && r.evidence); } catch (e) { refs = []; }
        const fmt = checkAnswerFormat(txt2);
        const parts = [`${ms}ms`];
        if (degraded) parts.push('本地模板（AI 不可用）');
        else parts.push(fmt.ok ? '格式完整' : '格式不完整：缺 ' + fmt.missing.join(''));
        parts.push(bad.length ? `${bad.length} 个数字无出处：${bad.slice(0, 3).join(', ')}` : '数字溯源通过');
        if (refs.length) parts.push(`引用 ${refs.slice(0, 3).map(e => e.id).join('、')}${refs.length > 3 ? ' 等 ' + refs.length + ' 项' : ''}`);
        if (r2.finishReason === 'length') parts.push('输出被截断');
        const meta = parts.join(' · ');
        chat.push({ role: 'assistant', content: txt2, meta, refs: refs.map(e => e.id), degraded });
      } catch (e) {
        chat.push({ role: 'assistant', content: '⚠ ' + diagnose(e) + '\n' + String(e.message).slice(0, 320), meta: '请求失败' });
      }
      bSend.disabled = false;
      bSend.textContent = '发送';
      renderChat();
    };
    bSend.onclick = () => { if (!bSend.disabled) send(ta.value); };
    ta.onkeydown = e => {
      // 中文输入法确认候选时会触发 keydown，此时不能当作发送
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (bSend.disabled) return;   // 请求进行中防重复发送
        send(ta.value);
      }
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
    b1.onclick = () => download(`DAC报告_${stamp()}.md`, r.reportWithEvidence || r.report, 'text/markdown');
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
    /**
   * 把 Markdown 报告转成 DOCX blocks。
   * 只处理报告里实际用到的语法：# 标题、- 列表、| 表格 |、普通段落、**粗体**（去掉标记）。
   * 复杂语法（嵌套列表、代码块）不处理——报告里本来也没有。
   */
  function mdToDocxBlocks(md) {
    const out = [];
    const lines = String(md || '').split('\n');
    let i = 0;
    const stripInline = (t) => t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');

    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) { i++; continue; }

      // 表格：以 | 开头且下一行是分隔行
      if (line.startsWith('|') && lines[i + 1] && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        const splitRow = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => stripInline(c.trim()));
        const head = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().startsWith('|')) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        out.push({ type: 'table', head, rows });
        continue;
      }

      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        const lv = h[1].length;
        out.push({ type: lv === 1 ? 'h1' : (lv === 2 ? 'h2' : 'h3'), text: stripInline(h[2]) });
        i++; continue;
      }

      const li = line.match(/^([-*+]|\d+\.)\s+(.*)$/);
      if (li) {
        out.push({ type: 'p', text: '· ' + stripInline(li[2]) });
        i++; continue;
      }

      if (line.startsWith('>')) {
        out.push({ type: 'quote', text: stripInline(line.replace(/^>\s?/, '')) });
        i++; continue;
      }

      // 普通段落：合并连续非空、非特殊行
      let buf = [line];
      i++;
      while (i < lines.length) {
        const nxt = lines[i].trim();
        if (!nxt || nxt.startsWith('|') || nxt.startsWith('#') || /^([-*+]|\d+\.)\s+/.test(nxt) || nxt.startsWith('>')) break;
        buf.push(nxt); i++;
      }
      out.push({ type: 'p', text: stripInline(buf.join(' ')) });
    }
    return out;
  }

  async function exportDOCX() {
    const r = S.res;
    if (!r) { toast('先跑一次分析'); return; }
    try {
      const md = r.reportWithEvidence || r.report || '';
      const blocks = mdToDocxBlocks(md);
      // 封面信息
      const cover = [
        { type: 'h1', text: S.projectName || 'DAC 分析报告' },
        { type: 'p', text: `数据：${r.meta.target} ← ${r.meta.factors.length} 个变量 · ${r.meta.usedRows} / ${r.meta.rows} 行` },
        { type: 'p', text: `生成时间：${new Date().toLocaleString('zh-CN')}` }
      ];
      if (window.__BUILD__) {
        cover.push({ type: 'quote', text: `构建摘要 ${window.__BUILD__.digest} · 源提交 ${String(window.__BUILD__.sourceCommit || '未知').slice(0, 8)}` });
      }
      cover.push({ type: 'quote', text: '本报告完全在浏览器本地生成，没有后端服务。所有数字来自本地计算，可在页面上一一核对。' });

      const buf = await C.toDOCX(cover.concat(blocks), S.projectName || 'DAC 分析报告');
      const name = (S.projectName || 'DAC报告').replace(/[\\/:*?"<>|]/g, '_');
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `${name}_${stamp()}.docx` });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast(`Word 报告已生成（${(buf.length / 1024).toFixed(1)} KB，${blocks.length} 个块）`, 4000);
    } catch (e) {
      toast('导出 Word 失败：' + e.message, 6000);
    }
  }

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
    const bDocx = el('button', { class: 'ghost mini', text: '导出 Word 报告(.docx)' });
    bDocx.onclick = () => exportDOCX();
    bar.appendChild(bP1); bar.appendChild(bP2); bar.appendChild(bP3); bar.appendChild(b5);
    bar.appendChild(bDocx);
    pane.appendChild(bar);
    pane.appendChild(el('div', { class: 'muted', html:
      `参数快照：分位 ${r.meta.params.lowPct}/${r.meta.params.highPct} · 云滴 ${r.meta.params.drops} · 等级 ${r.meta.params.levels} · k=${r.meta.params.k} · 深度 ${r.meta.params.treeDepth} · 阈值 ${r.meta.params.netThreshold} · 种子 ${r.meta.params.seed}` }));
    pane.appendChild(el('pre', { text: r.report }));
    renderEvidenceTable(pane, r.evidence);
    renderHistory(pane);
  }

  /* ---------------- 证据表（HTML 版） ---------------- */
  function renderEvidenceTable(container, list) {
    if (!list || !list.length) return;
    const wrap = el('div', { style: 'margin-top:18px' });

    const head = el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px' }, [
      el('h3', { text: `证据登记表（${list.length} 项）`, style: 'margin:0;font-size:13px' }),
      el('span', { class: 'muted', style: 'font-size:11.5px',
        text: '每个数字的出处：分母、评价阶段、计算方法、是否可用' })
    ]);
    const bCsv = el('button', { class: 'ghost mini', text: '导出证据 CSV' });
    bCsv.onclick = () => {
      const rows = list.map(e => [
        e.id, e.label, e.formatted, e.denominator === null ? '' : e.denominator,
        e.stage, e.method || '', e.valid ? '是' : '否', e.note || ''
      ]);
      download(`DAC证据_${stamp()}.csv`,
        '\ufeff' + C.toCSV(['ID', '指标', '值', '分母', '阶段', '方法', '有效', '限制'], rows),
        'text/csv');
    };
    head.appendChild(bCsv);
    wrap.appendChild(head);

    const tb = el('table', { style: 'font-size:12px' });
    tb.appendChild(el('thead', { html:
      '<tr><th style="text-align:left">ID</th><th style="text-align:left">指标</th>' +
      '<th>值</th><th>分母</th><th>阶段</th><th style="text-align:left">方法</th><th>有效</th></tr>' }));
    const body = el('tbody');
    list.forEach(e => {
      const bad = !e.valid;
      body.appendChild(el('tr', {
        title: [e.method, e.note].filter(Boolean).join(' · ') || e.label,
        style: bad ? 'opacity:.72' : '',
        html:
          `<td style="text-align:left"><code style="font-size:11px">${esc(e.id)}</code></td>` +
          `<td style="text-align:left">${esc(e.label)}</td>` +
          `<td style="text-align:right;${bad ? 'color:#f5c66b' : ''}">${esc(e.formatted)}</td>` +
          `<td style="text-align:right">${e.denominator === null ? '—' : esc(String(e.denominator))}</td>` +
          `<td>${esc(e.stage)}</td>` +
          `<td style="text-align:left;font-size:11px">${esc(e.method || '—')}</td>` +
          `<td>${bad ? '<span class="pill bad">否</span>' : '<span class="pill ok">是</span>'}</td>`
      }));
    });
    tb.appendChild(body);
    wrap.appendChild(tb);

    // 不可用项单列说明
    const bad = list.filter(e => !e.valid);
    if (bad.length) {
      wrap.appendChild(el('div', { class: 'hint', style: 'border-color:#5a4a2a;color:#f5c66b;margin-top:10px', html:
        `<b>${bad.length} 项不可用</b>：${bad.map(e => `<code>${esc(e.id)}</code>`).join('、')}<br>` +
        '这些字段存在但结果不可信或未运行，摘要与 AI 上下文里不会给出对应数值。' }));
    }

    container.appendChild(wrap);
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
  const PROJ_VERSION = 'dac-project/2.7';

  async function projectSnapshot(includeData) {
    const r = S.res;
    // 全量指纹：覆盖所有行 + 列名 + 类型，不是只哈希首行
    const fp = await dataFingerprint(S.columns, S.rows);
    const cfg = configFingerprint();
    return {
      format: PROJ_VERSION,
      name: (S.projectName || '未命名项目'),
      createdAt: new Date().toISOString(),
      app: {
        name: 'DAC Workbench', version: '2.7', algo: 'v4.8',
        // 源提交与部署提交要能区分：构建时由 build 脚本注入
        buildDigest: (window.__BUILD__ && window.__BUILD__.digest) || null,
        buildTime: (window.__BUILD__ && window.__BUILD__.time) || null
      },
      dataset: {
        name: S.fileName || (S.sheets ? S.sheets[S.sheetIdx].name : '内置示例'),
        rows: S.rows.length, cols: S.columns.length,
        columns: S.columns.slice(),
        // 默认不打包原始数据，避免项目文件失控膨胀与隐私外泄
        data: includeData ? (S.rowsRaw || S.rows) : null,
        // 全量指纹（含序列化版本、列名、类型、每行每格）
        hash: fp.hash,
        hashAlg: fp.alg,
        hashVersion: fp.version,
        hashBytes: fp.bytes,
        hashTypes: fp.types,
        // 导入时的解析元信息（分隔符等），便于复现"数据怎么进来的"
        importMeta: S.importMeta || null
      },
      // 配置指纹：目标 + 因子 + 角色 + 参数
      config: { hash: cfg.hash, alg: cfg.alg, text2: cfg.text },
      // 本次运行的唯一标识（数据 + 配置 + 时间戳），用于把结果与输入绑定
      runId: (S.runId || null),
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

  async function exportProject(includeData) {
    const proj = await projectSnapshot(includeData);
    const name = (proj.name || 'project').replace(/[\\/:*?"<>|]/g, '_');
    download(`DAC项目_${name}_${stamp()}.json`, JSON.stringify(proj, null, 2), 'application/json');
    toast(includeData ? '已导出（含数据）' : '已导出（不含原始数据，仅参数与结果）', 4000);
  }

  window.__dacImportProject = (file) => importProjectFile(file);

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
      // 恢复（带全量指纹校验，异步）
      const verify = async () => {
        if (!proj.dataset) return null;
        const want = proj.dataset.hash;
        if (Array.isArray(proj.dataset.data)) {
          S.columns = proj.dataset.columns.slice();
          S.rows = proj.dataset.data.map(r => r.slice());
          S.rowsRaw = S.rows.map(r => r.slice());
          S.numeric = C.numericCols(S.columns, S.rows);
        } else if (!S.columns.length) {
          toast('项目未含数据；请先导入同名列的数据集，再应用参数', 6000);
          return null;
        }
        if (!want) {
          S.projWarn = '该项目来自旧版本，没有全量指纹，无法校验数据是否一致';
          S.projMismatch = null;
          toast(S.projWarn, 6000);
          return null;
        }
        const fp = await dataFingerprint(S.columns, S.rows);
        if (fp.hash === want) {
          S.projWarn = null;
          S.projMismatch = null;
          S.projVerified = { hash: fp.hash, alg: fp.alg, rows: fp.rows, cols: fp.cols };
          toast(`数据校验通过（${fp.alg}，${fp.rows} 行 × ${fp.cols} 列）`, 4000);
          return true;
        }
        // 不一致必须说出来，不能静默继续
        const msg = `数据指纹不一致：项目 ${String(want).slice(0, 12)}… 当前 ${fp.hash.slice(0, 12)}…（${fp.alg}）`;
        toast(msg + ' —— 参数与结果可能与当前数据不对应', 9000);
        S.projMismatch = { want, got: fp.hash, alg: fp.alg };
        S.projVerified = null;   // 不一致时不能留着上一次"通过"的记录
        S.projWarn = null;
        return false;
      };
      const restored = verify();
      if (restored && restored.then) restored.then(() => { if (proj.runId) S.runId = proj.runId; });
      if (proj.roles) S.roles = Object.assign({}, proj.roles);
      if (proj.selections) {
        if (proj.selections.target) S.target = proj.selections.target;
        if (Array.isArray(proj.selections.factors)) S.factors = proj.selections.factors.slice();
      }
      // 关键：把目标同步回下拉框。否则 run() 里 S.target = $('#target').value
      // 会用上一个数据集残留的值覆盖项目里的目标（实测：wine 项目重开后目标变成 iris 的品种编码）
      (function syncTargetSelect() {
        const sel = $('#target');
        if (!sel) return;
        const cols = S.columns || [];
        sel.innerHTML = '';
        (S.numeric || []).forEach(c => sel.appendChild(el('option', { value: c, text: c })));
        if (S.target && cols.indexOf(S.target) >= 0) sel.value = S.target;
        if (typeof renderFactors === 'function') { try { renderFactors(); } catch (e) { } }
        // 下拉里可能没有这个列（列已被替换），那就明确报出来
        if (S.target && sel.value !== S.target) {
          S.projWarn = (S.projWarn ? S.projWarn + '；' : '') +
            `项目目标「${S.target}」不在当前数据列里，已回退到「${sel.value}」`;
          toast(S.projWarn, 8000);
        }
      })();
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

  /* ---------------- 主题（深/浅） ---------------- */
  function initTheme() {
    const KEY = 'dac-theme-v1';
    const btn = document.getElementById('btnTheme');
    let saved = 'dark';
    try { saved = localStorage.getItem(KEY) || 'dark'; } catch (e) { }
    const apply = (light) => {
      document.body.classList.toggle('light', light);
      if (btn) btn.textContent = light ? '深色' : '浅色';
    };
    apply(saved === 'light');
    // 主题按钮的点击行为统一交给 initPalette（避免双重绑定）
  }
  initTheme();

  /* ---------------- 配色与字号（可调，存本机） ---------------- */
  function initPalette() {
    const KEY = 'dac-palette-v1';
    const panel = document.getElementById('palettePanel');
    const btn = document.getElementById('btnPalette');
    if (!panel || !btn) return;

    const defaults = { theme: 'dark', accent: '', stripe: 'weak', font: '1' };
    let cfg = Object.assign({}, defaults);
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
    } catch (e) { }

    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { } };

    const apply = () => {
      const body = document.body;
      // 主题
      const sysLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
      const light = cfg.theme === 'light' || (cfg.theme === 'auto' && sysLight);
      body.classList.toggle('light', light);
      const tb = document.getElementById('btnTheme');
      if (tb) tb.textContent = light ? '深色' : '浅色';

      // 强调色
      const root = document.documentElement;
      if (cfg.accent) {
        root.style.setProperty('--acc', cfg.accent);
        // 强调色的浅一档用于 hover/次要文字
        root.style.setProperty('--acc2', cfg.accent);
      } else {
        root.style.removeProperty('--acc');
        root.style.removeProperty('--acc2');
      }

      // 斑马纹：按实际生效的主题取色（不按 cfg 推断，避免手动切 class 时错配）
      const darkEven = { none: 'transparent', weak: '#0f1922', strong: '#0a1219' };
      const lightEven = { none: 'transparent', weak: '#F7F9FA', strong: '#E8EEF2' };
      const isLightNow = body.classList.contains('light');
      const pick = isLightNow ? lightEven : darkEven;
      root.style.setProperty('--row-even', pick[cfg.stripe] || pick.weak);

      // 字号
      root.style.setProperty('--fs', cfg.font);
      document.body.style.fontSize = `calc(14.5px * ${cfg.font})`;

      // 同步按钮态
      document.querySelectorAll('#palTheme button').forEach(b => b.classList.toggle('on', b.dataset.v === cfg.theme));
      document.querySelectorAll('#palStripe button').forEach(b => b.classList.toggle('on', b.dataset.v === cfg.stripe));
      document.querySelectorAll('#palFont button').forEach(b => b.classList.toggle('on', b.dataset.v === cfg.font));
      document.querySelectorAll('#palAccent button[data-c]').forEach(b => b.classList.toggle('on', b.dataset.c === cfg.accent));
    };

    btn.onclick = (e) => { e.stopPropagation(); panel.hidden = !panel.hidden; };
    document.getElementById('palClose').onclick = () => { panel.hidden = true; };
    panel.addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => { if (!panel.hidden) panel.hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') panel.hidden = true; });

    document.querySelectorAll('#palTheme button').forEach(b => {
      b.onclick = () => { cfg.theme = b.dataset.v; save(); apply(); };
    });
    document.querySelectorAll('#palStripe button').forEach(b => {
      b.onclick = () => { cfg.stripe = b.dataset.v; save(); apply(); };
    });
    document.querySelectorAll('#palFont button').forEach(b => {
      b.onclick = () => { cfg.font = b.dataset.v; save(); apply(); };
    });
    document.querySelectorAll('#palAccent button[data-c]').forEach(b => {
      b.onclick = () => { cfg.accent = b.dataset.c; save(); apply(); };
    });
    const custom = document.getElementById('palAccentCustom');
    if (custom) custom.oninput = () => { cfg.accent = custom.value; save(); apply(); };
    document.getElementById('palReset').onclick = () => { cfg = Object.assign({}, defaults); save(); apply(); };

    // 右上角旧的主题按钮改为切换到"深/浅"两个明确值
    const tb = document.getElementById('btnTheme');
    if (tb) {
      tb.onclick = () => {
        cfg.theme = (cfg.theme === 'light') ? 'dark' : 'light';
        save(); apply();
      };
    }

    apply();
  }
  initPalette();

})();
