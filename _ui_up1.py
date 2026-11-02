# -*- coding: utf-8 -*-
"""前端升级 1/2：多数据集切换 + 结论摘要 + 表格排序 + 图例交互。"""
from pathlib import Path

p = Path(r"D:\reverse\dac-reverse-research\workbench\ui.js")
s = p.read_text(encoding="utf-8")

# ---------- A) 数据源：下拉替换按钮 ----------
old_a = """  $('#btnSample').onclick = () => {
    try {
      const text = (window.__SAMPLE_CSV__ || '').trim();
      if (!text) return toast('示例数据未内嵌');
      applyData(C.parseCSV(text), '示例：1000 家虚构企业');
    } catch (e) { toast('载入失败：' + e.message); }
  };"""
new_a = """  const DS = window.__DATASETS__ || {};
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
  }"""
assert old_a in s
s = s.replace(old_a, new_a)

# ---------- B) applyData 支持描述 ----------
s = s.replace("  function applyData(parsed, name) {", "  function applyData(parsed, name, desc) {")
s = s.replace(
    """    $('#dsInfo').innerHTML = `<b>${name}</b><br>${parsed.rows.length} 行 · ${parsed.columns.length} 列 · 其中数值列 ${S.numeric.length} 个`;
    $('#status').textContent = `${parsed.rows.length} 行已就绪`;""",
    """    $('#dsInfo').innerHTML = `<b>${name}</b><br>${parsed.rows.length} 行 · ${parsed.columns.length} 列 · 数值列 ${S.numeric.length} 个`
      + (desc ? `<br><span class="muted">${desc}</span>` : '');
    $('#status').textContent = `${parsed.rows.length} 行已就绪`;
    const tag = $('#dsTag');
    if (tag) { tag.textContent = name.slice(0, 22); tag.classList.add('live'); }""")

# ---------- C) 结论摘要 ----------
anchor = "  /* ---------------- Tab ---------------- */"
SUMMARY = r"""  /* ---------------- 结论摘要 ---------------- */
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

"""
assert anchor in s
s = s.replace(anchor, SUMMARY + anchor)

# ---------- D) renderTab 开头刷新摘要 ----------
s = s.replace("  function renderTab() {\n    const pane = $('#pane');",
              "  function renderTab() {\n    updateSummary();\n    const pane = $('#pane');")

# ---------- E) 体检表加排序 ----------
s = s.replace(
    """    const tb = el('table');
    tb.appendChild(el('thead', { html: '<tr><th>变量</th><th>类型</th><th>缺失</th><th>中位数</th><th>标准差</th><th>异常值</th><th>偏度</th></tr>' }));
    const body = el('tbody');
    prof.columns.forEach(c => body.appendChild(el('tr', { html:""",
    """    const tb = el('table');
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
      arr.forEach(c => body.appendChild(el('tr', { html:""")
s = s.replace(
    """       <td>${c.outliers ?? '-'}</td><td>${fmt(c.skew, 2)}</td>` })));
    tb.appendChild(body);
    pane.appendChild(tb);""",
    """         <td>${c.outliers ?? '-'}</td><td>${fmt(c.skew, 2)}</td>` })));
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
    pane.appendChild(tb);""")

# 修掉中间那段多余的 `prof.columns.forEach(...)` 前缀
s = s.replace("      arr.forEach(c => body.appendChild(el('tr', { html:\n      `<td>${c.name}</td>", "      arr.forEach(c => body.appendChild(el('tr', { html:\n         `<td>${c.name}</td>")
s = s.replace("`<td>${c.name}</td>\n       <td><span class=\"pill", "`<td>${c.name}</td>\n         <td><span class=\"pill")

# ---------- F) 启动逻辑改用 loadSample ----------
s = s.replace("    setTimeout(() => $('#btnSample').click(), 150);", "    setTimeout(() => loadSample(), 150);")
s = s.replace("    setTimeout(() => $('#btnSample').click(), 150);", "    setTimeout(() => loadSample(), 150);")

p.write_text(s, encoding="utf-8")
print("ui upgraded (1/2), len =", len(s))
for k in ["initDatasets", "loadSample", "updateSummary", "sortKey"]:
    print(f"  {k}:", k in s)
