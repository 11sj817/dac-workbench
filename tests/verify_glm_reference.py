"""Reference GLM verification: six families, unweighted and frequency weighted.

Install: python -m pip install numpy scipy statsmodels
Node is resolved from DAC_NODE or PATH. Data is seeded and synthetic.
Information criteria use statsmodels GLM conventions (scale excluded).
Negative-binomial theta is fixed at 2.5; no tests are skipped or exempted.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import warnings
import numpy as np
import scipy
import statsmodels
import statsmodels.api as sm
from scipy.stats import t as student_t

ROOT=Path(__file__).resolve().parent.parent
NODE=os.environ.get("DAC_NODE") or shutil.which("node")
if not NODE: raise SystemExit("tool_missing:node; set DAC_NODE or install Node.js")
rng=np.random.default_rng(20261103)
rows=rng.normal(0,.6,(80,2)); design=sm.add_constant(rows)
frequency=np.arange(80)%5
eta=.25+.3*rows[:,0]-.15*rows[:,1]
families=[
 ("gaussian",sm.families.Gaussian(),design@[.7,.4,-.2]+rng.normal(0,.5,80)),
 ("binomial",sm.families.Binomial(),rng.binomial(1,1/(1+np.exp(-eta)))),
 ("poisson",sm.families.Poisson(),rng.poisson(np.exp(eta))),
 ("gamma",sm.families.Gamma(sm.families.links.Log()),rng.gamma(12,np.exp(eta)/12)),
 ("gamma-inverse",sm.families.Gamma(sm.families.links.InversePower()),rng.gamma(12,1/(1.2+.08*rows[:,0]-.06*rows[:,1])/12)),
 ("negbin",sm.families.NegativeBinomial(alpha=1/2.5),rng.negative_binomial(2.5,2.5/(2.5+np.exp(eta))))
]
results=[]; failures=[]
def check(name,actual,expected,atol,rtol=0):
 actual,expected=np.asarray(actual,dtype=float),np.asarray(expected,dtype=float)
 ok=actual.shape==expected.shape and bool(np.all(np.isfinite(actual))) and bool(np.allclose(actual,expected,atol=atol,rtol=rtol))
 error=float(np.max(np.abs(actual-expected))) if actual.shape==expected.shape else None
 item=dict(item=name,ok=ok,max_abs_error=error,atol=atol,rtol=rtol)
 results.append(item)
 if not ok: failures.append(item)

for family,distribution,y in families:
 for weighted in (False,True):
  label=family+(".frequency" if weighted else ".unweighted")
  weights=frequency if weighted else np.ones(len(y))
  payload=dict(rows=rows.tolist(),y=y.tolist(),family=family,
   spec={"numCols":[{"name":"x1","idx":0},{"name":"x2","idx":1}]},maxIter=200,tol=1e-11)
  if weighted: payload["weights"]=weights.tolist()
  if family=="negbin": payload["theta"]=2.5
  run=subprocess.run([NODE,str(ROOT/"tests/glm_runner.cjs")],input=json.dumps(payload),capture_output=True,text=True,timeout=30,cwd=ROOT)
  got=json.loads(run.stdout)
  if not got.get("ok"):
   failures.append({"item":label,"error":got.get("error")}); print("FAIL",label,got.get("error")); continue
  actual=got["result"]
  with warnings.catch_warnings():
   warnings.simplefilter("ignore")
   reference=sm.GLM(y,design,family=distribution,freq_weights=weights).fit(maxiter=200,tol=1e-12,use_t=family=="gaussian")
  check(label+".converged",float(actual["converged"]),float(reference.converged),0)
  for field,expected in [("est",reference.params),("se",reference.bse),("stat",reference.tvalues),
    ("p",reference.pvalues),("lo",reference.conf_int()[:,0]),("hi",reference.conf_int()[:,1])]:
   check(label+"."+field,[c[field] for c in actual["coef"]],expected,2e-7,2e-6)
  for field,expected in [("deviance",reference.deviance),("pearson",reference.pearson_chi2),
    ("dfResid",reference.df_resid),("logLik",reference.llf),("aic",reference.aic),
    ("bic",reference.bic_llf),("dispersion",reference.pearson_chi2/reference.df_resid)]:
   check(label+"."+field,actual[field],expected,1e-5,1e-8)
  print(("PASS" if not any(f["item"].startswith(label+".") for f in failures) else "FAIL"),label)

# Small-sample regression constructs t=2.2 with eight residual degrees of freedom.
n=10; x=np.arange(n,dtype=float)-(n-1)/2
z=np.sin(np.arange(n)); z-=z.mean(); z-=x*np.dot(x,z)/np.dot(x,x)
noise=z/np.sqrt(np.dot(z,z))*np.sqrt((n-2)*np.dot(x,x)/2.2**2)
y=1+x+noise
run=subprocess.run([NODE,str(ROOT/"tests/glm_runner.cjs")],input=json.dumps({
 "rows":x[:,None].tolist(),"y":y.tolist(),"family":"gaussian","spec":{"numCols":[{"name":"x","idx":0}]}
}),capture_output=True,text=True,timeout=30)
actual=json.loads(run.stdout)["result"]["coef"][1]
check("small-n.stat",actual["stat"],2.2,1e-10)
check("small-n.p",actual["p"],2*student_t.sf(2.2,8),1e-11)
check("small-n.CI-contains-zero",float(actual["lo"]<0<actual["hi"]),1.,0)
report={"reference":{"numpy":np.__version__,"scipy":scipy.__version__,"statsmodels":statsmodels.__version__},
 "checks":len(results),"failures":failures,"results":results,"known_exemptions":[],"skipped_families":[]}
if "--output" in sys.argv:
 target=Path(sys.argv[sys.argv.index("--output")+1]); target.parent.mkdir(parents=True,exist_ok=True)
 target.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding="utf-8")
print(f'{len(results)-len(failures)}/{len(results)} checks passed; {len(failures)} failures; no exemptions')
for failure in failures: print(json.dumps(failure,ensure_ascii=False))
raise SystemExit(1 if failures else 0)
