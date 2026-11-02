# -*- coding: utf-8 -*-
"""补三件事：情境命名、肘部/轮廓曲线、导出校准数据 CSV + 复制参数。"""
from pathlib import Path

p = Path(r"D:\reverse\dac-reverse-research\workbench\ui.js")
s = p.read_text(encoding="utf-8")

# ---------- 1) 分型表增加"自动命名"列 ----------
old = """    const cols = ['情境', '样本', ...S.res.meta.factors, S.res.meta.target];"""
new = """    const cols = ['情境', '自动命名', '样本', ...S.res.meta.factors, S.res.meta.target];"""
assert old in s
s = s.replace(old, new)

old2 = """    sc.stats.forEach(s => b.appendChild(el('tr', { html:
      `<td>${s.name}</td><td>${s.n}</td>` +
      S.res.meta.factors.map(f => `<td>${fmt(s.mean[f], 2)}</td>`).join('') +
      `<td><b>${fmt(s.mean[S.res.meta.target], 3)}</b></td>` })));"""
new2 = """    sc.stats.forEach((s, i) => {
      const nm = (sc.names && sc.names[i]) || { tag: '', perf: '' };
      b.appendChild(el('tr', { html:
        `<td>${s.name}</td>
         <td style="text-align:left"><span class="pill ok">${nm.tag || '-'}</span> <span class="muted">${nm.perf || ''}</span></td>
         <td>${s.n}</td>` +
        S.res.meta.factors.map(f => `<td>${fmt(s.mean[f], 2)}</td>`).join('') +
        `<td><b>${fmt(s.mean[S.res.meta.target], 3)}</b></td>` }));
    });"""
assert old2 in s
s = s.replace(old2, new2)

# ---------- 2) 分型页尾部加肘部/轮廓曲线 ----------
old3 = """    pane.appendChild(el('div', { class: 'muted', style: 'margin-top:8px',
      text: '读法：同一列在不同情境间差异越大，说明该变量越能区分情境；最后一列看哪个情境的 y 最高。' }));"""
new3 = """    pane.appendChild(el('div', { class: 'muted', style: 'margin-top:8px',
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
    }"""
assert old3 in s
s = s.replace(old3, new3)

# ---------- 3) 报告页增加导出校准数据 + 复制参数 ----------
old4 = """    const b3 = el('button', { class: 'ghost mini', text: '打印 / 存 PDF' });
    b3.onclick = () => window.print();
    bar.appendChild(b1); bar.appendChild(b2); bar.appendChild(b3);"""
new4 = """    const b3 = el('button', { class: 'ghost mini', text: '打印 / 存 PDF' });
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
      download(`DAC校准数据_${stamp()}.csv`, '\\ufeff' + C.toCSV(head, rows), 'text/csv');
    };
    const b5 = el('button', { class: 'ghost mini', text: '复制参数快照' });
    b5.onclick = () => {
      const p2 = S.res.meta.params;
      const txt = JSON.stringify({ target: S.res.meta.target, factors: S.res.meta.factors, params: p2 }, null, 2);
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('参数已复制，可直接粘进论文方法部分'));
      else { download('params.json', txt, 'application/json'); }
    };
    bar.appendChild(b1); bar.appendChild(b2); bar.appendChild(b3); bar.appendChild(b4); bar.appendChild(b5);"""
assert old4 in s
s = s.replace(old4, new4)

p.write_text(s, encoding="utf-8")
print("ui round2 patched, len =", len(s))
