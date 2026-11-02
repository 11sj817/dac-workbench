# -*- coding: utf-8 -*-
"""给 workbench/core.js 增加：交叉验证、肘部曲线、稳健性扫描、情境命名、贝叶斯网络。"""
from pathlib import Path

p = Path(r"D:\reverse\dac-reverse-research\workbench\core.js")
s = p.read_text(encoding="utf-8")

EXTRA = r"""
  /* ============================================================
   * 扩展能力：交叉验证 / 肘部曲线 / 稳健性 / 情境命名 / 贝叶斯网络
   * ============================================================ */

  /* ---- 5 折交叉验证 ---- */
  function crossValidate(X, y, featureNames, labels, opt, folds) {
    const K = folds || 5;
    const idx = X.map((_, i) => i);
    const r = rng((opt && opt.seed) || 42);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const scores = [];
    const per = Math.ceil(idx.length / K);
    for (let f = 0; f < K; f++) {
      const test = idx.slice(f * per, (f + 1) * per);
      if (!test.length) continue;
      const testSet = new Set(test);
      const trX = [], trY = [];
      for (let i = 0; i < X.length; i++) if (!testSet.has(i)) { trX.push(X[i]); trY.push(y[i]); }
      if (trX.length < 20) continue;
      const t = cart(trX, trY, featureNames, labels, opt);
      let ok = 0;
      for (const i of test) if (predictTree(t.root, X[i]) === y[i]) ok++;
      scores.push(ok / test.length);
    }
    return {
      folds: scores.length,
      mean: mean(scores) || 0,
      std: std(scores) || 0,
      scores
    };
  }

  /* ---- 肘部 / 轮廓曲线 ---- */
  function elbowCurve(X, ks, seed) {
    const out = [];
    ks.forEach(k => {
      try {
        const km = kmeans(X, k, { seed: seed || 42, nInit: 6 });
        out.push({
          k, inertia: km.inertia,
          silhouette: silhouette(km.Z, km.labels)
        });
      } catch (e) { /* 跳过无效 k */ }
    });
    return out;
  }

  /* ---- 稳健性扫描：同一份数据，换参数看结论怎么变 ---- */
  function robustness(X, yv, factors, labels, base, opt) {
    const runs = [];
    const push = (label, over) => {
      const p = Object.assign({}, base, over);
      try {
        const cal = {};
        factors.forEach((f, i) => { cal[f] = calibrate(X.map(r => r[i]), p); });
        const calY = calibrate(yv, p);
        const Xc = X.map((_, i) => factors.map(f => cal[f].codes[i]));
        const t = cart(Xc, calY.codes, factors, labels, { maxDepth: p.treeDepth, minLeaf: 20 });
        const rules = t.rules.slice().sort((a, b) => b.support * b.confidence - a.support * a.confidence);
        runs.push({
          label, params: { lowPct: p.lowPct, highPct: p.highPct, levels: p.levels, k: p.k, treeDepth: p.treeDepth },
          accuracy: t.accuracy,
          rules: rules.length,
          top: rules[0] ? rules[0] : null
        });
      } catch (e) {
        runs.push({ label, error: e.message, params: p });
      }
    };
    push('基准', {});
    push('分位 20/80', { lowPct: 20, highPct: 80 });
    push('分位 30/70', { lowPct: 30, highPct: 70 });
    push('4 级离散', { levels: 4 });
    push('2 级离散', { levels: 2 });
    push('树深 +1', { treeDepth: Math.min(4, base.treeDepth + 1) });
    push('树深 -1', { treeDepth: Math.max(1, base.treeDepth - 1) });
    return runs;
  }

  /* ---- 情境自动命名：找出偏离总体均值最大的两个变量 ---- */
  function nameScenarios(stats, factors, target, baseMean) {
    return stats.map(s => {
      if (!s.n) return { name: s.name, tag: '空簇' };
      const diffs = factors.map(f => {
        const m = s.mean[f], b = baseMean[f];
        const sd = Math.abs(b) < 1e-9 ? 1 : Math.abs(b);
        const z = (m - b) / sd;
        return { f, z, dir: z >= 0 ? '高' : '低' };
      }).sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
      const top = diffs.slice(0, 2).filter(d => Math.abs(d.z) > 0.08);
      const tag = top.length
        ? top.map(d => d.dir + d.f).join('·')
        : '接近总体';
      const tgtZ = (s.mean[target] - baseMean[target]) / (Math.abs(baseMean[target]) < 1e-9 ? 1 : Math.abs(baseMean[target]));
      const perf = tgtZ > 0.15 ? '高绩效' : tgtZ < -0.15 ? '低绩效' : '中绩效';
      return { name: s.name, tag, perf };
    });
  }

  /* ============================================================
   * 贝叶斯网络（书第 6 章：结构学习 + 参数学习 + 敏感度）
   * 离散变量，父节点数上限 2，BIC 评分，爬山搜索
   * ============================================================ */

  function configIndex(states, row, parentIdx) {
    let idx = 0;
    for (const p of parentIdx) idx = idx * states + row[p];
    return idx;
  }

  function bicScore(data, nStates, node, parents) {
    const n = data.length;
    const k = nStates;
    const nParentConfigs = Math.pow(k, parents.length);
    const counts = new Array(nParentConfigs);
    for (let c = 0; c < nParentConfigs; c++) counts[c] = new Array(k).fill(0);
    for (const row of data) {
      const c = parents.length ? configIndex(k, row, parents) : 0;
      counts[c][row[node]]++;
    }
    let ll = 0;
    let q = 0;
    for (let c = 0; c < nParentConfigs; c++) {
      const tot = sum(counts[c]);
      if (!tot) continue;
      q++;
      for (let v = 0; v < k; v++) {
        if (!counts[c][v]) continue;
        ll += counts[c][v] * Math.log(counts[c][v] / tot);
      }
    }
    const params = q * (k - 1);
    return ll - (params / 2) * Math.log(n);
  }

  function bnLearn(discrete, names, levels, opt) {
    const o = Object.assign({ maxParents: 2, maxIter: 12 }, opt || {});
    const p = names.length;
    const parents = names.map(() => []);
    const scoreCache = new Map();
    const scoreOf = (node, par) => {
      const key = node + '|' + par.slice().sort((a, b) => a - b).join(',');
      if (!scoreCache.has(key)) scoreCache.set(key, bicScore(discrete, levels, node, par));
      return scoreCache.get(key);
    };
    const localScore = parents.map((ps, i) => scoreOf(i, ps));

    for (let it = 0; it < o.maxIter; it++) {
      let bestGain = 0, bestOp = null;
      for (let i = 0; i < p; i++) {
        // 加边
        if (parents[i].length < o.maxParents) {
          for (let j = 0; j < p; j++) {
            if (j === i || parents[i].includes(j)) continue;
            if (parents[j].includes(i)) continue; // 避免双向
            const np = parents[i].concat([j]);
            const gain = scoreOf(i, np) - localScore[i];
            if (gain > bestGain) { bestGain = gain; bestOp = { type: 'add', i, j }; }
          }
        }
        // 删边
        for (const j of parents[i]) {
          const np = parents[i].filter(x => x !== j);
          const gain = scoreOf(i, np) - localScore[i];
          if (gain > bestGain) { bestGain = gain; bestOp = { type: 'del', i, j }; }
        }
      }
      if (!bestOp || bestGain < 1e-6) break;
      const { type, i, j } = bestOp;
      if (type === 'add') parents[i] = parents[i].concat([j]);
      else parents[i] = parents[i].filter(x => x !== j);
      localScore[i] = scoreOf(i, parents[i]);
    }

    // 参数学习：CPT（拉普拉斯平滑）
    const cpt = names.map((_, i) => {
      const par = parents[i];
      const nCfg = Math.pow(levels, par.length);
      const table = [];
      for (let c = 0; c < nCfg; c++) table.push(new Array(levels).fill(1));
      for (const row of discrete) {
        const c = par.length ? configIndex(levels, row, par) : 0;
        table[c][row[i]]++;
      }
      return table.map(r => {
        const t = sum(r);
        return r.map(v => v / t);
      });
    });

    const edges = [];
    parents.forEach((ps, i) => ps.forEach(j => edges.push({ from: names[j], to: names[i] })));
    return { names, levels, parents, cpt, edges, score: sum(localScore) };
  }

  /* ---- 精确推断：枚举所有配置（变量数 ≤ 8、等级 ≤ 4 时可行） ---- */
  function bnJoint(model) {
    const { names, levels, parents, cpt } = model;
    const n = names.length;
    const total = Math.pow(levels, n);
    const joint = new Float64Array(total);
    for (let code = 0; code < total; code++) {
      const row = [];
      let x = code;
      for (let i = n - 1; i >= 0; i--) { row[i] = x % levels; x = Math.floor(x / levels); }
      let prob = 1;
      for (let i = 0; i < n; i++) {
        const par = parents[i];
        const c = par.length ? configIndex(levels, row, par) : 0;
        prob *= cpt[i][c][row[i]];
        if (prob === 0) break;
      }
      joint[code] = prob;
    }
    return joint;
  }

  function bnInfer(model, evidence) {
    const { names, levels } = model;
    const n = names.length;
    const total = Math.pow(levels, n);
    const joint = bnJoint(model);
    const targetIdx = n - 1;
    const post = new Array(levels).fill(0);
    let zsum = 0;
    for (let code = 0; code < total; code++) {
      const row = [];
      let x = code;
      for (let i = n - 1; i >= 0; i--) { row[i] = x % levels; x = Math.floor(x / levels); }
      let ok = true;
      for (const k in evidence) {
        const i = names.indexOf(k);
        if (i >= 0 && row[i] !== evidence[k]) { ok = false; break; }
      }
      if (!ok) continue;
      zsum += joint[code];
      post[row[targetIdx]] += joint[code];
    }
    if (zsum > 0) for (let v = 0; v < levels; v++) post[v] /= zsum;
    return {
      target: names[targetIdx],
      posterior: post,
      evidenceSize: zsum
    };
  }

  /* ---- 敏感度：把某变量逐档固定，看目标分布怎么变 ---- */
  function bnSensitivity(model, varName, levels) {
    const out = [];
    for (let v = 0; v < levels; v++) {
      const ev = {};
      ev[varName] = v;
      const r = bnInfer(model, ev);
      out.push({ state: v, posterior: r.posterior });
    }
    return out;
  }

  /* ---- 导出校准后的数据为 CSV ---- */
  function toCSV(columns, rows) {
    const esc = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [columns.map(esc).join(',')]
      .concat(rows.map(r => r.map(esc).join(',')))
      .join('\n');
  }

"""

marker = "  global.DACCore = {"
assert marker in s
s = s.replace(marker, EXTRA + marker)

old_export = "    parseCSV, parseXLSX, profile, corrMatrix, calibrate, pearson, robustScale,"
new_export = ("    parseCSV, parseXLSX, profile, corrMatrix, calibrate, pearson, robustScale,\n"
              "    crossValidate, elbowCurve, robustness, nameScenarios,\n"
              "    bnLearn, bnInfer, bnSensitivity, toCSV,")
assert old_export in s
s = s.replace(old_export, new_export)

p.write_text(s, encoding="utf-8")
print("core extended:", len(s), "chars")
for k in ["crossValidate", "elbowCurve", "robustness", "nameScenarios", "bnLearn", "bnInfer", "toCSV"]:
    print(f"  {k}:", ("function " + k) in s)
