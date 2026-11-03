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
  /**
   * 生成 B 组重采样索引。
   * 抽样契约（违反直接报错，不静默降级为 IID）：
   *  - group      : 必须给 groups（长度 = n），整组进出
   *  - stratified : 必须给 strata（长度 = n），层内独立抽
   *  - weighted   : 必须给 weights（长度 = n，非负有限、不全零）；零权重永不被抽中
   *  - pps        : 系统 PPS（与 weighted 区分：这是"按规模系统抽"，不是多项重采样）
   *  - block      : 见 sampleBlockIndices
   */
  function sampleIndices(o) {
    const n = o.n, B = o.B;
    const frac = o.fraction === undefined ? 1 : o.fraction;
    const repl = o.replacement !== false;
    const rnd = makeRng(o.seed === undefined ? 42 : o.seed);
    const out = [];
    const meta = { method: o.method || 'iid', replacement: repl, fraction: frac, unit: 'row', groupsSampled: null };

    /* ---------- 契约校验 ---------- */
    const checkLen = (arr, name) => {
      if (!arr || arr.length !== n) {
        throw new Error(`${name} 抽样未提供合法的 ${name} 向量（需长度 ${n}，实际 ${arr ? arr.length : 0}）。` +
          '请在界面上指定对应的列，或改用 IID 抽样。');
      }
    };
    if (o.method === 'group') checkLen(o.groups, '分组');
    if (o.method === 'stratified') checkLen(o.strata, '分层');
    if (o.method === 'weighted' || o.method === 'pps') {
      checkLen(o.weights, '加权');
      if (o.weights.some(v => !Number.isFinite(v) || v < 0)) {
        throw new Error('权重必须是非负有限数（发现负数或 NaN）。');
      }
      if (o.weights.every(v => v === 0)) {
        throw new Error('权重列全为 0，无法抽样。');
      }
    }

    if (o.method === 'block') {
      // 关键：把 fraction / replacement 传下去。旧实现没传，导致
      // 「请求 fraction=0.2 无放回」实际抽满 n 且重复，请求参数与实际执行不一致。
      const r = sampleBlockIndices({
        n, B, seed: o.seed, blockType: o.blockType, blockLength: o.blockLength,
        fraction: frac, replacement: repl
      });
      r.indices.meta = Object.assign({}, meta, {
        blockType: r.type, blockLength: r.blockLength, target: r.target
      });
      return r.indices;
    }

    /* ---------- 工具 ---------- */
    // 标准加权多项抽样：累积权重 + 二分，允许重复（有放回的定义）
    const pickMultinomial = (pool, k) => {
      const w = pool.map(i => (Number.isFinite(o.weights[i]) && o.weights[i] > 0 ? o.weights[i] : 0));
      const total = w.reduce((a, b) => a + b, 0);
      const cum = [];
      let acc = 0;
      for (let i = 0; i < pool.length; i++) { acc += w[i]; cum.push(acc); }
      const res = [];
      for (let c = 0; c < k; c++) {
        const u = rnd() * total;
        let lo = 0, hi = cum.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cum[mid] <= u) lo = mid + 1; else hi = mid;
        }
        res.push(pool[lo]);
      }
      return res;
    };
    // 系统 PPS：按累计规模等距取点（与多项抽样不同，不产生"同一样本被抽多次"的独立计数）
    const pickPPS = (pool, k) => {
      const w = pool.map(i => (Number.isFinite(o.weights[i]) && o.weights[i] > 0 ? o.weights[i] : 0));
      const total = w.reduce((a, b) => a + b, 0);
      const step = total / k;
      const res = [];
      let pos = rnd() * step;
      for (let c = 0; c < k; c++) {
        const target = pos + c * step;
        let acc = 0, chosen = pool[pool.length - 1];
        for (let i = 0; i < pool.length; i++) {
          acc += w[i];
          if (acc > target) { chosen = pool[i]; break; }
        }
        res.push(chosen);
      }
      return res;
    };

    /* ---------- 抽样 ---------- */
    for (let b = 0; b < B; b++) {
      let idx = [];
      const k = Math.max(2, Math.round(n * frac));

      if (o.method === 'group') {
        const byGroup = new Map();
        o.groups.forEach((g, i) => {
          const key = String(g);
          if (!byGroup.has(key)) byGroup.set(key, []);
          byGroup.get(key).push(i);
        });
        const keys = [...byGroup.keys()];
        const picked = [];
        if (repl) {
          // 有放回：抽 keys.length 个组，允许重复（整组进入）
          for (let c = 0; c < keys.length; c++) {
            const gk = keys[Math.floor(rnd() * keys.length)];
            picked.push(...byGroup.get(gk));
          }
          meta.groupsSampled = keys.length;
        } else {
          // 不放回：组不重复，随机排列后取前 ceil(组数×frac) 个
          const order = keys.slice();
          for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            const t = order[i]; order[i] = order[j]; order[j] = t;
          }
          const take = Math.max(1, Math.round(order.length * frac));
          for (let c = 0; c < take; c++) picked.push(...byGroup.get(order[c]));
          meta.groupsSampled = take;
        }
        idx = picked;
        meta.unit = 'group';
      } else if (o.method === 'stratified') {
        const byStratum = new Map();
        o.strata.forEach((sv, i) => {
          const key = String(sv);
          if (!byStratum.has(key)) byStratum.set(key, []);
          byStratum.get(key).push(i);
        });
        for (const pool of byStratum.values()) {
          const take = Math.max(1, Math.round(pool.length * frac));
          if (repl) {
            for (let c = 0; c < take; c++) idx.push(pool[Math.floor(rnd() * pool.length)]);
          } else {
            // 层内不放回：洗牌取前 take 个
            const ord = pool.slice();
            for (let i = ord.length - 1; i > 0; i--) {
              const j = Math.floor(rnd() * (i + 1));
              const t = ord[i]; ord[i] = ord[j]; ord[j] = t;
            }
            for (let c = 0; c < Math.min(take, ord.length); c++) idx.push(ord[c]);
          }
        }
        meta.unit = 'stratum';
      } else if (o.method === 'weighted') {
        if (!repl) {
          throw new Error('加权抽样只支持有放回（加权不放回没有标准定义）。请改用有放回，或去掉权重。');
        }
        idx = pickMultinomial([...Array(n).keys()], k);
        meta.unit = 'weighted';
      } else if (o.method === 'pps') {
        idx = pickPPS([...Array(n).keys()], k);
        meta.unit = 'pps';
      } else {
        // IID
        if (repl) {
          for (let c = 0; c < k; c++) idx.push(Math.floor(rnd() * n));
        } else {
          const pool = [...Array(n).keys()];
          for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
          }
          idx = pool.slice(0, Math.min(k, n));
        }
      }
      out.push(idx);
    }

    // 不放回必须唯一
    if (!repl && o.method !== 'group' && o.method !== 'stratified') {
      out.forEach((idx, bi) => {
        const u = new Set(idx);
        if (u.size !== idx.length) {
          throw new Error(`第 ${bi + 1} 轮不放回抽样出现重复索引（${idx.length} 个中有 ${idx.length - u.size} 个重复）`);
        }
      });
    }
    out.meta = meta;
    return out;
  }

  /* ---------------- Block Bootstrap（时间依赖） ---------------- */
  /**
   * 三种块抽样，块内保留时间顺序，用于存在自相关的序列数据。
   *  - moving   : 起点 0..n-b，取连续 b 个（块数 ⌈n/b⌉）
   *  - circular : 起点 0..n-1，取 b 个但越过 n 回绕到开头
   *  - stationary: 块长服从几何分布（均值 L），P(继续)=1-1/L
   */
  function sampleBlockIndices(o) {
    const n = o.n, B = o.B;
    const frac = (o.fraction === undefined) ? 1 : Number(o.fraction);
    if (!(frac > 0 && frac <= 1)) {
      throw new Error(`块抽样的 fraction 必须在 (0,1]，收到 ${o.fraction}`);
    }
    // 块抽样在统计上依赖"有放回地抽整块"；无放回块抽样会破坏块内相关性结构，
    // 且与 fraction 的组合在文献里没有公认定义 —— 明确拒绝，不能静默抽满 n。
    if (o.replacement === false && frac < 1) {
      throw new Error('块抽样不支持「无放回 + fraction<1」：块抽样按有放回抽整块定义，'
        + '无放回且不足全量会破坏块内相关结构。请改回有放回，或把 fraction 设为 1。');
    }
    const target = Math.max(1, Math.round(n * frac));
    const rnd = makeRng(o.seed === undefined ? 42 : o.seed);
    const L = Math.max(2, Math.min(n, Math.round(o.blockLength || Math.max(2, Math.round(Math.sqrt(n))))));
    const type = o.blockType || 'moving';
    const out = [];

    if (type === 'stationary') {
      // Politis & Romano (1994)：每步以概率 1/L 重新起块，否则接上一个
      for (let b = 0; b < B; b++) {
        const idx = [];
        let cur = Math.floor(rnd() * n);
        for (let i = 0; i < target; i++) {
          idx.push(cur);
          if (rnd() < 1 / L) cur = Math.floor(rnd() * n);
          else cur = (cur + 1) % n;
        }
        out.push(idx);
      }
      return { indices: out, blockLength: L, type, fraction: frac, target };
    }

    const blockCount = Math.ceil(target / L);
    for (let b = 0; b < B; b++) {
      const idx = [];
      for (let k = 0; k < blockCount && idx.length < target; k++) {
        let start;
        if (type === 'circular') start = Math.floor(rnd() * n);
        else start = Math.floor(rnd() * Math.max(1, n - L + 1));   // moving
        for (let j = 0; j < L && idx.length < target; j++) {
          idx.push((start + j) % n);
        }
      }
      out.push(idx);
    }
    return { indices: out, blockLength: L, type, fraction: frac, target };
  }

  /* ---------------- 内存估算 ---------------- */
  function memoryEstimate(n, B) {
    // 共聚类矩阵 n×n 两个 Float64Array
    const coBytes = n * n * 8 * 2;
    // 每次重采样保存 n 个标签
    const labelBytes = B * n * 4;
    const total = coBytes + labelBytes;
    return {
      n, B,
      coClusterMB: +(coBytes / 1048576).toFixed(1),
      labelsMB: +(labelBytes / 1048576).toFixed(1),
      totalMB: +(total / 1048576).toFixed(1),
      // 建议：超过 512 MB 就别算完整矩阵
      mode: total > 512 * 1048576 ? 'sample-pairs'
        : total > 128 * 1048576 ? 'sparse'
        : 'full'
    };
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
    lowPct: 25, highPct: 75, targetType: 'continuous',
      task: 'cluster', k: 3, maxDepth: 3, minLeaf: 10, levels: 3, drops: 200,
      confidenceLevel: 0.95, bnThreshold: 0.6
    }, opt || {});

    const n = data.X.length;
    const names = data.names || data.X[0].map((_, j) => 'x' + j);
    const factorLevels = names.map((_,j) =>
      C.detectTargetType(data.X.map(row => row[j])).type === 'binary' ? 2 : o.levels);
    const labels = data.labels || ['低', '中', '高', '很高'];
    const t0 = Date.now();
    const runs = [];
    let failed = 0;

    const idxList = sampleIndices({
      n, B: o.B, seed: o.seed, fraction: o.fraction, replacement: o.replacement,
      method: o.method, groups: data.groups, strata: data.strata, weights: data.weights,
      blockType: o.blockType, blockLength: o.blockLength
    });

    for (let b = 0; b < o.B; b++) {
      const idx = idxList[b];
      const rec = { b: b + 1, idx, ok: false };
      const t1 = Date.now();
      // OOB（袋外）索引：本次重采样中从未被抽到的样本
      const inBag = new Set(idx);
      const oobIdx = [];
      for (let i = 0; i < n; i++) if (!inBag.has(i)) oobIdx.push(i);
      rec.oobIdx = oobIdx;
      rec.oobCoverage = oobIdx.length / n;
      try {
        if (o.task === 'cluster') {
          const Xs = idx.map(i => data.X[i]);
          // 预处理只在重采样内拟合
          const im = P ? P.fitImputer(Xs, names, { strategy: o.impute || 'median' }) : null;
          const Xf = im ? P.transformImputer(Xs, im, Xs).matrix : Xs;
          // nInit 降到 2：Bootstrap 关心的是"这次重采样得到的结构"，不是全局最优
          const km = C.kmeans(Xf, o.k, { seed: o.seed + b, nInit: 2 });
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
          // silhouette 是 O(n²)：400 样本 × 20 轮 = 320 万次距离计算，
          // 实测光这一步就让 Bootstrap 跑到 331s。它不参与稳定性统计
          // （稳定性看 ARI/NMI/共聚类矩阵），只在需要时算一次。
          if (o.wantSilhouette) {
            rec.silhouette = C.silhouette(km.Z, km.labels);
          }
          rec.ok = true;
        } else if (o.task === 'rules') {
          const Xs = idx.map(i => data.X[i]);
          const ys = idx.map(i => data.y[i]);
          const im = P ? P.fitImputer(Xs, names, { strategy: o.impute || 'median' }) : null;
          const Xf = im ? P.transformImputer(Xs, im, Xs).matrix : Xs;
          const loP = (o.lowPct === undefined ? 25 : o.lowPct) / 100;
          const hiP = (o.highPct === undefined ? 75 : o.highPct) / 100;
          const bounds = names.map((_, j) => {
            const col = Xf.map(r => r[j]).filter(v => Number.isFinite(v)).sort((a, c) => a - c);
            if (!col.length) return { lo: 0, hi: 1 };
            const q = (p) => col[Math.min(col.length - 1, Math.floor(p * (col.length - 1)))];
            const lo = q(loP), hi = q(hiP);
            // lo === hi（常量列或高度集中）时给一个极小跨度，避免下游除 0
            if (!(hi > lo)) return { lo: lo, hi: lo + Math.max(1e-9, Math.abs(lo) * 1e-9) };
            return { lo, hi };
          });
          const Xc = names.map((_, j) => C.calibrateWith(Xf.map(r => r[j]), bounds[j], { levels: factorLevels[j], drops: o.drops, seed: o.seed + b }).codes);
          const Xcm = Xs.map((_, i) => names.map((_, j) => Xc[j][i]));
          const ysSorted = [...ys].filter(Number.isFinite).sort((a, c) => a - c);
          const yq = (p) => ysSorted[Math.min(ysSorted.length - 1, Math.floor(p * (ysSorted.length - 1)))];
          const yType = o.targetType || 'continuous';
          const targetLevels = o.targetLevels || C.encodeTarget(data.y, {targetType:yType}).levelValues;
          const targetEncoded = C.encodeTarget(ys, Object.assign({},o,{targetType:yType,targetLevels,seed:o.seed+b}));
          const yc = targetEncoded.codes;
          const yB = targetEncoded.discrete ? null : {lo:targetEncoded.lo,hi:targetEncoded.hi};
          const targetLabels = targetEncoded.labels;
          const tree = C.cart(Xcm, yc, names, targetLabels, {
            maxDepth: o.maxDepth, minLeaf: o.minLeaf,
            featureLabels: factorLevels.map(lv => C.LEVEL_LABELS[lv])
          });
          rec.rules = tree.rules.map(r => Object.assign({ sig: ruleSignature(r) }, r));
          rec.accuracy = tree.accuracy;

          // OOB 评估：用未进袋的样本做外部验证
          if (oobIdx.length >= 5) {
            try {
              const XoobRaw = oobIdx.map(i => data.X[i]);
              const XoobImp = im ? P.transformImputer(XoobRaw, im, Xs).matrix : XoobRaw;
              const XoobCols = names.map((_, j) =>
                C.calibrateWith(XoobImp.map(r => r[j]), bounds[j], { levels: factorLevels[j], drops: o.drops, seed: o.seed + b }).codes);
              const XoobCodes = XoobImp.map((_, i) => names.map((_, j) => XoobCols[j][i]));
              const yOobRaw = oobIdx.map(i => data.y[i]);
              let yOobCodes;
              if (yB === null) {
                yOobCodes = C.encodeTarget(yOobRaw,{targetType:yType,targetLevels}).codes;
              } else {
                yOobCodes = C.calibrateWith(yOobRaw, yB, { levels: o.levels, drops: o.drops, seed: o.seed + b }).codes;
              }
              const pred = XoobCodes.map(r => C.predictTree(tree.root, r));
              rec.oob = C.evalMetrics(yOobCodes, pred, targetEncoded.levels);
            } catch (e2) {
              rec.oobError = (e2 && e2.message) || String(e2);
            }
          }
          rec.importances = tree.importances;
          rec.rootVar = tree.root && tree.root.f !== undefined ? names[tree.root.f] : null;
          rec.splits = collectSplits(tree.root, names);
          rec.ok = true;
        } else if (o.task === 'bn') {
          const Xs = idx.map(i => data.X[i]);
          const ys = idx.map(i => data.y[i]);
          const allNames = names.concat([data.yName || 'Y']);
          const loP2 = (o.lowPct === undefined ? 25 : o.lowPct) / 100;
          const hiP2 = (o.highPct === undefined ? 75 : o.highPct) / 100;
          const bounds = names.map((_, j) => {
            const col = Xs.map(r => r[j]).filter(v => Number.isFinite(v)).sort((a, c) => a - c);
            if (!col.length) return { lo: 0, hi: 1 };
            const q = (p) => col[Math.min(col.length - 1, Math.floor(p * (col.length - 1)))];
            const lo = q(loP2), hi = q(hiP2);
            if (!(hi > lo)) return { lo: lo, hi: lo + Math.max(1e-9, Math.abs(lo) * 1e-9) };
            return { lo, hi };
          });
          const Xc = names.map((_, j) => C.calibrateWith(Xs.map(r => r[j]), bounds[j], { levels: factorLevels[j], drops: o.drops, seed: o.seed + b }).codes);
          const yS = [...ys].filter(Number.isFinite).sort((a, c) => a - c);
          const yq = (p) => yS[Math.min(yS.length - 1, Math.floor(p * (yS.length - 1)))];
          const yType2 = o.targetType || 'continuous';
          const targetLevels = o.targetLevels || C.encodeTarget(data.y,{targetType:yType2}).levelValues;
          const encoded = C.encodeTarget(ys,Object.assign({},o,{targetType:yType2,targetLevels,seed:o.seed+b}));
          const yc = encoded.codes;
          const discrete = Xs.map((_, i) => names.map((_, j) => Xc[j][i]).concat([yc[i]]));
          const bn = C.bnLearn(discrete, allNames, o.levels, {
            maxParents:2, seed:o.seed+b, cardinalities:factorLevels.concat([encoded.levels])
          });
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
      targetContract: {type:o.targetType||'continuous', levels:o.targetLevels||C.encodeTarget(data.y,{targetType:o.targetType||'continuous'}).levelValues},
      B: o.B, seed: o.seed, method: o.method, fraction: o.fraction, replacement: o.replacement,
      blockType: o.blockType || null, blockLength: o.blockLength || null,
      memory: memoryEstimate(n, o.B),
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
      // OOB 汇总（只统计成功算出 OOB 的重采样）
      const oobRuns = okRuns.filter(r => r.oob);
      const oobAcc = oobRuns.map(r => r.oob.accuracy).filter(Number.isFinite);
      const oobBA = oobRuns.map(r => r.oob.balancedAccuracy).filter(Number.isFinite);
      const oobF1 = oobRuns.map(r => r.oob.macroF1).filter(Number.isFinite);
      const oobCov = okRuns.map(r => r.oobCoverage).filter(Number.isFinite);
      out.rules = {
        oob: oobRuns.length ? {
          runs: oobRuns.length,
          accuracy: meanOf(oobAcc), accuracySd: sdOf(oobAcc),
          balancedAccuracy: meanOf(oobBA), macroF1: meanOf(oobF1),
          coverage: meanOf(oobCov)
        } : null,
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

  function sdOf(a) {
    const v = a.filter(Number.isFinite);
    if (v.length < 2) return NaN;
    const m = v.reduce((x, y) => x + y, 0) / v.length;
    return Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / (v.length - 1));
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
    run, summarize, diagnose, comb2, sampleBlockIndices, memoryEstimate, sdOf
  };
})(typeof window !== 'undefined' ? window : self);
