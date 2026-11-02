# -*- coding: utf-8 -*-
"""扩展示例数据集：Iris / Abalone / Auto-MPG / WDBC（全部 UCI 公开数据）。"""
from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

ROOT = Path(r"PROJDIR\dac-reverse-research")
PUB = ROOT / "data" / "public"
OUT = ROOT / "data" / "samples.js"
N = 300


def pack(name, desc, source, df):
    cols = [str(c) for c in df.columns]
    rows = []
    for _, r in df.iterrows():
        vals = []
        for v in r.tolist():
            if pd.isna(v):
                vals.append(None)
            elif isinstance(v, (int, float)):
                vals.append(round(float(v), 4))
            else:
                vals.append(str(v))
        rows.append(vals)
    return {"name": name, "desc": desc, "source": source, "columns": cols, "rows": rows}


def main():
    out = {}

    # ---- 1. Iris ----
    iris = pd.read_csv(PUB / "iris.data", header=None,
                       names=["sl", "sw", "pl", "pw", "species"])
    iris = iris.dropna()
    iris["species"] = iris["species"].map({
        "Iris-setosa": 0, "Iris-versicolor": 1, "Iris-virginica": 2})
    iris = iris.dropna().rename(columns={
        "sl": "萼片长", "sw": "萼片宽", "pl": "花瓣长", "pw": "花瓣宽",
        "species": "品种编码"})
    out["iris"] = pack(
        "鸢尾花（UCI Iris，150 条）",
        "4 个花部尺寸 → 品种编码（0 山鸢尾 / 1 变色鸢尾 / 2 维吉尼亚鸢尾）",
        "UCI ML Repository · Fisher 1936", iris)

    # ---- 2. Abalone ----
    ab = pd.read_csv(PUB / "abalone.data", header=None,
                     names=["sex", "length", "diameter", "height", "whole", "shucked",
                            "viscera", "shell", "rings"])
    ab["sex"] = ab["sex"].map({"M": 0, "F": 1, "I": 2})
    ab = ab.sample(n=min(N, len(ab)), random_state=20261102).reset_index(drop=True)
    ab = ab.rename(columns={
        "sex": "性别编码", "length": "长度", "diameter": "直径", "height": "高度",
        "whole": "整重", "shucked": "去壳重", "viscera": "内脏重",
        "shell": "壳重", "rings": "环数(年龄)"})
    out["abalone"] = pack(
        f"鲍鱼年龄（UCI Abalone，抽样 {len(ab)}）",
        "8 项物理测量 → 环数（环数越大越老）",
        "UCI ML Repository · Nash et al. 1994", ab)

    # ---- 3. Auto MPG ----
    cols = ["mpg", "cylinders", "displacement", "horsepower", "weight",
            "acceleration", "model_year", "origin", "car_name"]
    mpg = pd.read_csv(PUB / "auto-mpg.data", header=None, names=cols,
                      sep=r"\s+", na_values=["?"])
    mpg = mpg.drop(columns=["car_name"])
    mpg = mpg.sample(n=min(N, len(mpg)), random_state=20261102).reset_index(drop=True)
    mpg = mpg.rename(columns={
        "mpg": "油耗(mpg)", "cylinders": "气缸数", "displacement": "排量",
        "horsepower": "马力", "weight": "车重", "acceleration": "加速性能",
        "model_year": "车型年份", "origin": "产地编码"})
    out["autompg"] = pack(
        f"汽车油耗（UCI Auto-MPG，抽样 {len(mpg)}）",
        "车辆参数 → 油耗，含 6 个缺失值（马力列）",
        "UCI ML Repository · Quinlan 1993", mpg)

    # ---- 4. WDBC 乳腺癌 ----
    w = pd.read_csv(PUB / "wdbc.data", header=None)
    w.columns = ["ID", "诊断"] + [f"特征{i}" for i in range(1, w.shape[1] - 1)]
    w["诊断"] = w["诊断"].map({"M": 1, "B": 0})
    # 取前 10 个特征 + 诊断，保留 ID 列用于演示"ID 角色"
    keep = ["ID", "诊断"] + [f"特征{i}" for i in range(1, 11)]
    w = w[keep].sample(n=min(N, len(w)), random_state=20261102).reset_index(drop=True)
    w = w.rename(columns={"诊断": "恶性编码(1=恶性)"})
    out["wdbc"] = pack(
        f"乳腺细胞诊断（UCI WDBC，抽样 {len(w)}）",
        "10 项细胞核特征 → 恶性/良性；ID 列可用于演示「ID 角色不参与计算」",
        "UCI ML Repository · Street et al. 1993", w)

    # ---- 合并原有三份 ----
    old = json.loads((OUT.read_text(encoding="utf-8").split("=", 1)[1]).strip().rstrip(";"))
    for k in ("wine", "student", "enterprise"):
        if k in old:
            out[k] = old[k]

    OUT.write_text("window.__DATASETS__ = " + json.dumps(out, ensure_ascii=False) + ";\n",
                   encoding="utf-8")
    print(f"wrote {OUT}  {OUT.stat().st_size/1024:.0f} KB")
    for k, v in out.items():
        print(f"  {k:12s} {len(v['rows']):5d} 行 × {len(v['columns']):2d} 列  {v['name']}")


if __name__ == "__main__":
    main()
