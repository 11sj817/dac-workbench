"""DAC-Next 基础 Demo：零依赖 HTTP 服务（仅用 Python 标准库 + numpy/pandas）。

启动： python app.py
访问： http://127.0.0.1:8765

设计要点（对应报告第六、八部分）：
- 分析全部在 analysis_core 里以纯函数完成，服务层只做 IO、配额占位与序列化；
- 每次运行都写入 runs/<run_id>/ 快照（数据指纹 + 参数 + 结果），实现"可复现"；
- 不引入 Flask/FastAPI，私有化部署时无需额外依赖，也便于审计。
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import sys
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))
import analysis_core as core  # noqa: E402

ROOT = BASE.parent
UPLOAD_DIR = BASE / ".uploads"
RUN_DIR = BASE / ".runs"
for d in (UPLOAD_DIR, RUN_DIR):
    d.mkdir(parents=True, exist_ok=True)

DATASETS: dict[str, dict] = {}   # dataset_id -> {path, df, fingerprint, name}
RUNS: dict[str, dict] = {}       # run_id -> {params, at}
MAX_UPLOAD = 30 * 1024 * 1024


def _json_default(o):
    try:
        import numpy as np

        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
    except Exception:
        pass
    return str(o)


def _fingerprint(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _parse_multipart(body: bytes, boundary: bytes) -> dict[str, dict]:
    """极简 multipart/form-data 解析，够用即可。"""
    out: dict[str, dict] = {}
    sep = b"--" + boundary
    for part in body.split(sep):
        if not part or part in (b"--\r\n", b"--", b"\r\n"):
            continue
        part = part.lstrip(b"\r\n")
        if part.startswith(b"--"):
            continue
        if b"\r\n\r\n" not in part:
            continue
        head, _, data = part.partition(b"\r\n\r\n")
        data = data.rstrip(b"\r\n--")
        headers = head.decode("utf-8", errors="replace")
        name = ""
        filename = ""
        for line in headers.split("\r\n"):
            if line.lower().startswith("content-disposition"):
                for seg in line.split(";"):
                    seg = seg.strip()
                    if seg.startswith("name="):
                        name = seg[5:].strip('"')
                    elif seg.startswith("filename="):
                        filename = seg[9:].strip('"')
        out[name] = {"filename": filename, "data": data}
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "DACNext/0.1"

    # ---------------- 基础响应 ----------------
    def _send(self, code: int, body: bytes, ctype: str = "application/json; charset=utf-8") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False, default=_json_default).encode("utf-8"))

    def _err(self, msg: str, code: int = 400, **extra) -> None:
        payload = {"ok": False, "error": str(msg)}
        payload.update(extra)
        self._json(payload, code)

    def log_message(self, fmt: str, *args) -> None:  # 安静
        pass

    # ---------------- 路由 ----------------
    def do_GET(self) -> None:
        path = urlparse(self.path).path
        try:
            if path in ("/", "/index.html"):
                return self._file(BASE / "static" / "index.html", "text/html; charset=utf-8")
            if path.startswith("/static/"):
                return self._file(BASE / "static" / path[len("/static/"):], None)
            if path == "/api/health":
                return self._json({"ok": True, "service": "dac-next", "version": "0.1",
                                   "datasets": len(DATASETS), "runs": len(RUNS)})
            if path == "/api/sample":
                return self._sample()
            if path.startswith("/api/report/"):
                rid = path.rsplit("/", 1)[-1]
                p = RUN_DIR / rid / "report.md"
                if not p.exists():
                    return self._err("报告不存在", 404)
                return self._send(200, p.read_bytes(), "text/markdown; charset=utf-8")
            if path.startswith("/api/run/"):
                rid = path.rsplit("/", 1)[-1]
                p = RUN_DIR / rid / "result.json"
                if not p.exists():
                    return self._err("运行结果不存在", 404)
                return self._send(200, p.read_bytes(), "application/json; charset=utf-8")
            return self._err("not found", 404)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self._err(f"服务内部错误：{exc}", 500)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_UPLOAD:
                return self._err("文件超过 30MB 上限", 413)
            raw = self.rfile.read(length) if length else b""
            if path == "/api/upload":
                return self._upload(raw)
            if path == "/api/run":
                return self._run(raw)
            return self._err("not found", 404)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self._err(f"服务内部错误：{exc}", 500)

    # ---------------- 具体处理 ----------------
    def _file(self, p: Path, ctype: str | None) -> None:
        if not p.exists():
            return self._err("not found", 404)
        if ctype is None:
            ctype = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
        self._send(200, p.read_bytes(), ctype)

    def _sample(self) -> None:
        path = ROOT / "data" / "enterprise_1000.csv"
        if not path.exists():
            return self._err("示例数据缺失", 404)
        df = core.load_table(str(path))
        did = "sample"
        DATASETS[did] = {"path": str(path), "df": df, "fingerprint": _fingerpath(path), "name": "示例：1000 家虚构企业"}
        prof = core.profile(df)
        self._json({"ok": True, "dataset_id": did, "name": DATASETS[did]["name"],
                    "columns": [str(c) for c in df.columns], "rows": int(len(df)),
                    "profile": prof})

    def _upload(self, raw: bytes) -> None:
        ctype = self.headers.get("Content-Type", "")
        if "boundary=" not in ctype:
            return self._err("需要 multipart/form-data")
        boundary = ctype.split("boundary=", 1)[1].strip().strip('"').encode()
        parts = _parse_multipart(raw, boundary)
        f = parts.get("file")
        if not f or not f["data"]:
            return self._err("没有收到文件")
        name = f["filename"] or "upload.xlsx"
        ext = Path(name).suffix.lower() or ".xlsx"
        if ext not in (".xlsx", ".xls", ".csv"):
            return self._err("只支持 .xlsx / .xls / .csv")
        did = uuid.uuid4().hex[:12]
        dest = UPLOAD_DIR / f"{did}{ext}"
        dest.write_bytes(f["data"])
        try:
            df = core.load_table(str(dest))
        except Exception as exc:  # noqa: BLE001
            return self._err(f"文件解析失败：{exc}", 422)
        if df.shape[1] < 2:
            return self._err("至少需要 2 列（条件变量 + 决策变量）", 422)
        DATASETS[did] = {"path": str(dest), "df": df, "fingerprint": _fingerprint(dest), "name": name}
        self._json({"ok": True, "dataset_id": did, "name": name,
                    "columns": [str(c) for c in df.columns], "rows": int(len(df)),
                    "profile": core.profile(df)})

    def _run(self, raw: bytes) -> None:
        req = json.loads(raw or b"{}")
        did = req.get("dataset_id") or "sample"
        if did not in DATASETS:
            if did == "sample":
                self._sample()
                did = "sample"
            else:
                return self._err("数据集不存在或已过期，请重新上传", 404)
        ds = DATASETS[did]
        df: pd.DataFrame = ds["df"]
        cols = [str(c) for c in df.columns]
        target = req.get("target") or cols[-1]
        factors = req.get("factors") or [c for c in cols if c != target]
        params = {
            "low_pct": float(req.get("low_pct", 25)),
            "high_pct": float(req.get("high_pct", 75)),
            "drops": int(req.get("drops", 500)),
            "levels": int(req.get("levels", 3)),
            "k": int(req.get("k", 3)),
            "tree_depth": int(req.get("tree_depth", 3)),
            "net_threshold": float(req.get("net_threshold", 0.2)),
            "seed": int(req.get("seed", 42)),
            "scale": str(req.get("scale", "robust")),
        }
        t0 = time.time()
        res = core.run_pipeline(df, target=target, factors=factors, **params)
        elapsed = round(time.time() - t0, 3)
        md = core.to_markdown(res)

        rid = uuid.uuid4().hex[:12]
        rdir = RUN_DIR / rid
        rdir.mkdir(parents=True, exist_ok=True)
        (rdir / "result.json").write_text(json.dumps(res, ensure_ascii=False, default=_json_default), encoding="utf-8")
        (rdir / "report.md").write_text(md, encoding="utf-8")
        (rdir / "snapshot.json").write_text(
            json.dumps({"dataset": ds["name"], "fingerprint": ds["fingerprint"],
                        "target": target, "factors": factors, "params": params,
                        "elapsed_s": elapsed, "at": time.strftime("%Y-%m-%d %H:%M:%S"),
                        "core": "analysis-core 0.1"}, ensure_ascii=False, indent=2),
            encoding="utf-8")
        RUNS[rid] = {"params": params, "at": time.time()}

        res["run_id"] = rid
        res["elapsed_s"] = elapsed
        res["report_md"] = md
        res["snapshot"] = json.loads((rdir / "snapshot.json").read_text(encoding="utf-8"))
        self._json({"ok": True, "result": res})


def _fingerpath(p: Path) -> str:
    return _fingerprint(p)


def main() -> None:
    port = int(os.environ.get("DAC_PORT", "8765"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"DAC-Next demo running at http://127.0.0.1:{port}")
    print("按 Ctrl+C 停止")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
