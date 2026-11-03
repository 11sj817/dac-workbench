# -*- coding: utf-8 -*-
"""合并 workbench：HTML + CSS + JS + 三份公开数据集，产出单文件。"""
import json
from pathlib import Path
import hashlib
import subprocess
import sys
import re
from datetime import datetime, timezone

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
# ---- 构建信息注入（区分源提交 / 部署提交 / 构建摘要）----
def _git(cmd):
    try:
        r = subprocess.run(["git"] + cmd, cwd=str(ROOT), capture_output=True, text=True, timeout=10)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None

# 构建摘要：对「已注入 worker 的正文」取 SHA-256 前 12 位（不含 __BUILD__ 自身，避免自指）
_build_digest = hashlib.sha256(html.encode("utf-8")).hexdigest()[:12]
_build_info = {
    "digest": _build_digest,
    "time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "sourceCommit": _git(["rev-parse", "HEAD"]),
    "sourceDirty": bool((_git(["status", "--porcelain", "--",
        "workbench", "data/samples.js", "build_workbench.py"]) or "").strip()),
    "sourceDirtyScope": "build inputs: workbench/, data/samples.js, build_workbench.py",
    "note": "sourceCommit 是构建时本地 HEAD；部署提交是推送后生成的新提交，两者不同属正常。",
}
_build_js = json.dumps(_build_info, ensure_ascii=False).replace("</", "<\\/")
plain_html = html
html = html.replace("<script>", "<script>window.__BUILD__ = " + _build_js + ";</script>\n<script>", 1)

if "--check" in sys.argv:
    files = [OUT, ROOT / "docs/index.html", ROOT / "public/index.html"]
    for target in files:
        if not target.exists():
            raise SystemExit(f"Missing build output: {target.name}")
        existing = target.read_text(encoding="utf-8")
        match = re.search(r"window\.__BUILD__ = (\{.*?\});", existing)
        if not match or json.loads(match.group(1)).get("digest") != _build_digest:
            raise SystemExit(f"Invalid build digest: {target.relative_to(ROOT)}")
        clean = re.sub(r"<script>window\.__BUILD__ = \{.*?\};</script>\n", "", existing, count=1)
        if clean != plain_html:
            raise SystemExit(f"Stale build output: {target.relative_to(ROOT)}")
    if len({hashlib.sha256(f.read_bytes()).hexdigest() for f in files}) != 1:
        raise SystemExit("Build outputs have different bytes")
    print("PASS three identical outputs match current build inputs | digest", _build_digest)
    raise SystemExit(0)

OUT.write_text(html, encoding="utf-8", newline="\n")

# V3.0：统一构建——一个源，三处产物，避免"改了源码但线上没更新"
TARGETS = [ROOT / "docs" / "index.html", ROOT / "public" / "index.html"]
for t in TARGETS:
    t.parent.mkdir(parents=True, exist_ok=True)
    t.write_text(html, encoding="utf-8", newline="\n")

# 一致性校验：三份产物的 SHA-256 必须相同，换行统一为 LF。
def _h(x): return hashlib.sha256(x.read_bytes()).hexdigest()
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
print("构建摘要:", _build_digest, "| 源提交:", (_build_info["sourceCommit"] or "未知")[:8])
