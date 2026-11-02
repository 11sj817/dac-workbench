# -*- coding: utf-8 -*-
"""扩展 ui.js：交叉验证、情境命名、肘部曲线、贝叶斯网络、稳健性检验。"""
from pathlib import Path

p = Path(r"D:\reverse\dac-reverse-research\workbench\ui.js")
s = p.read_text(encoding="utf-8")

# ---------- 1) compute 增加 CV / 命名 / BN ----------
old = """    const res = {
      meta: { target, factors, rows: S.rows.length, usedRows: keep.length, params },
      profile: C.profile(S.columns, S.rows),
      corr: C.corrMatrix(S.columns, S.rows),
      calibration: { factors: cal, target: calY, labels },
      scenarios: { k: params.k, silhouette: sil, stats, labels: km.labels },
      tree: Object.assign({}, tree, { single }),
      net: Object.assign({}, net, { threshold: params.netThreshold }),
      pca: pc
    };
    res.report = C.report(res);
    return res;"""
new = """    // 交叉验证
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
    return res;"""
assert old in s
s = s.replace(old, new)

# ---------- 2) run() 里重置懒加载缓存 ----------
s = s.replace("        S.res = compute();", "        S.res = compute();\n        S.extra = {};")
s = s.replace("    res: null, tab: 'guide', step: 1, busy: false",
              "    res: null, extra: {}, tab: 'guide', step: 1, busy: false")

# ---------- 3) switch 增加分支 ----------
s = s.replace("      case 'net': return renderNet();",
              "      case 'net': return renderNet();\n      case 'bn': return renderBN();\n      case 'robust': return renderRobust();")

# ---------- 4) 新增渲染函数（插在 renderReport 之前） ----------
anchor = "  /* ---------------- 渲染：报告 ---------------- */"
NEW = r"""
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

"""
assert anchor in s
s = s.replace(anchor, NEW + anchor)

p.write_text(s, encoding="utf-8")
print("ui extended:", len(s), "chars")
for k in ["renderBN", "renderRobust", "crossValidate", "nameScenarios"]:
    print(f"  {k}:", k in s)
