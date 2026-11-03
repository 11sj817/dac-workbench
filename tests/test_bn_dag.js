/* BN 结构与推断的确定性测试
 * 覆盖：
 *  1) bnValidateDag 基本判定
 *  2) 大量随机数据集上 bnLearn 的结构必须是 DAG（回归 A→D→Y→A）
 *  3) reverse 不得产生环
 *  4) CPT 行和 = 1
 *  5) 无证据联合分布和 ≈ 1
 *  6) 后验归一化
 *  7) 不可能证据
 *  8) 小型已知网络穷举参考
 */
const fs = require('fs');
const path = require('path');

// 载入 core（与既有测试一致的做法）
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', 'workbench', 'core.js'), 'utf8'));
const C = global.window.DACCore;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  得到 ' + JSON.stringify(got) + ' 期望 ' + JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};
const ok = (name, cond, info) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + (info || '')}`);
  cond ? pass++ : fail++;
};
const near = (name, got, want, tol) => {
  const d = Math.abs(got - want);
  const good = Number.isFinite(got) && d <= tol;
  console.log(`${good ? 'PASS' : 'FAIL'}  ${name}  (${got} vs ${want}, |Δ|=${d.toExponential(2)})`);
  good ? pass++ : fail++;
};

/* ---------------- 1) bnValidateDag ---------------- */
console.log('\n=== 1. DAG 判定 ===');
{
  // 无环链 0→1→2
  eq('链 0→1→2 是 DAG', C.bnValidateDag([[], [0], [1]]).ok, true);
  // 自环
  eq('自环 0→0 被拒', C.bnValidateDag([[0]]).ok, false);
  // 二元环
  const two = C.bnValidateDag([[1], [0]]);
  eq('二元环 0↔1 被拒', two.ok, false);
  ok('环路径可读', Array.isArray(two.cycle) && two.cycle.length >= 2, JSON.stringify(two.cycle));
  // 三元环 A→D→Y→A
  const tri = C.bnValidateDag([[2], [0], [1]]);
  eq('三元环 0→1→2→0 被拒', tri.ok, false);
  ok('三元环路径含 3 个节点', tri.cycle.length >= 4, JSON.stringify(tri.cycle));
  // 菱形（两个父）无环
  eq('菱形 0→2, 1→2 是 DAG', C.bnValidateDag([[], [], [0, 1]]).ok, true);
}

/* ---------------- 2) 随机数据集上结构必须是 DAG ---------------- */
console.log('\n=== 2. 随机数据：bnLearn 结构必须无环 ===');
{
  // 确定性伪随机
  let seed = 20261103;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let bad = 0, checked = 0, cyclic = [];
  for (let trial = 0; trial < 60; trial++) {
    const n = 200, p = 4, lv = 3;
    const names = ['A', 'B', 'D', 'Y'];
    const discrete = [];
    for (let r = 0; r < n; r++) {
      const a = Math.floor(rand() * lv);
      const d = Math.min(lv - 1, Math.floor((a + rand() * 1.2) % lv));
      const y = Math.min(lv - 1, Math.floor((d * 0.7 + rand() * 1.4) % lv));
      const b = Math.floor(rand() * lv);
      discrete.push([a, b, d, y]);
    }
    try {
      const m = C.bnLearn(discrete, names, lv, { maxParents: 2, maxIter: 20, seed: trial + 1 });
      checked++;
      const dag = C.bnValidateDag(m.parents);
      if (!dag.ok) {
        bad++;
        cyclic.push({ trial, parents: m.parents, cycle: dag.cycle });
      }
    } catch (e) {
      // 抛错是允许的（我们要求宁可报错也不返回环），但不算通过
      bad++;
      cyclic.push({ trial, error: e.message });
    }
  }
  ok(`60 个随机数据集全部学出 DAG（检查 ${checked} 个）`, bad === 0,
    bad ? `有 ${bad} 个异常，首个：${JSON.stringify(cyclic[0])}` : '');
}

/* ---------------- 3) reverse 专项：强制触发反向搜索 ---------------- */
console.log('\n=== 3. reverse 不成环 ===');
{
  // 构造：X 与 Y 相互强依赖，且 Y 还受 Z 影响，容易触发 reverse
  let seed = 777;
  const rand = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const n = 400, lv = 3;
  const names = ['X', 'Y', 'Z', 'W'];
  const disc = [];
  for (let i = 0; i < n; i++) {
    const x = Math.floor(rand() * lv);
    const y = Math.min(lv - 1, Math.floor((x + rand() * 0.9) % lv));
    const z = Math.min(lv - 1, Math.floor((y + rand() * 1.1) % lv));
    const w = Math.floor(rand() * lv);
    disc.push([x, y, z, w]);
  }
  let revSeen = 0, revBad = 0;
  for (let s = 1; s <= 12; s++) {
    const m = C.bnLearn(disc, names, lv, { maxParents: 2, maxIter: 25, seed: s, randomStart: true });
    revSeen += (m.log || []).filter(l => l.op === 'rev').length;
    if (!C.bnValidateDag(m.parents).ok) revBad++;
  }
  ok(`12 次随机起点，反向操作出现 ${revSeen} 次，结构均为 DAG`, revBad === 0, `异常 ${revBad} 次`);
}

/* ---------------- 4) CPT 行和 ---------------- */
console.log('\n=== 4. CPT 行归一 ===');
{
  let seed = 421;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const disc = [];
  for (let i = 0; i < 300; i++) {
    const a = Math.floor(rand() * 3);
    const b = Math.min(2, Math.floor((a + rand()) % 3));
    const c = Math.floor(rand() * 3);
    disc.push([a, b, c]);
  }
  const m = C.bnLearn(disc, ['A', 'B', 'C'], 3, { maxParents: 2, seed: 5 });
  let worst = 0, rows = 0;
  for (let i = 0; i < m.cpt.length; i++) {
    const cpt = m.cpt[i];
    // cpt 结构：数组，每个 parent config 一行
    if (!Array.isArray(cpt)) continue;
    cpt.forEach(row => {
      if (!Array.isArray(row)) return;
      const sum = row.reduce((a, b) => a + b, 0);
      rows++;
      worst = Math.max(worst, Math.abs(sum - 1));
    });
  }
  ok(`检查了 ${rows} 行 CPT`, rows > 0, '没有读到 CPT 行');
  near('CPT 行和最大偏差 < 1e-9', worst, 0, 1e-9);
}

/* ---------------- 5) 无证据联合分布和 ---------------- */
console.log('\n=== 5. 联合分布归一 ===');
{
  const m = {
    names: ['A', 'B'], levels: 3,
    parents: [[], [0]],
    cpt: [
      [[0.2, 0.3, 0.5]],
      [[0.6, 0.3, 0.1], [0.2, 0.5, 0.3], [0.1, 0.2, 0.7]]
    ]
  };
  // 手算联合
  const P = (a, b) => m.cpt[0][0][a] * m.cpt[1][a][b];
  let sum = 0;
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) sum += P(a, b);
  near('手算联合和 = 1', sum, 1, 1e-12);

  const r1 = C.bnInfer(m, {});
  const post = r1.posterior;
  near('bnInfer 后验和 = 1', post.reduce((x, y) => x + y, 0), 1, 1e-9);
  near('evidenceProb = 1（无证据）', r1.evidenceProb, 1, 1e-9);
  // 目标变量的边界分布应是 B 的
  const pB = [0, 1, 2].map(b => [0, 1, 2].reduce((s, a) => s + P(a, b), 0));
  let worst = 0;
  for (let b = 0; b < 3; b++) worst = Math.max(worst, Math.abs(post[b] - pB[b]));
  near('P(B) 与手算一致', worst, 0, 1e-9);
}

/* ---------------- 6) 证据下的条件化 ---------------- */
console.log('\n=== 6. 证据条件化 ===');
{
  const m = {
    names: ['A', 'B'], levels: 2,
    parents: [[], [0]],
    cpt: [
      [[0.3, 0.7]],
      [[0.9, 0.1], [0.2, 0.8]]
    ]
  };
  // P(A=1) = 0.7
  // bnInfer 的目标固定是最后一个变量（B），所以后验是 P(B | A=1)
  const r2 = C.bnInfer(m, { A: 1 });
  const post2 = r2.posterior;
  near('P(B=1 | A=1) = 0.8（CPT 第 2 行）', post2[1], 0.8, 1e-9);
  near('后验和 = 1', post2[0] + post2[1], 1, 1e-9);
  near('evidenceProb = P(A=1) = 0.7', r2.evidenceProb, 0.7, 1e-9);
  ok('目标名是最后一个变量', r2.target === 'B', r2.target);
}

/* ---------------- 7) 不可能证据 ---------------- */
console.log('\n=== 7. 不可能证据 ===');
{
  // A 恒为 0；给证据 A=1 是零概率事件
  const m = {
    names: ['A', 'B'], levels: 2,
    parents: [[], [0]],
    cpt: [
      [[1, 0]],
      [[0.5, 0.5], [0.5, 0.5]]
    ]
  };
  let threw = false, val = null;
  try { val = C.bnInfer(m, { A: 1 }); } catch (e) { threw = true; }
  const handled = threw || (val && val.impossible === true && val.posterior === null);
  ok('不可能证据返回 impossible 而非伪后验', handled, threw ? '抛错也算处理' : `返回 ${JSON.stringify(val)}`);
}

/* ---------------- 8) 小型网络穷举参考 ---------------- */
console.log('\n=== 8. 穷举参考（链式 vs 独立）===');
{
  // A→B→C，全部二元，手算 P(C)
  const m = {
    names: ['A', 'B', 'C'], levels: 2,
    parents: [[], [0], [1]],
    cpt: [
      [[0.4, 0.6]],
      [[0.7, 0.3], [0.2, 0.8]],
      [[0.9, 0.1], [0.3, 0.7]]
    ]
  };
  // P(B=1) = 0.4*0.3 + 0.6*0.8 = 0.12 + 0.48 = 0.6
  // P(C=1) = P(B=0)*0.1 + P(B=1)*0.7 = 0.4*0.1 + 0.6*0.7 = 0.04 + 0.42 = 0.46
  const r3 = C.bnInfer(m, {});
  near('P(C=1) = 0.46（手算）', r3.posterior[1], 0.46, 1e-9);
  near('后验和 = 1', r3.posterior[0] + r3.posterior[1], 1, 1e-9);
}

console.log(`\n总计 ${pass + fail} 项，通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
