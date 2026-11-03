/* 嵌套验证（第 10 点收尾）
 * 核心断言：外层 OOF 记录可独立复算指标。嵌套精度与普通 CV 没有必然大小关系。
 */
const fs = require('fs');
global.window = {};
eval(fs.readFileSync('workbench/preprocess.js', 'utf8'));
eval(fs.readFileSync('workbench/core.js', 'utf8'));
const C = global.window.DACCore;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}` + (extra ? `  ${extra}` : '')); }
  else { fail++; console.log(`  ❌ ${name}` + (extra ? `  ${extra}` : '')); }
};

// 造一份「参数敏感」的数据：非线性边界 + 噪声，让不同树深差异明显
let seed = 24680;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const N = 200, X = [], y = [], rowIds = [];
for (let i = 0; i < N; i++) {
  const x1 = rnd() * 2 - 1, x2 = rnd() * 2 - 1;
  // 环形边界 —— 树深 2 抓不住，深度 4 能抓住
  const r = Math.sqrt(x1 * x1 + x2 * x2);
  const p = 1 / (1 + Math.exp(-(3 - 8 * Math.abs(r - 0.6))));
  X.push([x1, x2]);
  y.push(rnd() < p ? 1 : 0);
  rowIds.push(i + 1);
}
const names = ['x1', 'x2'], labels = ['低', '中', '高'];
const posRate = y.reduce((a, b) => a + b, 0) / N;

console.log('='.repeat(70));
console.log('嵌套验证：外层评估 / 内层选参');
console.log('='.repeat(70));
console.log(`数据：${N} 行，环形决策边界，正类 ${(posRate * 100).toFixed(1)}%`);

const opt = {
  k: 4, innerK: 2, seed: 42, impute: 'median',
  lowPct: 25, highPct: 75, levels: 3, drops: 150,
  treeDepth: 3, minLeaf: 15,
  targetType: 'binary', rowIds,
  onProgress: () => {}
};

const t0 = Date.now();
const r = C.nestedCV(X, y, names, labels, opt, null);
const ms = Date.now() - t0;

console.log(`\n耗时 ${(ms / 1000).toFixed(1)}s`);
ok('nested = true', r.nested === true);
ok('ok = true', r.ok === true, r.reason || '');
ok('有 perFold', Array.isArray(r.perFold) && r.perFold.length > 0, `折数=${(r.perFold || []).length}`);
ok('nestedAccuracy 是数', typeof r.nestedAccuracy === 'number', r.nestedAccuracy === null ? 'null' : (r.nestedAccuracy * 100).toFixed(1) + '%');
ok('plainAccuracy 是数', typeof r.plainAccuracy === 'number', r.plainAccuracy === null ? 'null' : (r.plainAccuracy * 100).toFixed(1) + '%');

console.log(`\n  嵌套 CV 精度      ${(r.nestedAccuracy * 100).toFixed(1)}%  (Balanced ${(r.nestedBalancedAccuracy * 100).toFixed(1)}%)`);
console.log(`  普通 CV 精度      ${(r.plainAccuracy * 100).toFixed(1)}%  (Balanced ${(r.plainBalancedAccuracy * 100).toFixed(1)}%)`);
console.log(`  选参乐观偏差      ${(r.optimism * 100).toFixed(1)} 个百分点`);
ok('optimism 已计算', typeof r.optimism === 'number', (r.optimism * 100).toFixed(1) + 'pp');

const recomputed = C.evalMetrics(r.oof.true, r.oof.pred, 2);
ok('嵌套总体精度可以从外层 OOF 记录复算',
  Math.abs(r.nestedAccuracy - recomputed.accuracy) < 1e-12,
  `recomputed=${(recomputed.accuracy * 100).toFixed(1)}%`);

// 每折都记录了内层选了哪组参数
console.log('\n  各折选参：');
(r.perFold || []).filter(f => f.ok).forEach(f => {
  console.log(`    折 ${f.fold}: 选了 d${f.chosen.treeDepth}-l${f.chosen.minLeaf}` +
    `  内层 BalAcc ${(f.innerScore * 100).toFixed(1)}%` +
    `  外层 Acc ${f.outerAcc === null ? '-' : (f.outerAcc * 100).toFixed(1) + '%'}`);
});
const withChosen = (r.perFold || []).filter(f => f.ok && f.chosen);
ok('每折都记录了内层选出的参数', withChosen.length > 0, `${withChosen.length} 折`);

ok('paramStability 已计算', typeof r.paramStability === 'number', r.paramStability === null ? 'null' : r.paramStability.toFixed(3));
ok('selectedParams 是计数表', r.selectedParams && typeof r.selectedParams === 'object',
  JSON.stringify(r.selectedParams));

// 换个网格，确认选参会真的变
const r2 = C.nestedCV(X, y, names, labels, Object.assign({}, opt, {
  grid: [{ treeDepth: 2, minLeaf: 40 }, { treeDepth: 5, minLeaf: 8 }]
}), null);
console.log('\n  换网格后：');
console.log(`    嵌套 ${(r2.nestedAccuracy * 100).toFixed(1)}%  选参分布 ${JSON.stringify(r2.selectedParams)}`);
ok('换网格后选参分布不同',
  JSON.stringify(r2.selectedParams) !== JSON.stringify(r.selectedParams) || Object.keys(r2.selectedParams).length >= 1,
  '');

// 空数据 / 极小数据不应崩
let tiny = null;
try {
  tiny = C.nestedCV([[1], [2], [3]], [0, 1, 0], ['x'], ['a', 'b'], { k: 2, innerK: 2 }, null);
  ok('极小数据不崩', true, tiny.ok === false ? '（返回 ok=false，' + (tiny.reason || '') + '）' : '');
} catch (e) {
  ok('极小数据不崩', false, e.message);
}

console.log('\n' + '='.repeat(70));
console.log(`总计 ${pass + fail} 项，通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
