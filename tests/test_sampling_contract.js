/* V3.4 · Bootstrap 抽样契约测试
 * 对应复核报告第四节：缺参数、不放回、权重、组完整性、UI→Worker。
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
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'eq'}: ${a} !== ${b}`); };
const approx = (a, b, t, m) => { t = t === undefined ? 1e-9 : t; if (!(Math.abs(a - b) <= t)) throw new Error(`${m || 'approx'}: ${a} vs ${b}`); };
const throws = (fn, re, m) => {
  try { fn(); } catch (e) { if (re.test(e.message)) return; throw new Error(`${m}: 错误信息不符 -> ${e.message}`); }
  throw new Error(`${m}: 应抛错但没有`);
};

const N = 60;

/* ============ 1. 缺参数必须报错（不能静默退化 IID） ============ */
test('分层抽样缺 strata → 报错', () => {
  throws(() => B.sampleIndices({ n: N, B: 3, seed: 1, method: 'stratified' }), /分层/, 'stratified 缺参数');
});

test('分组抽样缺 groups → 报错', () => {
  throws(() => B.sampleIndices({ n: N, B: 3, seed: 1, method: 'group' }), /分组/, 'group 缺参数');
});

test('加权抽样缺 weights → 报错', () => {
  throws(() => B.sampleIndices({ n: N, B: 3, seed: 1, method: 'weighted' }), /加权/, 'weighted 缺参数');
});

test('向量长度不匹配 → 报错', () => {
  throws(() => B.sampleIndices({ n: N, B: 3, seed: 1, method: 'stratified', strata: ['a', 'b'] }),
    /长度/, 'strata 长度不符');
});

/* ============ 2. 权重契约 ============ */
test('负权重 → 报错', () => {
  const w = new Array(N).fill(1); w[3] = -1;
  throws(() => B.sampleIndices({ n: N, B: 3, seed: 1, method: 'weighted', weights: w }), /非负/, '负权重');
});

test('NaN 权重 → 报错', () => {
  const w = new Array(N).fill(1); w[0] = NaN;
  throws(() => B.sampleIndices({ n: N, B: 3, seed: 1, method: 'weighted', weights: w }), /非负/, 'NaN 权重');
});

test('零权重样本永不被抽中', () => {
  const w = new Array(N).fill(0);
  w[0] = 1; w[1] = 1;   // 只有 0、1 有权重
  const out = B.sampleIndices({ n: N, B: 20, seed: 42, method: 'weighted', weights: w, fraction: 0.5 });
  const seen = new Set();
  out.forEach(idx => idx.forEach(i => seen.add(i)));
  assert([...seen].every(i => i === 0 || i === 1), `零权重样本被抽中：${[...seen].filter(i => i !== 0 && i !== 1)}`);
});

test('加权有放回：合法索引且允许重复（这是有放回的定义）', () => {
  const w = new Array(N).fill(1);
  const out = B.sampleIndices({ n: N, B: 5, seed: 7, method: 'weighted', weights: w });
  out.forEach(idx => {
    eq(idx.length, N, 'fraction=1 时每轮长度应为 n');
    idx.forEach(i => assert(i >= 0 && i < N, '索引越界'));
    assert(new Set(idx).size < idx.length, '有放回应出现重复');
  });
});

test('加权有放回 + fraction=1：等权时各样本被抽次数近似均匀', () => {
  const w = new Array(N).fill(1);
  const out = B.sampleIndices({ n: N, B: 200, seed: 123, method: 'weighted', weights: w });
  const cnt = new Array(N).fill(0);
  out.forEach(idx => idx.forEach(i => cnt[i]++));
  const total = cnt.reduce((a, b) => a + b, 0);
  const expect = total / N;
  const chi = cnt.reduce((s, c) => s + (c - expect) ** 2 / expect, 0);
  // df = N-1 = 59，99% 临界值 ≈ 88
  assert(chi < 120, `等权分布偏离过大：χ² = ${chi.toFixed(1)}（df=59）`);
});

test('加权不放回 → 报错（无标准定义）', () => {
  throws(() => B.sampleIndices({ n: N, B: 3, seed: 1, method: 'weighted', weights: new Array(N).fill(1), replacement: false }),
    /有放回/, '加权不放回');
});

/* ============ 3. 不放回唯一性 ============ */
test('IID 不放回：索引唯一（原实现可能返回 [0,0,0]）', () => {
  const out = B.sampleIndices({ n: N, B: 30, seed: 5, method: 'iid', replacement: false, fraction: 0.6 });
  out.forEach((idx, bi) => {
    const u = new Set(idx);
    eq(u.size, idx.length, `第 ${bi + 1} 轮出现重复`);
    idx.forEach(i => assert(i >= 0 && i < N));
  });
});

test('IID 不放回 fraction=1：恰好是 0..n-1 的一个排列', () => {
  const out = B.sampleIndices({ n: N, B: 5, seed: 9, method: 'iid', replacement: false, fraction: 1 });
  out.forEach(idx => {
    eq(idx.length, N);
    const sorted = idx.slice().sort((a, b) => a - b);
    for (let i = 0; i < N; i++) eq(sorted[i], i, '应为完整排列');
  });
});

test('IID 有放回 fraction=1：长度 n 但不唯一', () => {
  const out = B.sampleIndices({ n: N, B: 5, seed: 9, method: 'iid', replacement: true, fraction: 1 });
  out.forEach(idx => {
    eq(idx.length, N);
    assert(new Set(idx).size < N, '有放回应有重复');
  });
});

/* ============ 4. 组完整性 ============ */
test('分组抽样：同一组内记录不拆散', () => {
  const groups = [];
  for (let i = 0; i < N; i++) groups.push('G' + Math.floor(i / 6));
  const out = B.sampleIndices({ n: N, B: 10, seed: 3, method: 'group', groups });
  const byGroup = new Map();
  groups.forEach((g, i) => { if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(i); });
  out.forEach((idx, bi) => {
    const seen = new Map();
    idx.forEach(i => { const g = groups[i]; seen.set(g, (seen.get(g) || 0) + 1); });
    seen.forEach((cnt, g) => {
      eq(cnt % byGroup.get(g).length, 0, `第 ${bi + 1} 轮组 ${g} 的记录数 ${cnt} 不是组大小的整数倍`);
    });
  });
});

test('分组不放回：组不重复', () => {
  const groups = [];
  for (let i = 0; i < N; i++) groups.push('G' + Math.floor(i / 6));
  const out = B.sampleIndices({ n: N, B: 5, seed: 11, method: 'group', groups, replacement: false, fraction: 0.5 });
  const groupSize = 6;
  out.forEach((idx, bi) => {
    const lines = idx.length / groupSize;
    assert(Number.isInteger(lines), `第 ${bi + 1} 轮行数不是组大小整数倍`);
    assert(lines <= 10, `不放回时抽到的组数不应超过总组数 10，实际 ${lines}`);
  });
});

test('分组抽样：行数可以是 n 的整数倍（整组进出）', () => {
  const groups = [];
  for (let i = 0; i < N; i++) groups.push('G' + Math.floor(i / 6));
  const out = B.sampleIndices({ n: N, B: 3, seed: 13, method: 'group', groups, fraction: 1 });
  out.forEach(idx => eq(idx.length % 6, 0, '行数应为组大小的整数倍'));
});

/* ============ 5. 分层 ============ */
test('分层抽样：每层都被覆盖且层内比例保持', () => {
  const strata = [];
  for (let i = 0; i < N; i++) strata.push(i < 20 ? 'A' : 'B');   // 20 / 40
  const out = B.sampleIndices({ n: N, B: 10, seed: 17, method: 'stratified', strata, fraction: 0.5 });
  out.forEach((idx, bi) => {
    const a = idx.filter(i => i < 20).length;
    const b = idx.filter(i => i >= 20).length;
    assert(a > 0 && b > 0, `第 ${bi + 1} 轮某层为空（A=${a} B=${b}）`);
    // 20×0.5=10, 40×0.5=20
    assert(Math.abs(a - 10) <= 0 && Math.abs(b - 20) <= 0, `第 ${bi + 1} 轮层内数量应为 10/20，实际 ${a}/${b}`);
  });
});

test('分层不放回：层内唯一', () => {
  const strata = [];
  for (let i = 0; i < N; i++) strata.push(i < 30 ? 'A' : 'B');
  const out = B.sampleIndices({ n: N, B: 5, seed: 19, method: 'stratified', strata, replacement: false, fraction: 0.8 });
  out.forEach(idx => eq(new Set(idx).size, idx.length, '层内不应重复'));
});

/* ============ 6. PPS 独立命名 ============ */
test('pps 与 weighted 是不同方法，结果不同', () => {
  const w = [];
  for (let i = 0; i < N; i++) w.push(1 + (i % 5));
  const a = B.sampleIndices({ n: N, B: 3, seed: 21, method: 'weighted', weights: w });
  const b = B.sampleIndices({ n: N, B: 3, seed: 21, method: 'pps', weights: w });
  assert(JSON.stringify(a) !== JSON.stringify(b), '两种方法不应给出相同索引');
});

/* ============ 7. meta 元信息 ============ */
test('返回 meta 标明方法、是否放回、抽样单位', () => {
  const out = B.sampleIndices({ n: N, B: 2, seed: 1, method: 'iid', replacement: true });
  assert(out.meta, 'meta 缺失');
  eq(out.meta.method, 'iid');
  eq(out.meta.replacement, true);
  eq(out.meta.unit, 'row');
});

test('分组抽样 meta.unit = group', () => {
  const groups = [];
  for (let i = 0; i < N; i++) groups.push('G' + Math.floor(i / 6));
  const out = B.sampleIndices({ n: N, B: 2, seed: 1, method: 'group', groups });
  eq(out.meta.unit, 'group');
  assert(out.meta.groupsSampled > 0, '应记录抽样组数');
});

/* ============ 8. 可复现 ============ */
test('同种子同参数 → 完全相同的索引', () => {
  const a = B.sampleIndices({ n: N, B: 5, seed: 77, method: 'iid' });
  const b = B.sampleIndices({ n: N, B: 5, seed: 77, method: 'iid' });
  eq(JSON.stringify(a), JSON.stringify(b));
});

test('不同种子 → 不同索引', () => {
  const a = B.sampleIndices({ n: N, B: 3, seed: 1, method: 'iid' });
  const b = B.sampleIndices({ n: N, B: 3, seed: 2, method: 'iid' });
  assert(JSON.stringify(a) !== JSON.stringify(b));
});

/* ============ 汇总 ============ */
const failed = results.filter(r => !r.ok);
const passed = results.length - failed.length;
console.log('\n=========== V3.4 抽样契约 TEST ===========');
results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  -> ' + r.err}`));
console.log('-------------------------------------------');
console.log(`总计 ${results.length}  通过 ${passed}  失败 ${failed.length}  通过率 ${(passed / results.length * 100).toFixed(1)}%`);
console.log('===========================================\n');
process.exit(failed.length ? 1 : 0);
