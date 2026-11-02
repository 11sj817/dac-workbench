# -*- coding: utf-8 -*-
"""把三份公开/合成数据整理成工作台可直接加载的 JSON，输出 data/samples.js。"""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import pandas as pd

ROOT = Path(r"PROJDIR\dac-reverse-research")
PUB = ROOT / "data" / "public"
OUT = ROOT / "data" / "samples.js"
N = 400

WINE_MAP = {
    "fixed acidity": "固定酸度", "volatile acidity": "挥发酸度", "citric acid": "柠檬酸",
    "residual sugar": "残糖", "chlorides": "氯化物", "free sulfur dioxide": "游离二氧化硫",
    "total sulfur dioxide": "总二氧化硫", "density": "密度", "pH": "pH值",
    "sulphates": "硫酸盐", "alcohol": "酒精度", "quality": "质量评分",
}

STU_MAP = {
    "age": "年龄", "Medu": "母亲学历", "Fedu": "父亲学历", "studytime": "学习时间",
    "failures": "挂科次数", "absences": "缺勤次数", "goout": "外出频率",
    "health": "健康状况", "G1": "第一次成绩", "G2": "第二次成绩", "G3": "最终成绩",
}

BIN_MAP = {"sex": ("性别", {"M": 1, "F": 0}), "address": ("住址类型", {"U": 1, "R": 0}),
           "schoolsup": ("学校支持", {"yes": 1, "no": 0}), "famsup": ("家庭支持", {"yes": 1, "no": 0}),
           "internet": ("家里网络", {"yes": 1, "no": 0})}


def pack(name: str, desc: str, source: str, df: pd.DataFrame) -> dict:
    cols = [str(c) for c in df.columns]
    rows = []
    for _, r in df.iterrows():
        rows.append([None if pd.isna(v) else (round(float(v), 4) if isinstance(v, (int, float)) else v) for v in r.tolist()])
    return {"name": name, "desc": desc, "source": source, "columns": cols, "rows": rows}


def main() -> None:
    out: dict[str, dict] = {}

    # 1) 红酒质量
    wine = pd.read_csv(PUB / "winequality-red.csv", sep=";").rename(columns=WINE_MAP)
    wine = wine.sample(n=N, random_state=20261102).reset_index(drop=True)
    out["wine"] = pack(
        "红酒质量（UCI Wine Quality，抽样 400）",
        "11 项理化指标 → 感官质量评分，经典分类基准数据",
        "UCI ML Repository · Cortez et al. 2009",
        wine,
    )

    # 2) 学生成绩
    z = zipfile.ZipFile(PUB / "student.zip")
    stu = pd.read_csv(io.BytesIO(z.read("student-por.csv")), sep=";")
    keep = {}
    for src, dst in STU_MAP.items():
        if src in stu.columns:
            keep[dst] = stu[src]
    for src, (dst, mapping) in BIN_MAP.items():
        if src in stu.columns:
            keep[dst] = stu[src].map(mapping)
    sdf = pd.DataFrame(keep)
    sdf = sdf.astype(float).sample(n=min(N, len(sdf)), random_state=20261102).reset_index(drop=True)
    out["student"] = pack(
        "学生成绩（UCI Student Performance，抽样 400）",
        "家庭背景 + 学习行为 → 最终成绩 G3，教育评价场景",
        "UCI ML Repository · Cortez & Silva 2008",
        sdf,
    )

    # 3) 企业数据（原有合成数据）
    ent = pd.read_csv(ROOT / "data" / "enterprise_1000.csv", encoding="utf-8-sig")
    ent = ent.sample(n=N, random_state=20261102).reset_index(drop=True)
    out["enterprise"] = pack(
        "企业创新绩效（合成数据，抽样 400）",
        "规模/研发/融资约束/专利 → 创新绩效，含真实交互项",
        "DAC 研究项目自制（完全虚构）",
        ent,
    )

    OUT.write_text("window.__DATASETS__ = " + json.dumps(out, ensure_ascii=False) + ";\n", encoding="utf-8")
    print("wrote", OUT, f"{OUT.stat().st_size/1024:.0f} KB")
    for k, v in out.items():
        print(f"  {k}: {len(v['rows'])} rows x {len(v['columns'])} cols -> {v['name']}")


if __name__ == "__main__":
    main()
