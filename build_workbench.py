# -*- coding: utf-8 -*-
"""合并 workbench：HTML + CSS + JS + 三份公开数据集，产出单文件。"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WB = ROOT / "workbench"
OUT = ROOT / "DAC-Workbench.html"

html = (WB / "index.html").read_text(encoding="utf-8")
core = (WB / "core.js").read_text(encoding="utf-8")
pre = (WB / "preprocess.js").read_text(encoding="utf-8")
workerk = (WB / "worker.js").read_text(encoding="utf-8")
boot = (WB / "bootstrap.js").read_text(encoding="utf-8")
glm = (WB / "glm.js").read_text(encoding="utf-8")
ui = (WB / "ui.js").read_text(encoding="utf-8")
samples = (ROOT / "data" / "samples.js").read_text(encoding="utf-8")

bundle = (
    "<script>\n" + samples + "\n</script>\n"
    "<script>\n" + pre + "\n</script>\n"
    "<script>\n" + core + "\n</script>\n"
    "<script>\n" + boot + "\n</script>\n"
    "<script>\n" + glm + "\n</script>\n"
    "<script>\n" + ui + "\n</script>\n"
)

worker_src = "self.window = self;\n" + pre + "\n" + core + "\n" + boot + "\n" + glm + "\n" + workerk
# JS 字符串里把 </ 转成 <\/ ，避免提前闭合外层 <script>
js_literal = json.dumps(worker_src).replace("</", "<\\/")
html = html.replace("<!--CORE-->\n<!--UI-->",
                    "<script>window.__WORKER_SRC__ = " + js_literal + ";</script>\n" + bundle)
OUT.write_text(html, encoding="utf-8")

# V3.0：统一构建——一个源，三处产物，避免"改了源码但线上没更新"
TARGETS = [ROOT / "docs" / "index.html", ROOT / "public" / "index.html"]
for t in TARGETS:
    t.parent.mkdir(parents=True, exist_ok=True)
    t.write_text(html, encoding="utf-8")

# 一致性校验：三份产物的 SHA1 必须相同
import hashlib
def _h(x): return hashlib.sha1(x.read_bytes()).hexdigest()[:12]
hashes = {str(OUT.relative_to(ROOT)): _h(OUT)}
for t in TARGETS:
    hashes[str(t.relative_to(ROOT))] = _h(t)
if len(set(hashes.values())) != 1:
    raise SystemExit("构建产物不一致：" + str(hashes))
print("  synced -> " + ", ".join(f"{k} ({v})" for k, v in hashes.items()))

kb = OUT.stat().st_size / 1024
print(f"built: {OUT.name}  {kb:.0f} KB")
for token in ("__DATASETS__", "DACCore", "renderAI", "initDatasets"):
    print(f"  contains {token}:", token in html)
