/* ============================================================
 * DAC Workbench V3.0 · 广义线性模型（GLM）
 * 分布：Gaussian(identity) / Binomial(logit) / Poisson(log)
 * 估计：IRLS（Fisher Scoring）
 * 输出：系数、SE、z/t、p、CI、AIC、BIC、deviance、Pearson χ²、VIF、诊断
 *
 * 注意：这不是"智谱 GLM"（那是个大模型 API），这里是 Generalized Linear Model。
 * ============================================================ */
(function (global) {
  'use strict';

  const EPS = 1e-10;

  /* ---------------- 基础数学 ---------------- */
  // erf 近似（Abramowitz & Stegun 7.1.26），精度 ~1.5e-7
  function erf(x) {
    const s = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return s * y;
  }
  const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
  const normPdf = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  /** 双侧 p 值 */
  const pTwoSided = (z) => Math.max(0, Math.min(1, 2 * (1 - normCdf(Math.abs(z)))));

  /* t 分布双侧 p（用正态近似 + 小样本修正，df>200 等价正态） */
  function pTwoSidedT(t, df) {
    if (!isFinite(t)) return 0;
    if (df > 200) return pTwoSided(t);
    // 简单修正：用 df 调整临界值
    const a = Math.abs(t);
    const z = a * (1 - 1 / (4 * df));
    return Math.min(1, pTwoSided(z) * (1 + 1 / (2 * df)));
  }

  /* 线性方程组求解（高斯消元 + 部分主元） */
  function solve(A, b) {
    const n = A.length;
    const M = A.map((row, i) => row.slice().concat([b[i]]));
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;  // 奇异
      if (piv !== col) { const t = M[piv]; M[piv] = M[col]; M[col] = t; }
      for (let r = col + 1; r < n; r++) {
        const f = M[r][col] / M[col][col];
        if (f === 0) continue;
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = M[i][n];
      for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  /* 矩阵求逆（用于协方差矩阵） */
  function inverse(A) {
    const n = A.length;
    const inv = [];
    for (let i = 0; i < n; i++) {
      const e = new Array(n).fill(0); e[i] = 1;
      const col = solve(A, e);
      if (!col) return null;
      inv.push(col);
    }
    // inv 现在是按列存的，转置成按行
    const out = [];
    for (let i = 0; i < n; i++) { out.push([]); for (let j = 0; j < n; j++) out[i].push(inv[j][i]); }
    return out;
  }

  /* ---------------- 设计与编码 ---------------- */
  /**
   * 构建设计矩阵：数值列直接进；分类列做哑变量（drop-first）。
   * @returns {X, names, codings[], levelsMap, n}
   */
  function buildDesign(rows, spec) {
    const X = [];
    const names = ['(Intercept)'];
    const codings = [];
    const colDefs = [];

    (spec.numCols || []).forEach(c => { colDefs.push({ kind: 'num', name: c.name, idx: c.idx }); names.push(c.name); });
    (spec.catCols || []).forEach(c => {
      const lv = c.levels.slice();
      // 参考类别：默认第一个
      const ref = c.reference || lv[0];
      const used = lv.filter(v => v !== ref);
      used.forEach(v => { names.push(`${c.name}[${v}]`); colDefs.push({ kind: 'cat', name: c.name, idx: c.idx, level: v }); });
      codings.push({ name: c.name, reference: ref, levels: lv, dummies: used });
    });

    rows.forEach(r => {
      const row = [1];
      colDefs.forEach(d => {
        if (d.kind === 'num') row.push(typeof r[d.idx] === 'number' ? r[d.idx] : NaN);
        else row.push(String(r[d.idx]) === String(d.level) ? 1 : 0);
      });
      X.push(row);
    });

    return { X, names, codings, colDefs, n: rows.length, p: names.length };
  }

  /* ---------------- 各分布的链接 ---------------- */
  const FAMILIES = {
    gaussian: {
      name: 'Gaussian (identity)',
      linkinv: (eta) => eta,
      mueta: () => 1,
      variance: () => 1,
      devResid: (y, mu) => (y - mu) ** 2,
      init: (y) => y.slice()
    },
    binomial: {
      name: 'Binomial (logit)',
      linkinv: (eta) => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, eta)))),
      mueta: (mu) => Math.max(1e-10, mu * (1 - mu)),
      variance: (mu) => Math.max(1e-10, mu * (1 - mu)),
      // 二项 deviance 残差（y ∈ {0,1}）
      devResid: (y, mu) => {
        const m = Math.max(1e-10, Math.min(1 - 1e-10, mu));
        const a = y > 0 ? y * Math.log(y / m) : 0;
        const b = y < 1 ? (1 - y) * Math.log((1 - y) / (1 - m)) : 0;
        return 2 * (a + b);
      },
      init: (y) => y.map(v => Math.log(Math.max(0.01, Math.min(0.99, v)) / (1 - Math.max(0.01, Math.min(0.99, v)))))
    },
    poisson: {
      name: 'Poisson (log)',
      linkinv: (eta) => Math.exp(Math.max(-35, Math.min(35, eta))),
      mueta: (mu) => Math.max(1e-10, mu),
      variance: (mu) => Math.max(1e-10, mu),
      devResid: (y, mu) => {
        const m = Math.max(1e-10, mu);
        return 2 * (y > 0 ? y * Math.log(y / m) - (y - m) : m);
      },
      init: (y) => y.map(v => Math.log(Math.max(0.01, v + 0.1)))
    },
    gamma: {
      // 用 log link 而非 inverse：inverse 在 η→0+ 时 μ 爆炸，IRLS 极易发散；
      // log link 数值稳定且解释直观（exp(β) 为倍数效应），是实践中更稳的选择
      name: 'Gamma (log)',
      linkinv: (eta) => Math.exp(Math.max(-35, Math.min(35, eta))),
      mueta: (mu) => Math.max(1e-10, mu),
      variance: (mu) => Math.max(1e-10, mu * mu),
      devResid: (y, mu) => {
        const m = Math.max(1e-10, mu), yy = Math.max(1e-10, y);
        return 2 * ((yy - m) / m - Math.log(yy / m));
      },
      init: (y) => y.map(v => Math.log(Math.max(1e-6, v))),
      validate: (y) => {
        if (!y.every(v => v > 0)) throw new Error('Gamma 要求目标变量全部 > 0');
      }
    },
    'gamma-inverse': {
      name: 'Gamma (inverse)',
      linkinv: (eta) => {
        if (!(eta > 1e-8)) return NaN;   // 非正 η 视为无效，交给步长衰减处理
        return 1 / eta;
      },
      mueta: (mu) => -1 / Math.max(1e-20, mu * mu),
      variance: (mu) => Math.max(1e-10, mu * mu),
      devResid: (y, mu) => {
        const m = Math.max(1e-10, mu), yy = Math.max(1e-10, y);
        return 2 * ((yy - m) / m - Math.log(yy / m));
      },
      init: (y) => {
        const m = y.reduce((a, b) => a + b, 0) / y.length;
        return y.map(() => 0.5 / Math.max(1e-6, m));   // 保守初值，留出正的 η
      },
      validate: (y) => {
        if (!y.every(v => v > 0)) throw new Error('Gamma 要求目标变量全部 > 0');
      }
    },
    negbin: {
      name: 'Negative Binomial (log)',
      // θ（离散参数）通过矩估计确定，见 estimateTheta()
      linkinv: (eta) => Math.exp(Math.max(-35, Math.min(35, eta))),
      mueta: (mu) => Math.max(1e-10, mu),
      variance: (mu, theta) => {
        const t = Math.max(1e-6, theta || 1);
        return Math.max(1e-10, mu + mu * mu / t);
      },
      devResid: (y, mu, theta) => {
        const m = Math.max(1e-10, mu), t = Math.max(1e-6, theta || 1);
        const a = y > 0 ? y * Math.log(y / m) : 0;
        const b = (y + t) * Math.log((y + t) / (m + t));
        return 2 * (a - b);
      },
      init: (y) => y.map(v => Math.log(Math.max(0.01, v + 0.1))),
      validate: (y) => {
        if (!y.every(v => v >= 0 && Number.isInteger(v))) throw new Error('负二项要求目标为非负整数计数');
      }
    }
  };

  /* ---------------- 主拟合 ---------------- */
  /**
   * @param {object} d { rows, y:number[], spec:{numCols,catCols}, family:'gaussian'|'binomial'|'poisson', maxIter, tol }
   */
  function fit(d) {
    const fam = FAMILIES[d.family];
    if (!fam) throw new Error('不支持的分布：' + d.family);
    const design = buildDesign(d.rows, d.spec || {});
    const X = design.X, y = d.y, n = design.n, p = design.p;
    if (n < p + 2) throw new Error(`样本量 ${n} 不足以拟合 ${p} 个参数`);

    // 检查 NaN
    for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) {
      if (!Number.isFinite(X[i][j])) throw new Error(`第 ${i + 1} 行第 ${design.names[j]} 列含非数值`);
    }

    // Gamma / 负二项的前置校验
    if (fam.validate) fam.validate(y);

    // 负二项：先用泊松估计 θ（矩估计），再固定 θ 做 IRLS
    let theta = d.theta || null;
    if (d.family === 'negbin') {
      if (!theta) {
        const muP = y.reduce((a, b) => a + b, 0) / n;
        const varP = y.reduce((a, b) => a + (b - muP) ** 2, 0) / (n - 1);
        // θ̂ = μ² / (var - μ)，var<=μ 时退化为大 θ（≈泊松）
        theta = varP > muP ? (muP * muP) / (varP - muP) : 1e6;
        theta = Math.max(1e-4, theta);
      }
    }
    // 加权：w 默认全 1
    const wt = (d.weights && d.weights.length === n)
      ? d.weights.map(v => (Number.isFinite(v) && v > 0 ? v : 0))
      : new Array(n).fill(1);

    // 二分类取值检查
    if (d.family === 'binomial') {
      const u = [...new Set(y)];
      if (u.length !== 2) throw new Error(`Binomial 要求目标为 2 类，当前 ${u.length} 类`);
      if (!u.every(v => v === 0 || v === 1)) throw new Error('Binomial 目标必须编码为 0/1');
    }
    if (d.family === 'poisson' && y.some(v => v < 0 || !Number.isInteger(v))) {
      throw new Error('Poisson 目标必须是非负整数');
    }

    const maxIter = d.maxIter || 60;
    const tol = d.tol || 1e-8;

    // IRLS
    let beta = new Array(p).fill(0);
    // 用 y 的均值初始化截距
    const yMean = y.reduce((a, b) => a + b, 0) / n;
    if (d.family === 'gaussian') beta[0] = yMean;
    else if (d.family === 'binomial') beta[0] = Math.log(Math.max(1e-6, yMean) / Math.max(1e-6, 1 - yMean));
    else beta[0] = Math.log(Math.max(1e-6, yMean));

    let converged = false, iter = 0, deviance = Infinity, lastDev = Infinity;
    let W = null, mu = null, eta = null;

    for (; iter < maxIter; iter++) {
      eta = new Array(n); mu = new Array(n);
      for (let i = 0; i < n; i++) {
        let e = 0;
        for (let j = 0; j < p; j++) e += X[i][j] * beta[j];
        eta[i] = e; mu[i] = fam.linkinv(e);
      }

      // 工作权重与工作响应
      W = new Array(n);
      const z = new Array(n);
      for (let i = 0; i < n; i++) {
        const dm = fam.mueta(mu[i]);
        const v = fam.variance(mu[i], theta);
        W[i] = Math.max(1e-10, dm * dm / v);
        z[i] = eta[i] + (y[i] - mu[i]) / Math.max(1e-10, dm);
      }

      // (X'WX) β = X'Wz
      const XtWX = [], XtWz = [];
      for (let a = 0; a < p; a++) {
        XtWX.push(new Array(p).fill(0));
        XtWz.push(0);
      }
      for (let i = 0; i < n; i++) {
        const wi = W[i] * wt[i];
        if (wi <= 0) continue;
        for (let a = 0; a < p; a++) {
          const xa = X[i][a];
          if (xa === 0) continue;
          XtWz[a] += xa * wi * z[i];
          for (let b = 0; b < p; b++) XtWX[a][b] += xa * wi * X[i][b];
        }
      }
      const nb = solve(XtWX, XtWz);
      if (!nb) {
        throw new Error('设计矩阵奇异（完全共线或变量为常数）——请移除冗余变量');
      }
      if (!nb.every(Number.isFinite)) {
        const bad = design.names.filter((_, j) => !Number.isFinite(nb[j]));
        throw new Error(`IRLS 第 ${iter + 1} 次迭代出现非有限系数（${bad.join('、')}）：` +
          '常见原因是某列方差为 0、样本数不足以识别该参数，或数据含极端值。');
      }
      // 步长控制（halving）：inverse link 等情况下完整牛顿步会发散，
      // 只接受能降低 deviance 的步长
      const devOf = (b) => {
        let d = 0;
        for (let i = 0; i < n; i++) {
          let e = 0;
          for (let j = 0; j < p; j++) e += X[i][j] * b[j];
          const mm = fam.linkinv(e);
          if (!Number.isFinite(mm)) return Infinity;
          d += fam.devResid(y[i], mm, theta);
        }
        return Number.isFinite(d) ? d : Infinity;
      };

      let step = 1, accepted = null, devNew = Infinity;
      const curDev = Number.isFinite(deviance) ? deviance : Infinity;
      for (let h = 0; h < 12; h++) {
        const cand = beta.map((v, j) => v + step * (nb[j] - v));
        const dv = devOf(cand);
        if (dv <= curDev * (1 + 1e-10) || !Number.isFinite(curDev)) {
          accepted = cand; devNew = dv; break;
        }
        step /= 2;
      }
      if (!accepted) {
        throw new Error(`IRLS 第 ${iter + 1} 次迭代无法降低 deviance（${fam.name}），` +
          '可能是数据与链接函数不匹配或存在极端值。');
      }

      let maxDelta = 0;
      for (let j = 0; j < p; j++) maxDelta = Math.max(maxDelta, Math.abs(accepted[j] - beta[j]));
      beta = accepted;
      deviance = devNew;

      if (maxDelta < tol || Math.abs(deviance - lastDev) < tol * (1 + Math.abs(deviance))) {
        converged = true;
        iter++;
        break;
      }
      lastDev = deviance;
    }

    // 最终 mu/eta
    eta = new Array(n); mu = new Array(n);
    for (let i = 0; i < n; i++) {
      let e = 0;
      for (let j = 0; j < p; j++) e += X[i][j] * beta[j];
      eta[i] = e; mu[i] = fam.linkinv(e);
    }

    // 协方差矩阵 = (X'WX)^-1 * dispersion
    const XtWX = [];
    for (let a = 0; a < p; a++) {
      XtWX.push(new Array(p).fill(0));
    }
    const Wf = new Array(n);
    for (let i = 0; i < n; i++) {
      const dm = fam.mueta(mu[i]);
      const v = fam.variance(mu[i], theta);
      Wf[i] = Math.max(1e-10, dm * dm / v);
    }
    for (let i = 0; i < n; i++) {
      const wi = Wf[i] * wt[i];
      if (wi <= 0) continue;
      for (let a = 0; a < p; a++) {
        const xa = X[i][a];
        if (xa === 0) continue;
        for (let b = 0; b < p; b++) XtWX[a][b] += xa * wi * X[i][b];
      }
    }
    const cov = inverse(XtWX);
    if (!cov) throw new Error('信息矩阵奇异，无法估计标准误');

    // 离散参数
    const dfResid = n - p;
    let pearson = 0;
    for (let i = 0; i < n; i++) {
      const v = fam.variance(mu[i], theta);
      pearson += (y[i] - mu[i]) ** 2 / Math.max(1e-10, v);
    }
    const dispersion = d.family === 'gaussian' ? (deviance / Math.max(1, dfResid)) : (pearson / Math.max(1, dfResid));
    const dispUsed = (d.family === 'binomial' || d.family === 'poisson') ? 1 : dispersion;

    // 系数表
    const coef = design.names.map((name, j) => {
      const b = beta[j];
      const se = Math.sqrt(Math.max(0, cov[j][j] * dispUsed));
      const isT = d.family === 'gaussian';
      const stat = se > 0 ? b / se : NaN;
      const pv = isT ? pTwoSidedT(stat, dfResid) : pTwoSided(stat);
      const zc = isT ? tCrit(dfResid, 0.975) : 1.959963985;
      return {
        name, est: b, se, stat, statName: isT ? 't' : 'z', p: pv,
        lo: b - zc * se, hi: b + zc * se,
        exp: (d.family === 'binomial' || d.family === 'poisson') ? Math.exp(b) : null,
        expLo: (d.family === 'binomial' || d.family === 'poisson') ? Math.exp(b - zc * se) : null,
        expHi: (d.family === 'binomial' || d.family === 'poisson') ? Math.exp(b + zc * se) : null
      };
    });

    // 拟合优度
    const ll = logLik(d.family, y, mu, dispersion);
    const k = p + ((d.family === 'gaussian' || d.family === 'gamma') ? 1 : 0);
    const aic = -2 * ll + 2 * k;
    const bic = -2 * ll + k * Math.log(n);

    // 空模型 deviance（用于 R²）
    let nullDev = 0;
    const muNull = d.family === 'gaussian' ? yMean
      : d.family === 'binomial' ? yMean : yMean;
    for (let i = 0; i < n; i++) nullDev += fam.devResid(y[i], muNull, theta);

    // 诊断
    const diag = diagnose({ X, y, mu, beta, design, fam, dispersion, pearson, dfResid, nullDev, n, p, theta });

    return {
      family: d.family,
      familyName: fam.name,
      theta: (d.family === 'negbin') ? theta : null,
      weighted: wt.some(v => v !== 1),
      n, p, dfResid,
      converged, iterations: iter,
      coef, codings: design.codings, names: design.names,
      deviance, nullDeviance: nullDev,
      pearson, dispersion,
      logLik: ll, aic, bic,
      r2: d.family === 'gaussian' ? 1 - deviance / (nullDev || 1) : null,
      r2adj: d.family === 'gaussian' ? 1 - (1 - (1 - deviance / (nullDev || 1))) * (n - 1) / Math.max(1, dfResid) : null,
      rmse: d.family === 'gaussian' ? Math.sqrt(deviance / Math.max(1, dfResid)) : null,
      mae: d.family === 'gaussian' ? y.reduce((s, v, i) => s + Math.abs(v - mu[i]), 0) / n : null,
      mu, fitted: mu,
      diagnostics: diag,
      warnings: diag.warnings
    };
  }

  function logLik(family, y, mu, dispersion) {
    let ll = 0;
    if (family === 'gaussian') {
      const s2 = Math.max(1e-12, dispersion);
      for (let i = 0; i < y.length; i++) {
        ll += -0.5 * (Math.log(2 * Math.PI * s2) + (y[i] - mu[i]) ** 2 / s2);
      }
    } else if (family === 'binomial') {
      for (let i = 0; i < y.length; i++) {
        const m = Math.max(1e-12, Math.min(1 - 1e-12, mu[i]));
        ll += y[i] * Math.log(m) + (1 - y[i]) * Math.log(1 - m);
      }
    } else {
      for (let i = 0; i < y.length; i++) {
        const m = Math.max(1e-12, mu[i]);
        ll += y[i] * Math.log(m) - m - logGamma(y[i] + 1);
      }
    }
    return ll;
  }
  /* Stirling 近似的 log Γ */
  function logGamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    x -= 1;
    let a = c[0];
    const t = x + g + 0.5;
    for (let i = 1; i < 9; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  /* t 分布临界值（df, 双侧 1-α）—— 用正态 + 修正 */
  function tCrit(df, level) {
    if (df > 200) return 1.959963985;
    const z = 1.959963985;
    // 经验修正：t ≈ z + z(z²+1)/(4df)
    return z + z * (z * z + 1) / (4 * df);
  }

  /* ---------------- 诊断 ---------------- */
  function diagnose(x) {
    const warnings = [];
    const { X, y, mu, beta, design, fam, dispersion, pearson, dfResid, nullDev, n, p } = x;

    // 1) 完全分离（Logistic）
    let separated = false;
    if (fam === FAMILIES.binomial) {
      const hi = mu.filter(v => v > 0.999).length;
      const lo = mu.filter(v => v < 0.001).length;
      if (hi + lo > n * 0.15) {
        separated = true;
        warnings.push({
          level: 'error', code: 'separation',
          text: `疑似完全/准完全分离：${hi + lo}/${n} 个样本的预测概率极度接近 0 或 1。` +
                '此时系数与标准误不可信，显著性检验无效。请减少变量、增加样本，或使用 Firth 惩罚似然。'
        });
      }
    }

    // 2) 过度离散（Poisson）
    let overdispersed = false;
    if (fam === FAMILIES.poisson || fam === FAMILIES.negbin) {
      const ratio = pearson / Math.max(1, dfResid);
      if (ratio > 1.5) {
        overdispersed = true;
        warnings.push({
          level: 'error', code: 'overdispersion',
          text: `过度离散：Pearson χ²/df = ${ratio.toFixed(2)}（>1.5）。泊松假设（方差=均值）不成立，` +
                '标准误被低估，p 值偏小。建议改用负二项回归或准泊松。'
        });
      } else if (ratio > 1.2) {
        warnings.push({ level: 'warn', code: 'overdispersion-mild',
          text: `轻度过度离散：Pearson χ²/df = ${ratio.toFixed(2)}，解释 p 值时应保守。` });
      }
    }

    // 3) 共线性 VIF
    const vif = [];
    const numIdx = [];
    design.colDefs.forEach((d, j) => { numIdx.push(j + 1); });  // 跳过截距
    const pcols = X[0].length;
    for (let j = 1; j < pcols; j++) {
      // 第 j 列对其余列回归的 R²
      const yj = X.map(r => r[j]);
      const others = [];
      for (let k = 1; k < pcols; k++) if (k !== j) others.push(X.map(r => r[k]));
      // 若该列是常数（哑变量且只出现一次等），VIF 无意义
      const sd = Math.sqrt(yj.reduce((s, v) => s + (v - yj.reduce((a, b) => a + b, 0) / n) ** 2, 0) / n);
      if (sd < 1e-12) { vif.push({ name: design.names[j], vif: NaN }); continue; }
      const r2 = rSquared(yj, others);
      vif.push({ name: design.names[j], vif: r2 >= 1 - 1e-12 ? Infinity : 1 / (1 - r2) });
    }
    const highVif = vif.filter(v => Number.isFinite(v.vif) && v.vif > 10);
    const infVif = vif.filter(v => v.vif === Infinity);
    if (infVif.length) {
      warnings.push({ level: 'error', code: 'collinear',
        text: `完全共线：${infVif.map(v => v.name).join('、')} 可被其余变量线性表出，系数不可识别。` });
    } else if (highVif.length) {
      warnings.push({ level: 'warn', code: 'high-vif',
        text: `多重共线（VIF>10）：${highVif.map(v => `${v.name}(${v.vif.toFixed(1)})`).join('、')}。` +
              '系数方向可能不稳定，建议合并或删除变量。' });
    }

    // 4) 小样本
    if (n < 10 * p) {
      warnings.push({ level: 'warn', code: 'small-n',
        text: `样本量 ${n} 相对参数数 ${p} 偏少（<10:1），标准误估计不稳，结论宜保守。` });
    }

    // 5) 残差
    const resid = y.map((v, i) => v - mu[i]);
    const pearsonResid = resid.map((r, i) => r / Math.sqrt(Math.max(1e-10, fam.variance(mu[i], x.theta))));
    const devResid = y.map((v, i) => Math.sign(v - mu[i]) * Math.sqrt(Math.max(0, fam.devResid(v, mu[i], x.theta))));

    return {
      separated, overdispersed, vif, warnings,
      resid, pearsonResid, devResid,
      dispersion, devianceRatio: pearson / Math.max(1, dfResid)
    };
  }

  /* 多列回归的 R²（最小二乘） */
  function rSquared(yv, cols) {
    const n = yv.length, k = cols.length;
    if (!k) return 0;
    const A = [], b = [];
    for (let i = 0; i < k; i++) {
      A.push(new Array(k).fill(0)); b.push(0);
    }
    for (let a = 0; a < k; a++) {
      for (let i = 0; i < n; i++) b[a] += cols[a][i] * yv[i];
      for (let c = 0; c < k; c++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += cols[a][i] * cols[c][i];
        A[a][c] = s;
      }
    }
    const coef = solve(A, b);
    if (!coef) return 1;   // 奇异 → 完全共线
    const ybar = yv.reduce((a, b2) => a + b2, 0) / n;
    let ssr = 0, sst = 0;
    for (let i = 0; i < n; i++) {
      let pred = 0;
      for (let a = 0; a < k; a++) pred += coef[a] * cols[a][i];
      ssr += (yv[i] - pred) ** 2;
      sst += (yv[i] - ybar) ** 2;
    }
    return sst < 1e-12 ? 1 : Math.max(0, Math.min(1, 1 - ssr / sst));
  }

  /* ---------------- 模型比较 ---------------- */
  function compare(models) {
    const rows = models.map(m => ({
      family: m.familyName, n: m.n, p: m.p,
      aic: m.aic, bic: m.bic, deviance: m.deviance, dfResid: m.dfResid,
      r2: m.r2, converged: m.converged
    }));
    const best = rows.reduce((a, b) => (b.aic < a.aic ? b : a), rows[0]);
    return { rows, bestByAIC: best };
  }

  /* ---------------- 逻辑回归专用：ROC / 混淆矩阵 ---------------- */
  function roc(y, prob) {
    const pairs = y.map((v, i) => ({ y: v, p: prob[i] })).sort((a, b) => b.p - a.p);
    const P = y.filter(v => v === 1).length, N = y.length - P;
    const pts = [{ fpr: 0, tpr: 0 }];
    let tp = 0, fp = 0;
    pairs.forEach(pr => {
      if (pr.y === 1) tp++; else fp++;
      pts.push({ fpr: fp / Math.max(1, N), tpr: tp / Math.max(1, P) });
    });
    // AUC：梯形积分
    let auc = 0;
    for (let i = 1; i < pts.length; i++) {
      auc += (pts[i].fpr - pts[i - 1].fpr) * (pts[i].tpr + pts[i - 1].tpr) / 2;
    }
    // 最佳阈值（Youden J）
    let best = { j: -1, thr: 0.5, tpr: 0, fpr: 0 };
    pts.forEach(p => { const j = p.tpr - p.fpr; if (j > best.j) best = { j, thr: 1 - p.fpr, tpr: p.tpr, fpr: p.fpr }; });
    return { points: pts, auc, best };
  }

  function confusion(y, prob, thr) {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    y.forEach((v, i) => {
      const pred = prob[i] >= thr ? 1 : 0;
      if (v === 1 && pred === 1) tp++; else if (v === 0 && pred === 1) fp++;
      else if (v === 0 && pred === 0) tn++; else fn++;
    });
    const acc = (tp + tn) / Math.max(1, y.length);
    const sens = tp / Math.max(1, tp + fn);
    const spec = tn / Math.max(1, tn + fp);
    const prec = tp / Math.max(1, tp + fp);
    const f1 = 2 * prec * sens / Math.max(1e-12, prec + sens);
    return { tp, fp, tn, fn, acc, sens, spec, prec, f1, thr };
  }

  global.DACGLM = { fit, compare, roc, confusion, FAMILIES, buildDesign, pTwoSided, logGamma, solve, inverse };
})(typeof window !== 'undefined' ? window : self);
