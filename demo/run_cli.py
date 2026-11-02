"""命令行跑通 analysis-core，产出 report.md / result.json。"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pandas as pd  # noqa: E402

import analysis_core as core  # noqa: E402


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    src = root / "data" / "enterprise_1000.csv"
    df = core.load_table(str(src))
    target = df.columns[-1]
    factors = [c for c in df.columns if c != target]

    t0 = time.time()
    res = core.run_pipeline(
        df, target=target, factors=factors,
        low_pct=25, high_pct=75, drops=500, levels=3,
        k=3, tree_depth=3, net_threshold=0.2, seed=42,
    )
    dt = time.time() - t0

    out_md = root / "data" / "report_enterprise.md"
    out_json = root / "data" / "result_enterprise.json"
    md = core.to_markdown(res)
    out_md.write_text(md, encoding="utf-8")

    slim = json.loads(json.dumps(res, ensure_ascii=False, default=str))
    out_json.write_text(json.dumps(slim, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"elapsed: {dt:.2f}s")
    print("target:", target, "| factors:", factors)
    print("silhouette:", res["scenarios"]["silhouette"], "| tree acc:", res["tree"]["accuracy"],
          "| cv:", res["tree"]["cv"]["mean"], "+-", res["tree"]["cv"]["std"])
    print("importances:", res["tree"]["importances"])
    print("rules:", len(res["tree"]["rules"]), "| edges:", len(res["network"]["edges"]))
    print("report:", out_md)
    print("json  :", out_json)
    print("--- head of report ---")
    print("\n".join(md.splitlines()[:18]))


if __name__ == "__main__":
    main()
