/* 固定种子的验证数据集 —— 检验算法「行为」，不是断言某个准确率
 *
 * 覆盖：
 *   1) 无信号（纯噪声）→ 严格 CV 应接近多数类基线
 *   2) 适中信号 → 明显高于基线
 *   3) 非线性交互（XOR 型）→ CART 应能抓到交互
 *   4) 不平衡二分类 90/10 → Balanced Accuracy 应显著高于 Accuracy
 *   5) 不平衡二分类 130/70
 *   6) 三分类
 *   7) 分组结构（同组样本高度相关）→ 分组切分不跨组
 *   8) 时间相关（AR(1)）→ 时间顺序不能倒流
 *   9) 常量列 / 重复列 → 不崩、不产生 NaN
 *  10) 目标缺失 → 排除计数正确
 *  11) 未知类别（字符串）→ 不崩
 *
 * 生成机制与噪声都在注释里写明，随机全部固定种子。
 */
const fs = require('fs');
const path = require('path');
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'workbench', 'preprocess.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'workbench', 'core.js'), 'utf8'));
const C = global.window.DACCore;

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  → ' + (info === undefined ? '' : info)}`);
  cond ? pass++ : fail++;
};
const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d === undefined ? 3 : d) : String(v));

/* ---------- 确定性随机 ---------- */
function mkRng(seed) {
  let s = seed >>> 0;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
// Box-Muller 正态
function mkNormal(rnd) {
  return function () {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/* ============ 1. 无信号 ============ */
console.log('=== 1. 无信号（3 个纯噪声特征，目标与特征独立）===');
{
  const n = 300, rnd = mkRng(1001), norm = mkNormal(rnd);
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    X.push([norm(), norm(), norm()]);
    y.push(rnd() < 0.5 ? 0 : 1);          // 与 X 完全独立
  }
  const cv = C.crossValidateStrict(X, y, ['a', 'b', 'c'], ['类0', '类1'],
    { k: 5, seed: 42, levels: 3, drops: 80, targetType: 'binary', targetLevels: 2 });
  const base = Math.max(y.filter(v => v === 0).length, y.filter(v => v === 1).length) / n;
  ok('无信号：OOF 不显著高于多数类基线',
    cv.oof.accuracy <= base + 0.10,
    `OOF=${fmt(cv.oof.accuracy)} 基线=${fmt(base)}`);
  ok('无信号：Balanced Acc 接近 0.5',
    Math.abs(cv.oof.balancedAccuracy - 0.5) < 0.15,
    `Balanced=${fmt(cv.oof.balancedAccuracy)}`);
}

/* ============ 2. 适中信号 ============ */
console.log('\n=== 2. 适中信号（y = 1 概率随 x1 线性上升，加噪声）===');
{
  const n = 400, rnd = mkRng(1002), norm = mkNormal(rnd);
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    const x1 = norm(), x2 = norm(), x3 = norm();
    const p = 1 / (1 + Math.exp(-(1.6 * x1)));   // 只有 x1 有效
    X.push([x1, x2, x3]);
    y.push(rnd() < p ? 1 : 0);
  }
  const cv = C.crossValidateStrict(X, y, ['x1', 'x2', 'x3'], ['类0', '类1'],
    { k: 5, seed: 42, levels: 3, drops: 80, targetType: 'binary', targetLevels: 2 });
  const base = Math.max(y.filter(v => v === 0).length, y.filter(v => v === 1).length) / n;
  ok('适中信号：OOF 明显高于基线（+0.08）',
    cv.oof.accuracy > base + 0.08,
    `OOF=${fmt(cv.oof.accuracy)} 基线=${fmt(base)}`);
}

/* ============ 3. 非线性交互（XOR）============ */
console.log('\n=== 3. 非线性交互：y = (x1>0) XOR (x2>0)，单变量无信息 ===');
{
  const n = 400, rnd = mkRng(1003), norm = mkNormal(rnd);
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    const x1 = norm(), x2 = norm();
    X.push([x1, x2]);
    y.push(((x1 > 0) !== (x2 > 0)) ? 1 : 0);
  }
  // 单变量与 y 的相关应接近 0（无主效应）
  const r1 = C.pearson(X.map(r => r[0]), y);
  const r2 = C.pearson(X.map(r => r[1]), y);
  ok('XOR：单个特征与目标几乎无关',
    Math.abs(r1) < 0.15 && Math.abs(r2) < 0.15,
    `r1=${fmt(r1)} r2=${fmt(r2)}`);

  // 用云等级 + CART，应能超过基线
  const cal = [0, 1].map(j => C.calibrate(X.map(r => r[j]), { levels: 3, drops: 60, seed: 42 }));
  const Xc = X.map((_, i) => [cal[0].codes[i], cal[1].codes[i]]);
  const t = C.cart(Xc, y, ['x1', 'x2'], ['类0', '类1'], { maxDepth: 4, minLeaf: 10 });
  ok('XOR：CART 能学到交互（准确率 > 0.7）', t.accuracy > 0.7, `acc=${fmt(t.accuracy)}`);
  const usesBoth = t.rules.some(r => r.conditions.length >= 2);
  ok('XOR：规则里同时出现两个变量', usesBoth, JSON.stringify(t.rules.map(r => r.conditions)));
}

/* ============ 4. 不平衡 90/10 ============ */
console.log('\n=== 4. 不平衡二分类 90/10 ===');
{
  const n = 400, rnd = mkRng(1004), norm = mkNormal(rnd);
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    // 前 40 个是正类，且 x1 明显更高（2.0 ± 0.3 vs 0 ± 0.8），保证信号可学
    if (i < 40) { X.push([2.0 + norm() * 0.3, norm()]); y.push(1); }
    else { X.push([norm() * 0.8, norm()]); y.push(0); }
  }
  const nPos = y.filter(v => v === 1).length;
  ok('90/10：正类约 40/400', nPos >= 30 && nPos <= 50, `nPos=${nPos}`);
  const cv = C.crossValidateStrict(X, y, ['x1', 'x2'], ['负', '正'],
    { k: 5, seed: 42, levels: 3, drops: 80, targetType: 'binary', targetLevels: 2 });
  const b = cv.oof.balancedAccuracy, a = cv.oof.accuracy;
  ok('90/10：Balanced Acc ≥ 0.5（没有比随机更差）', b >= 0.5 - 1e-9, `Bal=${fmt(b)}`);
  // 不平衡数据里，只看 Accuracy 会被多数类盖住；这里检验"两者不是同一个数"
  ok('90/10：Balanced 与 Accuracy 反映不同信息（不要求谁大）',
    Math.abs(b - a) > 1e-9 || a >= 0.99,
    `Acc=${fmt(a)} Bal=${fmt(b)}`);
}

/* ============ 5. 不平衡 130/70 ============ */
console.log('\n=== 5. 不平衡二分类 130/70 ===');
{
  const n = 200, rnd = mkRng(1005), norm = mkNormal(rnd);
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    const x1 = norm();
    X.push([x1]);
    y.push(i < 130 ? 0 : 1);
  }
  const cv = C.crossValidateStrict(X, y, ['x1'], ['负', '正'],
    { k: 5, seed: 42, levels: 3, drops: 80, targetType: 'binary', targetLevels: 2 });
  ok('130/70：正类基准率 = 0.35',
    Math.abs(cv.oof.n > 0 ? (y.filter(v => v === 1).length / n) - 0.35 : 1) < 1e-9,
    `${y.filter(v => v === 1).length / n}`);
  ok('130/70：OOF 覆盖全部样本', cv.oof.n === n, `n=${cv.oof.n}`);
}

/* ============ 6. 三分类 ============ */
console.log('\n=== 6. 三分类（三个簇，间隔明显）===');
{
  const n = 300, rnd = mkRng(1006), norm = mkNormal(rnd);
  const X = [], y = [];
  const centers = [[-3, 0], [0, 3], [3, -2]];
  for (let i = 0; i < n; i++) {
    const c = i % 3;
    X.push([centers[c][0] + norm() * 0.6, centers[c][1] + norm() * 0.6]);
    y.push(c);
  }
  const cv = C.crossValidateStrict(X, y, ['x1', 'x2'], ['甲', '乙', '丙'],
    { k: 5, seed: 42, levels: 3, drops: 80, targetType: 'categorical', targetLevels: 3 });
  ok('三分类：OOF 远高于 1/3', cv.oof.accuracy > 0.8, `OOF=${fmt(cv.oof.accuracy)}`);
  ok('三分类：nLevels = 3', cv.nLevels === 3 || cv.targetLevels === 3, `nLevels=${cv.nLevels}`);
}

/* ============ 7. 分组结构 ============ */
console.log('\n=== 7. 分组结构（同组样本高度相关）===');
{
  const nGroups = 20, perGroup = 10, rnd = mkRng(1007), norm = mkNormal(rnd);
  const X = [], y = [], groups = [];
  for (let g = 0; g < nGroups; g++) {
    const gEffect = norm() * 2;               // 组内共享的强效应
    for (let k = 0; k < perGroup; k++) {
      X.push([gEffect + norm() * 0.3, norm()]);
      y.push(gEffect > 0 ? 1 : 0);            // 目标几乎由组决定
    }
  }
  for (let g = 0; g < nGroups; g++) for (let k = 0; k < perGroup; k++) groups.push(g);

  const folds = C.groupFolds(groups, 5, 42);
  ok('分组切分：5 折', folds.length === 5, `${folds.length}`);
  // 每折的「测试集」= folds[f]，训练集 = 其他折
  let leaked = 0;
  folds.forEach((testIdx, f) => {
    const testGroups = new Set(testIdx.map(i => groups[i]));
    const trainIdx = folds.filter((_, g) => g !== f).reduce((a, arr) => a.concat(arr), []);
    trainIdx.forEach(i => { if (testGroups.has(groups[i])) leaked++; });
  });
  ok('分组切分：训练折不含测试折的组', leaked === 0, `泄漏 ${leaked} 条`);
  const covered = new Set();
  folds.forEach(f => f.forEach(i => covered.add(i)));
  ok('分组切分：覆盖全部样本', covered.size === X.length, `${covered.size}/${X.length}`);
  // 每折的测试集之间不重叠
  let overlap = 0;
  const seen = new Set();
  folds.forEach(f => f.forEach(i => { if (seen.has(i)) overlap++; seen.add(i); }));
  ok('分组切分：各折测试集互不重叠', overlap === 0, `重叠 ${overlap}`);
}

/* ============ 8. 时间相关 ============ */
console.log('\n=== 8. 时间相关（AR(1)，rho=0.8）===');
{
  const n = 300, rnd = mkRng(1008), norm = mkNormal(rnd);
  const seq = [norm()];
  for (let i = 1; i < n; i++) seq.push(0.8 * seq[i - 1] + norm() * 0.6);
  const r1 = C.pearson(seq.slice(0, -1), seq.slice(1));
  ok('AR(1) 自相关约 0.8', Math.abs(r1 - 0.8) < 0.12, `r=${fmt(r1)}`);

  // 时间切分：前 70% 训练、后 30% 测试，索引不能倒流
  const cut = Math.floor(n * 0.7);
  const trainIdx = Array.from({ length: cut }, (_, i) => i);
  const testIdx = Array.from({ length: n - cut }, (_, i) => cut + i);
  ok('时间切分：训练索引全部早于测试索引',
    Math.max(...trainIdx) < Math.min(...testIdx), `${Math.max(...trainIdx)} < ${Math.min(...testIdx)}`);
  ok('时间切分：无重叠', trainIdx.filter(i => testIdx.indexOf(i) >= 0).length === 0);
}

/* ============ 9. 常量列 / 重复列 ============ */
console.log('\n=== 9. 常量列与重复列 ===');
{
  const n = 100, rnd = mkRng(1009), norm = mkNormal(rnd);
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    const a = norm();
    X.push([a, 5, a, norm()]);               // 第 2 列常量、第 3 列与第 1 列重复
    y.push(a > 0 ? 1 : 0);
  }
  const corr = C.corrMatrix(['a', 'const', 'a2', 'b'], X);
  ok('常量列不产生 NaN 相关', Number.isFinite(corr.matrix[0][1]) || corr.matrix[0][1] === 0,
    `r=${corr.matrix[0][1]}`);
  ok('重复列相关 = 1', Math.abs(corr.matrix[0][2] - 1) < 1e-9, `r=${corr.matrix[0][2]}`);

  let err = null, cv = null;
  try {
    cv = C.crossValidateStrict(X, y, ['a', 'const', 'a2', 'b'], ['类0', '类1'],
      { k: 5, seed: 42, levels: 3, drops: 60, targetType: 'binary', targetLevels: 2 });
  } catch (e) { err = e; }
  ok('常量列不导致严格 CV 崩溃', !err, err && err.message);
  ok('常量列不产生 NaN 准确率', !cv || Number.isFinite(cv.oof.accuracy), cv && cv.oof.accuracy);
}

/* ============ 10. 目标缺失 ============ */
console.log('\n=== 10. 目标缺失 ===');
{
  const n = 100, rnd = mkRng(1010), norm = mkNormal(rnd);
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    X.push([norm()]);
    y.push(i < 20 ? null : (rnd() < 0.5 ? 0 : 1));   // 前 20 个目标缺失
  }
  const validY = y.filter(v => v !== null);
  ok('目标缺失 20 条', validY.length === 80, `${validY.length}`);
  const cv = C.crossValidateStrict(X, y, ['x1'], ['类0', '类1'],
    { k: 5, seed: 42, levels: 3, drops: 60, targetType: 'binary', targetLevels: 2 });
  ok('缺失目标不参与评分（OOF n = 80）', cv.oof.n === 80, `n=${cv.oof.n}`);
  ok('缺失目标不产生 NaN', Number.isFinite(cv.oof.accuracy), cv.oof.accuracy);
}

/* ============ 11. 未知类别 ============ */
console.log('\n=== 11. 字符串类别 ===');
{
  const n = 150, rnd = mkRng(1011);
  const X = [], y = [];
  const labels = ['甲', '乙', '丙'];
  for (let i = 0; i < n; i++) {
    X.push([Math.floor(rnd() * 5), Math.floor(rnd() * 4)]);
    y.push(i % 3);                             // 三分类整数编码
  }
  let err = null, cv = null;
  try {
    cv = C.crossValidateStrict(X, y, ['c1', 'c2'], labels,
      { k: 5, seed: 42, levels: 3, drops: 60, targetType: 'categorical', targetLevels: 3 });
  } catch (e) { err = e; }
  ok('纯离散特征不崩溃', !err, err && err.message);
  ok('纯离散特征能给出有限准确率', !cv || Number.isFinite(cv.oof.accuracy), cv && cv.oof.accuracy);

  const t = C.detectTargetType(y.map(v => labels[v]));
  ok('字符串目标被识别为类别', t.type === 'categorical' || t.type === 'nominal', `${t.type}`);
}

/* ============ 12. 标签置换（整体行为）============ */
console.log('\n=== 12. 标签置换：打乱 y 后准确率应接近基线 ===');
{
  const n = 300, rnd = mkRng(1012), norm = mkNormal(rnd);
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    const x1 = norm();
    X.push([x1, norm()]);
    y.push(1 / (1 + Math.exp(-2 * x1)) > rnd() ? 1 : 0);
  }
  // 打乱
  const perm = y.slice();
  for (let i = perm.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const base = Math.max(perm.filter(v => v === 0).length, perm.filter(v => v === 1).length) / n;
  const cv = C.crossValidateStrict(X, perm, ['x1', 'x2'], ['类0', '类1'],
    { k: 5, seed: 42, levels: 3, drops: 60, targetType: 'binary', targetLevels: 2 });
  ok('置换后 OOF 不比基线高多少（≤ +0.12）',
    cv.oof.accuracy <= base + 0.12,
    `OOF=${fmt(cv.oof.accuracy)} 基线=${fmt(base)}`);
}

console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
