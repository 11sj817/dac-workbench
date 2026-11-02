from pathlib import Path
p = Path(r"PROJDIR\dac-reverse-research\workbench\ui.js")
s = p.read_text(encoding="utf-8")
n = s.count("\x08")
s = s.replace("\x08", "\\b")
p.write_text(s, encoding="utf-8")
print("backspace chars fixed:", n)
# 验证正则片段
import re
for m in re.finditer(r"/\\b\d+\\b/", s):
    print("  regex ok:", m.group(0))
