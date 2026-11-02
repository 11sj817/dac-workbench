# -*- coding: utf-8 -*-
"""修三个问题：robustness 的等级标签、贝叶斯网络成环、silhouette 采样提速。"""
from pathlib import Path

p = Path(r"D:\reverse\dac-reverse-research\workbench\core.js")
s = p.read_text(encoding="utf-8")

# 1) robustness 内部按 levels 取标签
old = """  function robustness(X, yv, factors, labels, base, opt) {
    const runs = [];
    const push = (label, over) => {
      const p = Object.assign({}, base, over);
      try {
        const cal = {};"""
new = """  function robustness(X, yv, factors, baseLabels, base, opt) {
    const runs = [];
    const push = (label, over) => {
      const p = Object.assign({}, base, over);
      const labels = LEVEL_LABELS[p.levels] || baseLabels;
      try {
        const cal = {};"""
assert old in s
s = s.replace(old, new)

# 2) silhouette 采样
old_sil = s[s.index("  function silhouette(Z, labels) {"):s.index("  /* ---------------- PCA")]
new_sil = """  function silhouette(Z, labels) {
    const N = Z.length;
    if (N > 6000) return NaN;
    let pick = Z.map((_, i) => i);
    if (N > 700) {
      const r = rng(20261102);
      for (let i = pick.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [pick[i], pick[j]] = [pick[j], pick[i]];
      }
      pick = pick.slice(0, 700);
    }
    const n = pick.length;
    const uniq = [...new Set(labels)];
    if (uniq.length < 2) return NaN;
    const D = [];
    for (let a = 0; a < n; a++) {
      const row = new Float64Array(n);
      for (let b = 0; b < n; b++) row[b] = Math.sqrt(dist2(Z[pick[a]], Z[pick[b]]));
      D.push(row);
    }
    let total = 0;
    for (let a = 0; a < n; a++) {
      const la = labels[pick[a]];
      let aSum = 0, aCnt = 0;
      const bMin = {};
      for (let b = 0; b < n; b++) {
        if (a === b) continue;
        const lb = labels[pick[b]];
        if (lb === la) { aSum += D[a][b]; aCnt++; }
        else {
          bMin[lb] = bMin[lb] === undefined ? [0, 0] : bMin[lb];
          bMin[lb][0] += D[a][b]; bMin[lb][1]++;
        }
      }
      const a1 = aCnt ? aSum / aCnt : 0;
      let b1 = Infinity;
      for (const c in bMin) b1 = Math.min(b1, bMin[c][0] / bMin[c][1]);
      total += (b1 === Infinity || Math.max(a1, b1) === 0) ? 0 : (b1 - a1) / Math.max(a1, b1);
    }
    return total / n;
  }

"""
s = s.replace(old_sil, new_sil)

# 3) 贝叶斯网络加环检测
old_add = """        if (parents[i].length < o.maxParents) {
          for (let j = 0; j < p; j++) {
            if (j === i || parents[i].includes(j)) continue;
            if (parents[j].includes(i)) continue; // 避免双向
            const np = parents[i].concat([j]);"""
new_add = """        if (parents[i].length < o.maxParents) {
          for (let j = 0; j < p; j++) {
            if (j === i || parents[i].includes(j)) continue;
            if (isAncestor(parents, i, j)) continue; // 会成环
            const np = parents[i].concat([j]);"""
assert old_add in s
s = s.replace(old_add, new_add)

# 插入 isAncestor 工具
anchor = "  function configIndex(states, row, parentIdx) {"
helper = """  /* i 是否为 j 的祖先：从 j 沿父节点链向上找，看能否遇到 i */
  function isAncestor(parents, i, j) {
    const stack = [j];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (cur === i) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const p of parents[cur]) stack.push(p);
    }
    return false;
  }

"""
s = s.replace(anchor, helper + anchor)

p.write_text(s, encoding="utf-8")
print("patched, len =", len(s))
