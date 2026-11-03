/* ============================================================
 * DAC Workbench V2.6 · Web Worker 计算内核
 * 由 build_workbench.py 与 core.js / preprocess.js 一起拼成 Blob，
 * 在主线程外执行重计算，支持进度 / 取消 / 超时 / 错误回传。
 * ============================================================ */
/* global DACCore, DACPre */
'use strict';

const post = (msg) => self.postMessage(msg);

/* 任务表：每个任务接收 (payload, onProgress)，返回可序列化结果 */
const TASKS = {

  /* KNN 大数据填补：只做 transform，不重新 fit */
  knnImpute(payload, onProgress) {
    const P = self.DACPre;
    const { rows, names, fitOpts, batch } = payload;
    const model = P.fitImputer(rows.slice(0, Math.min(rows.length, fitOpts.trainN || rows.length)), names, fitOpts);
    const out = new Array(rows.length);
    const step = Math.max(1, Math.floor(rows.length / Math.max(1, batch || 10)));
    for (let i = 0; i < rows.length; i++) {
      out[i] = rows[i].slice();
      if (i % step === 0) onProgress(Math.round(i / rows.length * 100));
    }
    const res = P.transformImputer(out, model, out);
    onProgress(100);
    return { matrix: res.matrix, log: res.log };
  },

  /* 贝叶斯网络结构学习 */
  bnLearn(payload, onProgress) {
    const C = self.DACCore;
    const { discrete, names, levels, opts } = payload;
    onProgress(30);
    const model = C.bnLearn(discrete, names, levels, opts);
    onProgress(100);
    // CPT 体积可能较大，只回传必需字段
    return {
      names: model.names, levels: model.levels, parents: model.parents,
      edges: model.edges, score: model.score, log: model.log,
      converged: model.converged, iterations: model.iterations, cpt: model.cpt
    };
  },

  /* 贝叶斯推断（多场景批量） */
  bnInferBatch(payload, onProgress) {
    const C = self.DACCore;
    const { model, scenarios } = payload;
    const out = [];
    for (let i = 0; i < scenarios.length; i++) {
      try { out.push({ ok: true, ...C.bnInfer(model, scenarios[i]) }); }
      catch (e) { out.push({ ok: false, error: e.message }); }
      onProgress(Math.round((i + 1) / scenarios.length * 100));
    }
    return out;
  },

  /* PCA（含采样保护） */
  pca(payload, onProgress) {
    const C = self.DACCore;
    const { X, labels, y } = payload;
    onProgress(20);
    const res = C.pca(X, labels, y);
    onProgress(100);
    return res;
  },

  /* 严格无泄漏交叉验证 */
  /* 嵌套验证（外层评估 / 内层选参） */
  nestedCV(payload, onProgress) {
    const C = self.DACCore;
    const { rawX, yRaw, names, labels, opt, groups } = payload;
    if (!C.nestedCV) throw new Error('内核未提供 nestedCV');
    onProgress(5);
    const o = Object.assign({}, opt, {
      onProgress: p => onProgress(5 + Math.round(p * 0.95))
    });
    const res = C.nestedCV(rawX, yRaw, names, labels, o, groups || null);
    onProgress(100);
    // records/perFold 里可能带大数组，回传时保留必要字段
    return res;
  },

  strictCV(payload, onProgress) {
    const C = self.DACCore;
    const { rawX, yRaw, names, labels, opts, groups } = payload;
    onProgress(10);
    const res = C.crossValidateStrict(rawX, yRaw, names, labels, opts, groups || null);
    onProgress(100);
    // records 里的 imputeModel 含完整训练引用，去掉再回传
    if (res.records) {
      res.records = res.records.map(r => ({
        fold: r.fold, trainIdx: r.trainIdx, testIdx: r.testIdx,
        trainRawIdx: r.trainRawIdx, testRawIdx: r.testRawIdx,
        bounds: r.bounds, yBounds: r.yBounds,
        imputeModel: r.imputeModel ? {
          names: r.imputeModel.names, strategies: r.imputeModel.strategies,
          fillValues: r.imputeModel.fillValues, stats: r.imputeModel.stats,
          types: r.imputeModel.types, ranges: r.imputeModel.ranges,
          skipColumns: r.imputeModel.skipColumns, knn: r.imputeModel.knn,
          fallback: r.imputeModel.fallback
        } : null
      }));
    }
    return res;
  },

  /* Bootstrap 稳定性（聚类 + 规则 + 重要性） */
  bootstrap(payload, onProgress) {
    const C = self.DACCore;
    const { X, y, featureNames, labels, B, seed, k } = payload;
    const n = X.length;
    const memberships = [];
    const ruleHits = {};
    const impSum = new Array(featureNames.length).fill(0);
    let ok = 0, failed = 0;
    let a = (seed || 42) >>> 0;
    const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

    for (let b = 0; b < B; b++) {
      try {
        const idx = [];
        for (let i = 0; i < n; i++) idx.push(Math.floor(rnd() * n));
        const Xb = idx.map(i => X[i]);
        const yb = idx.map(i => y[i]);
        if (k) {
          const km = C.kmeans(Xb, k, { seed: seed + b, nInit: 4 });
          memberships.push(km.labels);
        }
        const t = C.cart(Xb, yb, featureNames, labels, { maxDepth: 3, minLeaf: Math.max(5, Math.round(n / 40)) });
        t.rules.forEach(r => {
          const key = r.conditions.join('&') + '=>' + r.then;
          ruleHits[key] = (ruleHits[key] || 0) + 1;
        });
        t.importances.forEach((im, j) => { impSum[j] += im.value; });
        ok++;
      } catch (e) { failed++; }
      onProgress(Math.round((b + 1) / B * 100));
    }

    // 聚类稳定性：标签对齐后算 ARI（简化版：两两共分率）
    let stability = null;
    if (memberships.length >= 2) {
      const pairs = [];
      for (let i = 0; i < memberships[0].length; i += Math.max(1, Math.floor(n / 60))) {
        for (let j = i + 1; j < memberships[0].length; j += Math.max(1, Math.floor(n / 60))) {
          let agree = 0, total = 0;
          for (let b = 0; b < memberships.length - 1; b++) {
            const sameA = memberships[b][i] === memberships[b][j];
            const sameB = memberships[b + 1][i] === memberships[b + 1][j];
            if (sameA === sameB) agree++;
            total++;
          }
          if (total) pairs.push(agree / total);
        }
      }
      stability = pairs.length ? pairs.reduce((x, y2) => x + y2, 0) / pairs.length : null;
    }

    const topRules = Object.entries(ruleHits)
      .sort((x, y2) => y2[1] - x[1]).slice(0, 10)
      .map(([rule, cnt]) => ({ rule, freq: cnt, rate: cnt / Math.max(1, ok) }));

    return {
      B, ok, failed,
      importances: featureNames.map((f, j) => ({ name: f, mean: impSum[j] / Math.max(1, ok) })),
      topRules, stability
    };
  },

  /* 广义线性模型拟合 */
  glmFit(payload, onProgress) {
    const G = self.DACGLM;
    if (!G) throw new Error('缺少 DACGLM 模块');
    onProgress(30);
    const res = G.fit(payload);
    onProgress(100);
    // 去掉大数组，减少结构化克隆开销
    return Object.assign({}, res, {
      mu: res.mu ? res.mu.map(v => +v.toFixed(6)) : null,
      diagnostics: res.diagnostics ? Object.assign({}, res.diagnostics, {
        resid: res.diagnostics.resid.map(v => +v.toFixed(6)),
        pearsonResid: res.diagnostics.pearsonResid.map(v => +v.toFixed(6)),
        devResid: res.diagnostics.devResid.map(v => +v.toFixed(6))
      }) : null
    });
  },

  /* Bootstrap 稳定性（聚类 / 规则 / 网络） */
  bootstrapStability(payload, onProgress) {
    const B = self.DACBootstrap;
    if (!B) throw new Error('缺少 DACBootstrap 模块');
    const { data, opt } = payload;
    return B.run(data, opt, onProgress);
  },

  /* 肘部曲线 */
  elbow(payload, onProgress) {
    const C = self.DACCore;
    const { X, ks, seed } = payload;
    const out = [];
    for (let i = 0; i < ks.length; i++) {
      out.push(...C.elbowCurve(X, [ks[i]], seed));
      onProgress(Math.round((i + 1) / ks.length * 100));
    }
    return out;
  },

  /* 重复交叉验证 */
  repeatedCV(payload, onProgress) {
    const C = self.DACCore;
    const { X, y, featureNames, labels, opt, folds, repeats } = payload;
    const runs = [];
    for (let r = 0; r < repeats; r++) {
      const cv = C.crossValidate(X, y, featureNames, labels,
        Object.assign({}, opt, { seed: (opt.seed || 42) + r * 101 }), folds);
      runs.push({ seed: (opt.seed || 42) + r * 101, mean: cv.mean, std: cv.std, k: cv.k });
      onProgress(Math.round((r + 1) / repeats * 100));
    }
    const means = runs.map(r => r.mean);
    const avg = means.reduce((a, b) => a + b, 0) / means.length;
    const sd = Math.sqrt(means.reduce((a, b) => a + (b - avg) ** 2, 0) / means.length);
    return { repeats, runs, mean: avg, std: sd };
  }
};

self.onmessage = (e) => {
  const msg = e.data || {};
  const { id, task, payload } = msg;
  if (!id) return;
  if (msg.command === 'ping') { post({ id, status: 'pong' }); return; }
  const fn = TASKS[task];
  if (!fn) { post({ id, status: 'error', error: '未知任务: ' + task }); return; }

  post({ id, status: 'start', task });
  try {
    const result = fn(payload, (p) => post({ id, status: 'progress', progress: p }));
    post({ id, status: 'done', result });
  } catch (err) {
    post({ id, status: 'error', error: (err && err.message) || String(err) });
  }
};
