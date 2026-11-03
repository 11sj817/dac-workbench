/* Bootstrap 校准契约测试
 * 覆盖：
 *  1) 二分类目标（130/70）不再因 q25=q75 而崩（lo=0,hi=0）
 *  2) 条件变量常量列不产生除零
 *  3) lowPct/highPct 真的生效（改参数会改等级分布）
 *  4) 失败轮次被记录，不被抹掉
 *  5) fraction / replacement 契约
 */
const fs = require('fs');
const path = require('path');
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'workbench', 'preprocess.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'workbench', 'core.js'), 'utf8'));
eval(fs.readFileSync(path.join(__dirname, '..', 'workbench', 'bootstrap.js'), 'utf8'));
const C = global.window.DACCore;
const B = global.window.DACBootstrap;

let pass = 0, fail = 0;
const ok = (name, cond, info) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  → ' + (info || '')}`);
  cond ? pass++ : fail++;
};

/* 造 130 个 0 / 70 个 1 的二分类数据；X 有两列，一列连续一列常量 */
const n = 200;
const X = [], y = [];
for (let i = 0; i < n; i++) {
  const x1 = i % 7;
  const x2 = 5;                    // 常量列
  X.push([x1, x2]);
  y.push(i < 130 ? 0 : 1);
}
const names = ['X1', 'X2'];
const labels = ['低', '高'];

console.log('=== 1. 二分类目标：old 会 lo=hi=0 ===');
{
  // 复现崩点：190/10 这种强不均衡时 q25 === q75 === 0
  const y190 = [];
  for (let i = 0; i < 200; i++) y190.push(i < 190 ? 0 : 1);
  const s190 = [...y190].sort((a, b) => a - b);
  const q190 = (p) => s190[Math.min(s190.length - 1, Math.floor(p * (s190.length - 1)))];
  ok('190/10 时 q25 === q75 === 0（这正是旧实现 lo=hi=0 的来源）',
    q190(0.25) === 0 && q190(0.75) === 0, `q25=${q190(0.25)} q75=${q190(0.75)}`);
  // 130/70 时 q25=0, q75=1，虽然不崩，但仍是"用分位数去切一个本来只有 2 个取值的变量"，方法上不成立
  const s130 = [...y].sort((a, b) => a - b);
  const q130 = (p) => s130[Math.min(s130.length - 1, Math.floor(p * (s130.length - 1)))];
  ok('130/70 时 q25=0 q75=1：分位数切法把二分类硬切成三段，方法上不适用',
    q130(0.25) === 0 && q130(0.75) === 1, `q25=${q130(0.25)} q75=${q130(0.75)}`);

  let err = null, res = null;
  try {
    res = B.run(
      { X, y, n, names, labels, yName: 'Y' },
      {
        task: 'rules', B: 12, seed: 42, levels: 3, drops: 60,
        lowPct: 25, highPct: 75, targetType: 'binary',
        maxDepth: 3, minLeaf: 5, fraction: 1, replacement: true, method: 'iid'
      }
    );
  } catch (e) { err = e; }
  ok('binary 目标不再抛错', !err, err && err.message);
  if (res) {
    ok('有成功轮次', res.okCount > 0, `okCount=${res.okCount}`);
    const rec = (res.runs || []).find(r => r.ok);
    ok('成功轮次含规则', rec && Array.isArray(rec.rules), rec ? typeof rec.rules : 'no rec');
    // rec.rules 是规则签名字符串（"X1 = 低 => 低"），不是对象
    const allStr = rec && rec.rules && rec.rules.every(r => typeof r === 'string');
    ok('规则以签名字符串保存', !!allStr, rec && rec.rules ? typeof rec.rules[0] : 'no rules');
    const outcomes = (rec && rec.rules || []).map(r => String(r).split('=>').pop().trim());
    ok('结论保留原始 0 / 1 类别（未出现第 3 类空等级）',
      outcomes.length > 0 && outcomes.every(o => ['0', '1'].indexOf(o) >= 0),
      JSON.stringify(outcomes));
    ok('失败轮次有记录字段', typeof res.failed === 'number', JSON.stringify(Object.keys(res)));
  }
}

console.log('\n=== 2. 常量列不除零 ===');
{
  let err = null, res = null;
  try {
    res = B.run(
      { X, y, n, names, labels, yName: 'Y' },
      { task: 'rules', B: 8, seed: 7, levels: 3, drops: 60, lowPct: 25, highPct: 75,
        targetType: 'binary', maxDepth: 3, minLeaf: 5, method: 'iid' }
    );
  } catch (e) { err = e; }
  ok('常量列不导致崩溃', !err, err && err.message);
  ok('没有产生 NaN 准确率', !res || !(res.runs || []).some(r => r.ok && Number.isNaN(r.accuracy)),
    res ? JSON.stringify((res.runs || []).filter(r => r.ok && Number.isNaN(r.accuracy)).length) : '');
}

console.log('\n=== 3. lowPct/highPct 生效 ===');
{
  // 连续目标，用 10/90 与 40/60 两种切点，等级分布应不同
  const yc = [], Xc = [];
  for (let i = 0; i < 200; i++) { yc.push(i); Xc.push([i % 13]); }
  const mk = (lo, hi) => B.run(
    { X: Xc, y: yc, n: 200, names: ['X'], labels: ['低', '中', '高'], yName: 'Y' },
    { task: 'rules', B: 4, seed: 1, levels: 3, drops: 40, lowPct: lo, highPct: hi,
      targetType: 'continuous', maxDepth: 2, minLeaf: 10, method: 'iid' }
  );
  let a = null, b = null;
  try { a = mk(10, 90); } catch (e) { }
  try { b = mk(40, 60); } catch (e) { }
  const ra = a && (a.runs || []).find(r => r.ok);
  const rb = b && (b.runs || []).find(r => r.ok);
  ok('两种切点都能跑', !!ra && !!rb, `a=${!!ra} b=${!!rb}`);
  if (ra && rb) {
    const sa = JSON.stringify(ra.rules);
    const sb = JSON.stringify(rb.rules);
    ok('切点变化会改变规则结构', sa !== sb, `10/90=${sa.slice(0,60)} 40/60=${sb.slice(0,60)}`);
  }
}

console.log('\n=== 4. fraction / replacement 契约 ===');
{
  // 有放回 + fraction=1：唯一 in-bag 应显著小于 n
  const r1 = B.sampleIndices({ n: 500, B: 1, seed: 3, fraction: 1, replacement: true, method: 'iid' });
  const u1 = new Set(r1[0]).size;
  ok('IID 有放回 fraction=1：唯一数 < n', u1 < 500, `唯一 ${u1}`);

  // 无放回 + fraction=0.2：应恰好抽到 100 个且不重复
  const r2 = B.sampleIndices({ n: 500, B: 1, seed: 3, fraction: 0.2, replacement: false, method: 'iid' });
  ok('IID 无放回 fraction=0.2：数量 = 100', r2[0].length === 100, `实际 ${r2[0].length}`);
  ok('IID 无放回 fraction=0.2：无重复', new Set(r2[0]).size === 100, `唯一 ${new Set(r2[0]).size}`);

  // block + fraction=0.2 无放回：旧实现会抽满 n 且重复
  const timeIdx = Array.from({ length: 500 }, (_, i) => i);
  let rb = null, eb = null;
  try {
    rb = B.sampleIndices({
      n: 500, B: 1, seed: 3, fraction: 0.2, replacement: false,
      method: 'block', blockType: 'moving', blockLen: 10, order: timeIdx
    });
  } catch (e) { eb = e; }
  if (eb) {
    // 明确拒绝是期望行为：不静默抽满 n
    ok('block+无放回+fraction<1 被明确拒绝（不是静默抽满）',
      /块抽样不支持/.test(eb.message), eb.message.slice(0, 90));
  } else {
    ok('block+无放回+fraction<1 未拒绝（应拒绝）', false, `实际抽到 ${rb[0].length}`);
  }

  // 有放回 + fraction=0.2 应抽 100
  let rb2 = null, eb2 = null;
  try {
    rb2 = B.sampleIndices({
      n: 500, B: 1, seed: 3, fraction: 0.2, replacement: true,
      method: 'block', blockType: 'moving', blockLen: 10, blockLength: 10
    });
  } catch (e) { eb2 = e; }
  ok('block+有放回+fraction=0.2 可执行', !eb2, eb2 && eb2.message);
  if (rb2) {
    ok('样本量约为 100（不是 500）', Math.abs(rb2[0].length - 100) <= 12, `实际 ${rb2[0].length}`);
  }
}

console.log('\n=== 5. 失败轮次不被抹掉 ===');
{
  // 极端：B 很小 + 极短块，可能出问题；关键是有 failed 计数
  const res = B.run(
    { X, y, n, names, labels, yName: 'Y' },
    { task: 'rules', B: 6, seed: 11, levels: 3, drops: 20, lowPct: 25, highPct: 75,
      targetType: 'binary', maxDepth: 1, minLeaf: 100, method: 'iid' }
  );
  ok('结果对象含 failed 字段', typeof res.failed === 'number', JSON.stringify(Object.keys(res)));
  ok('runs 长度 = B', (res.runs || []).length === 6, `实际 ${(res.runs || []).length}`);
  ok('okCount + failed = B', res.okCount + res.failed === 6, `${res.okCount}+${res.failed}`);
}

console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
