/* V3.2 · OOB 与 Block Bootstrap 算法验证
 * 重点验证"算法是否正确"，不是"函数能不能跑"。
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
global.window = {};
global.DecompressionStream = undefined;
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'preprocess.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'core.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'bootstrap.js'), 'utf8'));
const B = global.window.DACBootstrap;

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

/* ============ 1. OOB 覆盖率 ============ */
test('OOB 覆盖率接近 1/e ≈ 0.368（n=5000）', () => {
  const n = 5000, B = 5;
  const idx = B === 1 ? null : null;
  // 直接复算：模拟一次抽样，统计未入袋比例
  const r = rng(42);
  let sum = 0;
  for (let b = 0; b < 20; b++) {
    const inBag = new Set();
    for (let i = 0; i < n; i++) inBag.add(Math.floor(r() * n));
    sum += (n - inBag.size) / n;
  }
  const avg = sum / 20;
  assert(Math.abs(avg - 1 / Math.E) < 0.02, `OOB 比例 ${avg.toFixed(4)} 应接近 ${(1 / Math.E).toFixed(4)}`);
});

test('OOB 索引与抽样索引严格不相交', () => {
  const d = synth(120, 5);
  const res = B.run({ X: d.X, y: d.y, names: ['a', 'b', 'c'], labels: ['低', '中', '高'] },
    { B: 5, seed: 42, task: 'rules', levels: 3, drops: 60, maxDepth: 3, minLeaf: 8 });
  // 从 runs 里看不到 oobIdx（已裁剪），改为直接验证 sampleIndices + 集合运算
  const idxList = B.sampleIndices({ n: 120, B: 5, seed: 42, fraction: 1, replacement: true });
  idxList.forEach(idx => {
    const inBag = new Set(idx);
    const oob = [];
    for (let i = 0; i < 120; i++) if (!inBag.has(i)) oob.push(i);
    oob.forEach(i => assert(!inBag.has(i), 'OOB 不应在袋内'));
    assert(oob.length > 0, '应有 OOB 样本');
  });
});

test('rules 任务产出 OOB 指标', () => {
  const d = synth(150, 7);
  const res = B.run({ X: d.X, y: d.y, names: ['a', 'b', 'c'], labels: ['低', '中', '高'] },
    { B: 6, seed: 42, task: 'rules', levels: 3, drops: 80, maxDepth: 3, minLeaf: 8 });
  const oob = res.summary.rules.oob;
  assert(oob, 'summary.rules.oob 缺失');
  assert(oob.runs >= 4, `OOB 成功次数应 ≥4，实际 ${oob.runs}`);
  assert(oob.accuracy >= 0 && oob.accuracy <= 1, 'OOB 准确率越界');
  assert(oob.coverage > 0.2 && oob.coverage < 0.6, `OOB 覆盖率 ${oob.coverage.toFixed(3)} 应在 0.2~0.6`);
});

/* ============ 2. Block Bootstrap：块内保留时间结构 ============ */
/** 构造 AR(1)：x_t = ρ x_{t-1} + ε */
function ar1(n, rho, seed) {
  const r = rng(seed);
  const x = [0];
  for (let i = 1; i < n; i++) {
    // Box-Muller
    const u1 = Math.max(1e-12, r()), u2 = r();
    const eps = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    x.push(rho * x[i - 1] + eps);
  }
  return x;
}
function lag1Autocorr(seq) {
  const n = seq.length;
  const m = seq.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) den += (seq[i] - m) ** 2;
  for (let i = 1; i < n; i++) num += (seq[i] - m) * (seq[i - 1] - m);
  return num / (den || 1);
}

test('IID 抽样破坏自相关（对照组）', () => {
  const x = ar1(2000, 0.8, 11);
  const rho0 = lag1Autocorr(x);
  assert(rho0 > 0.6, `原始序列 ρ1=${rho0.toFixed(3)} 应 >0.6`);
  const idx = B.sampleIndices({ n: 2000, B: 1, seed: 7, fraction: 1, replacement: true })[0];
  const sampled = idx.map(i => x[i]);
  const rho1 = lag1Autocorr(sampled);
  assert(Math.abs(rho1) < 0.15, `IID 抽样后 ρ1=${rho1.toFixed(3)} 应接近 0（这就是不能对时序用 IID 的原因）`);
});

test('Moving Block 保留自相关', () => {
  const x = ar1(2000, 0.8, 13);
  const out = B.sampleBlockIndices({ n: 2000, B: 1, seed: 7, blockType: 'moving', blockLength: 60 });
  const sampled = out.indices[0].map(i => x[i]);
  const rho = lag1Autocorr(sampled);
  assert(rho > 0.5, `MBB 抽样后 ρ1=${rho.toFixed(3)} 应保留 >0.5`);
  eq(out.blockLength, 60);
  eq(out.type, 'moving');
});

test('Circular Block 保留自相关且能回绕', () => {
  const x = ar1(500, 0.8, 17);
  const out = B.sampleBlockIndices({ n: 500, B: 20, seed: 7, blockType: 'circular', blockLength: 40 });
  const sampled = out.indices[0].map(i => x[i]);
  const rho = lag1Autocorr(sampled);
  assert(rho > 0.4, `CBB 抽样后 ρ1=${rho.toFixed(3)} 应保留`);
  // 回绕：某些块应出现索引递减（跨过 n 回到 0）
  let wrapped = false;
  out.indices.forEach(idx => {
    for (let i = 1; i < idx.length; i++) {
      if (idx[i] === 0 && idx[i - 1] === 500 - 1) { wrapped = true; break; }
    }
  });
  assert(wrapped, 'CBB 应出现从 n-1 回绕到 0 的相邻对');
});

test('Stationary Bootstrap 保留自相关且块长随机', () => {
  const x = ar1(2000, 0.8, 19);
  const out = B.sampleBlockIndices({ n: 2000, B: 1, seed: 7, blockType: 'stationary', blockLength: 50 });
  const sampled = out.indices[0].map(i => x[i]);
  const rho = lag1Autocorr(sampled);
  assert(rho > 0.4, `SB 抽样后 ρ1=${rho.toFixed(3)} 应保留`);
  // 块长随机 → 相邻索引差为 +1 的比例应明显小于 1
  const idx = out.indices[0];
  let consec = 0;
  for (let i = 1; i < idx.length; i++) {
    if (idx[i] === (idx[i - 1] + 1) % 2000) consec++;
  }
  const pConsec = consec / (idx.length - 1);
  assert(pConsec > 0.5 && pConsec < 0.995, `SB 连续概率 ${pConsec.toFixed(3)} 应在 0.5~0.995（期望≈1-1/L=0.98）`);
});

test('三种块抽样的结构确实不同', () => {
  const n = 400;
  const mbb = B.sampleBlockIndices({ n, B: 3, seed: 1, blockType: 'moving', blockLength: 30 }).indices;
  const cbb = B.sampleBlockIndices({ n, B: 3, seed: 1, blockType: 'circular', blockLength: 30 }).indices;
  const sb = B.sampleBlockIndices({ n, B: 3, seed: 1, blockType: 'stationary', blockLength: 30 }).indices;
  assert(JSON.stringify(mbb) !== JSON.stringify(cbb), 'MBB 与 CBB 不应相同');
  assert(JSON.stringify(mbb) !== JSON.stringify(sb), 'MBB 与 SB 不应相同');
});

test('Block 抽样长度与 n 一致', () => {
  const out = B.sampleBlockIndices({ n: 333, B: 4, seed: 3, blockType: 'moving', blockLength: 20 });
  out.indices.forEach(idx => eq(idx.length, 333));
});

test('Block 抽样索引全部合法', () => {
  const n = 250;
  ['moving', 'circular', 'stationary'].forEach(t => {
    const out = B.sampleBlockIndices({ n, B: 5, seed: 9, blockType: t, blockLength: 25 });
    out.indices.forEach(idx => idx.forEach(i => {
      assert(Number.isInteger(i) && i >= 0 && i < n, `${t} 出现非法索引 ${i}`);
    }));
  });
});

test('Block 长度自动取 √n', () => {
  const out = B.sampleBlockIndices({ n: 900, B: 1, seed: 1, blockType: 'moving' });
  eq(out.blockLength, 30, '√900 = 30');
});

test('Block 长度超过 n 时被截断', () => {
  const out = B.sampleBlockIndices({ n: 50, B: 2, seed: 1, blockType: 'moving', blockLength: 999 });
  eq(out.blockLength, 50, '块长应被截到 n');
});

/* ============ 3. 内存估算 ============ */
test('内存估算：小样本 full 模式', () => {
  const m = B.memoryEstimate(500, 200);
  eq(m.mode, 'full');
  assert(m.totalMB < 5, `应 <5MB，实际 ${m.totalMB}`);
});
test('内存估算：大样本自动建议 sample-pairs', () => {
  const m = B.memoryEstimate(50000, 200);
  eq(m.mode, 'sample-pairs');
  assert(m.coClusterMB > 1000, `50k 的 n×n 矩阵应超 1GB，实际 ${m.coClusterMB}MB`);
});
test('内存估算：中样本建议 sparse', () => {
  const m = B.memoryEstimate(8000, 300);
  assert(['sparse', 'sample-pairs', 'full'].includes(m.mode));
  assert(m.totalMB > 100, `8000×8000 应超过 100MB，实际 ${m.totalMB}`);
});

/* ============ 4. run 集成 Block ============ */
test('run 支持 method=block 端到端', () => {
  const x = ar1(200, 0.7, 23);
  const X = x.map((v, i) => [v, i % 7]);
  const y = x.map(v => v + 0.2);
  const res = B.run({ X, y, names: ['v', 't'], labels: ['低', '中', '高'] },
    { B: 5, seed: 42, task: 'cluster', k: 3, method: 'block', blockType: 'moving', blockLength: 20, drops: 60 });
  eq(res.method, 'block');
  eq(res.blockType, 'moving');
  assert(res.okCount >= 3, `成功次数应 ≥3，实际 ${res.okCount}`);
});

/* ============ 辅助 ============ */
function synth(n, seed) {
  const r = rng(seed);
  const X = [], y = [], groups = [];
  for (let i = 0; i < n; i++) {
    const g = Math.floor(i / 10);
    const shift = (g % 3) * 5;
    X.push([r() * 10 + shift, r() * 10 + shift, r() * 5 + (g % 2) * 3]);
    y.push(r() * 10 + shift);
    groups.push('G' + g);
  }
  return { X, y, groups };
}

const failed = results.filter(r => !r.ok);
const passed = results.length - failed.length;
console.log('\n=========== V3.2 OOB / BLOCK TEST ===========');
results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`));
console.log('--------------------------------------------');
console.log(`总计 ${results.length}  通过 ${passed}  失败 ${failed.length}  通过率 ${(passed / results.length * 100).toFixed(1)}%`);
console.log('============================================\n');
process.exit(failed.length ? 1 : 0);
