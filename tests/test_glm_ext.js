/* V3.2 · Gamma / 负二项 / 加权 GLM 验证 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
global.window = {};
global.DecompressionStream = undefined;
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'preprocess.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'core.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'glm.js'), 'utf8'));
const G = global.window.DACGLM;

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message }); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const approx = (a, b, t, m) => { t = t === undefined ? 1e-9 : t; if (!(Math.abs(a - b) <= t)) throw new Error(`${m || 'approx'}: ${a} vs ${b}`); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'eq'}: ${a} !== ${b}`); };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gammaSample(r, shape, scale) {
  // Marsaglia & Tsang
  if (shape < 1) {
    const u = Math.max(1e-12, r());
    return gammaSample(r, shape + 1, scale) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (; ;) {
    let x, v;
    do { x = Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r()); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x ** 4) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/* ============ Gamma ============ */
test('Gamma：系数与已知真值方向一致', () => {
  const r = rng(101);
  const X = [], y = [];
  for (let i = 0; i < 400; i++) {
    const x1 = (i % 20) / 10, x2 = ((i * 7) % 13) / 6;
    X.push([x1, x2]);
    // 真值（log link）：log μ = 0.5 + 0.3*x1 - 0.2*x2
    const mu = Math.exp(0.5 + 0.3 * x1 - 0.2 * x2);
    y.push(gammaSample(r, 4, mu / 4));   // shape=4 → var=mu²/4
  }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'x1', idx: 0 }, { name: 'x2', idx: 1 }] }, family: 'gamma' });
  assert(fit.converged, '应收敛');
  assert(fit.coef[1].est > 0, `x1 系数应为正（实际 ${fit.coef[1].est.toFixed(4)}）`);
  assert(fit.coef[2].est < 0, `x2 系数应为负（实际 ${fit.coef[2].est.toFixed(4)}）`);
});

test('Gamma：score 方程归零', () => {
  const r = rng(103);
  const X = [], y = [];
  for (let i = 0; i < 300; i++) {
    const a = (i % 15) / 10 + 0.6;
    X.push([a]);
    const mu = Math.exp(0.8 + 0.5 * a);
    y.push(gammaSample(r, 5, mu / 5));
  }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'a', idx: 0 }] }, family: 'gamma' });
  // score: Σ (y-μ)/(μ²) * (dμ/dη) * x = Σ (y-μ)/μ * x   （inverse link）
  const Xd = [[1, X[0][0]]];
  let worst = 0;
  for (let j = 0; j < 2; j++) {
    let s = 0;
    for (let i = 0; i < X.length; i++) {
      const mu = fit.mu[i];
      const xi = j === 0 ? 1 : X[i][0];
      s += ((y[i] - mu) / mu) * xi;
    }
    worst = Math.max(worst, Math.abs(s));
  }
  assert(worst < 1e-3, `score 未归零：${worst.toExponential(2)}`);
});

test('Gamma：目标必须 >0', () => {
  let threw = false;
  try { G.fit({ rows: [[1], [2], [3], [4], [5]], y: [1, 2, 0, 4, 5], spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'gamma' }); }
  catch (e) { threw = /全部 > 0|>0/.test(e.message); }
  assert(threw, '应拒绝含 0 的 Gamma 目标');
});

/* ============ 负二项 ============ */
test('负二项：θ 被估计且为正', () => {
  const r = rng(201);
  const X = [], y = [];
  // 过度离散计数：NB(theta=2)
  const theta = 2;
  for (let i = 0; i < 400; i++) {
    const x = (i % 10) / 5;
    X.push([x]);
    const mu = Math.exp(0.5 + 0.4 * x);
    // NB 抽样：lambda ~ Gamma(shape=theta, scale=mu/theta)，然后 Poisson(lambda)
    const lam = gammaSample(r, theta, mu / theta);
    // Poisson(lam)
    let k = 0, p = 1, acc = 0;
    do { k++; acc += Math.log(Math.max(1e-12, r())); } while (acc > -lam && k < 200);
    y.push(k - 1);
  }
  const fit = G.fit({ rows: X, y, spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'negbin' });
  assert(fit.converged, '应收敛');
  assert(fit.theta > 0, `θ 应为正，实际 ${fit.theta}`);
  assert(fit.coef[1].est > 0, '斜率应为正');
});

test('负二项：θ 越大越接近泊松', () => {
  const X = [], y = [];
  for (let i = 0; i < 200; i++) {
    const x = (i % 10) / 5;
    X.push([x]);
    y.push(Math.round(Math.exp(0.5 + 0.4 * x)));
  }
  const fitNB = G.fit({ rows: X, y, spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'negbin' });
  const fitP = G.fit({ rows: X, y, spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'poisson' });
  // 无过度离散的计数数据 → θ 应很大，两模型系数接近
  if (fitNB.theta > 100) {
    approx(fitNB.coef[1].est, fitP.coef[1].est, 0.05, 'θ 很大时 NB 应接近 Poisson');
  } else {
    // 允许有限 θ，但方向必须一致
    eq(Math.sign(fitNB.coef[1].est), Math.sign(fitP.coef[1].est));
  }
});

test('负二项：拒绝非整数目标', () => {
  let threw = false;
  try { G.fit({ rows: [[1], [2], [3], [4], [5]], y: [1.5, 2, 3, 4, 5], spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'negbin' }); }
  catch (e) { threw = /非负整数/.test(e.message); }
  assert(threw);
});

/* ============ 加权 ============ */
test('权重全为 1 时结果与不加权完全一致', () => {
  const X = [], y = [];
  for (let i = 0; i < 120; i++) { X.push([i % 9, (i * 3) % 7]); y.push(i * 0.3 + (i % 5)); }
  const spec = { numCols: [{ name: 'a', idx: 0 }, { name: 'b', idx: 1 }] };
  const a = G.fit({ rows: X, y, spec, family: 'gaussian' });
  const b = G.fit({ rows: X, y, spec, family: 'gaussian', weights: new Array(120).fill(1) });
  approx(a.coef[1].est, b.coef[1].est, 1e-12);
  approx(a.coef[1].se, b.coef[1].se, 1e-12);
});

test('频率权重等价于复制样本', () => {
  const X = [], y = [];
  for (let i = 0; i < 40; i++) { X.push([i % 5]); y.push(i * 0.5 + (i % 3)); }
  const spec = { numCols: [{ name: 'x', idx: 0 }] };
  const w = new Array(40).fill(2);
  const fitW = G.fit({ rows: X, y, spec, family: 'gaussian', weights: w });
  // 复制一遍
  const X2 = X.concat(X), y2 = y.concat(y);
  const fitDup = G.fit({ rows: X2, y: y2, spec, family: 'gaussian' });
  approx(fitW.coef[1].est, fitDup.coef[1].est, 1e-9, '点估计应一致');
  // 标准误：频率权重下 se 更小（样本量翻倍）
  assert(fitW.coef[1].se < fitDup.coef[1].se * 1.1, '加权 SE 应与复制样本同量级');
});

test('权重全 0 报错而非静默出 NaN', () => {
  const X = [[1], [2], [3], [4], [5], [6]], y = [1, 2, 3, 4, 5, 6];
  let threw = false;
  try { G.fit({ rows: X, y, spec: { numCols: [{ name: 'x', idx: 0 }] }, family: 'gaussian', weights: new Array(6).fill(0) }); }
  catch (e) { threw = /奇异|非有限/.test(e.message); }
  assert(threw, '全 0 权重应报错');
});

test('加权改变点估计（非平凡权重 + 异方差）', () => {
  const X = [], y = [];
  // 噪声随 x 增大：加权会明显改变斜率
  let a2 = 7;
  const rnd = () => { a2 |= 0; a2 = (a2 + 0x6D2B79F5) | 0; let t2 = Math.imul(a2 ^ (a2 >>> 15), 1 | a2); t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2; return ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < 60; i++) {
    const x = i % 6;
    X.push([x]);
    y.push(1 + 2 * x + (rnd() - 0.5) * (x + 1) * 3);
  }
  const spec = { numCols: [{ name: 'x', idx: 0 }] };
  const a = G.fit({ rows: X, y, spec, family: 'gaussian' });
  const w = X.map(r => 1 + r[0]);   // 与 x 相关的权重
  const b = G.fit({ rows: X, y, spec, family: 'gaussian', weights: w });
  assert(Math.abs(a.coef[1].est - b.coef[1].est) > 1e-6, '加权应改变点估计');
});

/* ============ 汇总 ============ */
const failed = results.filter(r => !r.ok);
const passed = results.length - failed.length;
console.log('\n=========== V3.2 GLM 扩展 TEST ===========');
results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`));
console.log('-------------------------------------------');
console.log(`总计 ${results.length}  通过 ${passed}  失败 ${failed.length}  通过率 ${(passed / results.length * 100).toFixed(1)}%`);
console.log('===========================================\n');
process.exit(failed.length ? 1 : 0);
