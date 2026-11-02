from pathlib import Path

# ---- 1) robustness 提速 ----
c = Path(r"D:\reverse\dac-reverse-research\workbench\core.js")
s = c.read_text(encoding="utf-8")
s = s.replace("      const p = Object.assign({}, base, over);\n      const labels = LEVEL_LABELS[p.levels] || baseLabels;",
              "      const p = Object.assign({}, base, over);\n      p.drops = Math.min(p.drops || 500, 200);\n      const labels = LEVEL_LABELS[p.levels] || baseLabels;")
c.write_text(s, encoding="utf-8")
print("robust speedup:", "p.drops = Math.min" in s)

# ---- 2) index.html 增加两个 Tab ----
h = Path(r"D:\reverse\dac-reverse-research\workbench\index.html")
t = h.read_text(encoding="utf-8")
t = t.replace('        <button data-tab="net">机制网络</button>',
              '        <button data-tab="net">机制网络</button>\n        <button data-tab="bn">贝叶斯网络</button>\n        <button data-tab="robust">稳健性检验</button>')
h.write_text(t, encoding="utf-8")
print("tabs added:", t.count('data-tab='))
