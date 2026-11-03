"""Verify every shipped sample against UCI files, preserving duplicates and order.

Network is used only by an explicit invocation. No input rows are rewritten.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import csv
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "data/samples.js"
SOURCES = {
    "iris": (53, "iris", "iris.data"),
    "abalone": (1, "abalone", "abalone.data"),
    "autompg": (9, "auto+mpg", "auto-mpg.data"),
    "wdbc": (17, "breast+cancer+wisconsin+diagnostic", "wdbc.data"),
    "wine": (186, "wine+quality", "winequality-red.csv"),
    "student": (320, "student+performance", "student-por.csv"),
}


def canonical(rows):
    return json.dumps(rows, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_catalog():
    return json.loads(CATALOG.read_text(encoding="utf-8").split("=", 1)[1].strip().rstrip(";"))


def member(blob, filename):
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for name in z.namelist():
            if Path(name).name == filename:
                return z.read(name)
        for name in z.namelist():
            if name.endswith(".zip"):
                try:
                    return member(z.read(name), filename)
                except KeyError:
                    pass
    raise KeyError(filename)


def transform(key, raw):
    text = raw.decode("utf-8-sig")
    if key == "autompg":
        import shlex
        return [[None if v == "?" else float(v) for v in shlex.split(line)[:8]]
                for line in text.splitlines() if line.strip()]
    if key in ("wine", "student"):
        source = list(csv.DictReader(io.StringIO(text), delimiter=";"))
        if key == "wine":
            return [[float(v) for v in row.values()] for row in source]
        names = ["age", "Medu", "Fedu", "studytime", "failures", "absences",
                 "goout", "health", "G1", "G2", "G3"]
        mappings = [("sex", {"M": 1, "F": 0}), ("address", {"U": 1, "R": 0}),
                    ("schoolsup", {"yes": 1, "no": 0}), ("famsup", {"yes": 1, "no": 0}),
                    ("internet", {"yes": 1, "no": 0})]
        return [[float(row[n]) for n in names] + [mp[row[n]] for n, mp in mappings]
                for row in source]
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    if key == "iris":
        codes = {"Iris-setosa": 0, "Iris-versicolor": 1, "Iris-virginica": 2}
        return [[*map(float, r[:4]), codes[r[4]]] for r in rows]
    if key == "abalone":
        return [[{"M": 0, "F": 1, "I": 2}[r[0]], *map(float, r[1:])] for r in rows]
    if key == "wdbc":
        return [[float(r[0]), {"M": 1, "B": 0}[r[1]], *map(float, r[2:12])] for r in rows]
    raise ValueError(key)


def row_key(row):
    # Original packers rounded to four decimals; int/float encodings are equivalent.
    return tuple(None if v is None else round(float(v), 4) for v in row)


def verify_rows(sample, original):
    available = defaultdict(list)
    for i, row in enumerate(original, 1):
        available[row_key(row)].append(i)
    positions = []
    for i, row in enumerate(sample, 1):
        matches = available[row_key(row)]
        if not matches:
            raise ValueError(f"Sample row {i} has no unused matching source row")
        positions.append(matches.pop(0))
    return positions


def audit(cache):
    catalog = read_catalog()
    verified_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    records = {}
    for key, (source_id, slug, filename) in SOURCES.items():
        url = f"https://archive.ics.uci.edu/static/public/{source_id}/{slug}.zip"
        saved = cache / f"uci-{source_id}.zip"
        if not saved.exists():
            request = urllib.request.Request(url, headers={"User-Agent": "DAC-data-verification/6.6"})
            with urllib.request.urlopen(request, timeout=45) as response:
                blob = response.read(8 * 1024 * 1024 + 1)
            if len(blob) > 8 * 1024 * 1024:
                raise ValueError("Unexpected source archive size")
            saved.write_bytes(blob)
        archive = saved.read_bytes()
        raw = member(archive, filename)
        original = transform(key, raw)
        sample = catalog[key]
        indices = verify_rows(sample["rows"], original)
        records[key] = {
            "kind": "public", "status": "matched", "checkedAt": verified_at,
            "sourceUrl": f"https://archive.ics.uci.edu/dataset/{source_id}/{slug}",
            "downloadUrl": url, "sourceFile": filename,
            "archiveSha256": digest(archive), "sourceFileSha256": digest(raw),
            "sampleSha256": digest(canonical(sample["rows"]).encode()),
            "columnsSha256": digest(canonical(sample["columns"]).encode()),
            "matchedRows": len(indices), "sourceRows": len(original),
            "sourceRowNumbers": indices, "license": "CC BY 4.0",
            "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
            "comparison": "每行每列与官方文件核对；类别编码及中文列名转换；数值按现有打包逻辑保留四位小数。匹配考虑重复行数量。",
            "sampling": "固定随机种子 20261102 的演示子集" if key != "iris" else "完整 150 行",
            "limitations": "匹配官方文件证明数据来源与转换一致，不证明原研究没有偏差，也不证明当前模型有效。",
        }
        print(f"PASS {key}: {len(indices)}/{len(sample['rows'])} rows match {filename}", flush=True)
    records["student_g1g2"] = dict(records["student"])
    if catalog["student"]["rows"] != catalog["student_g1g2"]["rows"]:
        raise ValueError("Student variants differ unexpectedly")
    enterprise = catalog["enterprise"]
    original = list(csv.DictReader((ROOT / "data/enterprise_1000.csv").open(encoding="utf-8-sig")))
    positions = verify_rows(enterprise["rows"], [[float(v) for v in r.values()] for r in original])
    records["enterprise"] = {
        "kind": "synthetic", "status": "synthetic", "checkedAt": verified_at,
        "sourceUrl": None, "sourceFile": "data/enterprise_1000.csv",
        "sourceFileSha256": digest((ROOT / "data/enterprise_1000.csv").read_bytes()),
        "sampleSha256": digest(canonical(enterprise["rows"]).encode()),
        "columnsSha256": digest(canonical(enterprise["columns"]).encode()),
        "matchedRows": len(positions), "sourceRows": len(original),
        "sourceRowNumbers": positions,
        "generator": "data/gen_enterprise_data.py",
        "comparison": "仅核对项目内合成母表，不是外部真实观测。",
        "sampling": "固定随机种子 20261102，400/1000 行",
        "limitations": "完全虚构，仅用于交互和方法演示；交互项由生成规则设定，不可视为真实企业证据。",
    }
    return catalog, {"schemaVersion": 1, "checkedAt": verified_at, "datasets": records}


def apply_metadata(catalog, evidence):
    for key, d in catalog.items():
        d["provenance"] = evidence["datasets"][key]
        if key != "enterprise":
            d["license"] = "CC BY 4.0（UCI ML Repository；使用时保留署名与来源）"
    catalog["enterprise"]["desc"] = "规模/研发/融资约束/专利 → 创新绩效，含人工设定的交互项"
    catalog["abalone"]["units"] = {
        col: "源文件刻度（未反缩放）" for col in ["长度", "直径", "高度", "整重", "去壳重", "内脏重", "壳重"]
    } | {"环数(年龄)": "环数；估计年龄通常为环数 + 1.5 年"}
    catalog["abalone"]["note"] = (
        "环数是计数目标；估计年龄通常为环数 + 1.5 年。连续测量保留源文件刻度，"
        "未执行反缩放，不能直接标作实际 mm 或 g。是否用 Poisson 需检查过度离散。"
    )
    mpg = catalog["autompg"]
    missing = sum(r[3] is None for r in mpg["rows"])
    mpg["desc"] = f"车辆参数 → 燃油经济性（mpg 越高越省油）；当前子集马力缺失 {missing} 项"
    mpg["units"]["加速性能"] = "秒（0–60 mph）"
    mpg["units"].pop("加速", None)
    catalog["wine"]["units"]["pH值"] = "无量纲"
    catalog["wine"]["units"].pop("pH", None)
    wdbc = catalog["wdbc"]
    wdbc["units"] = {k: "源文件图像测量刻度；未确认物理单位" for k in ["半径均值", "周长均值", "面积均值"]}
    wdbc["units"]["纹理均值"] = "灰度值标准差"
    wdbc["columnDesc"]["平滑度均值"] = "半径长度的局部变化；源定义未给出此处可验证的闭式公式"
    wdbc["columnDesc"]["紧凑度均值"] = "周长²/面积 − 1.0（UCI 数据说明定义）"
    CATALOG.write_text("window.__DATASETS__ = " + json.dumps(catalog, ensure_ascii=False, separators=(",", ":")) + ";\n",
                       encoding="utf-8", newline="\n")


def check_catalog():
    catalog = read_catalog()
    evidence = json.loads((ROOT / "evidence/data-provenance.json").read_text(encoding="utf-8"))
    for key, d in catalog.items():
        p = d["provenance"]
        if p != evidence["datasets"][key]:
            raise ValueError(f"{key}: metadata does not match evidence")
        if p["sampleSha256"] != digest(canonical(d["rows"]).encode()):
            raise ValueError(f"{key}: rows changed since source verification")
        if p["columnsSha256"] != digest(canonical(d["columns"]).encode()):
            raise ValueError(f"{key}: columns changed since source verification")
        if p["matchedRows"] != len(d["rows"]):
            raise ValueError(f"{key}: verification incomplete")
        print(f"PASS {key}: catalog hash and evidence consistent")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--write", action="store_true", help="Attach evidence without changing sample rows")
    parser.add_argument("--check", action="store_true", help="Offline check of packaged hashes and evidence")
    args = parser.parse_args()
    if args.check:
        check_catalog()
    else:
        if not args.cache:
            parser.error("--cache is required for explicit official-source downloads")
        args.cache.mkdir(parents=True, exist_ok=True)
        data, result = audit(args.cache)
        if args.write:
            apply_metadata(data, result)
            (ROOT / "evidence/data-provenance.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            check_catalog()
