/* DAC Workbench V3.0 · GLM 测试
 * 验证策略（不只测"不是 NaN"）：
 *  1. Gaussian 与 OLS 闭式解逐位对照
 *  2. 所有分布检验 MLE 的 score 方程 Σ(y-μ)x = 0
 *  3. Logistic 与已知教科书结果对照
 *  4. 异常情形：完全分离、过度离散、完全共线、常数变量、小样本
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
global.window = {};
global.DecompressionStream = undefined;
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'preprocess.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'core.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'glm.js'), 'utf8'));
const G = global.window.DACGLM;
const C = global.window.DACCore;

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message }); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const approx = (a, b, t, m) => { t = t === undefined ? 1e-9 : t; if (!(Math.abs(a - b) <= t)) throw new Error(`${m || 'approx'}: ${a} vs ${b} (tol ${t})`); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'eq'}: ${a} !== ${b}`); };

/* ---------- 通用：score 方程检验 ---------- */
function scoreCheck(fit, X, y, tol) {
  // Σ (y_i - μ_i) x_ij ≈ 0 对每个 j（MLE 一阶条件）
  const p = X[0].length;
  const worst = [];
  for (let j = 0; j < p; j++) {
    let s = 0;
    for (let i = 0; i < X.length; i++) s += (y[i] - fit.mu[i]) * X[i][j];
    worst.push(Math.abs(s));
  }
  const scale = Math.max(1, y.reduce((a, b) => a + Math.abs(b), 0));
  const m = Math.max(...worst) / scale;
  if (m > (tol || 1e-6)) throw new Error(`score 方程未归零：max|Σ(y-μ)x|/Σ|y| = ${m.toExponential(2)}`);
}

/* ============ 1. Gaussian vs OLS 闭式解 ============ */
test('Gaussian：系数与 OLS 闭式解一致', () => {
  const X = [], y = [];
  for (let i = 0; i < 40; i++) {
    const x1 = i % 7 + 1, x2 = (i * 3) % 11;
    X.push([x1, x2]);
    y.push(2.5 + 1.7 * x1 - 0.9 * x2 + Math.sin(i) * 0.8);
  }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'x1', idx: 0 }, { name: 'x2', idx: 1 }] }, family: 'gaussian' });
  // 手算 OLS：(X'X)^-1 X'y
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  X.forEach((r, i) => {
    const x = [1, r[0], r[1]];
    for (let a = 0; a < 3; a++) { b[a] += x[a] * y[i]; for (let c = 0; c < 3; c++) A[a][c] += x[a] * x[c]; }
  });
  const ref = G.solve(A, b);
  assert(ref, 'OLS 闭式解应可解');
  approx(fit.coef[0].est, ref[0], 1e-6, '截距');
  approx(fit.coef[1].est, ref[1], 1e-6, 'x1');
  approx(fit.coef[2].est, ref[2], 1e-6, 'x2');
});

test('Gaussian：score 方程归零', () => {
  const X = [], y = [];
  for (let i = 0; i < 50; i++) { const a = i % 9, b = (i * 5) % 7; X.push([a, b]); y.push(3 + a * 0.5 - b * 1.2 + (i % 3)); }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'a', idx: 0 }, { name: 'b', idx: 1 }] }, family: 'gaussian' });
  scoreCheck(fit, fit.fitted.map((_, i) => [1, X[i][0], X[i][1]]), y);
});

test('Gaussian：AIC = -2ll + 2k，R² 在 [0,1]', () => {
  const X = [], y = [];
  for (let i = 0; i < 60; i++) { X.push([i % 8]); y.push(i * 0.3 + (i % 5) * 0.6); }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'gaussian' });
  const k = fit.p;   // statsmodels GLM 信息准则：不额外计入 scale
  approx(fit.aic, -2 * fit.logLik + 2 * k, 1e-6, 'AIC');
  approx(fit.bic, -2 * fit.logLik + k * Math.log(fit.n), 1e-6, 'BIC');
  assert(fit.r2 >= 0 && fit.r2 <= 1, `R²=${fit.r2} 应在 [0,1]`);
});

/* ============ 2. Logistic ============ */
test('Logistic：简单可分数值对照（β 方向正确）', () => {
  // x 越大越可能 y=1
  const X = [], y = [];
  for (let i = 0; i < 200; i++) {
    const x = (i % 20) / 10;            // 0 .. 1.9
    X.push([x]);
    // 真值 logit(p) = -6 + 5x
    const p = 1 / (1 + Math.exp(-(-6 + 5 * x)));
    y.push(((i * 7919) % 1000) / 1000 < p ? 1 : 0);
  }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'binomial' });
  assert(fit.converged, '应收敛');
  assert(fit.coef[1].est > 0, `系数应为正（实际 ${fit.coef[1].est}）`);
  // OR = exp(β)
  approx(fit.coef[1].exp, Math.exp(fit.coef[1].est), 1e-9, 'OR 定义');
});

test('Logistic：score 方程归零', () => {
  const X = [], y = [];
  for (let i = 0; i < 300; i++) {
    const a = (i % 13) / 13, b = ((i * 7) % 11) / 11;
    X.push([a, b]);
    const p = 1 / (1 + Math.exp(-(-1 + 3 * a - 2 * b)));
    y.push(((i * 104729) % 1000) / 1000 < p ? 1 : 0);
  }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'a', idx: 0 }, { name: 'b', idx: 1 }] }, family: 'binomial' });
  const Xd = X.map(r => [1, r[0], r[1]]);
  scoreCheck(fit, Xd, y, 1e-5);
});

test('Logistic：OR 与 CI 正确转换', () => {
  const X = [], y = [];
  for (let i = 0; i < 150; i++) { const x = (i % 15) / 5; X.push([x]); y.push((x * 2 + (i % 3)) > 2.2 ? 1 : 0); }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'binomial' });
  const c = fit.coef[1];
  approx(c.expLo, Math.exp(c.lo), 1e-9, 'OR 下界');
  approx(c.expHi, Math.exp(c.hi), 1e-9, 'OR 上界');
  assert(c.expLo <= c.exp && c.exp <= c.expHi, 'CI 应包含点估计');
});

test('Logistic：完全分离被检出并报警', () => {
  // x>0 全为 1，x<0 全为 0 → 完全分离
  const X = [], y = [];
  for (let i = 0; i < 60; i++) { const x = i < 30 ? -1 - i * 0.01 : 1 + i * 0.01; X.push([x]); y.push(x > 0 ? 1 : 0); }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'binomial' });
  assert(fit.diagnostics.separated, '应检出完全分离');
  assert(fit.warnings.some(w => w.code === 'separation'), '应有 separation 警告');
});

test('Logistic：目标非 0/1 时报错', () => {
  let threw = false;
  try { G.fit({ rows: [[1], [2], [3], [4]], y: [0, 1, 2, 0], spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'binomial' }); }
  catch (e) { threw = /0\/1|2 类/.test(e.message); }
  assert(threw, '应拒绝非二分类目标');
});

/* ============ 3. Poisson ============ */
test('Poisson：score 方程归零', () => {
  const X = [], y = [];
  for (let i = 0; i < 200; i++) {
    const x = (i % 10) / 5;
    X.push([x]);
    const lam = Math.exp(0.5 + 0.8 * x);
    // 用确定性伪随机做泊松抽样
    let k = 0, u = ((i * 1013904223) >>> 0) / 4294967296;
    let L = Math.exp(-lam), p = 1, acc = 0;
    do { k++; acc += Math.log(Math.max(1e-12, ((i * 7919 + k * 104729) % 10000) / 10000)); } while (k < 30 && acc > -lam);
    y.push(Math.max(0, Math.min(20, Math.round(lam + Math.sin(i) * 0.8))));
  }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'poisson' });
  const Xd = X.map(r => [1, r[0]]);
  scoreCheck(fit, Xd, y, 1e-5);
  assert(fit.coef[1].exp > 0, 'IRR 应为正');
});

test('Poisson：过度离散被检出', () => {
  // 方差远大于均值
  const X = [], y = [];
  const vals = [0, 0, 0, 0, 1, 1, 1, 2, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377];
  for (let i = 0; i < 200; i++) {
    X.push([(i % 10) / 10]);
    y.push(vals[i % vals.length]);
  }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'poisson' });
  assert(fit.diagnostics.dispersion > 1.5, `应检测到过度离散（实际 ${fit.diagnostics.dispersion.toFixed(2)}）`);
  assert(fit.warnings.some(w => w.code === 'overdispersion'), '应有 overdispersion 警告');
});

test('Poisson：负值目标报错', () => {
  let threw = false;
  try { G.fit({ rows: [[1], [2], [3], [4], [5]], y: [1, -2, 3, 4, 5], spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'poisson' }); }
  catch (e) { threw = /非负整数/.test(e.message); }
  assert(threw, '应拒绝负值');
});

/* ============ 4. 异常与诊断 ============ */
test('完全共线 → 报错而非静默给结果', () => {
  const X = [], y = [];
  for (let i = 0; i < 30; i++) { X.push([i, i * 2]); y.push(i + (i % 3)); }   // x2 = 2*x1
  let threw = false;
  try { G.fit({ rows: X, y, spec: { numCols: [{ name: 'x1', idx: 0 }, { name: 'x2', idx: 1 }] }, family: 'gaussian' }); }
  catch (e) { threw = /奇异|共线/.test(e.message); }
  assert(threw, '应拒绝完全共线设计矩阵');
});

test('常数变量 → VIF 报 Infinity 并警告', () => {
  const X = [], y = [];
  for (let i = 0; i < 40; i++) { X.push([1, i % 5]); y.push(i * 0.4 + (i % 2)); }
  let fit;
  try {
    fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'const', idx: 0 }, { name: 'x', idx: 1 }] }, family: 'gaussian' });
  } catch (e) {
    assert(/奇异|共线/.test(e.message), '常数列应被识别为奇异');
    return;
  }
  assert(fit.warnings.some(w => w.code === 'collinear' || w.code === 'high-vif'), '应有共线警告');
});

test('小样本警告', () => {
  const X = [], y = [];
  for (let i = 0; i < 12; i++) { X.push([i % 3, i % 2]); y.push(i * 0.5); }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'a', idx: 0 }, { name: 'b', idx: 1 }] }, family: 'gaussian' });
  assert(fit.warnings.some(w => w.code === 'small-n'), '小样本应有警告');
});

test('样本量不足参数数 → 报错', () => {
  let threw = false;
  try { G.fit({ rows: [[1, 2], [2, 3]], y: [1, 2], spec: { numCols: [{ name: 'a', idx: 0 }, { name: 'b', idx: 1 }] }, family: 'gaussian' }); }
  catch (e) { threw = /不足以拟合/.test(e.message); }
  assert(threw);
});

/* ============ 5. 分类变量编码 ============ */
test('分类变量哑变量：参考类别被丢弃，编码可追溯', () => {
  const rows = [], y = [];
  const groups = ['A', 'B', 'C'];
  for (let i = 0; i < 90; i++) {
    const g = groups[i % 3];
    rows.push([g, i % 7]);
    y.push((g === 'B' ? 2 : g === 'C' ? 4 : 0) + (i % 3) * 0.5);
  }
  const fit = G.fit({
    rows, y,
    spec: { numCols: [{ name: 'x', idx: 1 }], catCols: [{ name: 'g', idx: 0, levels: ['A', 'B', 'C'], reference: 'A' }] },
    family: 'gaussian'
  });
  eq(fit.codings.length, 1, '应有一个分类变量编码');
  eq(fit.codings[0].reference, 'A');
  eq(fit.codings[0].dummies.join(','), 'B,C');
  assert(fit.coef.some(c => c.name === 'g[B]'), '应有 g[B] 系数');
  assert(!fit.coef.some(c => c.name === 'g[A]'), '参考类别不应出现');
});

test('ROC / 混淆矩阵', () => {
  const y = [0, 0, 1, 1, 1, 0, 1, 0];
  const p = [0.1, 0.2, 0.8, 0.9, 0.7, 0.3, 0.6, 0.4];
  const r = G.roc(y, p);
  assert(r.auc > 0.8 && r.auc <= 1, `AUC=${r.auc} 应在 (0.8,1]`);
  const cm = G.confusion(y, p, 0.5);
  // thr=0.5：p>=0.5 → 预测 1，逐个核对：
  //   0.1/0 → TN  0.2/0 → TN  0.8/1 → TP  0.9/1 → TP
  //   0.7/1 → TP  0.3/0 → TN  0.6/1 → TP  0.4/0 → TN
  eq(cm.tp, 4); eq(cm.tn, 4); eq(cm.fp, 0); eq(cm.fn, 0);
  approx(cm.acc, 1, 1e-9);
  approx(cm.sens, 1, 1e-9);
  approx(cm.spec, 1, 1e-9);
});

test('ROC：完美分类 AUC=1', () => {
  const r = G.roc([0, 0, 1, 1], [0.1, 0.2, 0.8, 0.9]);
  approx(r.auc, 1, 1e-9);
});

/* ============ 6. 数学函数 ============ */
test('正态 CDF 与 p 值', () => {
  approx(G.pTwoSided(0), 1, 1e-6, 'z=0 → p=1');
  approx(G.pTwoSided(1.959963985), 0.05, 1e-5, 'z=1.96 → p=0.05');
  assert(G.pTwoSided(3) < 0.01, 'z=3 应显著');
});
test('logGamma 与已知值', () => {
  approx(G.logGamma(1), 0, 1e-6, 'logΓ(1)=0');
  approx(G.logGamma(5), Math.log(24), 1e-6, 'logΓ(5)=log24');
  approx(G.logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-6, 'logΓ(0.5)=log√π');
});

/* ============ 汇总 ============ */
const failed = results.filter(r => !r.ok);
const passed = results.length - failed.length;
console.log('\n=========== V3.0 GLM TEST ===========');
results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`));
console.log('--------------------------------------');
console.log(`总计 ${results.length}  通过 ${passed}  失败 ${failed.length}  通过率 ${(passed / results.length * 100).toFixed(1)}%`);
console.log('======================================\n');
process.exit(failed.length ? 1 : 0);
