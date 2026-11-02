# -*- coding: utf-8 -*-
"""合并 workbench：HTML + CSS + JS + 三份公开数据集，产出单文件。"""
import json
from pathlib import Path

ROOT = Path(r"PROJDIR\dac-reverse-research")
WB = ROOT / "workbench"
OUT = ROOT / "DAC-Workbench.html"

html = (WB / "index.html").read_text(encoding="utf-8")
core = (WB / "core.js").read_text(encoding="utf-8")
pre = (WB / "preprocess.js").read_text(encoding="utf-8")
workerk = (WB / "worker.js").read_text(encoding="utf-8")
ui = (WB / "ui.js").read_text(encoding="utf-8")
samples = (ROOT / "data" / "samples.js").read_text(encoding="utf-8")

bundle = (
    "<script>\n" + samples + "\n</script>\n"
    "<script>\n" + pre + "\n</script>\n"
    "<script>\n" + core + "\n</script>\n"
    "<script>\n" + ui + "\n</script>\n"
)

worker_src = "self.window = self;\n" + pre + "\n" + core + "\n" + workerk
# JS 字符串里把 </ 转成 <\/ ，避免提前闭合外层 <script>
js_literal = json.dumps(worker_src).replace("</", "<\\/")
html = html.replace("<!--CORE-->\n<!--UI-->",
                    "<script>window.__WORKER_SRC__ = " + js_literal + ";</script>\n" + bundle)
OUT.write_text(html, encoding="utf-8")

kb = OUT.stat().st_size / 1024
print(f"built: {OUT.name}  {kb:.0f} KB")
for token in ("__DATASETS__", "DACCore", "renderAI", "initDatasets"):
    print(f"  contains {token}:", token in html)
