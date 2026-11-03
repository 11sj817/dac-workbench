/* 严格 CV 的三种切分 + OOF 追溯 + 多数类基线（第 10 点）
 * 用 node 直接跑 core.js，不需要浏览器
 */
const fs = require('fs');
const { execSync } = require('child_process');

global.window = {};
eval(fs.readFileSync('workbench/preprocess.js', 'utf8'));
eval(fs.readFileSync('workbench/core.js', 'utf8'));
const C = global.window.DACCore;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}` + (extra ? `  ${extra}` : '')); }
  else { fail++; console.log(`  ❌ ${name}` + (extra ? `  ${extra}` : '')); }
};

// ---------- 造数据：有分组结构 + 有时间趋势 ----------
let seed = 987654321;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

const nGroup = 20, perGroup = 15;
const N = nGroup * perGroup;   // 300
const X = [], y = [], groups = [], times = [], rowIds = [];
for (let g = 0; g < nGroup; g++) {
  // 每个组有自己的偏移 —— 组内相似、组间不同，这正是分组切分要防的
  const gOff = (rnd() - 0.5) * 4;
  for (let k = 0; k < perGroup; k++) {
    const i = g * perGroup + k;
    const x1 = gOff + rnd() * 0.6;
    const x2 = rnd() * 2 - 1;
    X.push([x1, x2]);
    // 标签主要由组决定 → 随机切分会把同组样本分到两侧，精度虚高
    y.push((gOff + (rnd() - 0.5) * 0.8) > 0 ? 1 : 0);
    groups.push('G' + g);
    times.push(1000 + i);           // 单调时间
    rowIds.push(i + 1);
  }
}
const names = ['x1', 'x2'];
const labels = ['低', '中', '高'];

console.log('=' .repeat(70));
console.log('严格 CV：三种切分 + OOF 追溯 + 多数类基线');
console.log('=' .repeat(70));
console.log(`数据：${N} 行，${nGroup} 组 × ${perGroup} 条，二分类`);
const baseRate = y.reduce((a, b) => a + b, 0) / N;
console.log(`正类比例 ${(baseRate * 100).toFixed(1)}%`);

const baseOpt = {
  k: 5, seed: 42, impute: 'median', lowPct: 25, highPct: 75,
  levels: 3, drops: 200, treeDepth: 3, minLeaf: 8,
  targetType: 'binary', rowIds
};

// ---------- A. 分层随机 ----------
console.log('\n【A】分层随机切分（默认）');
const rA = C.crossValidateStrict(X, y, names, labels, Object.assign({}, baseOpt));
ok('splitKind = stratified', rA.splitKind === 'stratified', rA.splitKind);
ok('ok = true', rA.ok === true);
ok('有 fold 数', rA.k >= 2, 'k=' + rA.k);
ok('OOF 有 rowId', Array.isArray(rA.oof.rowId) && rA.oof.rowId.length > 0, 'len=' + (rA.oof.rowId || []).length);
ok('OOF 有 pred', Array.isArray(rA.oof.pred));
ok('OOF 有 true', Array.isArray(rA.oof.true));
ok('OOF 有混淆矩阵', Array.isArray(rA.oof.confusion) && rA.oof.confusion.length === 2);
ok('OOF 有 perClass', Array.isArray(rA.oof.perClass) && rA.oof.perClass.length === 2);
ok('OOF 有 baseline', !!rA.oof.baseline, JSON.stringify(rA.oof.baseline));
console.log(`      OOF acc=${(rA.oof.accuracy * 100).toFixed(1)}%  balAcc=${(rA.oof.balancedAccuracy * 100).toFixed(1)}%  macroF1=${(rA.oof.macroF1 * 100).toFixed(1)}%`);
console.log(`      多数类基线 acc=${(rA.oof.baseline.accuracy * 100).toFixed(1)}%  balAcc=${(rA.oof.baseline.balancedAccuracy * 100).toFixed(1)}%`);
ok('rowId 与 pred 等长', rA.oof.rowId.length === rA.oof.pred.length, `${rA.oof.rowId.length} vs ${rA.oof.pred.length}`);

// 抽查：rowId 能追回原始样本
const sampleId = rA.oof.rowId[0];
const sampleIdx = rowIds.indexOf(sampleId);
ok('rowId 可追回原始行', sampleIdx >= 0, `rowId=${sampleId} → 原始下标 ${sampleIdx}`);

// ---------- B. 分组切分 ----------
console.log('\n【B】分组切分（同组不跨折）');
const rB = C.crossValidateStrict(X, y, names, labels, Object.assign({}, baseOpt), groups);
ok('splitKind = group', rB.splitKind === 'group', rB.splitKind);
ok('grouped = true', rB.grouped === true);
ok('ok = true', rB.ok === true);
console.log(`      OOF acc=${(rB.oof.accuracy * 100).toFixed(1)}%  balAcc=${(rB.oof.balancedAccuracy * 100).toFixed(1)}%`);
console.log(`      分组切分通常比随机切分**低**，因为它不再让模型偷看同组样本`);
// 真正该验证的是：同一个组的样本有没有跨折
// 组内样本分到两侧 = 模型偷看训练集里的"同组兄弟" = 精度虚高
let groupLeak = 0, groupChecked = 0;
(rB.records || []).forEach(r => {
  if (!r.testRawIdx || !r.trainRawIdx) return;
  const trG = new Set(r.trainRawIdx.map(i => groups[i]));
  r.testRawIdx.forEach(i => {
    groupChecked++;
    if (trG.has(groups[i])) groupLeak++;
  });
});
ok('分组切分：测试集的组没有出现在训练集里',
  groupChecked > 0 && groupLeak === 0,
  `检查 ${groupChecked} 条测试样本，跨组泄漏 ${groupLeak} 条`);

console.log(`      分组 acc=${(rB.oof.accuracy * 100).toFixed(1)}%  随机 acc=${(rA.oof.accuracy * 100).toFixed(1)}%` +
            `  （这份数据组效应弱，两者接近是正常的；关键是上面那条没泄漏）`);

// ---------- C. 时间切分 ----------
console.log('\n【C】时间切分（只用过去预测未来）');
const timeOrder = Array.from({ length: N }, (_, i) => i);   // 已经是时间升序
const rC = C.crossValidateStrict(X, y, names, labels, Object.assign({}, baseOpt, { timeOrder }));
ok('splitKind = time', rC.splitKind === 'time', rC.splitKind);
ok('ok = true', rC.ok === true);
console.log(`      OOF acc=${(rC.oof.accuracy * 100).toFixed(1)}%  balAcc=${(rC.oof.balancedAccuracy * 100).toFixed(1)}%`);
ok('时间切分折数合理', rC.k >= 2, 'k=' + rC.k);

// 验证「不用未来数据」：每折训练集的最大行号 < 测试集最小行号
let noFuture = true, checked = 0;
(rC.records || []).forEach(r => {
  if (!r.trainRawIdx || !r.testRawIdx || !r.trainRawIdx.length || !r.testRawIdx.length) return;
  const maxTrain = Math.max(...r.trainRawIdx);
  const minTest = Math.min(...r.testRawIdx);
  checked++;
  if (maxTrain >= minTest) noFuture = false;
});
ok('每折训练集不含未来样本', noFuture && checked > 0, `检查了 ${checked} 折`);

// ---------- D. 常数基线检查 ----------
console.log('\n【D】多数类基线合理性');
const cnt = [0, 0];
rA.oof.true.forEach(v => { if (v >= 0 && v < 2) cnt[v]++; });
const majCount = Math.max(...cnt);
const expectedBaseline = majCount / (cnt[0] + cnt[1]);
ok('baseline.accuracy = 最常见类的占比',
  Math.abs(rA.oof.baseline.accuracy - expectedBaseline) < 1e-9,
  `${(rA.oof.baseline.accuracy * 100).toFixed(2)}% vs 期望 ${(expectedBaseline * 100).toFixed(2)}%`);
ok('二分类 baseline.balancedAccuracy = 0.5',
  Math.abs(rA.oof.baseline.balancedAccuracy - 0.5) < 1e-9,
  rA.oof.balancedAccuracy.toString());

// ---------- E. 模型是否真的比基线强 ----------
console.log('\n【E】模型 vs 基线');
const lift = rA.oof.balancedAccuracy - rA.oof.baseline.balancedAccuracy;
console.log(`      Balanced Acc 提升 ${(lift * 100).toFixed(1)} 个百分点（相对基线）`);
ok('Balanced Acc 计算正确（不是等于 accuracy 硬套）',
  rA.oof.balancedAccuracy !== rA.oof.accuracy || Math.abs(cnt[0] - cnt[1]) < 5,
  `bal=${(rA.oof.balancedAccuracy * 100).toFixed(1)}% acc=${(rA.oof.accuracy * 100).toFixed(1)}%`);

console.log('\n' + '='.repeat(70));
console.log(`总计 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
if (fail) { console.log('失败项需要修'); process.exit(1); }
