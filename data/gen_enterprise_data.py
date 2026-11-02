"""生成完全虚构的企业样本数据（不含任何真实企业或个人信息）。

用途：DAC 逆向研究项目的本地测试数据。
结构对齐 DAC 的输入约定：前 n-1 列为条件变量（自变量），最后一列为决策变量（因变量）。
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

RNG = np.random.default_rng(20261102)
N = 1000


def z(x: np.ndarray) -> np.ndarray:
    return (x - x.mean()) / (x.std(ddof=0) + 1e-9)


def main() -> None:
    # 企业规模（人）：对数正态，中位约 250 人
    size = np.exp(RNG.normal(5.5, 1.1, N)).clip(20, 20000)
    emp = np.maximum(5, np.round(size * np.exp(RNG.normal(0, 0.12, N)))).astype(int)

    # 研发投入强度：规模越大越愿意投入，并带个体差异
    log_size = np.log(size)
    rd_ratio = np.clip(
        0.018 + 0.085 / (1 + np.exp(-(log_size - 5.6))) + RNG.normal(0, 0.018, N),
        0.002, 0.30,
    )
    rd = np.round(size * rd_ratio, 2)  # 万元

    # 融资约束（0-100，越高越难融资）：小企业更受约束
    fin = np.clip(62 - 9.5 * (log_size - 5.5) + RNG.normal(0, 14, N), 0, 100).round(1)

    # 专利数量：受研发投入驱动，被融资约束抑制
    lam = np.maximum(0.3, (rd / 90.0) * (1 - fin / 190.0))
    patents = RNG.poisson(lam).astype(int)

    # 创新绩效：主效应 + 两个真实的交互项 + 噪声
    rd_z, pat_z, fin_z, size_z = z(rd), z(patents), z(fin), z(size)
    rd_high = (rd_z > 0.6).astype(float)
    fin_low = (fin_z < -0.3).astype(float)
    pat_high = (pat_z > 0.5).astype(float)

    perf_raw = (
        0.85 * rd_z
        + 0.55 * pat_z
        - 0.60 * fin_z
        + 0.75 * rd_high * fin_low      # 高研发 + 低融资约束 的协同
        + 0.45 * size_z * pat_high      # 规模与专利的协同
        + RNG.normal(0, 0.85, N)
    )
    perf = np.round(pd.Series(perf_raw).rank(pct=True).to_numpy(), 4)

    df = pd.DataFrame(
        {
            "企业规模": np.round(size, 0).astype(int),
            "研发投入": rd,
            "员工人数": emp,
            "融资约束": fin,
            "专利数量": patents,
            "创新绩效": perf,
        }
    )

    out_dir = Path(__file__).resolve().parent
    out_csv = str(out_dir / "enterprise_1000.csv")
    out_xlsx = str(out_dir / "enterprise_1000.xlsx")
    df.to_csv(out_csv, index=False, encoding="utf-8-sig")
    df.to_excel(out_xlsx, index=False)

    print("rows:", len(df), "cols:", list(df.columns))
    print(df.describe().round(3).to_string())
    print("saved:", out_csv)
    print("saved:", out_xlsx)


if __name__ == "__main__":
    main()
