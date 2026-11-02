/* ============================================================
 * DAC Workbench V2.1 · 预处理模块（缺失值填补 + 严格隔离）
 * 设计原则：
 *   1) fit 只接收训练数据，transform 不得修改已拟合参数
 *   2) KNN 的参考集永远是训练集（验证/测试样本之间不得互为邻居）
 *   3) 目标变量与 ID 列不参与距离计算，也不被填补
 *   4) 一切回退（fallback）都要记账，不静默
 * ============================================================ */
(function (global) {
  'use strict';

  const EPS = 1e-9;
  const isNull = v => v === null || v === undefined ||
    (typeof v === 'number' && !Number.isFinite(v)) ||
    (typeof v === 'string' && v.trim() === '');

  /* ---------------- 类型推断 ---------------- */
  function inferType(values, opts) {
    const o = opts || {};
    const seen = values.filter(v => !isNull(v));
    if (!seen.length) return 'empty';
    const nums = seen.filter(v => typeof v === 'number');
    const strs = seen.filter(v => typeof v === 'string');
    // 纯数值，且唯一值不太少 → 数值型
    if (nums.length === seen.length) {
      const uniq = new Set(seen).size;
      if (uniq <= 2) return 'binary';
      return 'num';
    }
    // 混合：能转数字的比例 > 80% 视为数值（保留原始字符串由调用方转换）
    if (nums.length / seen.length > 0.8) return 'num';
    // 名字像 ID 的
    if (o.name && /(^id$|_id$|编号|序号|代码)/i.test(String(o.name))) return 'id';
    const uniq = new Set(seen.map(String)).size;
    if (uniq === seen.length && seen.length > 10) return 'id';   // 全唯一 → 疑似 ID
    if (uniq <= 2) return 'binary';
    return 'cat';
  }

  /* ---------------- 列统计（仅训练集） ---------------- */
  function colStats(values) {
    const vals = values.filter(v => !isNull(v));
    const nums = vals.filter(v => typeof v === 'number');
    const st = {
      n: values.length,
      valid: vals.length,
      missing: values.length - vals.length,
      mean: null, median: null, mode: null, min: null, max: null,
      allMissing: vals.length === 0
    };
    if (nums.length) {
      const s = [...nums].sort((a, b) => a - b);
      st.mean = s.reduce((a, b) => a + b, 0) / s.length;
      const mid = Math.floor(s.length / 2);
      st.median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
      st.min = s[0];
      st.max = s[s.length - 1];
    }
    if (vals.length) {
      const cnt = new Map();
      vals.forEach(v => cnt.set(v, (cnt.get(v) || 0) + 1));
      let best = null, bestN = -1;
      // 频数相同时取"先出现的"以保证可复现
      for (const [k, c] of cnt) { if (c > bestN) { bestN = c; best = k; } }
      st.mode = best;
      st.uniq = cnt.size;
    }
    return st;
  }

  /* ---------------- fit：只吃训练数据 ---------------- */
  /**
   * @param {Array<Array>} train    训练矩阵（可含 null）
   * @param {Array<string>} names   列名
   * @param {object} opts
   *   strategy: 'mean'|'median'|'mode'|'knn'|'drop'   （全局默认）
   *   perColumn: {列名: strategy}                        （按列覆盖）
   *   knn: { k, weighted }
   *   fallback: 'mean'|'median'|'mode'                  （KNN 失败时用）
   *   skipColumns: [列名]                                （目标/ID，不填补）
   * @returns {object} model（可直接序列化，用于审计）
   */
  function fitImputer(train, names, opts) {
    const o = opts || {};
    const p = names.length;
    const skip = new Set(o.skipColumns || []);
    const perColumn = o.perColumn || {};
    const stats = [];
    const types = [];
    const strategies = [];
    const fillValues = [];

    for (let j = 0; j < p; j++) {
      const col = train.map(r => r[j]);
      const st = colStats(col);
      const type = inferType(col, { name: names[j] });
      stats.push(st);
      types.push(type);

      const wanted = skip.has(names[j]) ? 'none'
        : (perColumn[names[j]] || o.strategy || 'mean');
      let strat = wanted;
      // 空列无法用统计量填补
      if (strat !== 'none' && strat !== 'drop' && st.allMissing) strat = 'constant';
      // KNN 需要至少一个可参考的其他列，单列数据下退化为统计量
      if (strat === 'knn' && p - (skip.size) < 2) strat = 'median';
      // 分类列不能求均值
      if ((strat === 'mean' || strat === 'median') && (type === 'cat' || type === 'binary')) strat = 'mode';
      strategies.push(strat);

      let fill = null;
      if (strat === 'mean') fill = st.mean;
      else if (strat === 'median') fill = st.median;
      else if (strat === 'mode') fill = st.mode;
      else if (strat === 'constant') fill = st.mode !== null ? st.mode : 0;
      fillValues.push(fill === undefined ? null : fill);
    }

    return {
      version: 'v2.1',
      names: names.slice(),
      nTrain: train.length,
      p,
      types,
      strategies,
      stats,
      fillValues,
      skipColumns: [...skip],
      knn: {
        k: Math.max(1, (o.knn && o.knn.k) || 5),
        weighted: !!(o.knn && o.knn.weighted)
      },
      fallback: o.fallback || 'median',
      // 距离归一化所需的训练集范围（只由训练集决定）
      ranges: stats.map(st => (st.min !== null && st.max !== null && st.max > st.min) ? (st.max - st.min) : 0),
      fittedAt: Date.now()
    };
  }

  /* ---------------- 距离：Gower（只用双方都非缺失的列） ---------------- */
  function gowerDistance(a, b, model, skipIdx) {
    let sum = 0, wsum = 0;
    for (let j = 0; j < model.p; j++) {
      if (skipIdx.has(j)) continue;
      const va = a[j], vb = b[j];
      if (isNull(va) || isNull(vb)) continue;
      const t = model.types[j];
      let d;
      if (t === 'num') {
        const range = model.ranges[j] || 1;
        d = Math.abs((typeof va === 'number' ? va : Number(va)) - (typeof vb === 'number' ? vb : Number(vb))) / range;
        if (!Number.isFinite(d)) continue;
      } else {
        d = String(va) === String(vb) ? 0 : 1;
      }
      sum += d; wsum += 1;
    }
    if (wsum === 0) return null;      // 没有共同有效特征
    return sum / wsum;                // 按有效特征数校正
  }

  /* ---------------- KNN 单点填补 ---------------- */
  function knnFillOne(row, model, trainRef, skipIdx, idxCache) {
    const k = model.knn.k;
    // 先算所有参考样本的距离，只保留"目标列非缺失"的
    const cand = [];
    for (let i = 0; i < trainRef.length; i++) {
      const d = gowerDistance(row, trainRef[i], model, skipIdx);
      if (d === null) continue;
      cand.push({ i, d });
    }
    cand.sort((x, y) => x.d - y.d || x.i - y.i);   // 距离相同按索引稳定排序
    return cand;
  }

  /* ---------------- transform：绝不重新拟合 ---------------- */
  /**
   * @param {Array<Array>} matrix 待填补矩阵（验证集/测试集/训练集均可）
   * @param {object} model        fitImputer 的返回值
   * @param {Array<Array>} refTrain 可选：KNN 的参考集（默认用 model 里保存的训练数据）
   * @returns {{matrix, log}}
   */
  function transformImputer(matrix, model, refTrain) {
    const p = model.p;
    const skipIdx = new Set(model.skipColumns.map(n => model.names.indexOf(n)).filter(i => i >= 0));
    const out = matrix.map(r => r.slice());
    const log = {
      filledPerColumn: new Array(p).fill(0),
      fallbackPerColumn: new Array(p).fill(0),
      fallbackReasons: [],
      knnUsed: model.strategies.some(s => s === 'knn'),
      nRows: matrix.length,
      nTrainRef: refTrain ? refTrain.length : 0
    };

    // 1) 先处理非 KNN 列
    for (let j = 0; j < p; j++) {
      if (model.strategies[j] === 'knn' || model.strategies[j] === 'none' || model.strategies[j] === 'drop') continue;
      const fill = model.fillValues[j];
      for (let i = 0; i < out.length; i++) {
        if (isNull(out[i][j])) { out[i][j] = fill; log.filledPerColumn[j]++; }
      }
    }

    // 2) KNN 列
    const knnCols = [];
    for (let j = 0; j < p; j++) if (model.strategies[j] === 'knn') knnCols.push(j);
    if (knnCols.length) {
      const ref = refTrain || model._trainRef || [];
      if (!ref.length) {
        // 没有参考集 → 全部回退
        knnCols.forEach(j => {
          for (let i = 0; i < out.length; i++) {
            if (isNull(out[i][j])) {
              out[i][j] = fallbackValue(model, j);
              log.filledPerColumn[j]++; log.fallbackPerColumn[j]++;
              log.fallbackReasons.push(`列「${model.names[j]}」缺少训练参考集，已用 ${model.fallback}`);
            }
          }
        });
      } else {
        // 预计算每个待填补行与参考集的候选邻居（一次性，避免重复计算）
        const candCache = new Array(out.length);
        for (let i = 0; i < out.length; i++) {
          const need = knnCols.some(j => isNull(out[i][j]));
          if (!need) continue;
          candCache[i] = knnFillOne(out[i], model, ref, skipIdx);
        }
        for (const j of knnCols) {
          for (let i = 0; i < out.length; i++) {
            if (!isNull(out[i][j])) continue;
            const cand = candCache[i] || [];
            // 只保留该列在参考集中非缺失的邻居
            const usable = [];
            for (const c of cand) {
              if (!isNull(ref[c.i][j])) {
                usable.push(c);
                if (usable.length >= model.knn.k) break;
              }
            }
            // 训练集中的样本要排除自身（transform 训练集时）
            const filtered = usable.filter(c => !(ref[c.i] === out[i] && c.d === 0));
            const pick = filtered.length ? filtered : usable;
            if (!pick.length) {
              out[i][j] = fallbackValue(model, j);
              log.fallbackPerColumn[j]++;
              log.fallbackReasons.push(`列「${model.names[j]}」第 ${i + 1} 行无可用邻居，已回退 ${model.fallback}`);
            } else {
              out[i][j] = voteValue(pick, ref, j, model);
            }
            log.filledPerColumn[j]++;
          }
        }
      }
    }

    // 3) drop 列：整行删除由调用方处理（这里标记）
    log.dropRows = model.strategies.some(s => s === 'drop');
    return { matrix: out, log };
  }

  function fallbackValue(model, j) {
    const st = model.stats[j];
    if (model.fallback === 'mean' && st.mean !== null) return st.mean;
    if (model.fallback === 'mode' && st.mode !== null) return st.mode;
    return st.median !== null ? st.median : (st.mode !== null ? st.mode : 0);
  }

  function voteValue(pick, ref, j, model) {
    const isNum = model.types[j] === 'num';
    if (isNum) {
      let s = 0, w = 0;
      pick.forEach(c => {
        const weight = model.knn.weighted ? 1 / (c.d + 1e-6) : 1;
        s += Number(ref[c.i][j]) * weight;
        w += weight;
      });
      return w > 0 ? s / w : fallbackValue(model, j);
    }
    // 分类：加权众数
    const cnt = new Map();
    pick.forEach(c => {
      const weight = model.knn.weighted ? 1 / (c.d + 1e-6) : 1;
      const key = ref[c.i][j];
      cnt.set(key, (cnt.get(key) || 0) + weight);
    });
    let best = null, bestW = -1;
    for (const [k, v] of cnt) { if (v > bestW) { bestW = v; best = k; } }
    return best;
  }

  /* ---------------- 完整案例删除（只针对参与分析的列） ---------------- */
  function completeCases(matrix, colIdx) {
    const keep = [], dropped = [];
    matrix.forEach((r, i) => {
      const ok = colIdx.every(j => !isNull(r[j]));
      if (ok) keep.push(i); else dropped.push(i);
    });
    return { keepIdx: keep, dropIdx: dropped, matrix: keep.map(i => matrix[i].slice()) };
  }

  /* ---------------- 缺失诊断 ---------------- */
  function diagnoseMissing(matrix, names) {
    const n = matrix.length, p = names.length;
    const perCol = [];
    let totalCells = 0, totalMissing = 0;
    for (let j = 0; j < p; j++) {
      let miss = 0;
      for (let i = 0; i < n; i++) if (isNull(matrix[i][j])) miss++;
      perCol.push({
        name: names[j], missing: miss, valid: n - miss,
        rate: n ? miss / n : 0, allMissing: miss === n
      });
      totalCells += n; totalMissing += miss;
    }
    const perRow = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) if (isNull(matrix[i][j])) perRow[i]++;
    const rowHist = {};
    perRow.forEach(c => { rowHist[c] = (rowHist[c] || 0) + 1; });
    const completeRows = perRow.filter(c => c === 0).length;
    return {
      n, p, totalCells, totalMissing,
      overallRate: totalCells ? totalMissing / totalCells : 0,
      perCol, perRow, rowHist,
      completeRows,
      allMissingCols: perCol.filter(c => c.allMissing).map(c => c.name),
      highMissingCols: perCol.filter(c => c.rate > 0.5 && !c.allMissing).map(c => c.name),
      // 缺失矩阵（抽样，用于热力图）
      pattern: buildPattern(matrix, n, p)
    };
  }

  function buildPattern(matrix, n, p) {
    const maxRow = 200, maxCol = 40;
    const stepR = Math.max(1, Math.ceil(n / maxRow));
    const stepC = Math.max(1, Math.ceil(p / maxCol));
    const rows = [];
    for (let i = 0; i < n && rows.length < maxRow; i += stepR) {
      const line = [];
      for (let j = 0; j < p && line.length < maxCol; j += stepC) line.push(isNull(matrix[i][j]) ? 1 : 0);
      rows.push(line);
    }
    return rows;
  }

  global.DACPre = {
    isNull, inferType, colStats,
    fitImputer, transformImputer, completeCases, diagnoseMissing,
    gowerDistance
  };
})(typeof window !== 'undefined' ? window : globalThis);
