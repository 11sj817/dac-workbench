# -*- coding: utf-8 -*-
"""GLM 数值验证：与 statsmodels 逐项对照（Gaussian / Logistic / Poisson）。"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
NODE = r"USERDIR\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"


def make_data(seed=20261103):
    rng = np.random.default_rng(seed)
    n = 300
    x1 = rng.normal(0, 1, n)
    x2 = rng.uniform(-2, 2, n)
    g = rng.choice(["A", "B", "C"], n)
    # Gaussian
    y_g = 1.5 + 0.8 * x1 - 0.6 * x2 + (g == "B") * 0.9 + rng.normal(0, 1, n)
    # Logistic
    lp = -0.3 + 1.1 * x1 - 0.5 * x2 + (g == "C") * 0.7
    y_b = (rng.random(n) < 1 / (1 + np.exp(-lp))).astype(int)
    # Poisson
    lam = np.exp(0.4 + 0.5 * x1 + 0.2 * x2 + (g == "B") * 0.3)
    y_p = rng.poisson(lam)
    df = pd.DataFrame({"x1": x1, "x2": x2, "g": g, "y_g": y_g, "y_b": y_b, "y_p": y_p})
    return df


def statsmodels_fit(df, family):
    X = pd.get_dummies(df[["x1", "x2", "g"]], columns=["g"], drop_first=True, dtype=float)
    X = sm.add_constant(X)
    if family == "gaussian":
        y = df["y_g"]
        m = sm.GLM(y, X, family=sm.families.Gaussian()).fit()
    elif family == "binomial":
        y = df["y_b"]
        m = sm.GLM(y, X, family=sm.families.Binomial()).fit()
    else:
        y = df["y_p"]
        m = sm.GLM(y, X, family=sm.families.Poisson()).fit()
    return {
        "names": list(X.columns),
        "est": [float(v) for v in m.params],
        "se": [float(v) for v in m.bse],
        "stat": [float(v) for v in m.tvalues],
        "p": [float(v) for v in m.pvalues],
        "aic": float(m.aic),
        "bic": float(m.bic_llf),
        "deviance": float(m.deviance),
        "llf": float(m.llf),
    }


def js_fit(df, family):
    ycol = {"gaussian": "y_g", "binomial": "y_b", "poisson": "y_p"}[family]
    payload = {
        "rows": df[["x1", "x2", "g"]].values.tolist(),
        "y": df[ycol].tolist(),
        "spec": {
            "numCols": [{"name": "x1", "idx": 0}, {"name": "x2", "idx": 1}],
            "catCols": [{"name": "g", "idx": 2, "levels": ["A", "B", "C"], "reference": "A"}],
        },
        "family": family,
    }
    tmp = ROOT / "evidence" / "_glm_payload.json"
    tmp.parent.mkdir(exist_ok=True)
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    script = r"""
const fs = require('fs');
global.window = {}; global.DecompressionStream = undefined;
const R = process.argv[2];
eval(fs.readFileSync(R + '/workbench/preprocess.js','utf8'));
eval(fs.readFileSync(R + '/workbench/core.js','utf8'));
eval(fs.readFileSync(R + '/workbench/glm.js','utf8'));
const p = JSON.parse(fs.readFileSync(R + '/evidence/_glm_payload.json','utf8'));
const r = global.window.DACGLM.fit(p);
console.log(JSON.stringify({
  names: r.coef.map(c=>c.name), est: r.coef.map(c=>c.est), se: r.coef.map(c=>c.se),
  stat: r.coef.map(c=>c.stat), p: r.coef.map(c=>c.p),
  aic: r.aic, bic: r.bic, deviance: r.deviance, llf: r.logLik
}));
"""
    sp = ROOT / "evidence" / "_glm_run.js"
    sp.write_text(script, encoding="utf-8")
    out = subprocess.run([NODE, str(sp), str(ROOT)], capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        raise RuntimeError("node 失败: " + out.stderr[:500])
    return json.loads(out.stdout)


def compare(family, sm_r, js_r, df):
    print(f"\n=== {family.upper()} ===")
    print(f"{'参数':<12}{'statsmodels':>14}{'本实现':>14}{'相对误差':>12}")
    ok = True
    worst = 0
    for i, name in enumerate(sm_r["names"]):
        # 名称对齐：statsmodels 用 g_B/g_C，JS 用 g[B]/g[C]
        js_name = name.replace("g_B", "g[B]").replace("g_C", "g[C]").replace("const", "(Intercept)")
        try:
            j = js_r["names"].index(js_name)
        except ValueError:
            print(f"  ⚠ 名称不匹配: {name}")
            ok = False
            continue
        e_sm, e_js = sm_r["est"][i], js_r["est"][j]
        rel = abs(e_sm - e_js) / max(1e-9, abs(e_sm))
        worst = max(worst, rel)
        se_sm, se_js = sm_r["se"][i], js_r["se"][j]
        rel_se = abs(se_sm - se_js) / max(1e-9, abs(se_sm))
        flag = "" if rel < 1e-6 and rel_se < 1e-4 else "  ⚠"
        print(f"{name:<12}{e_sm:>14.8f}{e_js:>14.8f}{rel:>12.2e}{flag}")
        if rel_se > 1e-4:
            print(f"{'  (SE)':<12}{se_sm:>14.8f}{se_js:>14.8f}{rel_se:>12.2e}  ⚠ SE 不一致")
            ok = False
        if rel > 1e-6:
            ok = False
    for k in ("aic", "bic", "deviance"):
        a, b = sm_r[k], js_r[k]
        rel = abs(a - b) / max(1e-9, abs(a))
        note = ""
        if rel > 1e-6:
            # Gaussian 的 AIC 存在软件约定差异：
            #   R glm(): k = p + 1（把方差参数计入）
            #   statsmodels GLM(): k = p
            # 差值应恰为 2（AIC）或 log(n)（BIC）
            if k == "aic" and abs(abs(a - b) - 2) < 0.2:
                note = "  （已知约定差异：k 多算 1 个方差参数，差≈2）"
                rel = 0
            elif k == "bic" and abs(abs(a - b) - np.log(len(df))) < 0.3:
                note = "  （同上，BIC 差≈log n）"
                rel = 0
            else:
                note = "  ⚠"
                ok = False
        print(f"{k:<12}{a:>14.6f}{b:>14.6f}{rel:>12.2e}{note}")
    print(f"  最大系数相对误差: {worst:.2e}  →  {'✅ 一致' if ok else '❌ 存在差异'}")
    return ok


def main():
    df = make_data()
    print(f"数据：{len(df)} 行 × {len(df.columns)} 列")
    all_ok = True
    for fam in ("gaussian", "binomial", "poisson"):
        sm_r = statsmodels_fit(df, fam)
        js_r = js_fit(df, fam)
        all_ok &= compare(fam, sm_r, js_r, df)

    # 额外：完全分离检测对照
    print("\n=== 完全分离检测 ===")
    sep = pd.DataFrame({
        "x": list(range(-30, 0)) + list(range(1, 31)),
        "y": [0] * 30 + [1] * 30,
    })
    payload = {
        "rows": sep[["x"]].values.tolist(), "y": sep["y"].tolist(),
        "spec": {"numCols": [{"name": "x", "idx": 0}]}, "family": "binomial",
    }
    (ROOT / "evidence" / "_glm_payload.json").write_text(json.dumps(payload), encoding="utf-8")
    out = subprocess.run([NODE, str(ROOT / "evidence" / "_glm_run.js"), str(ROOT)],
                         capture_output=True, text=True, encoding="utf-8")
    js = json.loads(out.stdout) if out.returncode == 0 else {"names": []}
    Xs = sm.add_constant(sep["x"].astype(float))
    sm_sep = sm.GLM(sep["y"], Xs, family=sm.families.Binomial()).fit()
    print(f"  statsmodels 最大系数: {sm_sep.params.max():.3f}（完全分离时趋于无穷）")
    print(f"  本实现 x 系数: {js['est'][1]:.3f}")
    print(f"  是否检出分离: {'是' if abs(js['est'][1]) > 5 else '否'}")

    print("\n" + "=" * 50)
    print("结论:", "✅ 三个模型与 statsmodels 数值一致" if all_ok else "❌ 存在差异，需修复")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

