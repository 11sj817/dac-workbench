# -*- coding: utf-8 -*-
"""改进数字溯源校验：允许模型做派生计算（差值 / 比值 / 百分比 / 计数）。"""
from pathlib import Path

p = Path(r"PROJDIR\dac-reverse-research\workbench\ui.js")
s = p.read_text(encoding="utf-8")

old = """  function auditNumbers(text, res) {
    const allow = [...collectNumbers(res)];
    const nums = (text.match(/\\d+(?:\\.\\d+)?/g) || []).map(Number);
    const bad = [];
    nums.forEach(n => {
      if (n <= 4) return;                       // 等级/小整数放过
      const cands = [n, n / 100, n * 100];
      const hit = cands.some(x => allow.some(y => Math.abs(y - x) <= Math.max(0.02, Math.abs(y) * 0.02)));
      if (!hit) bad.push(n);
    });
    return [...new Set(bad)].slice(0, 6);
  }"""

new = """  /* 允许"派生数字"：模型常做差值、比值、占比这类合法运算 */
  function expandNumbers(base) {
    const set = new Set(base);
    const arr = [...base].filter(x => x > 0 && x < 1e6).slice(0, 60);
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j];
        set.add(Math.abs(a - b));                       // 差值
        set.add(Math.abs((a - b) / (a || 1) * 100));    // 差值占比
        set.add(a / b);                                 // 比值
        set.add(b / a);
      }
    }
    return set;
  }

  function auditNumbers(text, res) {
    const base = collectNumbers(res);
    // 数组长度也常被引用（"11 个因素"）
    [res && res.meta && res.meta.factors,
     res && res.tree && res.tree.rules,
     res && res.profile && res.profile.columns,
     res && res.calibration && res.calibration.labels].forEach(a => {
      if (Array.isArray(a)) base.add(a.length);
    });
    const allow = [...expandNumbers(base)];
    const nums = (text.match(/\\d+(?:\\.\\d+)?/g) || []).map(Number);
    const bad = [];
    nums.forEach(n => {
      if (n <= 4) return;                       // 等级/小整数放过
      const cands = [n, n / 100, n * 100];
      const hit = cands.some(x => allow.some(y => Math.abs(y - x) <= Math.max(0.02, Math.abs(y) * 0.02)));
      if (!hit) bad.push(n);
    });
    return [...new Set(bad)].slice(0, 6);
  }"""
assert old in s, "auditNumbers 未找到"
s = s.replace(old, new)
p.write_text(s, encoding="utf-8")
print("audit improved, len =", len(s))
