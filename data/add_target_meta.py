# -*- coding: utf-8 -*-
"""V3.3 P0：为 7 份内置数据补目标语义元数据，修复"默认目标是最后一列"导致的错位。"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLES = ROOT / "data" / "samples.js"

META = {
    "iris": {
        "recommendedTarget": "品种编码",
        "targetType": "nominal",
        "note": "品种是无序三分类（0 山鸢尾 / 1 变色鸢尾 / 2 维吉尼亚鸢尾），不要解释成低/中/高。",
        "task": "三分类判别"
    },
    "abalone": {
        "recommendedTarget": "环数(年龄)",
        "targetType": "count",
        "note": "环数是计数语义候选，是否用 Poisson 需先看过度离散诊断。",
        "task": "计数回归"
    },
    "autompg": {
        "recommendedTarget": "油耗(mpg)",
        "targetType": "continuous",
        "note": "油耗是连续目标；「产地编码」应作为类别特征，不能当目标。",
        "task": "连续回归",
        "roleHints": {"产地编码": "cat", "车型年份": "cat"}
    },
    "wdbc": {
        "recommendedTarget": "恶性编码(1=恶性)",
        "targetType": "binary",
        "positiveClass": 1,
        "exclude": ["ID"],
        "note": "二分类诊断任务（1=恶性）；ID 列不参与任何计算。",
        "task": "二分类判别",
        "roleHints": {"ID": "id"}
    },
    "wine": {
        "recommendedTarget": "质量评分",
        "targetType": "ordinal",
        "note": "质量评分是有序等级（3~8），可直接做有序分析；是否压成 DAC 三等级需用户明确选择。",
        "task": "有序回归"
    },
    "student": {
        "recommendedTarget": "最终成绩",
        "targetType": "continuous",
        "note": "推荐目标为「最终成绩」。G1/G2（第一/第二次成绩）能否作为预测变量取决于预测时点："
                "若目标是学期初预测，G1/G2 尚未发生，必须排除。",
        "task": "连续回归",
        "caveatPredictors": ["第一次成绩", "第二次成绩"]
    },
    "enterprise": {
        "recommendedTarget": "创新绩效",
        "targetType": "continuous",
        "note": "合成数据，用于演示；不代表任何真实企业。",
        "task": "连续回归"
    }
}

src = SAMPLES.read_text(encoding="utf-8")
data = json.loads(src.split("=", 1)[1].strip().rstrip(";"))

for key, meta in META.items():
    if key not in data:
        print("跳过（数据缺失）:", key)
        continue
    d = data[key]
    d.update(meta)
    # 校验推荐目标确实存在
    if meta["recommendedTarget"] not in d["columns"]:
        raise SystemExit(f"{key} 的 recommendedTarget 不在列里: {meta['recommendedTarget']}")

SAMPLES.write_text("window.__DATASETS__ = " + json.dumps(data, ensure_ascii=False) + ";\n", encoding="utf-8")
print(f"已写入元数据 -> {SAMPLES.name}  {SAMPLES.stat().st_size/1024:.0f} KB")
for k, v in data.items():
    print(f"  {k:12s} target={v.get('recommendedTarget','(未设)'):14s} type={v.get('targetType','-'):10s} task={v.get('task','-')}")
