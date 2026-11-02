import json, subprocess, sys
from pathlib import Path
import numpy as np, pandas as pd, statsmodels.api as sm

ROOT = Path(__file__).resolve().parent.parent
NODE = r"USERDIR\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

rng = np.random.default_rng(20261105)
n = 400
x1 = rng.normal(0, 1, n); x2 = rng.uniform(-1.5, 1.5, n)
mu_g = np.exp(0.8 + 0.4*x1 - 0.25*x2)
y_g = rng.gamma(shape=4.0, scale=mu_g/4.0)
mu_nb = np.exp(0.6 + 0.35*x1 + 0.15*x2)
# NB: lambda ~ Gamma(shape=theta, scale=mu/theta)
theta_true = 2.5
lam = rng.gamma(shape=theta_true, scale=mu_nb/theta_true)
y_nb = rng.poisson(lam)
df = pd.DataFrame({"x1": x1, "x2": x2, "y_g": y_g, "y_nb": y_nb})

def sm_fit(family, ycol):
    X = sm.add_constant(df[["x1","x2"]].astype(float))
    y = df[ycol]
    if family == "gamma":
        m = sm.GLM(y, X, family=sm.families.Gamma(sm.families.links.Log())).fit()
    else:
        # 用同一 theta 固定，比较系数
        m = sm.GLM(y, X, family=sm.families.NegativeBinomial(alpha=1.0/theta_true)).fit()
    return {"est":[float(v) for v in m.params], "se":[float(v) for v in m.bse],
            "deviance":float(m.deviance), "aic":float(m.aic)}

def js_fit(family, ycol, theta=None):
    payload = {"rows": df[["x1","x2"]].values.tolist(), "y": df[ycol].tolist(),
               "spec":{"numCols":[{"name":"x1","idx":0},{"name":"x2","idx":1}]}, "family":family}
    if theta: payload["theta"] = theta
    (ROOT/"evidence").mkdir(exist_ok=True)
    (ROOT/"evidence/_p.json").write_text(json.dumps(payload), encoding="utf-8")
    js = r"""
const fs=require('fs');global.window={};global.DecompressionStream=undefined;
const R=process.argv[2];
eval(fs.readFileSync(R+'/workbench/preprocess.js','utf8'));
eval(fs.readFileSync(R+'/workbench/core.js','utf8'));
eval(fs.readFileSync(R+'/workbench/glm.js','utf8'));
const p=JSON.parse(fs.readFileSync(R+'/evidence/_p.json','utf8'));
const r=global.window.DACGLM.fit(p);
console.log(JSON.stringify({est:r.coef.map(c=>c.est),se:r.coef.map(c=>c.se),deviance:r.deviance,aic:r.aic,theta:r.theta}));
"""
    (ROOT/"evidence/_r.js").write_text(js, encoding="utf-8")
    out = subprocess.run([NODE, str(ROOT/"evidence/_r.js"), str(ROOT)],
                         capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0: raise RuntimeError(out.stderr[:400])
    return json.loads(out.stdout)

print("数据：", n, "行")
for fam, ycol, theta in [("gamma","y_g",None), ("negbin","y_nb",theta_true)]:
    print(f"\n=== {fam.upper()} ===")
    a = sm_fit(fam, ycol); b = js_fit(fam, ycol, theta)
    names = ["const","x1","x2"]
    worst = 0
    for i,nm in enumerate(names):
        rel = abs(a["est"][i]-b["est"][i])/max(1e-9,abs(a["est"][i]))
        worst = max(worst, rel)
        print(f"{nm:<8} sm={a['est'][i]:>12.8f} js={b['est'][i]:>12.8f} rel={rel:.2e}")
    print(f"deviance sm={a['deviance']:.4f} js={b['deviance']:.4f}")
    print(f"最大系数相对误差 {worst:.2e} -> {'✅' if worst<1e-4 else '❌'}")
    if fam=="negbin": print(f"（θ 固定为 {theta_true}，JS 端 θ={b['theta']:.3f}）")


