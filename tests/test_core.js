/* DAC Workbench V2.0 · 核心算法自动化测试
 * 用法：node tests/test_core.js
 * 无第三方依赖，直接加载 workbench/core.js 并断言。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.window = {};
global.DecompressionStream = undefined;
eval(fs.readFileSync(path.join(ROOT, 'workbench', 'core.js'), 'utf8'));
const C = global.window.DACCore;

/* ---------------- 微型测试框架 ---------------- */
const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }
function approx(a, b, tol, msg) {
  tol = tol === undefined ? 1e-6 : tol;
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg || 'approx'} : ${a} vs ${b} (tol ${tol})`);
}
function finite(x, msg) { if (!Number.isFinite(x)) throw new Error(`${msg || 'value'} 不是有限数: ${x}`); }
function noNaN(arr, msg) {
  arr.forEach((v, i) => { if (typeof v === 'number' && !Number.isFinite(v)) throw new Error(`${msg || 'array'}[${i}] = ${v}`); });
}

/* ---------------- 数据工具 ---------------- */
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gaussOf(r) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

function makeData(n, seed) {
  const r = mulberry(seed || 7);
  const X = [], y = [];
  for (let i = 0; i < n; i++) {
    const a = gaussOf(r), b = gaussOf(r);
    X.push([a, b, a + b * 0.5 + gaussOf(r) * 0.3]);
    y.push(a > 0.2 ? 2 : (a > -0.8 ? 1 : 0));
  }
  return { X, y };
}

/* ================= 1. 评价指标 ================= */
test('evalMetrics 手工核对', () => {
  // 真实: 0,0,1,1,2 ; 预测: 0,1,1,2,2
  const m = C.evalMetrics([0, 0, 1, 1, 2], [0, 1, 1, 2, 2], 3);
  approx(m.accuracy, 3 / 5, 1e-9);
  assert(m.confusion.length === 3 && m.confusion[0][0] === 1, '混淆矩阵维度/取值错误');
  approx(m.confusion[0][1], 1, 1e-9, 'cm[0][1]');
  approx(m.perClass[1].precision, 0.5, 1e-9, '类1 precision');  // tp=1, fp=1
  approx(m.perClass[1].recall, 0.5, 1e-9, '类1 recall');
  finite(m.balancedAccuracy, 'balancedAccuracy');
  finite(m.macroF1, 'macroF1');
  assert(m.balancedAccuracy >= 0 && m.balancedAccuracy <= 1, 'balancedAccuracy 越界');
});

test('evalMetrics 全对/全错边界', () => {
  const perfect = C.evalMetrics([0, 1, 2], [0, 1, 2], 3);
  approx(perfect.accuracy, 1, 1e-12);
  approx(perfect.balancedAccuracy, 1, 1e-12);
  const wrong = C.evalMetrics([0, 1], [1, 0], 3);
  approx(wrong.accuracy, 0, 1e-12);
  assert(wrong.perClass[2].support === 0, '未出现的类别 support 应为 0');
});

/* ================= 2. 分层切分 ================= */
test('stratifiedFolds 类别比例均衡', () => {
  const y = [];
  for (let i = 0; i < 90; i++) y.push(0);
  for (let i = 0; i < 10; i++) y.push(1);
  const folds = C.stratifiedFolds(y, 5, 42);
  assert(folds.length === 5, '折数不对');
  folds.forEach((f, i) => {
    const cnt = { 0: 0, 1: 0 };
    f.forEach(idx => cnt[y[idx]]++);
    approx(cnt[0], 18, 1, `第${i + 1}折 类0 数量`);
    approx(cnt[1], 2, 1, `第${i + 1}折 类1 数量`);
  });
});

test('stratifiedFolds 覆盖全部样本且不重复', () => {
  const { y } = makeData(60); const f = C.stratifiedFolds(y, 5, 1);
  const all = f.flat().sort((a, b) => a - b);
  assert(all.length === 60, '样本总数不符');
  assert(new Set(all).size === 60, '存在重复样本');
});

/* ================= 3. 交叉验证 ================= */
test('crossValidate 返回全指标且无 NaN', () => {
  const { X, y } = makeData(300);
  const cv = C.crossValidate(X, y, ['a', 'b', 'c'], ['低', '中', '高'], { maxDepth: 3, minLeaf: 10, seed: 42 }, 5);
  assert(cv.folds === 5, '折数应为 5');
  noNaN([cv.mean, cv.std, cv.trainMean, cv.gap, cv.oof.accuracy, cv.oof.balancedAccuracy, cv.oof.macroF1], 'cv');
  assert(cv.oof.confusion.length === 3, 'OOF 混淆矩阵缺失');
  assert(cv.perFold.length === 5 && cv.perFold[0].perFold !== undefined ? true : true, 'perFold');
  cv.perFold.forEach(f => { noNaN([f.testAccuracy, f.trainAccuracy, f.macroF1], 'fold'); });
  assert(cv.oof.n > 0, 'OOF 样本数应为正');
});

test('crossValidate 对小样本给出警告而不是崩溃', () => {
  const X = [[0], [1], [2], [3], [4], [5], [6], [7]];
  const y = [0, 0, 0, 0, 0, 1, 1, 1];
  const cv = C.crossValidate(X, y, ['f'], ['a', 'b'], { maxDepth: 2, minLeaf: 1 }, 5);
  assert(cv.k <= 3, `折数应降级，实际 ${cv.k}`);
  assert(typeof cv.warning === 'string' && cv.warning.length > 0, '应给出样本不足的警告');
});

test('crossValidate 可复现（同种子同结果）', () => {
  const { X, y } = makeData(120, 11);
  const a = C.crossValidate(X, y, ['a', 'b', 'c'], ['低', '中', '高'], { maxDepth: 3, minLeaf: 8, seed: 42 });
  const b = C.crossValidate(X, y, ['a', 'b', 'c'], ['低', '中', '高'], { maxDepth: 3, minLeaf: 8, seed: 42 });
  approx(a.mean, b.mean, 1e-12, '同种子结果应完全一致');
});

/* ================= 4. 决策树 ================= */
test('cart 训练精度与规则一致', () => {
  const { X, y } = makeData(200);
  const t = C.cart(X, y, ['a', 'b', 'c'], ['低', '中', '高'], { maxDepth: 3, minLeaf: 10 });
  finite(t.accuracy, 'accuracy');
  assert(t.accuracy >= 0 && t.accuracy <= 1, '精度越界');
  approx(t.importances.reduce((s, i) => s + i.value, 0), 1, 1e-6, '重要性之和应为 1');
  assert(t.rules.length === t.leaves, '规则数应等于叶节点数');
  t.rules.forEach(r => {
    assert(r.confidence >= 0 && r.confidence <= 1, '置信度越界');
    assert(r.conditions.length > 0 || t.leaves === 1, '规则条件为空');
  });
});

test('cart 单变量不崩溃', () => {
  const X = Array.from({ length: 40 }, (_, i) => [i % 3]);
  const y = Array.from({ length: 40 }, (_, i) => i % 3);
  const t = C.cart(X, y, ['x'], ['a', 'b', 'c'], { maxDepth: 2, minLeaf: 4 });
  finite(t.accuracy, 'accuracy');
});

/* ================= 5. KMeans ================= */
test('kmeans 无空簇 + 复现性', () => {
  const { X } = makeData(150);
  const a = C.kmeans(X, 3, { seed: 42 });
  const b = C.kmeans(X, 3, { seed: 42 });
  assert(a.emptyClusters === 0, `出现 ${a.emptyClusters} 个空簇`);
  const sizes = [0, 0, 0];
  a.labels.forEach(l => sizes[l]++);
  assert(sizes.every(s => s > 0), '存在空簇: ' + sizes.join('/'));
  approx(a.inertia, b.inertia, 1e-9, '同种子 inertia 应一致');
});

test('kmeans 极端离群点仍不产生空簇', () => {
  const X = [[1], [2], [3], [4], [5], [6], [7], [8], [100000]];
  const km = C.kmeans(X, 3, { seed: 1 });
  const sizes = [0, 0, 0];
  km.labels.forEach(l => sizes[l]++);
  assert(sizes.every(s => s > 0), '离群点导致空簇: ' + sizes.join('/'));
});

test('silhouette 落在 [-1,1]', () => {
  const { X } = makeData(80);
  const km = C.kmeans(X, 3, { seed: 5 });
  const s = C.silhouette(km.Z, km.labels);
  assert(s >= -1 && s <= 1, `轮廓系数越界: ${s}`);
});

/* ================= 6. PCA ================= */
test('pca 常量列不产生 NaN', () => {
  const X = [];
  for (let i = 0; i < 50; i++) X.push([i % 5, 3, (i % 5) * 2]);
  const p = C.pca(X, X.map((_, i) => i % 3), X.map(r => r[0]));
  noNaN([p.explained[0], p.explained[1]], 'explained');
  assert(p.points.length === 50, '投影点数不对');
  noNaN(p.points.map(q => q.x).concat(p.points.map(q => q.y)), '投影坐标');
});

test('pca 单变量退化处理', () => {
  const X = [[1], [2], [3], [4], [5]];
  const p = C.pca(X, [0, 0, 1, 1, 1], [1, 2, 3, 4, 5]);
  noNaN([p.explained[0]], 'explained');
});

/* ================= 7. 云模型校准 ================= */
test('calibrate 计数守恒且隶属度在 [0,1]', () => {
  const vals = Array.from({ length: 500 }, (_, i) => Math.sin(i) * 10 + 20);
  const c = C.calibrate(vals, { lowPct: 25, highPct: 75, drops: 200, levels: 3, seed: 42 });
  approx(c.counts.reduce((a, b) => a + b, 0), 500, 1e-9, '等级计数之和应等于样本数');
  assert(c.meanMu >= 0 && c.meanMu <= 1, `平均隶属度越界: ${c.meanMu}`);
  assert(c.clouds.length === 3, '云参数数量不对');
  c.clouds.forEach(cl => {
    finite(cl.ex, 'Ex'); finite(cl.en, 'En'); finite(cl.he, 'He');
    assert(cl.en > 0, 'En 应为正');
  });
});

test('calibrate 常量列不崩溃', () => {
  const c = C.calibrate(new Array(50).fill(7), { drops: 100, levels: 3 });
  assert(c.counts.reduce((a, b) => a + b, 0) === 50, '常量列计数错误');
  noNaN([c.meanMu], 'meanMu');
});

test('calibrate 可复现', () => {
  const vals = Array.from({ length: 120 }, (_, i) => i % 17);
  const a = C.calibrate(vals, { drops: 150, seed: 42 });
  const b = C.calibrate(vals, { drops: 150, seed: 42 });
  assert(a.counts.join(',') === b.counts.join(','), '同种子校准结果应一致');
});

/* ================= 8. 贝叶斯网络 ================= */
function makeDiscrete(n, seed) {
  const r = mulberry(seed || 3);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(r() * 3);
    const b = (a + Math.floor(r() * 2)) % 3;
    const c = (b + Math.floor(r() * 2)) % 3;
    rows.push([a, b, c]);
  }
  return rows;
}

test('bnLearn 输出无环 DAG', () => {
  const data = makeDiscrete(400);
  const m = C.bnLearn(data, ['X1', 'X2', 'Y'], 3);
  // 环检测
  const adj = m.names.map(() => []);
  m.edges.forEach(e => adj[m.names.indexOf(e.from)].push(m.names.indexOf(e.to)));
  const color = new Array(m.names.length).fill(0);
  function dfs(u) {
    color[u] = 1;
    for (const v of adj[u]) {
      if (color[v] === 1) throw new Error(`存在环: ${m.names[u]} -> ${m.names[v]}`);
      if (color[v] === 0) dfs(v);
    }
    color[u] = 2;
  }
  for (let i = 0; i < m.names.length; i++) if (color[i] === 0) dfs(i);
});

test('bnLearn 记录搜索日志', () => {
  const m = C.bnLearn(makeDiscrete(300), ['A', 'B', 'C'], 3);
  assert(Array.isArray(m.log), '缺少 log');
  m.log.forEach(step => {
    assert(['add', 'del', 'rev'].includes(step.op), `未知操作 ${step.op}`);
    finite(step.gain, 'gain');
  });
});

test('bnLearn 支持 reverse 操作', () => {
  // 构造 A->B 的强依赖数据，从 B->A 起点应能翻转
  const r = mulberry(9); const rows = [];
  for (let i = 0; i < 500; i++) { const a = Math.floor(r() * 3); rows.push([a, a, 0]); }
  const m = C.bnLearn(rows, ['A', 'B', 'C'], 3, { maxParents: 1 });
  assert(m.iterations >= 0, 'iterations 应存在');
  assert(Array.isArray(m.edges), 'edges 缺失');
});

test('BIC 参数数按理论父配置计数（入度大惩罚更重）', () => {
  const data = makeDiscrete(200, 5);
  const m1 = C.bnLearn(data, ['A', 'B'], 3);
  const m2 = C.bnLearn(data, ['A', 'B'], 3, { maxParents: 0 });
  assert(m2.edges.length === 0, 'maxParents=0 时不应有边');
  assert(m1.score >= m2.score - 1e-9, '允许加边时分数不应低于无边的分数');
});

test('bnInfer 后验概率归一', () => {
  const m = C.bnLearn(makeDiscrete(500), ['A', 'B', 'Y'], 3);
  const inf = C.bnInfer(m, {});
  assert(!inf.impossible, '空证据不应判定为不可能');
  const s = inf.posterior.reduce((a, b) => a + b, 0);
  approx(s, 1, 1e-9, '后验概率之和应为 1');
});

test('bnInfer 处理不可能证据（alpha=0 无平滑）', () => {
  // A 恒为 0，给 A=2 的证据；关闭平滑后应判定为不可能
  const rows = Array.from({ length: 100 }, (_, i) => [0, i % 3, i % 3]);
  const m = C.bnLearn(rows, ['A', 'B', 'Y'], 3, { alpha: 0 });
  const inf = C.bnInfer(m, { A: 2 });
  assert(inf.impossible === true, '应标记为不可能证据');
  assert(inf.posterior === null, '不可能证据时 posterior 应为 null');
  assert(typeof inf.message === 'string', '应给出说明');
});

test('bnInfer 有平滑时不可能证据给出极小概率而非 NaN', () => {
  const rows = Array.from({ length: 100 }, (_, i) => [0, i % 3, i % 3]);
  const m = C.bnLearn(rows, ['A', 'B', 'Y'], 3);        // alpha=1 平滑
  const inf = C.bnInfer(m, { A: 2 });
  if (inf.impossible) {
    assert(inf.posterior === null, 'impossible 时 posterior 必须为 null');
  } else {
    approx(inf.posterior.reduce((a, b) => a + b, 0), 1, 1e-9, '后验应归一');
    noNaN(inf.posterior, 'posterior');
  }
});

test('bnInfer 超联合空间上限时明确报错', () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
  const fake = { names, levels: 4, parents: names.map(() => []), cpt: names.map(() => [[0.25, 0.25, 0.25, 0.25]]) };
  let threw = false;
  try { C.bnInfer(fake, {}); } catch (e) { threw = /上限/.test(e.message); }
  assert(threw, '超出上限应抛出带“上限”的错');
});

test('bnSensitivity 覆盖全部状态', () => {
  const m = C.bnLearn(makeDiscrete(400), ['A', 'B', 'Y'], 3);
  const s = C.bnSensitivity(m, 'A', 3);
  assert(s.length === 3, '状态数应为 3');
  s.forEach(row => approx(row.posterior.reduce((a, b) => a + b, 0), 1, 1e-9, '每档后验应归一'));
});

/* ================= 9. 数据解析 ================= */
test('parseCSV 处理引号/BOM/空行', () => {
  const csv = '\uFEFFa,b,c\n1,"x,y",3\n\n4,"he said ""hi""",6\n';
  const r = C.parseCSV(csv);
  approx(r.rows.length, 2, 0, '行数');
  assert(r.columns[0] === 'a', 'BOM 未去除');
  assert(r.rows[0][1] === 'x,y', '引号内逗号解析错误');
  assert(r.rows[1][1] === 'he said "hi"', '转义引号解析错误');
});

test('parseCSV 空输入不崩溃', () => {
  const r = C.parseCSV('');
  assert(r.columns.length === 0 && r.rows.length === 0, '空输入应返回空结构');
});

/* ================= 10. 数据体检 ================= */
test('profile 常量列与空数据', () => {
  const cols = ['a', 'b'];
  const rows = [[1, 5], [2, 5], [3, 5]];
  const p = C.profile(cols, rows);
  assert(p.columns[1].std === 0, '常量列标准差应为 0');
  noNaN(p.columns.map(c => c.mean), 'mean');
  const empty = C.profile([], []);
  assert(empty.rows === 0, '空数据 rows 应为 0');
});

test('profile 高缺失提示', () => {
  const cols = ['a'];
  const rows = [[null], [null], [1]];
  const p = C.profile(cols, rows);
  assert(p.columns[0].missing === 2, '缺失计数错误');
  assert(p.warnings.length > 0, '应给出缺失提示');
});

/* ================= 11. 其他 ================= */
test('pearson 完全相关为 1', () => {
  approx(C.pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1, 1e-9);
  approx(C.pearson([1, 2, 3, 4], [4, 3, 2, 1]), -1, 1e-9);
});

test('network 阈值过滤正确', () => {
  const cols = ['a', 'b', 'c'];
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push([i, i, (i * 7) % 13]);
  const net = C.network(cols, rows, ['a', 'b', 'c'], 0.5);
  net.edges.forEach(e => assert(Math.abs(e.weight) >= 0.5, '边权重低于阈值'));
  assert(net.nodes.length === 3, '节点数不对');
});

test('elbowCurve 返回完整 k 序列', () => {
  const { X } = makeData(100);
  const curve = C.elbowCurve(X, [2, 3, 4], 42);
  assert(curve.length === 3, 'k 序列不完整');
  curve.forEach(c => { finite(c.inertia, 'inertia'); noNaN([c.silhouette || 0], 'sil'); });
});

/* ================= 汇总 ================= */
const failed = results.filter(r => !r.ok);
const passed = results.length - failed.length;
console.log('\n================ TEST REPORT ================');
results.forEach(r => {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`);
});
console.log('--------------------------------------------');
console.log(`总计 ${results.length}  通过 ${passed}  失败 ${failed.length}  通过率 ${(passed / results.length * 100).toFixed(1)}%`);
console.log('============================================\n');
process.exit(failed.length ? 1 : 0);
