from pathlib import Path
p = Path(r"D:\reverse\dac-reverse-research\workbench\ui.js")
s = p.read_text(encoding="utf-8")
s = s.replace("    if (!S.res && t !== 'guide') {", "    if (!S.res && S.tab !== 'guide') {")
p.write_text(s, encoding="utf-8")
print("fixed:", "S.tab !== 'guide'" in s)
