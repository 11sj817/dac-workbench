/* DAC Workbench V2.9 · Bootstrap 引擎测试
 * 用法：node tests/test_bootstrap.js
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
const C = global.window.DACCore;

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, err: e.message }); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
function approx(a, b, tol, m) {
  tol = tol === undefined ? 1e-9 : tol;
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m || 'approx'}: ${a} vs ${b}`);
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: ${a} !== ${b}`); }

/* ============ 1. ARI ============ */
test('ARI 完全一致 = 1', () => {
  approx(B.ari([0, 0, 1, 1, 2], [0, 0, 1, 1, 2]), 1, 1e-12);
});
test('ARI 标签置换不变', () => {
  const a = [0, 0, 1, 1, 2, 2];
  const b = [2, 2, 0, 0, 1, 1];   // 只是换了编号
  approx(B.ari(a, b), 1, 1e-12, '置换后应仍为 1');
});
test('ARI 完全错位 < 1', () => {
  const a = [0, 0, 1, 1];
  const b = [0, 1, 0, 1];
  assert(B.ari(a, b) < 0.5, '交错应显著低于 1');
});
test('ARI 单簇情形', () => {
  approx(B.ari([0, 0, 0], [0, 0, 0]), 1, 1e-12);
});

/* ============ 2. NMI ============ */
test('NMI 完全一致 = 1', () => {
  approx(B.nmi([0, 1, 2, 0, 1, 2], [0, 1, 2, 0, 1, 2]), 1, 1e-9);
});
test('NMI 标签置换不变', () => {
  approx(B.nmi([0, 0, 1, 1], [5, 5, 9, 9]), 1, 1e-9);
});
test('NMI 独立 ≈ 0', () => {
  const a = [], b = [];
  for (let i = 0; i < 200; i++) { a.push(i % 2); b.push(Math.floor(i / 100)); }
  assert(B.nmi(a, b) < 0.1, '完全独立应接近 0');
});

/* ============ 3. 抽样 ============ */
test('IID 有放回抽样长度正确', () => {
  const s = B.sampleIndices({ n: 50, B: 3, seed: 1, fraction: 1, replacement: true });
  eq(s.length, 3);
  s.forEach(idx => eq(idx.length, 50));
  s.forEach(idx => idx.forEach(i => assert(i >= 0 && i < 50, '索引越界')));
});
test('同种子抽样完全一致', () => {
  const a = B.sampleIndices({ n: 30, B: 2, seed: 7, fraction: 1, replacement: true });
  const b = B.sampleIndices({ n: 30, B: 2, seed: 7, fraction: 1, replacement: true });
  eq(JSON.stringify(a), JSON.stringify(b));
});
test('不同种子抽样不同', () => {
  const a = B.sampleIndices({ n: 30, B: 2, seed: 7, fraction: 1, replacement: true });
  const b = B.sampleIndices({ n: 30, B: 2, seed: 8, fraction: 1, replacement: true });
  assert(JSON.stringify(a) !== JSON.stringify(b), '不同 seed 应产生不同索引');
});
test('无放回抽样不重复', () => {
  const s = B.sampleIndices({ n: 40, B: 5, seed: 3, fraction: 0.5, replacement: false });
  s.forEach(idx => {
    eq(new Set(idx).size, idx.length, '无放回应无重复');
    assert(idx.length <= 40);
  });
});
test('分组抽样：整组进整组出', () => {
  const groups = [];
  for (let i = 0; i < 60; i++) groups.push('g' + (i % 10));
  const s = B.sampleIndices({ n: 60, B: 5, seed: 5, method: 'group', groups });
  s.forEach(idx => {
    const inSample = new Set(idx.map(i => groups[i]));
    // 每一组的成员要么全在，要么全不在
    for (let g = 0; g < 10; g++) {
      const members = [];
      for (let i = 0; i < 60; i++) if (groups[i] === 'g' + g) members.push(i);
      const present = members.filter(i => idx.includes(i)).length;
      assert(present === 0 || present === members.length,
        `组 g${g} 被拆散：${present}/${members.length}`);
    }
  });
});
test('分层抽样：每层都有代表', () => {
  const strata = [];
  for (let i = 0; i < 80; i++) strata.push(i < 20 ? 'A' : i < 40 ? 'B' : i < 60 ? 'C' : 'D');
  const s = B.sampleIndices({ n: 80, B: 3, seed: 11, method: 'stratified', strata, fraction: 0.5 });
  s.forEach(idx => {
    const seen = new Set(idx.map(i => strata[i]));
    eq(seen.size, 4, '四层都应有样本');
  });
});
test('加权抽样：高权重被抽中更多', () => {
  const weights = [];
  for (let i = 0; i < 100; i++) weights.push(i === 0 ? 100 : 1);
  const s = B.sampleIndices({ n: 100, B: 1, seed: 2, method: 'weighted', weights, fraction: 0.3 });
  const cnt0 = s[0].filter(i => i === 0).length;
  assert(cnt0 >= 10, `高权重样本应被多次抽中，实际 ${cnt0}`);
});
test('加权边界：权重全为 0 明确报错（契约）', () => {
  // V3.4 起：全零权重不再是"容忍"，而是直接报错——无法定义抽样分布
  let threw = false;
  try {
    B.sampleIndices({ n: 10, B: 3, seed: 1, method: 'weighted', weights: new Array(10).fill(0) });
  } catch (e) { threw = /全为 0/.test(e.message); }
  assert(threw, '全零权重应报错');
});

/* ============ 4. 共聚类 ============ */
test('共聚类：完全一致时概率为 1', () => {
  const labs = [[0, 0, 1, 1], [0, 0, 1, 1]];
  const co = B.coCluster(labs, 4);
  approx(co.matrix[0 * 4 + 1], 1, 1e-12, '同簇样本应为 1');
  approx(co.matrix[0 * 4 + 2], 0, 1e-12, '异簇样本应为 0');
});
test('共聚类：分母为 0 时返回 NaN 而非 0', () => {
  // 样本 2 从未参与任何一次评价
  const labs = [[0, 0, null, null], [0, 0, null, null]];
  const co = B.coCluster(labs, 4);
  assert(Number.isNaN(co.matrix[0 * 4 + 2]), '未共同出现的样本对应为 NaN');
  assert(!Number.isNaN(co.matrix[0 * 4 + 1]), '共同出现的应为数值');
});
test('共聚类：部分参与时分母正确', () => {
  // 样本 0 与 1 同时出现在两次；0 与 2 只共同出现一次
  const labs = [
    [0, 0, 0, null],
    [0, 0, null, 0]
  ];
  const co = B.coCluster(labs, 4);
  approx(co.matrix[0 * 4 + 2], 1, 1e-12, '只共现一次且同簇 → 1');
  eq(co.seen[0 * 4 + 2], 1, '分母应为 1');
  eq(co.seen[0 * 4 + 1], 2, '分母应为 2');
});

/* ============ 5. 规则签名 ============ */
test('规则签名：条件顺序无关', () => {
  const a = B.ruleSignature({ conditions: ['x > 1', 'y = 高'], then: '高' });
  const b = B.ruleSignature({ conditions: ['y = 高', 'x > 1'], then: '高' });
  eq(a, b, '条件顺序不应影响签名');
});
test('规则签名：不同结果不同', () => {
  const a = B.ruleSignature({ conditions: ['x > 1'], then: '高' });
  const b = B.ruleSignature({ conditions: ['x > 1'], then: '低' });
  assert(a !== b);
});

/* ============ 6. 边频率与共识网络 ============ */
test('边频率：分母为成功次数', () => {
  const names = ['A', 'B'];
  const graphs = [
    { edges: [{ from: 'A', to: 'B' }] },
    { edges: [{ from: 'A', to: 'B' }] },
    { edges: [] }
  ];
  const ef = B.edgeFrequencies(graphs, names);
  eq(ef.okCount, 3);
  approx(ef.fwd[0 * 2 + 1] / ef.okCount, 2 / 3, 1e-12);
});
test('共识网络：拒绝成环', () => {
  const names = ['A', 'B', 'C'];
  const edges = [
    { from: 'A', to: 'B', freq: 0.9 },
    { from: 'B', to: 'C', freq: 0.9 },
    { from: 'C', to: 'A', freq: 0.9 }   // 会成环
  ];
  const g = B.consensusGraph(edges, names, 0.5);
  assert(g.dropped >= 1, '应丢弃至少一条成环边');
  // 检查仍无环
  const adj = new Map(names.map(n => [n, []]));
  g.edges.forEach(e => adj.get(e.from).push(e.to));
  const color = new Map(names.map(n => [n, 0]));
  const dfs = (u) => {
    color.set(u, 1);
    for (const v of adj.get(u)) {
      if (color.get(v) === 1) throw new Error('共识网络仍有环');
      if (color.get(v) === 0) dfs(v);
    }
    color.set(u, 2);
  };
  names.forEach(n => { if (color.get(n) === 0) dfs(n); });
});

/* ============ 7. 端到端 run ============ */
function synth(n, seed) {
  let a = seed >>> 0;
  const r = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
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

test('run(cluster) 端到端结构完整', () => {
  const d = synth(60, 5);
  const res = B.run({ X: d.X, y: d.y, names: ['a', 'b', 'c'], labels: ['低', '中', '高'], k: 3 },
    { B: 8, seed: 42, task: 'cluster', k: 3, drops: 80 }, null);
  eq(res.task, 'cluster');
  eq(res.B, 8);
  assert(res.okCount >= 6, `成功次数应 ≥6，实际 ${res.okCount}`);
  assert(res.summary.cluster, 'summary.cluster 缺失');
  assert(Number.isFinite(res.summary.cluster.ari.mean), 'ARI 均值应为有限值');
  assert(res.summary.cluster.ari.mean >= -1 && res.summary.cluster.ari.mean <= 1, 'ARI 越界');
  eq(res.summary.cluster.coCluster.matrix.length, res.n * res.n);
});

test('run(cluster) 同种子可复现', () => {
  const d = synth(50, 9);
  const a = B.run({ X: d.X, y: d.y, names: ['a', 'b', 'c'], labels: ['低', '中', '高'] },
    { B: 5, seed: 123, task: 'cluster', k: 3, drops: 60 });
  const b = B.run({ X: d.X, y: d.y, names: ['a', 'b', 'c'], labels: ['低', '中', '高'] },
    { B: 5, seed: 123, task: 'cluster', k: 3, drops: 60 });
  approx(a.summary.cluster.ari.mean, b.summary.cluster.ari.mean, 1e-12, '同种子 ARI 应一致');
});

test('run(rules) 输出规则频率', () => {
  const d = synth(80, 3);
  const res = B.run({ X: d.X, y: d.y, names: ['a', 'b', 'c'], labels: ['低', '中', '高'] },
    { B: 6, seed: 42, task: 'rules', levels: 3, drops: 80, maxDepth: 3, minLeaf: 8 });
  assert(res.summary.rules, 'summary.rules 缺失');
  assert(res.summary.rules.rules.length > 0, '应有规则');
  res.summary.rules.rules.forEach(r => assert(r.freq > 0 && r.freq <= 1, '频率越界'));
});

test('run(bn) 输出边频率与共识网络', () => {
  const d = synth(80, 4);
  const res = B.run({ X: d.X, y: d.y, names: ['a', 'b', 'c'], labels: ['低', '中', '高'], yName: 'Y' },
    { B: 5, seed: 42, task: 'bn', levels: 3, drops: 60, bnThreshold: 0.4 });
  assert(res.summary.bn, 'summary.bn 缺失');
  assert(res.summary.bn.edges.length >= 0, 'edges 应为数组');
  res.summary.bn.edges.forEach(e => assert(e.freq >= 0 && e.freq <= 1, '边频率越界'));
  assert(res.summary.bn.consensus.acyclic === true, '共识网络应无环');
});

test('run 分组抽样端到端', () => {
  const d = synth(60, 6);
  const res = B.run({ X: d.X, y: d.y, groups: d.groups, names: ['a', 'b', 'c'], labels: ['低', '中', '高'] },
    { B: 5, seed: 42, task: 'cluster', k: 3, method: 'group', drops: 60 });
  eq(res.method, 'group');
  // 每次抽样的索引里，组必须完整
  res.runs.forEach(r => {
    if (!r.idx) return;
    const inSet = new Set(r.idx);
    for (let g = 0; g < 6; g++) {
      const members = [];
      for (let i = 0; i < 60; i++) if (d.groups[i] === 'G' + g) members.push(i);
      const present = members.filter(i => inSet.has(i)).length;
      // 分组抽样是整组重复加入，present 应等于 members.length 或其倍数
      assert(present === 0 || present % members.length === 0, `组 G${g} 被拆散`);
    }
  });
});

test('run 记录失败而不中断', () => {
  const d = synth(20, 1);
  // 故意给不合理的 K（大于样本数）
  const res = B.run({ X: d.X, y: d.y, names: ['a', 'b', 'c'], labels: ['低', '中', '高'] },
    { B: 3, seed: 42, task: 'cluster', k: 50, drops: 40 });
  assert(res.failed > 0, '应有失败记录');
  res.runs.forEach(r => { if (!r.ok) assert(typeof r.error === 'string', '失败应带原因'); });
});

test('diagnose 给出结论', () => {
  const d = synth(60, 7);
  const res = B.run({ X: d.X, y: d.y, names: ['a', 'b', 'c'], labels: ['低', '中', '高'] },
    { B: 6, seed: 42, task: 'cluster', k: 3, drops: 60 });
  const dg = B.diagnose(res);
  assert(Array.isArray(dg.items) && dg.items.length >= 3, '诊断项不足');
  dg.items.forEach(i => assert(['PASS', 'WARNING', 'FAIL', 'INFO'].includes(i.status), '非法状态'));
  assert(dg.items.some(i => i.id === 'interpretation'), '必须包含解释边界提示');
});

/* ============ 8. 极端与性能 ============ */
test('极端数据：常量列不崩溃', () => {
  const X = [], y = [];
  for (let i = 0; i < 40; i++) { X.push([1, i % 5]); y.push(i % 5); }
  const res = B.run({ X, y, names: ['const', 'x'], labels: ['低', '中', '高'] },
    { B: 4, seed: 1, task: 'cluster', k: 2, drops: 40 });
  assert(res.B === 4);
});

test('性能：1000 行 × B=20 聚类在 10 秒内', () => {
  const d = synth(1000, 2);
  const t0 = Date.now();
  const res = B.run({ X: d.X, y: d.y, names: ['a', 'b', 'c'], labels: ['低', '中', '高'] },
    { B: 20, seed: 42, task: 'cluster', k: 3, drops: 100 });
  const ms = Date.now() - t0;
  assert(ms < 10000, `耗时 ${ms}ms 超出预期`);
  console.log(`      （1000 行 × B=20：${ms}ms，ok=${res.okCount}）`);
});

/* ============ 汇总 ============ */
const failed = results.filter(r => !r.ok);
const passed = results.length - failed.length;
console.log('\n=========== V2.9 BOOTSTRAP TEST ===========');
results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`));
console.log('-------------------------------------------');
console.log(`总计 ${results.length}  通过 ${passed}  失败 ${failed.length}  通过率 ${(passed / results.length * 100).toFixed(1)}%`);
console.log('===========================================\n');
process.exit(failed.length ? 1 : 0);
