/* ============================================================
 * DAC Workbench V2.9 · Bootstrap 稳定性引擎
 * 支持：IID / 分组(Cluster) / 分层(Stratified) / 加权 重采样
 * 评价：ARI / NMI / 共聚类矩阵 / 规则签名频率 / 网络边频率
 * 原则：稳定性 ≠ 准确率；边频率 ≠ 因果概率
 * ============================================================ */
(function (global) {
  'use strict';

  const EPS = 1e-12;

  /* ---------------- 组合数（数值稳定版） ---------------- */
  function comb2(n) { return n < 2 ? 0 : n * (n - 1) / 2; }

  /* ---------------- ARI：标签置换不变 ---------------- */
  function ari(a, b) {
    const n = a.length;
    if (n !== b.length || n === 0) return NaN;
    const ca = new Map(), cb = new Map(), cab = new Map();
    for (let i = 0; i < n; i++) {
      ca.set(a[i], (ca.get(a[i]) || 0) + 1);
      cb.set(b[i], (cb.get(b[i]) || 0) + 1);
      const key = a[i] + '|' + b[i];
      cab.set(key, (cab.get(key) || 0) + 1);
    }
    let sumCab = 0;
    for (const v of cab.values()) sumCab += comb2(v);
    let sumA = 0, sumB = 0;
    for (const v of ca.values()) sumA += comb2(v);
    for (const v of cb.values()) sumB += comb2(v);
    const total = comb2(n);
    const expected = (sumA * sumB) / (total || EPS);
    const maxIndex = 0.5 * (sumA + sumB);
    const denom = maxIndex - expected;
    if (Math.abs(denom) < EPS) return (Math.abs(sumCab - expected) < EPS) ? 1 : 0;
    return (sumCab - expected) / denom;
  }

  /* ---------------- NMI（算术平均归一化） ---------------- */
  function nmi(a, b) {
    const n = a.length;
    if (!n) return NaN;
    const ca = new Map(), cb = new Map(), cab = new Map();
    for (let i = 0; i < n; i++) {
      ca.set(a[i], (ca.get(a[i]) || 0) + 1);
      cb.set(b[i], (cb.get(b[i]) || 0) + 1);
      const k = a[i] + '|' + b[i];
      cab.set(k, (cab.get(k) || 0) + 1);
    }
    let mi = 0;
    const back = (v) => (/^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : v);
    for (const [k, v] of cab) {
      const parts = k.split('|');
      const px = (ca.get(back(parts[0])) || 0) / n;
      const py = (cb.get(back(parts[1])) || 0) / n;
      const pxy = v / n;
      if (px > 0 && py > 0 && pxy > 0) mi += pxy * Math.log(pxy / (px * py) + EPS);
    }
    const ent = (m) => {
      let h = 0;
      for (const v of m.values()) { const p = v / n; h -= p * Math.log(p + EPS); }
      return h;
    };
    const ha = ent(ca), hb = ent(cb);
    if (ha + hb < EPS) return 1;
    return 2 * mi / (ha + hb);
  }

  /* ---------------- 抽样：IID / 分组 / 分层 / 加权 ---------------- */
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 生成一次重采样的索引。
   * @param {object} o { n, B, seed, fraction, replacement, method, groups, strata, weights }
   * @returns {Array<Array<number>>} 每次的索引数组（长度可能 < n）
   */
  function sampleIndices(o) {
    const n = o.n;
    const B = o.B;
    const frac = o.fraction === undefined ? 1 : o.fraction;
    const repl = o.replacement !== false;
    const rnd = makeRng(o.seed === undefined ? 42 : o.seed);
    const out = [];

    const pickWeighted = (pool, k) => {
      // 权重抽样的系统抽样（PPS），避免 O(n·k)
      const w = pool.map(i => (o.weights && o.weights[i] > 0 ? o.weights[i] : 1));
      const total = w.reduce((a, b) => a + b, 0);
      const res = [];
      const step = total / k;
      let pos = rnd() * step;
      let acc = 0, idx = 0;
      for (let c = 0; c < k; c++) {
        const target = pos + c * step;
        while (idx < pool.length - 1 && acc + w[idx] < target) { acc += w[idx]; idx++; }
        res.push(pool[idx]);
      }
      return res;
    };

    for (let b = 0; b < B; b++) {
      let idx = [];
      const k = Math.max(2, Math.round(n * frac));

      if (o.method === 'group' && o.groups) {
        // 整组重采样：组是被抽单位，组内全部记录一起进入
        const byGroup = new Map();
        o.groups.forEach((g, i) => {
          const key = String(g);
          if (!byGroup.has(key)) byGroup.set(key, []);
          byGroup.get(key).push(i);
        });
        const keys = [...byGroup.keys()];
        const picked = [];
        for (let c = 0; c < keys.length; c++) {
          const gk = keys[Math.floor(rnd() * keys.length)];
          picked.push(...byGroup.get(gk));
        }
        idx = picked;
      } else if (o.method === 'stratified' && o.strata) {
        // 分层重采样：每层内独立抽样，保持层结构
        const byStratum = new Map();
        o.strata.forEach((s, i) => {
          const key = String(s);
          if (!byStratum.has(key)) byStratum.set(key, []);
          byStratum.get(key).push(i);
        });
        for (const pool of byStratum.values()) {
          const take = Math.max(1, Math.round(pool.length * frac));
          for (let c = 0; c < take; c++) idx.push(pool[Math.floor(rnd() * pool.length)]);
        }
      } else if (o.method === 'weighted' && o.weights) {
        const kk = repl ? k : Math.min(k, n);
        idx = pickWeighted([...Array(n).keys()], kk);
      } else {
        // IID
        if (repl) {
          for (let c = 0; c < k; c++) idx.push(Math.floor(rnd() * n));
        } else {
          const pool = [...Array(n).keys()];
          for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
          }
          idx = pool.slice(0, k);
        }
      }
      out.push(idx);
    }
    return out;
  }

  /* ---------------- 共聚类矩阵 ---------------- */
  /**
   * C(i,j) = 同簇次数 / 共同参与次数
   * 分母为 0 时返回 null（不是 0）——从未共同出现的样本对不等于"不同簇"
   */
  function coCluster(labelsList, n) {
    const same = new Float64Array(n * n);
    const seen = new Float64Array(n * n);
    labelsList.forEach(lab => {
      const present = lab.map(v => v !== null && v !== undefined && v >= 0);
      for (let i = 0; i < n; i++) {
        if (!present[i]) continue;
        for (let j = i; j < n; j++) {
          if (!present[j]) continue;
          seen[i * n + j]++; seen[j * n + i]++;
          if (lab[i] === lab[j]) { same[i * n + j]++; same[j * n + i]++; }
        }
      }
    });
    const co = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      co[i * n + i] = 1;
      for (let j = i + 1; j < n; j++) {
        const d = seen[i * n + j];
        co[i * n + j] = co[j * n + i] = d > 0 ? same[i * n + j] / d : NaN;
      }
    }
    return { matrix: co, seen };
  }

  /* ---------------- 规则签名 ---------------- */
  function ruleSignature(rule) {
    const conds = (rule.conditions || []).map(c => String(c).trim());
    conds.sort();
    return conds.join(' && ') + ' => ' + String(rule.then);
  }

  /* ---------------- 边频率 ---------------- */
  function edgeFrequencies(graphs, nodeNames) {
    const idx = new Map(nodeNames.map((n, i) => [n, i]));
    const P = nodeNames.length;
    const fwd = new Float64Array(P * P);
    const rev = new Float64Array(P * P);
    let okCount = 0;
    graphs.forEach(g => {
      if (!g || !g.edges) return;
      okCount++;
      g.edges.forEach(e => {
        const i = idx.get(e.from), j = idx.get(e.to);
        if (i === undefined || j === undefined) return;
        fwd[i * P + j]++;
      });
    });
    // 反向 = 另一次采样里出现了相反方向
    graphs.forEach(g => {
      if (!g || !g.edges) return;
      g.edges.forEach(e => {
        const i = idx.get(e.from), j = idx.get(e.to);
        if (i === undefined || j === undefined) return;
        rev[j * P + i]++;
      });
    });
    return { fwd, rev, okCount, P, nodeNames };
  }

  /* 共识网络：阈值筛边 + DAG 检查 */
  function consensusGraph(edges, nodeNames, threshold) {
    const sel = edges.filter(e => e.freq >= threshold);
    const adj = new Map(nodeNames.map(n => [n, []]));
    sel.sort((a, b) => b.freq - a.freq);
    const kept = [];
    const hasPath = (from, to) => {
      const seen = new Set();
      const stack = [from];
      while (stack.length) {
        const cur = stack.pop();
        if (cur === to) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        (adj.get(cur) || []).forEach(x => stack.push(x));
      }
      return false;
    };
    sel.forEach(e => {
      if (hasPath(e.to, e.from)) return;   // 会成环 → 丢弃
      adj.get(e.from).push(e.to);
      kept.push(e);
    });
    return { edges: kept, dropped: sel.length - kept.length, acyclic: true };
  }

  /* ---------------- 主流程 ---------------- */
  /**
   * @param {object} data { X, y, groups, weights, strata, names, labels, params }
   * @param {object} opt  { B, seed, fraction, replacement, method, task, k, maxDepth, ... }
   * @param {function} onProgress
   */
  function run(data, opt, onProgress) {
    const C = global.DACCore || (typeof window !== 'undefined' && window.DACCore);
    const P = global.DACPre || (typeof window !== 'undefined' && window.DACPre);
    if (!C) throw new Error('缺少 DACCore');
    const o = Object.assign({
      B: 200, seed: 42, fraction: 1, replacement: true, method: 'iid',
      task: 'cluster', k: 3, maxDepth: 3, minLeaf: 10, levels: 3, drops: 200,
      confidenceLevel: 0.95, bnThreshold: 0.6
    }, opt || {});

    const n = data.X.length;
    const names = data.names || data.X[0].map((_, j) => 'x' + j);
    const labels = data.labels || ['低', '中', '高', '很高'];
    const t0 = Date.now();
    const runs = [];
    let failed = 0;

    const idxList = sampleIndices({
      n, B: o.B, seed: o.seed, fraction: o.fraction, replacement: o.replacement,
      method: o.method, groups: data.groups, strata: data.strata, weights: data.weights
    });

    for (let b = 0; b < o.B; b++) {
      const idx = idxList[b];
      const rec = { b: b + 1, idx, ok: false };
      const t1 = Date.now();
      try {
        if (o.task === 'cluster') {
          const Xs = idx.map(i => data.X[i]);
          // 预处理只在重采样内拟合
          const im = P ? P.fitImputer(Xs, names, { strategy: o.impute || 'median' }) : null;
          const Xf = im ? P.transformImputer(Xs, im, Xs).matrix : Xs;
          const km = C.kmeans(Xf, o.k, { seed: o.seed + b, nInit: 4 });
          // 统一参考集：把模型应用到全部原始样本
          // 关键：先用 km 的 med/iqr 把参考集映射到与 centers 相同的标准化空间，
          // 否则距离是「原始值 vs 标准化中心」，标签会退化成常数。
          const Ref = im ? P.transformImputer(data.X, im, Xs).matrix : data.X;
          const refLabels = Ref.map(r => {
            const z = r.map((v, j) => {
              const sc = (v - km.med[j]) / km.iqr[j];
              return Math.max(-5, Math.min(5, sc));
            });
            let best = 0, bestD = Infinity;
            for (let c = 0; c < km.centers.length; c++) {
              const d = km.centers[c].reduce((s, v, j) => s + (z[j] - v) ** 2, 0);
              if (d < bestD) { bestD = d; best = c; }
            }
            return best;
          });
          rec.labels = refLabels;
          rec.inSampleLabels = km.labels;
          rec.sizes = km.centers.map((_, c) => refLabels.filter(x => x === c).length);
          rec.inertia = km.inertia;
          rec.emptyClusters = km.emptyClusters || 0;
          rec.silhouette = C.silhouette(km.Z, km.labels);
          rec.ok = true;
        } else if (o.task === 'rules') {
          const Xs = idx.map(i => data.X[i]);
          const ys = idx.map(i => data.y[i]);
          const im = P ? P.fitImputer(Xs, names, { strategy: o.impute || 'median' }) : null;
          const Xf = im ? P.transformImputer(Xs, im, Xs).matrix : Xs;
          const bounds = names.map((_, j) => {
            const col = Xf.map(r => r[j]).filter(v => Number.isFinite(v)).sort((a, c) => a - c);
            if (!col.length) return { lo: 0, hi: 1 };
            const q = (p) => col[Math.min(col.length - 1, Math.floor(p * (col.length - 1)))];
            return { lo: q(0.25), hi: q(0.75) };
          });
          const Xc = names.map((_, j) => C.calibrateWith(Xf.map(r => r[j]), bounds[j], { levels: o.levels, drops: o.drops, seed: o.seed + b }).codes);
          const Xcm = Xs.map((_, i) => names.map((_, j) => Xc[j][i]));
          const ysSorted = [...ys].sort((a, c) => a - c);
          const yq = (p) => ysSorted[Math.min(ysSorted.length - 1, Math.floor(p * (ysSorted.length - 1)))];
          const yB = { lo: yq(0.25), hi: yq(0.75) };
          const yc = C.calibrateWith(ys, yB, { levels: o.levels, drops: o.drops, seed: o.seed + b }).codes;
          const tree = C.cart(Xcm, yc, names, labels, { maxDepth: o.maxDepth, minLeaf: o.minLeaf });
          rec.rules = tree.rules.map(r => Object.assign({ sig: ruleSignature(r) }, r));
          rec.accuracy = tree.accuracy;
          rec.importances = tree.importances;
          rec.rootVar = tree.root && tree.root.f !== undefined ? names[tree.root.f] : null;
          rec.splits = collectSplits(tree.root, names);
          rec.ok = true;
        } else if (o.task === 'bn') {
          const Xs = idx.map(i => data.X[i]);
          const ys = idx.map(i => data.y[i]);
          const allNames = names.concat([data.yName || 'Y']);
          const bounds = names.map((_, j) => {
            const col = Xs.map(r => r[j]).filter(v => Number.isFinite(v)).sort((a, c) => a - c);
            if (!col.length) return { lo: 0, hi: 1 };
            const q = (p) => col[Math.min(col.length - 1, Math.floor(p * (col.length - 1)))];
            return { lo: q(0.25), hi: q(0.75) };
          });
          const Xc = names.map((_, j) => C.calibrateWith(Xs.map(r => r[j]), bounds[j], { levels: o.levels, drops: o.drops, seed: o.seed + b }).codes);
          const yS = [...ys].sort((a, c) => a - c);
          const yq = (p) => yS[Math.min(yS.length - 1, Math.floor(p * (yS.length - 1)))];
          const yc = C.calibrateWith(ys, { lo: yq(0.25), hi: yq(0.75) }, { levels: o.levels, drops: o.drops, seed: o.seed + b }).codes;
          const discrete = Xs.map((_, i) => names.map((_, j) => Xc[j][i]).concat([yc[i]]));
          const bn = C.bnLearn(discrete, allNames, o.levels, { maxParents: 2, seed: o.seed + b });
          rec.graph = { edges: bn.edges, nodeNames: allNames };
          rec.score = bn.score;
          rec.ok = true;
        }
      } catch (e) {
        rec.error = (e && e.message) || String(e);
        failed++;
      }
      rec.ms = Date.now() - t1;
      runs.push(rec);
      if (onProgress && (b % Math.max(1, Math.floor(o.B / 50)) === 0)) {
        onProgress(Math.round((b + 1) / o.B * 100));
      }
    }
    if (onProgress) onProgress(100);

    const summary = summarize(runs, { task: o.task, B: o.B, n, names, labels, k: o.k, threshold: o.bnThreshold });
    return {
      task: o.task,
      B: o.B, seed: o.seed, method: o.method, fraction: o.fraction, replacement: o.replacement,
      n, failed, okCount: runs.filter(r => r.ok).length,
      elapsedMs: Date.now() - t0,
      runs: runs.map(r => ({ b: r.b, ok: r.ok, error: r.error, ms: r.ms, sizes: r.sizes, emptyClusters: r.emptyClusters,
        inertia: r.inertia, silhouette: r.silhouette, accuracy: r.accuracy, rootVar: r.rootVar,
        rules: r.rules ? r.rules.map(x => x.sig) : undefined,
        graph: r.graph ? r.graph.edges : undefined,
        idx: r.idx })),
      summary
    };
  }

  function collectSplits(node, names, out) {
    out = out || [];
    if (!node || node.f === undefined) return out;
    out.push(names[node.f]);
    collectSplits(node.left, names, out);
    collectSplits(node.right, names, out);
    return out;
  }

  /* ---------------- 汇总 ---------------- */
  function summarize(runs, meta) {
    const okRuns = runs.filter(r => r.ok);
    const out = { task: meta.task, okCount: okRuns.length, total: runs.length };

    if (meta.task === 'cluster') {
      const labs = okRuns.map(r => r.labels);
      const n = meta.n;
      // 两两 ARI/NMI
      const aris = [], nmis = [];
      for (let i = 0; i < labs.length; i++) {
        for (let j = i + 1; j < labs.length; j++) {
          aris.push(ari(labs[i], labs[j]));
          nmis.push(nmi(labs[i], labs[j]));
        }
      }
      const q = (arr, p) => {
        if (!arr.length) return NaN;
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
      };
      const co = coCluster(labs, n);
      // 样本级稳定性：该样本与同簇伙伴的平均共聚类概率
      const stability = new Array(n).fill(NaN);
      if (labs.length) {
        const base = labs[0];
        for (let i = 0; i < n; i++) {
          let s = 0, c = 0;
          for (let j = 0; j < n; j++) {
            if (i === j || base[i] !== base[j]) continue;
            const v = co.matrix[i * n + j];
            if (!Number.isNaN(v)) { s += v; c++; }
          }
          stability[i] = c ? s / c : NaN;
        }
      }
      const sizesAll = okRuns.map(r => r.sizes);
      const avgSizes = meta.k ? Array.from({ length: meta.k }, (_, c) =>
        sizesAll.reduce((a, s) => a + (s ? s[c] || 0 : 0), 0) / Math.max(1, sizesAll.length)) : [];
      out.cluster = {
        ari: { mean: meanOf(aris), median: q(aris, 0.5), p05: q(aris, 0.025), p95: q(aris, 0.975), values: aris },
        nmi: { mean: meanOf(nmis), median: q(nmis, 0.5), p05: q(nmis, 0.025), p95: q(nmis, 0.975), values: nmis },
        coCluster: co,
        stability,
        avgSizes,
        emptyRate: okRuns.filter(r => (r.emptyClusters || 0) > 0).length / Math.max(1, okRuns.length),
        silhouetteMean: meanOf(okRuns.map(r => r.silhouette).filter(Number.isFinite))
      };
    } else if (meta.task === 'rules') {
      const freq = new Map();
      const rootFreq = new Map();
      const splitFreq = new Map();
      okRuns.forEach(r => {
        (r.rules || []).forEach(x => freq.set(x.sig, (freq.get(x.sig) || 0) + 1));
        if (r.rootVar) rootFreq.set(r.rootVar, (rootFreq.get(r.rootVar) || 0) + 1);
        (r.splits || []).forEach(v => splitFreq.set(v, (splitFreq.get(v) || 0) + 1));
      });
      const total = Math.max(1, okRuns.length);
      const rules = [...freq.entries()].map(([sig, c]) => ({ sig, count: c, freq: c / total }))
        .sort((a, b) => b.count - a.count);
      out.rules = {
        rules: rules.slice(0, 40),
        ruleCount: rules.length,
        rootVar: [...rootFreq.entries()].map(([v, c]) => ({ name: v, freq: c / total })).sort((a, b) => b.freq - a.freq),
        splitFreq: [...splitFreq.entries()].map(([v, c]) => ({ name: v, freq: c / total })).sort((a, b) => b.freq - a.freq),
        accuracyMean: meanOf(okRuns.map(r => r.accuracy).filter(Number.isFinite)),
        stableRules: rules.filter(x => x.freq >= 0.5).length
      };
    } else if (meta.task === 'bn') {
      const graphs = okRuns.map(r => r.graph);
      const nodeNames = (graphs[0] && graphs[0].nodeNames) || meta.names.concat(['Y']);
      const ef = edgeFrequencies(graphs, nodeNames);
      const P2 = ef.P;
      const edges = [];
      for (let i = 0; i < P2; i++) {
        for (let j = 0; j < P2; j++) {
          if (i === j) continue;
          const f = ef.fwd[i * P2 + j] / Math.max(1, ef.okCount);
          if (f > 0) edges.push({ from: nodeNames[i], to: nodeNames[j], freq: f, revFreq: ef.rev[i * P2 + j] / Math.max(1, ef.okCount) });
        }
      }
      edges.sort((a, b) => b.freq - a.freq);
      const cons = consensusGraph(edges, nodeNames, meta.threshold || 0.6);
      out.bn = {
        nodeNames, edges, okCount: ef.okCount,
        consensus: cons,
        unstable: edges.filter(e => e.freq > 0.1 && e.revFreq > 0.1).length,
        topEdges: edges.slice(0, 20)
      };
    }
    return out;
  }

  function meanOf(a) {
    const v = a.filter(Number.isFinite);
    return v.length ? v.reduce((x, y) => x + y, 0) / v.length : NaN;
  }

  /* ---------------- 诊断 ---------------- */
  function diagnose(result) {
    const items = [];
    const push = (id, name, status, detail) => items.push({ id, name, status, detail });
    const s = result.summary;

    push('sample', '重采样', result.failed === 0 ? 'PASS' : 'WARNING',
      `成功 ${result.okCount}/${result.B} 次${result.failed ? '，失败 ' + result.failed + ' 次' : ''}`);
    push('method', '抽样方法', 'INFO',
      `method=${result.method}，fraction=${result.fraction}，replacement=${result.replacement}`);

    if (s.cluster) {
      const a = s.cluster.ari.mean;
      const verdict = a >= 0.75 ? 'PASS' : a >= 0.5 ? 'WARNING' : 'FAIL';
      push('ari', '聚类结构稳定性（平均 ARI）', verdict,
        `${Number.isFinite(a) ? a.toFixed(3) : 'NaN'}（≥0.75 稳定，0.5~0.75 中等，<0.5 不稳定）`);
      push('empty', '空簇比例', s.cluster.emptyRate > 0.1 ? 'WARNING' : 'PASS',
        `${(s.cluster.emptyRate * 100).toFixed(1)}% 的重采样出现空簇`);
    }
    if (s.rules) {
      const stableRatio = s.rules.ruleCount ? s.rules.stableRules / s.rules.ruleCount : 0;
      push('rule-stable', '规则稳定性', stableRatio >= 0.3 ? 'PASS' : 'WARNING',
        `${s.rules.stableRules}/${s.rules.ruleCount} 条规则在 ≥50% 的重采样中出现`);
    }
    if (s.bn) {
      push('bn-edges', '网络结构稳定性', s.bn.unstable === 0 ? 'PASS' : 'WARNING',
        `${s.bn.edges.length} 条候选边，其中 ${s.bn.unstable} 条方向不稳定（正反向频率都 >10%）`);
      push('bn-dag', '共识网络无环', s.bn.consensus.acyclic ? 'PASS' : 'FAIL',
        `保留 ${s.bn.consensus.edges.length} 条边，因成环丢弃 ${s.bn.consensus.dropped} 条`);
    }
    push('interpretation', '解释边界', 'INFO',
      '稳定性 ≠ 准确率；边频率只表示结构选择的重采样稳定性，不代表因果成立概率');
    return { items, ok: !items.some(i => i.status === 'FAIL') };
  }

  global.DACBootstrap = {
    ari, nmi, sampleIndices, coCluster, ruleSignature, edgeFrequencies, consensusGraph,
    run, summarize, diagnose, comb2
  };
})(typeof window !== 'undefined' ? window : self);
