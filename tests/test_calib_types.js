/* V3.5 · 条件变量按类型校准的测试
 * 核心：二分类变量不能被切成 3 等级（中间等级恒空 = 编码无意义）
 */
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

function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** 构造：一列二分类 + 一列连续 + 一列三类 */
function makeData(n, seed) {
  const r = rng(seed);
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    X.push([i % 2, r() * 10, i % 3]);
    y.push(Math.sin(i / 5) * 3 + (i % 2) * 2);
  }
  return { X, y };
}

/* ============ 1. 二分类列只产生 2 个等级 ============ */
test('crossValidateStrict：二分类列 colLevels = 2', () => {
  const d = makeData(120, 7);
  const cv = C.crossValidateStrict(d.X, d.y, ['bin', 'cont', 'tri'], ['低', '中', '高'],
    { k: 3, seed: 42, impute: 'median', levels: 3, drops: 100 });
  assert(cv.ok, '应成功');
  const rec = cv.records[0];
  eq(rec.colLevels[0], 2, '二分类列应为 2 级');
  eq(rec.colLevels[1], 3, '连续列应为 3 级');
  eq(rec.colLevels[2], 3, '三类列应为 3 级');
  eq(rec.colTypes[0], 'binary');
  eq(rec.colTypes[1], 'continuous');
});

test('二分类列编码后不会出现"中间等级"这种恒空层', () => {
  const n = 200;
  const X = [], y = [];
  for (let i = 0; i < n; i++) { X.push([i % 2, (i * 7) % 11]); y.push(Math.cos(i / 4) * 2 + (i % 2)); }
  // 全量校准二分类列，等级应只有 2 个非空
  const col = X.map(r => r[0]);
  const cal = C.calibrate(col, { levels: 2, drops: 200, lowPct: 25, highPct: 75, seed: 42 });
  assert(cal.counts.length === 2, `等级数应为 2，实际 ${cal.counts.length}`);
  assert(cal.counts.every(c => c > 0), `不应有空等级，实际 ${cal.counts}`);
});

test('同样的数据若强行 3 等级，中间必空（反证）', () => {
  const col = [];
  for (let i = 0; i < 200; i++) col.push(i % 2);
  const cal3 = C.calibrate(col, { levels: 3, drops: 200, lowPct: 25, highPct: 75, seed: 42 });
  const empty = cal3.counts.filter(c => c === 0).length;
  assert(empty >= 1, `二分类强行 3 等级应出现空等级，实际 ${cal3.counts}`);
});

/* ============ 2. 主分析一致性 ============ */
test('严格 CV 每折的二分类列等级数一致（不随机变化）', () => {
  const d = makeData(150, 11);
  const cv = C.crossValidateStrict(d.X, d.y, ['bin', 'cont', 'tri'], ['低', '中', '高'],
    { k: 5, seed: 42, impute: 'median', levels: 3, drops: 100 });
  const lv = cv.records.map(r => r.colLevels[0]);
  assert(new Set(lv).size === 1, `各折等级数应一致，实际 ${lv}`);
  eq(lv[0], 2);
});

test('连续目标 + 二分类条件：OOF 仍可算出且准确率合理', () => {
  const d = makeData(150, 13);
  const cv = C.crossValidateStrict(d.X, d.y, ['bin', 'cont', 'tri'], ['低', '中', '高'],
    { k: 4, seed: 42, impute: 'median', levels: 3, drops: 120 });
  assert(cv.oof.n > 0, 'OOF 应有样本');
  assert(cv.oof.accuracy >= 0 && cv.oof.accuracy <= 1, '准确率越界');
});

/* ============ 3. 字符串二分类 ============ */
test('字符串二分类（M/B）也识别为 2 级', () => {
  const n = 100;
  const X = [], y = [];
  for (let i = 0; i < n; i++) { X.push([i % 2 === 0 ? 'M' : 'B', i % 7]); y.push(i * 0.1); }
  const cv = C.crossValidateStrict(X, y, ['label', 'num'], ['低', '中', '高'],
    { k: 3, seed: 42, impute: 'median', levels: 3, drops: 80 });
  eq(cv.records[0].colTypes[0], 'binary');
  eq(cv.records[0].colLevels[0], 2);
});

/* ============ 4. 三类列不受影响 ============ */
test('三类列仍按用户设定的 3 级', () => {
  const d = makeData(120, 17);
  const cv = C.crossValidateStrict(d.X, d.y, ['bin', 'cont', 'tri'], ['低', '中', '高'],
    { k: 3, seed: 42, impute: 'median', levels: 4, drops: 100 });
  eq(cv.records[0].colLevels[2], 4, '三类列应跟随用户设定 4 级');
  eq(cv.records[0].colLevels[0], 2, '二分类列仍固定 2 级');
});

/* ============ 汇总 ============ */
const failed = results.filter(r => !r.ok);
const passed = results.length - failed.length;
console.log('\n=========== V3.5 校准类型 TEST ===========');
results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`));
console.log('-------------------------------------------');
console.log(`总计 ${results.length}  通过 ${passed}  失败 ${failed.length}  通过率 ${(passed / results.length * 100).toFixed(1)}%`);
console.log('===========================================\n');
process.exit(failed.length ? 1 : 0);
