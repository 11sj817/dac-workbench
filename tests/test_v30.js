/* DAC Workbench V3.0 · P0 算法修复测试（目标类型 / OOF 口径 / 离散目标） */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
global.window = {};
global.DecompressionStream = undefined;
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'preprocess.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'core.js'), 'utf8'));
const C = global.window.DACCore;

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message }); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'eq'}: ${a} !== ${b}`); };
const approx = (a, b, t, m) => { t = t === undefined ? 1e-9 : t; if (!(Math.abs(a - b) <= t)) throw new Error(`${m || 'approx'}: ${a} vs ${b}`); };

/* ============ 1. 目标变量类型识别 ============ */
test('二分类：数值型 0/1 → binary', () => {
  const r = C.detectTargetType([0, 1, 0, 1, 1, 0, 1, 1, 0, 0]);
  eq(r.type, 'binary');
  eq(r.levels.length, 2);
  eq(r.levels[0], 0);
  assert(/不做分位数校准/.test(r.reason), '应说明不做校准');
});
test('二分类：字符串 M/B → binary', () => {
  const r = C.detectTargetType(['M', 'B', 'M', 'B', 'M', 'B']);
  eq(r.type, 'binary');
  eq(r.levels.join(''), 'BM');
});
test('多分类：字符串 3 类 → categorical', () => {
  const r = C.detectTargetType(['A', 'B', 'C', 'A', 'B', 'C', 'A']);
  eq(r.type, 'categorical');
  eq(r.levels.length, 3);
});
test('有序分类：少量整数 → categorical', () => {
  const r = C.detectTargetType([1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2]);
  eq(r.type, 'categorical');
});
test('连续变量：大量不同浮点 → continuous', () => {
  const v = [];
  for (let i = 0; i < 100; i++) v.push(i * 0.37 + Math.sin(i));
  eq(C.detectTargetType(v).type, 'continuous');
});
test('计数变量：非负整数且方差>>均值 → count', () => {
  // 负二项式风格的过度离散计数
  const v = [0, 0, 0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597];
  const r = C.detectTargetType(v);
  eq(r.type, 'count', '应识别为计数（实际 ' + r.type + '）');
});
test('全空 → unknown', () => {
  eq(C.detectTargetType([null, null, undefined]).type, 'unknown');
});
test('常数变量不会崩溃', () => {
  const r = C.detectTargetType([5, 5, 5, 5, 5, 5]);
  assert(['categorical', 'binary', 'continuous', 'count'].includes(r.type), '应给出某种类型');
});

/* ============ 2. 二分类目标：不做云模型校准 ============ */
function synthBinary(n, seed) {
  let a = seed >>> 0;
  const r = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    const x1 = r() * 10, x2 = r() * 10;
    X.push([x1, x2]);
    y.push((x1 + x2 > 10) ? 1 : 0);
  }
  return { X, y };
}

test('二分类目标：nLevels = 2，且标记 discreteTarget', () => {
  const d = synthBinary(120, 7);
  const cv = C.crossValidateStrict(d.X, d.y, ['a', 'b'], ['低', '中', '高'],
    { k: 3, seed: 42, impute: 'median', levels: 3, drops: 100 });
  eq(cv.targetType, 'binary');
  eq(cv.discreteTarget, true);
  eq(cv.nLevels, 2, '二分类目标应只有 2 个等级');
  eq(cv.targetLevels.join(','), '0,1');
});

test('二分类目标：标签定义不受分位数影响（条件变量仍会被离散化）', () => {
  const d = synthBinary(120, 11);
  const a = C.crossValidateStrict(d.X, d.y, ['a', 'b'], ['低', '中', '高'],
    { k: 3, seed: 42, impute: 'median', levels: 3, drops: 100, lowPct: 25, highPct: 75 });
  const b = C.crossValidateStrict(d.X, d.y, ['a', 'b'], ['低', '中', '高'],
    { k: 3, seed: 42, impute: 'median', levels: 3, drops: 100, lowPct: 10, highPct: 90 });
  // 目标类别定义必须一致（这是 P0 的核心）
  eq(a.nLevels, 2); eq(b.nLevels, 2);
  eq(a.targetLevels.join(','), b.targetLevels.join(','), '目标类别不应随分位数改变');
  eq(a.discreteTarget, true);
  // 条件变量仍按训练折分位数离散化，因此整体准确率会变——这是正确行为，不是 bug
  assert(a.mean > 0 && b.mean > 0, '两次都应得到有效结果');
});

test('连续目标：仍然使用云校准（受分位数影响）', () => {
  const X = [], y = [];
  for (let i = 0; i < 120; i++) { X.push([i % 11, (i * 3) % 7]); y.push(i % 11 + (i % 3) * 0.1); }
  const a = C.crossValidateStrict(X, y, ['a', 'b'], ['低', '中', '高'],
    { k: 3, seed: 42, impute: 'median', levels: 3, drops: 100, lowPct: 25, highPct: 75 });
  eq(a.discreteTarget, false);
  eq(a.nLevels, 3);
});

/* ============ 3. OOF 口径一致性 ============ */
test('OOF 真实标签来自各折，而非全量粗标签', () => {
  const d = synthBinary(150, 13);
  const cv = C.crossValidateStrict(d.X, d.y, ['a', 'b'], ['低', '中', '高'],
    { k: 4, seed: 42, impute: 'median', levels: 3, drops: 100 });
  const oofN = cv.oof.confusion.flat().reduce((a, b) => a + b, 0);
  assert(oofN > 0, 'OOF 样本数应 > 0');
  // OOF 的准确率必须等于混淆矩阵对角线占比（同一口径）
  const diag = cv.oof.confusion.reduce((s, row, i) => s + row[i], 0);
  approx(cv.oof.accuracy, diag / oofN, 1e-9, 'OOF 准确率应等于混淆矩阵对角占比');
});

test('OOF 覆盖数 ≤ 总样本数', () => {
  const d = synthBinary(100, 17);
  const cv = C.crossValidateStrict(d.X, d.y, ['a', 'b'], ['低', '中', '高'],
    { k: 3, seed: 42, impute: 'median', levels: 3, drops: 100 });
  assert(cv.oof.n <= 100, `OOF n=${cv.oof.n} 不应超过样本数`);
  assert(cv.oof.n >= 80, `OOF n=${cv.oof.n} 应覆盖大部分样本`);
});

/* ============ 4. 每折标签定义独立 ============ */
test('连续目标：每折 yBounds 不同（训练集分位数各算各的）', () => {
  const X = [], y = [];
  for (let i = 0; i < 100; i++) { X.push([i % 7, i % 5]); y.push(Math.sin(i / 5) * 10 + i * 0.05); }
  const cv = C.crossValidateStrict(X, y, ['a', 'b'], ['低', '中', '高'],
    { k: 4, seed: 42, impute: 'median', levels: 3, drops: 100 });
  const los = cv.records.map(r => r.yBounds && r.yBounds.lo).filter(Number.isFinite);
  assert(los.length >= 2, '应有至少 2 折记录 yBounds');
  assert(new Set(los.map(x => x.toFixed(6))).size > 1, '各折 yBounds 不应完全相同');
});

test('离散目标：records 里 yBounds 为 null（不做分位数）', () => {
  const d = synthBinary(100, 23);
  const cv = C.crossValidateStrict(d.X, d.y, ['a', 'b'], ['低', '中', '高'],
    { k: 3, seed: 42, impute: 'median', levels: 3, drops: 100 });
  cv.records.forEach(r => assert(r.yBounds === null, '离散目标不该有 yBounds'));
});

/* ============ 5. 三分类字符串目标 ============ */
test('字符串三类目标：nLevels=3 且标签保留', () => {
  const X = [], y = [];
  const L = ['低', '中', '高'];
  for (let i = 0; i < 120; i++) { X.push([i % 9, i % 5]); y.push(L[i % 3]); }
  const cv = C.crossValidateStrict(X, y, ['a', 'b'], L, { k: 3, seed: 42, impute: 'median', levels: 3, drops: 100 });
  eq(cv.targetType, 'categorical');
  eq(cv.nLevels, 3);
  eq(cv.targetLevels.join(','), '中,低,高');
});

/* ============ 汇总 ============ */
const failed = results.filter(r => !r.ok);
const passed = results.length - failed.length;
console.log('\n=========== V3.0 P0 TEST ===========');
results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`));
console.log('-------------------------------------');
console.log(`总计 ${results.length}  通过 ${passed}  失败 ${failed.length}  通过率 ${(passed / results.length * 100).toFixed(1)}%`);
console.log('=====================================\n');
process.exit(failed.length ? 1 : 0);
