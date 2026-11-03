/* DAC Workbench V2.1 · 缺失值处理与防泄漏专项测试
 * 用法：node tests/test_v21.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.window = {};
global.DecompressionStream = undefined;
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'preprocess.js'), 'utf8'));
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'core.js'), 'utf8'));
const P = global.window.DACPre;
const C = global.window.DACCore;

/* ---------------- 框架 ---------------- */
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function approx(a, b, tol, m) {
  tol = tol === undefined ? 1e-9 : tol;
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m || 'approx'}: ${a} vs ${b}`);
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: ${a} !== ${b}`); }

/* ================= 1. 分布漂移：填补必须用训练集统计量 ================= */
test('填补均值来自训练集（验证集均值 1000 不污染）', () => {
  const train = [[10], [10], [10], [10], [null]];
  const test = [[1000], [1000], [1000], [1000], [null]];
  const model = P.fitImputer(train, ['x'], { strategy: 'mean' });
  approx(model.fillValues[0], 10, 1e-12, '训练集均值应为 10');
  const r = P.transformImputer(test, model, train);
  approx(r.matrix[4][0], 10, 1e-12, '验证集缺失应填 10 而不是 502');
  const rTrain = P.transformImputer(train, model, train);
  approx(rTrain.matrix[4][0], 10, 1e-12);
});

test('中位数填补不受极端值影响', () => {
  const train = [[1], [2], [3], [4], [100000], [null]];
  const model = P.fitImputer(train, ['x'], { strategy: 'median' });
  approx(model.fillValues[0], 3, 1e-12, '中位数应为 3');
  const meanModel = P.fitImputer(train, ['x'], { strategy: 'mean' });
  assert(meanModel.fillValues[0] > 1000, '均值应被极端值拉高');
});

test('众数填补：分类列不会用均值', () => {
  const train = [['A'], ['A'], ['A'], ['B'], [null]];
  const model = P.fitImputer(train, ['c'], { strategy: 'mean' });   // 故意传 mean
  eq(model.strategies[0], 'mode', '分类列应自动降级为众数');
  eq(model.fillValues[0], 'A', '众数应为 A');
});

/* ================= 2. 分位数泄漏 ================= */
test('calibrateWith 不重算分位数，只按给定界打分', () => {
  const bounds = { lo: 0, hi: 10 };
  const low = C.calibrateWith([0.5], bounds, { levels: 3, drops: 100, seed: 42 });
  const high = C.calibrateWith([9.5], bounds, { levels: 3, drops: 100, seed: 42 });
  eq(low.codes[0], 0, '0.5 应落在最低档');
  eq(high.codes[0], 2, '9.5 应落在最高档');
  eq(low.lo, 0); eq(low.hi, 10);
  // 传入极端值也不改变界
  const extreme = C.calibrateWith([1e6], bounds, { levels: 3, drops: 100, seed: 42 });
  eq(extreme.lo, 0, 'calibrateWith 不得修改 lo');
  eq(extreme.codes[0], 2, '超界值应归入最高档');
});

// 契约变更（V4.6）：lo === hi 属于「常量列」这种合法数据，不该整条流水线崩；
// 但必须标记 degenerate，让下游知道这一列没有信息。
// 真正非法的输入（NaN / Infinity）仍然抛错。
test('calibrateWith 非有限界抛错', () => {
  let threw1 = false, threw2 = false;
  try { C.calibrateWith([1], { lo: NaN, hi: 5 }, { levels: 3 }); } catch (e) { threw1 = /非法/.test(e.message); }
  try { C.calibrateWith([1], { lo: 0, hi: Infinity }, { levels: 3 }); } catch (e) { threw2 = /非法/.test(e.message); }
  assert(threw1, 'lo = NaN 应抛错');
  assert(threw2, 'hi = Infinity 应抛错');
});

test('calibrateWith 常量列降级但不崩', () => {
  const r = C.calibrateWith([5, 5, 5], { lo: 5, hi: 5 }, { levels: 3, drops: 50, seed: 42 });
  assert(r.degenerate === true, 'lo === hi 应标记 degenerate');
  assert(Number.isFinite(r.lo) && Number.isFinite(r.hi), 'lo/hi 必须仍是有限数');
  assert(r.hi > r.lo, '内部应给一个极小跨度，避免下游除 0');
  assert(r.codes.every(c => Number.isFinite(c)), 'codes 不得为 NaN');
  // 常量列不该被切成多个等级：所有样本应落在同一个码
  const uniq = new Set(r.codes);
  assert(uniq.size === 1, '常量列应全部落在同一等级，实际 ' + JSON.stringify([...uniq]));
});

test('calibrateWith 反向界（lo > hi）不产生 NaN', () => {
  let r = null, err = null;
  try { r = C.calibrateWith([1, 2, 3], { lo: 10, hi: 0 }, { levels: 3, drops: 50, seed: 42 }); }
  catch (e) { err = e; }
  // 要么明确报错，要么给出有限结果；不允许静默产生 NaN
  if (!err) {
    assert(r.codes.every(c => Number.isFinite(c)), 'codes 不得为 NaN');
  } else {
    assert(/非法/.test(err.message), '若报错，应说明是界的非法');
  }
});

test('严格 CV 的分位数界落在训练折值域内', () => {
  const n = 120;
  const rawX = [], y = [];
  for (let i = 0; i < n; i++) {
    rawX.push([i % 10, (i * 7) % 13, i % 5]);
    y.push((i % 10) * 0.5 + ((i * 7) % 13) * 0.1);
  }
  const cv = C.crossValidateStrict(rawX, y, ['a', 'b', 'c'], ['低', '中', '高'],
    { k: 5, seed: 42, impute: 'median', levels: 3, drops: 200 });
  assert(cv.ok, 'CV 应成功: ' + cv.reason);
  cv.records.forEach(r => {
    r.bounds.forEach((b, j) => {
      const vals = r.trainIdx.map(i => rawX[i][j]).filter(v => Number.isFinite(v)).sort((x, y2) => x - y2);
      assert(b.lo >= vals[0] - 1e-9, `第${r.fold}折列${j} lo 下界越界`);
      assert(b.hi <= vals[vals.length - 1] + 1e-9, `第${r.fold}折列${j} hi 上界越界`);
    });
  });
});

/* ================= 3. 标准化 / 距离归一化 ================= */
test('KNN 距离归一化范围只由训练集决定', () => {
  const train = [[0], [1], [2], [3], [4], [null]];
  const model = P.fitImputer(train, ['x'], { strategy: 'knn', knn: { k: 2 } });
  approx(model.ranges[0], 4, 1e-12, '训练集范围应为 4');
  // 用远超训练范围的验证集，ranges 不得改变
  const test = [[1000], [null]];
  P.transformImputer(test, model, train);
  approx(model.ranges[0], 4, 1e-12, 'transform 后 range 不得改变');
});

/* ================= 4. KNN 泄漏 ================= */
test('KNN 填补只参考训练集，验证集样本互不影响', () => {
  const train = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]];
  const testA = [[null, 0.2], [1000, 1000]];
  const testB = [[null, 0.2], [9999, 9999]];   // 只改第二个验证样本
  const model = P.fitImputer(train, ['x', 'y'], { strategy: 'knn', knn: { k: 2, weighted: false } });
  const a = P.transformImputer(testA, model, train);
  const b = P.transformImputer(testB, model, train);
  approx(a.matrix[0][0], b.matrix[0][0], 1e-12, '验证集其他样本不应影响本样本的填补值');
});

test('KNN 数值填补取邻居均值', () => {
  // 训练集一维等距 0..4，目标点在 1.2 附近 → 邻居 1 和 2 → 均值 1.5
  const train = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]];
  const test = [[1.2, null]];
  const model = P.fitImputer(train, ['x', 'y'], { strategy: 'knn', knn: { k: 2, weighted: false } });
  const r = P.transformImputer(test, model, train);
  assert(r.matrix[0][1] >= 1 && r.matrix[0][1] <= 2.5, `邻居均值应接近 1.5，实际 ${r.matrix[0][1]}`);
});

test('KNN 分类填补取加权众数', () => {
  const train = [['A', 0], ['A', 1], ['B', 2], ['A', 3], ['B', 4]];
  const test = [['A', null]][0] ? [[null, 0.2]] : [];
  const model = P.fitImputer(train, ['g', 'v'], { strategy: 'knn', knn: { k: 3, weighted: false } });
  const r = P.transformImputer(test, model, train);
  eq(r.matrix[0][0], 'A', '最近 3 个邻居中 A 占多数');
});

test('KNN 无可用邻居时回退并记账', () => {
  // 只有一列，且该列缺失 → 无法算距离
  const train = [[1], [2], [3]];
  const test = [[null], [null]];
  const model = P.fitImputer(train, ['x'], { strategy: 'knn', fallback: 'median' });
  // 单列数据会自动降级为 median，故这里验证降级记录
  eq(model.strategies[0], 'median', '单列 KNN 应降级为 median');
  const r = P.transformImputer(test, model, train);
  approx(r.matrix[0][0], 2, 1e-12, '应填中位数 2');
});

test('KNN 参考集中目标列全缺失时也能回退', () => {
  const train = [[1, null], [2, null], [3, null]];
  const test = [[null, 5]];
  const model = P.fitImputer(train, ['x', 'y'], { strategy: 'knn', fallback: 'median', knn: { k: 2 } });
  const r = P.transformImputer(test, model, train);
  assert(Number.isFinite(r.matrix[0][0]), '应得到有限值');
  assert(r.log.fallbackReasons.length > 0, '应记录回退原因');
});

/* ================= 5. 交叉验证独立性 ================= */
test('CV 每折训练/验证索引不重叠', () => {
  const rawX = [], y = [];
  for (let i = 0; i < 100; i++) { rawX.push([i % 7, i % 5]); y.push(i % 7); }
  const cv = C.crossValidateStrict(rawX, y, ['a', 'b'], ['低', '中', '高'], { k: 5, impute: 'median', drops: 100 });
  cv.records.forEach(r => {
    const s = new Set(r.trainIdx);
    const hit = r.testIdx.filter(i => s.has(i));
    eq(hit.length, 0, `第${r.fold}折存在重叠样本`);
  });
});

test('CV 每折使用独立的填补器实例', () => {
  const rawX = [], y = [];
  for (let i = 0; i < 90; i++) { rawX.push([i % 9, i % 4]); y.push(i % 9); }
  const cv = C.crossValidateStrict(rawX, y, ['a', 'b'], ['低', '中', '高'], { k: 4, impute: 'mean', drops: 100 });
  const ids = new Set(cv.records.map(r => r.imputeModel));
  eq(ids.size, cv.records.length, '每折应有独立填补器');
});

test('每折填补参数 = 该折训练集统计量（重算比对）', () => {
  const rawX = [], y = [];
  for (let i = 0; i < 80; i++) { rawX.push([i % 8, i % 3]); y.push(i % 8); }
  const cv = C.crossValidateStrict(rawX, y, ['a', 'b'], ['低', '中', '高'],
    { k: 5, impute: 'mean', drops: 100, seed: 42 });
  cv.records.forEach(r => {
    if (!r.imputeModel) return;
    const vals = r.trainIdx.map(i => rawX[i][0]).filter(v => v !== null && v !== undefined);
    const expect = vals.reduce((a, b) => a + b, 0) / vals.length;
    approx(r.imputeModel.fillValues[0], expect, 1e-9,
      `第${r.fold}折均值应等于其训练折均值`);
  });
});

/* ================= 6. 目标泄漏 ================= */
test('目标变量缺失样本被排除而非填补', () => {
  const rawX = [], y = [];
  for (let i = 0; i < 60; i++) { rawX.push([i % 5, i % 3]); y.push(i % 5); }
  y[10] = null; y[20] = undefined; y[30] = NaN;
  const cv = C.crossValidateStrict(rawX, y, ['a', 'b'], ['低', '中', '高'], { k: 3, impute: 'median', drops: 100 });
  eq(cv.excludedByTarget.length, 3, '应排除 3 条目标缺失样本');
});

test('skipColumns 的列不被填补', () => {
  const train = [[1, null], [2, null], [3, null]];
  const model = P.fitImputer(train, ['x', 'target'], { strategy: 'mean', skipColumns: ['target'] });
  eq(model.strategies[1], 'none', 'target 列策略应为 none');
  const r = P.transformImputer(train, model, train);
  eq(r.matrix[0][1], null, 'target 列应保持 null');
});

/* ================= 7. 小样本 ================= */
test('样本不足时明确拒绝而不是硬跑', () => {
  const rawX = [[1], [2], [3]], y = [1, 2, 3];
  const cv = C.crossValidateStrict(rawX, y, ['a'], ['低', '中', '高'], { k: 3 });
  eq(cv.ok, false, '应返回 ok=false');
  assert(/有效样本/.test(cv.reason), '应给出原因');
});

test('全缺失列不导致崩溃', () => {
  const train = [[null, 1], [null, 2], [null, 3]];
  const model = P.fitImputer(train, ['allnull', 'x'], { strategy: 'mean' });
  eq(model.strategies[0], 'constant', '全缺失列应为 constant 策略');
  const r = P.transformImputer(train, model, train);
  assert(r.matrix.every(row => Number.isFinite(row[0])), '应填入常量');
});

/* ================= 8. 混合变量 ================= */
test('Gower 距离：数值归一化 + 分类匹配', () => {
  const model = {
    p: 2, types: ['num', 'cat'], ranges: [10, 0], skipColumns: []
  };
  const d1 = P.gowerDistance([5, 'A'], [5, 'A'], model, new Set());
  approx(d1, 0, 1e-12, '完全相同距离应为 0');
  const d2 = P.gowerDistance([0, 'A'], [10, 'A'], model, new Set());
  approx(d2, 0.5, 1e-12, '数值差满量程 = 1，分类相同 = 0，平均 0.5');
  const d3 = P.gowerDistance([0, 'A'], [0, 'B'], model, new Set());
  approx(d3, 0.5, 1e-12, '分类不同 = 1，数值相同 = 0，平均 0.5');
});

test('无共同有效特征时距离为 null（不可用邻居）', () => {
  const model = { p: 2, types: ['num', 'num'], ranges: [1, 1], skipColumns: [] };
  const d = P.gowerDistance([null, null], [1, 2], model, new Set());
  eq(d, null, '没有共同有效特征应返回 null');
});

test('ID 列被 skip 后不参与距离，且自身不被填补', () => {
  // 三列：x 参与距离、id 被排除、v 待填补
  const train = [[1, 100, 10], [1, 200, 20], [2, 300, 30], [2, 400, 40]];
  const model = P.fitImputer(train, ['x', 'id', 'v'],
    { strategy: 'knn', skipColumns: ['id'], knn: { k: 1, weighted: false } });
  const r = P.transformImputer([[1, null, null]], model, train);
  // x=1 的两行距离都是 0（id 不参与距离）→ 稳定排序取索引较小的第一行 → v=10
  eq(r.matrix[0][2], 10, '应在 x 相同的最近邻处取值（说明 id 未参与距离）');
  eq(r.matrix[0][1], null, 'id 列被 skip，应保持 null 不被填补');
});

/* ================= 9. 异常值 ================= */
test('极端值下 median 稳定、mean 漂移', () => {
  const train = [[1], [2], [3], [4], [5], [1e9], [null]];
  const med = P.fitImputer(train, ['x'], { strategy: 'median' }).fillValues[0];
  const mn = P.fitImputer(train, ['x'], { strategy: 'mean' }).fillValues[0];
  approx(med, 3.5, 1e-9, '中位数应为 3.5');
  assert(mn > 1e8, '均值应被拉到极大');
});

test('KNN 加权填补在异常值下仍有限', () => {
  const train = [[0, 0], [1, 1], [2, 2], [1e9, 1e9], [null, null]];
  const model = P.fitImputer(train, ['x', 'y'], { strategy: 'knn', knn: { k: 2, weighted: true } });
  const r = P.transformImputer([[0.5, null]], model, train);
  assert(Number.isFinite(r.matrix[0][1]), '填补值应有限');
});

/* ================= 10. 复现性 ================= */
test('同种子同参数结果完全一致', () => {
  const rawX = [], y = [];
  for (let i = 0; i < 80; i++) { rawX.push([i % 8, (i * 3) % 7]); y.push(i % 8); }
  rawX[5][0] = null; rawX[15][1] = null;
  const run = () => C.crossValidateStrict(rawX, y, ['a', 'b'], ['低', '中', '高'], { k: 4, seed: 7, impute: 'mean', drops: 100 });
  const A = run(), B = run();
  approx(A.mean, B.mean, 1e-12, '均值应一致');
  eq(A.perFold.map(f => f.testAccuracy).join(','), B.perFold.map(f => f.testAccuracy).join(','), '每折结果应一致');
});

test('不同种子产生合理差异但指标仍在 [0,1]', () => {
  const rawX = [], y = [];
  for (let i = 0; i < 100; i++) { rawX.push([i % 6, i % 4]); y.push(i % 6); }
  const A = C.crossValidateStrict(rawX, y, ['a', 'b'], ['低', '中', '高'], { k: 5, seed: 1, impute: 'mean', drops: 100 });
  const B = C.crossValidateStrict(rawX, y, ['a', 'b'], ['低', '中', '高'], { k: 5, seed: 999, impute: 'mean', drops: 100 });
  [A, B].forEach(cv => {
    assert(cv.mean >= 0 && cv.mean <= 1, '准确率越界');
    cv.perFold.forEach(f => assert(f.balancedAccuracy >= 0 && f.balancedAccuracy <= 1, '平衡准确率越界'));
  });
});

/* ================= 11. 泄漏审计 ================= */
test('审计：正常严格 CV 全部 PASS', () => {
  const rawX = [], y = [];
  for (let i = 0; i < 100; i++) { rawX.push([i % 7, i % 5]); y.push(i % 7); }
  const cv = C.crossValidateStrict(rawX, y, ['a', 'b'], ['低', '中', '高'], { k: 5, impute: 'mean', drops: 100, seed: 42 });
  const audit = C.leakageAudit(cv, rawX, ['a', 'b']);
  const fails = audit.items.filter(i => i.status === 'FAIL');
  assert(fails.length === 0, '不应有 FAIL: ' + fails.map(f => f.name + ' ' + f.evidence).join('; '));
  eq(audit.verdict, '严格无泄漏');
});

test('审计：人为破坏索引重叠应 FAIL', () => {
  const rawX = [], y = [];
  for (let i = 0; i < 60; i++) { rawX.push([i % 6, i % 3]); y.push(i % 6); }
  const cv = C.crossValidateStrict(rawX, y, ['a', 'b'], ['低', '中', '高'], { k: 3, impute: 'mean', drops: 100, seed: 42 });
  // 故意把验证样本塞进训练索引
  cv.records[0].trainIdx = cv.records[0].trainIdx.concat([cv.records[0].testIdx[0]]);
  const audit = C.leakageAudit(cv, rawX, ['a', 'b']);
  const split = audit.items.find(i => i.id === 'split-disjoint');
  eq(split.status, 'FAIL', '重叠应判 FAIL');
  eq(audit.ok, false, '整体应不合格');
});

test('审计：篡改填补参数应 FAIL', () => {
  const rawX = [], y = [];
  for (let i = 0; i < 60; i++) { rawX.push([i % 6, i % 3]); y.push(i % 6); }
  const cv = C.crossValidateStrict(rawX, y, ['a', 'b'], ['低', '中', '高'], { k: 3, impute: 'mean', drops: 100, seed: 42 });
  // 篡改：把全量均值塞进记录（模拟"用全量数据拟合"）
  const allMean = rawX.reduce((s, r) => s + r[0], 0) / rawX.length;
  cv.records[0].imputeModel.fillValues[0] = allMean + 1;
  const audit = C.leakageAudit(cv, rawX, ['a', 'b']);
  const imp = audit.items.find(i => i.id === 'imputer-fit-on-train');
  eq(imp.status, 'FAIL', '参数与训练折不一致应判 FAIL');
});

test('审计：无记录时拒绝出结论', () => {
  const audit = C.leakageAudit({ records: [] }, [], []);
  eq(audit.ok, false);
  eq(audit.items[0].status, 'FAIL');
});

/* ================= 12. 诊断 ================= */
test('缺失诊断统计正确', () => {
  const m = [[1, null, 3], [null, null, 3], [1, 2, null]];
  const d = P.diagnoseMissing(m, ['a', 'b', 'c']);
  eq(d.totalMissing, 4);
  eq(d.perCol[1].missing, 2);
  eq(d.perCol[1].allMissing, false);
  eq(d.completeRows, 0);
  approx(d.overallRate, 4 / 9, 1e-9);
});

test('完全缺失列被识别', () => {
  const d = P.diagnoseMissing([[null], [null]], ['x']);
  eq(d.allMissingCols.length, 1);
  eq(d.perCol[0].allMissing, true);
});

/* ================= 汇总 ================= */
const failed = results.filter(r => !r.ok);
const passed = results.length - failed.length;
console.log('\n============ V2.1 TEST REPORT ============');
results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`));
console.log('------------------------------------------');
console.log(`总计 ${results.length}  通过 ${passed}  失败 ${failed.length}  通过率 ${(passed / results.length * 100).toFixed(1)}%`);
console.log('==========================================\n');
process.exit(failed.length ? 1 : 0);
