"""analysis-core: DAC 数据分析链路的纯函数重实现。

设计目标（对应研究报告第五、六部分）：
1. 纯函数、无全局状态 —— 原系统把状态塞进进程内全局变量，多 worker 直接丢数据。
2. 参数可快照、结果可复算 —— 同一 (data, params, seed) 必须得到同一结果。
3. 只依赖 numpy + pandas —— 不引入 sklearn，便于私有化离线部署与审计。

实现的分析链路（对齐 DAC 的三段式方法论）：
    异质性特征分析  -> profile / correlation / calibrate（云模型）
    组合效应分析    -> cart + tree_rules（条件组合与规则）
    影响机制分析    -> influence_network（相关网络 + 剪枝 + 中心性）
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np
import pandas as pd

# --------------------------------------------------------------------------
# 数据载入
# --------------------------------------------------------------------------


def load_table(path: str, sheet: int | str | None = 0) -> pd.DataFrame:
    """读取 CSV / Excel。CSV 自动尝试 utf-8-sig 与 gbk。"""
    low = path.lower()
    if low.endswith((".xls", ".xlsx")):
        return pd.read_excel(path, sheet_name=sheet)
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            return pd.read_csv(path, encoding=enc)
        except UnicodeDecodeError:
            continue
    return pd.read_csv(path, encoding="utf-8", errors="replace")


# --------------------------------------------------------------------------
# 第一段：数据体检（异质性特征分析的前置）
# --------------------------------------------------------------------------


def _is_numeric(s: pd.Series) -> bool:
    return pd.api.types.is_numeric_dtype(s)


def profile(df: pd.DataFrame) -> dict[str, Any]:
    """数据体检：类型、缺失、唯一值、分布、IQR 异常值。"""
    rows: list[dict[str, Any]] = []
    for col in df.columns:
        s = df[col]
        miss = int(s.isna().sum())
        item: dict[str, Any] = {
            "name": str(col),
            "dtype": "numeric" if _is_numeric(s) else "category",
            "missing": miss,
            "missing_rate": round(miss / max(1, len(df)), 4),
            "unique": int(s.nunique(dropna=True)),
        }
        if _is_numeric(s):
            v = s.dropna().to_numpy(dtype=float)
            if v.size:
                q1, q3 = np.percentile(v, [25, 75])
                iqr = q3 - q1
                lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
                item.update(
                    {
                        "min": float(np.min(v)),
                        "p25": float(q1),
                        "median": float(np.median(v)),
                        "p75": float(q3),
                        "max": float(np.max(v)),
                        "mean": round(float(np.mean(v)), 4),
                        "std": round(float(np.std(v, ddof=0)), 4),
                        "outliers": int(((v < lo) | (v > hi)).sum()),
                        "skew": round(float(pd.Series(v).skew()), 4),
                    }
                )
        else:
            vc = s.astype(str).value_counts().head(5)
            item["top"] = [{"value": k, "count": int(c)} for k, c in vc.items()]
        rows.append(item)

    dup = int(df.duplicated().sum())
    return {
        "rows": int(len(df)),
        "cols": int(df.shape[1]),
        "duplicates": dup,
        "columns": rows,
        "warnings": _profile_warnings(rows, dup),
    }


def _profile_warnings(rows: Sequence[dict], dup: int) -> list[str]:
    warn: list[str] = []
    for r in rows:
        if r["missing_rate"] > 0:
            warn.append(f"「{r['name']}」存在 {r['missing']} 个缺失值（{r['missing_rate']:.1%}），当前版本不做插补，分析按整行剔除。")
        if r.get("outliers", 0) > 0:
            warn.append(f"「{r['name']}」检测到 {r['outliers']} 个 IQR 异常值，校准分位数可能被拉偏。")
        if r["dtype"] == "category" and r["unique"] > 50:
            warn.append(f"「{r['name']}」是文本列但唯一值达 {r['unique']} 个，疑似 ID 或自由文本。")
    if dup:
        warn.append(f"存在 {dup} 行完全重复的样本，建议先去重。")
    return warn


def numeric_frame(df: pd.DataFrame, cols: Sequence[str] | None = None) -> pd.DataFrame:
    """抽出数值列并整行剔除缺失（与原系统一致：不做插补）。"""
    use = list(cols) if cols else [c for c in df.columns if _is_numeric(df[c])]
    sub = df[use].dropna(axis=0, how="any")
    return sub.astype(float)


def correlation(df: pd.DataFrame, cols: Sequence[str] | None = None, method: str = "pearson") -> dict[str, Any]:
    sub = numeric_frame(df, cols)
    if sub.shape[1] < 2:
        return {"columns": [], "matrix": [], "note": "数值列不足 2 个，无法计算相关矩阵。"}
    m = sub.corr(method=method).round(4)
    names = [str(c) for c in m.columns]
    return {
        "columns": names,
        "matrix": m.to_numpy().tolist(),
        "pairs": _top_pairs(names, m.to_numpy(), 10),
        "note": f"{method} 相关系数；n={len(sub)}。相关不等于因果。",
    }


def _top_pairs(names: Sequence[str], mat: np.ndarray, k: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            r = float(mat[i, j])
            out.append({"a": names[i], "b": names[j], "r": round(r, 4), "abs": round(abs(r), 4)})
    out.sort(key=lambda d: d["abs"], reverse=True)
    return out[:k]


# --------------------------------------------------------------------------
# 云模型校准（正态云 + 分位数定标）
# --------------------------------------------------------------------------


@dataclass
class CloudSpec:
    """单个云的参数。"""

    ex: float
    en: float
    he: float
    label: str


@dataclass
class CalibrationResult:
    codes: np.ndarray
    membership: np.ndarray
    clouds: list[CloudSpec]
    thresholds: list[float]
    stats: dict[str, Any] = field(default_factory=dict)

    def summary(self) -> dict[str, Any]:
        counts = np.bincount(self.codes, minlength=len(self.clouds)).tolist()
        return {
            "levels": len(self.clouds),
            "counts": counts,
            "thresholds": [round(t, 4) for t in self.thresholds],
            "clouds": [
                {"label": c.label, "Ex": round(c.ex, 4), "En": round(c.en, 4), "He": round(c.he, 4)}
                for c in self.clouds
            ],
            "stats": self.stats,
        }


def calibrate(
    values: Sequence[float],
    low_pct: float = 25.0,
    high_pct: float = 75.0,
    drops: int = 500,
    levels: int = 3,
    seed: int = 42,
) -> CalibrationResult:
    """正态云模型校准：分位数定标 -> 多云隶属度 -> 等级编码。

    数学说明（详见报告第五部分）：
      Ex    —— 云的期望，取分位区间内等分段的中心；
      En    —— 熵，控制隶属函数的宽度，取半区间 /(3*levels)（3σ 覆盖原则）；
      He    —— 超熵，控制云滴的离散程度，取 En/10；
      隶属度 μ_k(x) = exp(-(x-Ex_k)^2 / (2*(En_k + He_k*ξ)^2))，ξ~N(0,1)；
      用 `drops` 次云滴做 Monte Carlo 平均，得到稳定的 μ，再取 argmax 定级。
    "云滴数量"参数在原系统中叫 iter_num（100~1000），作用即此。
    """
    x = np.asarray(values, dtype=float)
    mask = ~np.isnan(x)
    xv = x[mask]
    if xv.size == 0:
        raise ValueError("没有可用数值")

    lo, hi = np.percentile(xv, [low_pct, high_pct])
    if hi <= lo:
        hi = lo + 1e-6
    span = hi - lo
    clouds: list[CloudSpec] = []
    for k in range(levels):
        ex = lo + (k + 0.5) * span / levels
        en = span / (3.0 * levels)
        he = en / 10.0
        clouds.append(CloudSpec(ex=ex, en=en, he=he, label=_level_label(k, levels)))

    rng = np.random.default_rng(seed)
    mu_sum = np.zeros((xv.size, levels))
    for _ in range(int(max(1, drops))):
        for k, c in enumerate(clouds):
            en_k = c.en + c.he * rng.standard_normal(xv.size)
            en_k = np.where(np.abs(en_k) < 1e-9, 1e-9, en_k)
            mu_sum[:, k] += np.exp(-((xv - c.ex) ** 2) / (2 * en_k**2))
    mu = mu_sum / max(1, drops)
    codes_v = np.argmax(mu, axis=1)

    codes = np.full(x.shape, -1, dtype=int)
    codes[mask] = codes_v
    membership = np.full((x.size, levels), np.nan)
    membership[mask] = mu

    # 等级切点：相邻云的交点（用于报告里给出可复述的阈值）
    thresholds = [float((clouds[k].ex + clouds[k + 1].ex) / 2) for k in range(levels - 1)]

    stats = {
        "low_pct": low_pct,
        "high_pct": high_pct,
        "lo": round(float(lo), 4),
        "hi": round(float(hi), 4),
        "mean_mu": round(float(np.mean(np.max(mu, axis=1))), 4),
        "ambiguous_rate": round(float(np.mean(np.sort(mu, axis=1)[:, -1] - np.sort(mu, axis=1)[:, -2] < 0.15)), 4),
        "n": int(xv.size),
    }
    return CalibrationResult(codes=codes, membership=membership, clouds=clouds, thresholds=thresholds, stats=stats)


def _level_label(k: int, levels: int) -> str:
    if levels == 2:
        return ["低", "高"][k]
    if levels == 3:
        return ["低", "中", "高"][k]
    if levels == 4:
        return ["很低", "偏低", "偏高", "很高"][k]
    return f"L{k}"


# --------------------------------------------------------------------------
# KMeans（numpy 手写，k-means++ 初始化）
# --------------------------------------------------------------------------


def _zscore(X: np.ndarray) -> np.ndarray:
    mu = X.mean(axis=0)
    sd = X.std(axis=0, ddof=0)
    sd = np.where(sd < 1e-12, 1.0, sd)
    return (X - mu) / sd


def _robust_scale(X: np.ndarray, clip: float = 5.0) -> np.ndarray:
    """中位数 / IQR 标准化 + 截断。

    为什么默认用它：企业规模这类变量天然右偏（少数巨头），
    普通 z-score 会被极端值主导，导致 KMeans 把一个簇让给单个离群点。
    """
    med = np.median(X, axis=0)
    q1, q3 = np.percentile(X, [25, 75], axis=0)
    iqr = q3 - q1
    sd = X.std(axis=0, ddof=0)
    denom = np.where(iqr < 1e-12, np.where(sd < 1e-12, 1.0, sd), iqr)
    return np.clip((X - med) / denom, -clip, clip)


def _scaling(X: np.ndarray, mode: str) -> np.ndarray:
    return _robust_scale(X) if mode == "robust" else _zscore(X)


def _kmeanspp(X: np.ndarray, k: int, rng: np.random.Generator) -> np.ndarray:
    n = X.shape[0]
    centers = [X[rng.integers(n)]]
    d2 = ((X - centers[0]) ** 2).sum(axis=1)
    for _ in range(1, k):
        prob = d2 / d2.sum() if d2.sum() > 0 else np.full(n, 1 / n)
        idx = int(rng.choice(n, p=prob))
        centers.append(X[idx])
        d2 = np.minimum(d2, ((X - X[idx]) ** 2).sum(axis=1))
    return np.vstack(centers)


def kmeans(
    X: np.ndarray,
    k: int = 3,
    seed: int = 42,
    n_init: int = 10,
    max_iter: int = 300,
    scale: str = "robust",
) -> dict[str, Any]:
    """欧氏 KMeans。返回标签、中心、惯性、轮廓系数、迭代次数。

    scale="robust"（默认）先做中位数/IQR 标准化并截断，避免极端值独占一个簇。
    """
    X = np.asarray(X, dtype=float)
    if X.ndim != 2 or X.shape[0] < k:
        raise ValueError("样本数少于聚类数")
    Z = _scaling(X, scale)
    rng = np.random.default_rng(seed)
    best: dict[str, Any] | None = None
    for _ in range(n_init):
        C = _kmeanspp(Z, k, rng)
        labels = np.zeros(Z.shape[0], dtype=int)
        for it in range(1, max_iter + 1):
            d = ((Z[:, None, :] - C[None, :, :]) ** 2).sum(axis=2)
            new = np.argmin(d, axis=1)
            if np.array_equal(new, labels) and it > 1:
                labels = new
                break
            labels = new
            for j in range(k):
                m = labels == j
                if m.any():
                    C[j] = Z[m].mean(axis=0)
        inertia = float(((Z - C[labels]) ** 2).sum())
        if best is None or inertia < best["inertia"]:
            best = {"labels": labels.copy(), "centers": C.copy(), "inertia": inertia, "iters": it}
    assert best is not None
    sil = silhouette(Z, best["labels"])
    return {
        "k": k,
        "labels": best["labels"],
        "centers_z": best["centers"],
        "inertia": round(best["inertia"], 4),
        "iters": best["iters"],
        "silhouette": round(sil, 4),
    }


def silhouette(Z: np.ndarray, labels: np.ndarray) -> float:
    n = Z.shape[0]
    uniq = np.unique(labels)
    if len(uniq) < 2 or n > 6000:
        return float("nan")
    d = np.sqrt(((Z[:, None, :] - Z[None, :, :]) ** 2).sum(axis=2))
    s = np.zeros(n)
    for i in range(n):
        same = labels == labels[i]
        same[i] = False
        a = d[i, same].mean() if same.any() else 0.0
        b = min(d[i, labels == u].mean() for u in uniq if u != labels[i])
        s[i] = 0.0 if max(a, b) == 0 else (b - a) / max(a, b)
    return float(s.mean())


# --------------------------------------------------------------------------
# CART 决策树（多分类，Gini）
# --------------------------------------------------------------------------


@dataclass
class TreeNode:
    feature: int | None = None
    threshold: float | None = None
    left: "TreeNode | None" = None
    right: "TreeNode | None" = None
    value: np.ndarray | None = None       # 类别分布
    n: int = 0
    impurity: float = 0.0
    gain: float = 0.0

    def is_leaf(self) -> bool:
        return self.feature is None


def _gini(counts: np.ndarray) -> float:
    tot = counts.sum()
    if tot <= 0:
        return 0.0
    p = counts / tot
    return float(1.0 - (p**2).sum())


def _best_split(X: np.ndarray, y: np.ndarray, n_classes: int, min_leaf: int) -> tuple[int | None, float | None, float]:
    n, p = X.shape
    parent = np.bincount(y, minlength=n_classes)
    parent_g = _gini(parent)
    best_gain, best_f, best_t = 0.0, None, None
    for f in range(p):
        col = X[:, f]
        qs = np.unique(np.percentile(col, np.linspace(5, 95, 19)))
        for t in qs:
            mask = col <= t
            nl = int(mask.sum())
            if nl < min_leaf or n - nl < min_leaf:
                continue
            g = parent_g - (
                nl / n * _gini(np.bincount(y[mask], minlength=n_classes))
                + (n - nl) / n * _gini(np.bincount(y[~mask], minlength=n_classes))
            )
            if g > best_gain:
                best_gain, best_f, best_t = float(g), f, float(t)
    return best_f, best_t, best_gain


def _build(
    X: np.ndarray, y: np.ndarray, n_classes: int, depth: int, max_depth: int,
    min_leaf: int, min_gain: float, importances: np.ndarray,
) -> TreeNode:
    counts = np.bincount(y, minlength=n_classes).astype(float)
    node = TreeNode(value=counts, n=int(y.size), impurity=_gini(counts))
    if depth >= max_depth or y.size < 2 * min_leaf or node.impurity <= 1e-9:
        return node
    f, t, gain = _best_split(X, y, n_classes, min_leaf)
    if f is None or gain < min_gain:
        return node
    mask = X[:, f] <= t
    importances[f] += gain * y.size
    node.feature, node.threshold, node.gain = f, t, gain
    node.left = _build(X[mask], y[mask], n_classes, depth + 1, max_depth, min_leaf, min_gain, importances)
    node.right = _build(X[~mask], y[~mask], n_classes, depth + 1, max_depth, min_leaf, min_gain, importances)
    return node


def cart(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: Sequence[str],
    class_names: Sequence[str],
    max_depth: int = 3,
    min_samples_leaf: int = 20,
    min_gain: float = 1e-4,
    level_labels: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=int)
    n_classes = len(class_names)
    imp = np.zeros(X.shape[1])
    root = _build(X, y, n_classes, 0, max_depth, min_samples_leaf, min_gain, imp)
    pred = predict_tree(root, X)
    acc = float((pred == y).mean())
    total = imp.sum() if imp.sum() > 0 else 1.0
    importances = {
        str(feature_names[i]): round(float(imp[i] / total), 4) for i in range(len(feature_names))
    }
    return {
        "tree": root,
        "accuracy": round(acc, 4),
        "depth": max_depth,
        "leaves": count_leaves(root),
        "importances": dict(sorted(importances.items(), key=lambda kv: kv[1], reverse=True)),
        "rules": tree_rules(root, feature_names, class_names, level_labels=level_labels),
        "node_count": count_nodes(root),
    }


def predict_tree(node: TreeNode, X: np.ndarray) -> np.ndarray:
    out = np.zeros(X.shape[0], dtype=int)
    for i in range(X.shape[0]):
        cur = node
        while not cur.is_leaf():
            assert cur.feature is not None and cur.threshold is not None
            cur = cur.left if X[i, cur.feature] <= cur.threshold else cur.right  # type: ignore[assignment]
        assert cur.value is not None
        out[i] = int(np.argmax(cur.value))
    return out


def count_leaves(node: TreeNode) -> int:
    if node.is_leaf():
        return 1
    return count_leaves(node.left) + count_leaves(node.right)  # type: ignore[arg-type]


def count_nodes(node: TreeNode) -> int:
    if node.is_leaf():
        return 1
    return 1 + count_nodes(node.left) + count_nodes(node.right)  # type: ignore[arg-type]


def _desc_condition(fname: str, threshold: float, labels: list[str] | None, left: bool) -> str:
    """把编码阈值翻译成人话：left=True 表示 <= threshold 的分支。"""
    if not labels:
        return f"{fname} <= {threshold:.4g}" if left else f"{fname} > {threshold:.4g}"
    k = max(0, min(len(labels) - 1, int(math.floor(threshold + 1e-9))))
    chosen = labels[: k + 1] if left else labels[k + 1:]
    if not chosen:
        chosen = [labels[0] if left else labels[-1]]
    if len(chosen) == 1:
        return f"{fname} = {chosen[0]}"
    return f"{fname} 属于 {chosen[0]}~{chosen[-1]}"


def tree_rules(
    node: TreeNode,
    feature_names: Sequence[str],
    class_names: Sequence[str],
    conds: list[str] | None = None,
    out: list[dict[str, Any]] | None = None,
    level_labels: dict[str, list[str]] | None = None,
) -> list[dict[str, Any]]:
    conds = conds or []
    out = out if out is not None else []
    if node.is_leaf():
        assert node.value is not None
        tot = node.value.sum()
        idx = int(np.argmax(node.value))
        conf = float(node.value[idx] / tot) if tot else 0.0
        out.append(
            {
                "conditions": conds.copy(),
                "then": str(class_names[idx]),
                "support": int(node.n),
                "confidence": round(conf, 4),
                "distribution": [int(v) for v in node.value],
            }
        )
        return out
    assert node.feature is not None and node.threshold is not None
    fname = str(feature_names[node.feature])
    t = node.threshold
    labs = (level_labels or {}).get(fname)
    tree_rules(node.left, feature_names, class_names, conds + [_desc_condition(fname, t, labs, True)], out, level_labels)  # type: ignore[arg-type]
    tree_rules(node.right, feature_names, class_names, conds + [_desc_condition(fname, t, labs, False)], out, level_labels)  # type: ignore[arg-type]
    return out


def cross_validate(
    X: np.ndarray,
    y: np.ndarray,
    feature_names: Sequence[str],
    class_names: Sequence[str],
    max_depth: int,
    folds: int = 5,
    seed: int = 42,
) -> dict[str, Any]:
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(y))
    chunks = np.array_split(idx, folds)
    scores: list[float] = []
    for i in range(folds):
        test = chunks[i]
        train = np.concatenate([chunks[j] for j in range(folds) if j != i])
        imp = np.zeros(X.shape[1])
        tree = _build(X[train], y[train], len(class_names), 0, max_depth, 20, 1e-4, imp)
        scores.append(float((predict_tree(tree, X[test]) == y[test]).mean()))
    return {
        "folds": folds,
        "mean": round(float(np.mean(scores)), 4),
        "std": round(float(np.std(scores, ddof=0)), 4),
        "scores": [round(s, 4) for s in scores],
    }


# --------------------------------------------------------------------------
# 影响机制：相关网络 + 剪枝 + 中心性
# --------------------------------------------------------------------------


def influence_network(df: pd.DataFrame, cols: Sequence[str] | None = None, threshold: float = 0.2) -> dict[str, Any]:
    sub = numeric_frame(df, cols)
    names = [str(c) for c in sub.columns]
    if len(names) < 2:
        return {"nodes": [], "edges": [], "note": "数值列不足。"}
    r = sub.corr().to_numpy()
    edges = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            val = float(r[i, j])
            if abs(val) >= threshold:
                edges.append({"source": names[i], "target": names[j], "weight": round(val, 4), "abs": round(abs(val), 4)})
    edges.sort(key=lambda e: e["abs"], reverse=True)

    strength = {n: 0.0 for n in names}
    degree = {n: 0 for n in names}
    for e in edges:
        strength[e["source"]] += e["abs"]
        strength[e["target"]] += e["abs"]
        degree[e["source"]] += 1
        degree[e["target"]] += 1

    nodes = [
        {
            "id": n,
            "degree": degree[n],
            "strength": round(strength[n], 4),
            "eigen": round(float(v), 4),
        }
        for n, v in zip(names, _eigen_centrality(names, edges))
    ]
    nodes.sort(key=lambda d: d["strength"], reverse=True)
    return {
        "nodes": nodes,
        "edges": edges,
        "threshold": threshold,
        "note": f"|r| >= {threshold} 的边被保留（剪枝）；边表示线性相关，不等于因果路径。",
    }


def _eigen_centrality(names: Sequence[str], edges: Sequence[dict]) -> np.ndarray:
    n = len(names)
    idx = {nm: i for i, nm in enumerate(names)}
    A = np.zeros((n, n))
    for e in edges:
        i, j = idx[e["source"]], idx[e["target"]]
        A[i, j] = A[j, i] = e["abs"]
    v = np.full(n, 1.0 / n)
    for _ in range(60):
        nv = A @ v
        nrm = np.linalg.norm(nv)
        if nrm < 1e-12:
            return v
        v = nv / nrm
    return v


# --------------------------------------------------------------------------
# 端到端流水线
# --------------------------------------------------------------------------


def run_pipeline(
    df: pd.DataFrame,
    target: str | None = None,
    factors: Sequence[str] | None = None,
    low_pct: float = 25.0,
    high_pct: float = 75.0,
    drops: int = 500,
    levels: int = 3,
    k: int = 3,
    tree_depth: int = 3,
    net_threshold: float = 0.2,
    seed: int = 42,
    scale: str = "robust",
) -> dict[str, Any]:
    """跑完整链路，返回可直接序列化的结果。"""
    columns = [str(c) for c in df.columns]
    if target is None:
        target = columns[-1]
    if factors is None:
        factors = [c for c in columns if c != target]

    prof = profile(df)
    corr = correlation(df, columns)
    numeric_cols = [c for c in columns if _is_numeric(df[c])]
    missing = [c for c in [target, *factors] if c not in numeric_cols]
    if missing:
        raise ValueError(f"这些列不是数值列，当前版本不支持：{missing}")

    work = numeric_frame(df, [*factors, target])
    X = work[list(factors)].to_numpy(dtype=float)
    yv = work[target].to_numpy(dtype=float)

    # 1) 校准：因子 + 因变量都做云模型分级
    cal_factors = {f: calibrate(X[:, i], low_pct, high_pct, drops, levels, seed) for i, f in enumerate(factors)}
    cal_y = calibrate(yv, low_pct, high_pct, drops, levels, seed)
    class_names = [c.label for c in cal_y.clouds]

    # 2) 异质性：KMeans 情境分型
    km = kmeans(X, k=k, seed=seed, scale=scale)
    labels = km["labels"]
    scenario_stats = []
    for c in range(k):
        m = labels == c
        item = {"scenario": f"S{c + 1}", "n": int(m.sum())}
        for i, f in enumerate(factors):
            item[f] = round(float(X[m, i].mean()), 4)
        item[target] = round(float(yv[m].mean()), 4)
        scenario_stats.append(item)

    # 3) 组合效应：校准后的因子 -> 因变量等级 的 CART
    Xc = np.column_stack([cal_factors[f].codes for f in factors]).astype(float)
    yc = cal_y.codes.astype(int)
    labels_map = {f: [c.label for c in cal_factors[f].clouds] for f in factors}
    tree = cart(Xc, yc, list(factors), class_names, max_depth=tree_depth, level_labels=labels_map)
    cv = cross_validate(Xc, yc, list(factors), class_names, tree_depth)
    single = {}
    for i, f in enumerate(factors):
        r = float(np.corrcoef(X[:, i], yv)[0, 1])
        single[f] = round(r, 4)

    # 4) 影响机制：相关网络
    net = influence_network(df, [*factors, target], threshold=net_threshold)

    return {
        "meta": {
            "rows": int(len(df)),
            "used_rows": int(len(work)),
            "target": target,
            "factors": list(factors),
            "params": {
                "low_pct": low_pct, "high_pct": high_pct, "drops": drops,
                "levels": levels, "k": k, "tree_depth": tree_depth,
                "net_threshold": net_threshold, "seed": seed, "scale": scale,
            },
        },
        "profile": prof,
        "correlation": corr,
        "calibration": {
            "factors": {f: cal_factors[f].summary() for f in factors},
            "target": cal_y.summary(),
            "class_names": class_names,
        },
        "scenarios": {
            "k": k,
            "silhouette": km["silhouette"],
            "inertia": km["inertia"],
            "stats": scenario_stats,
            "labels": labels.tolist(),
        },
        "tree": {
            "accuracy": tree["accuracy"],
            "leaves": tree["leaves"],
            "nodes": tree["node_count"],
            "depth": tree_depth,
            "importances": tree["importances"],
            "rules": tree["rules"],
            "cv": cv,
            "single_factor_r": single,
        },
        "network": net,
        "figures": {
            "scatter": _scatter_points(X, yv, labels, factors),
            "pca": _pca_points(X, yv, labels, factors),
        },
    }


def _scatter_points(X: np.ndarray, y: np.ndarray, labels: np.ndarray, factors: Sequence[str]) -> dict[str, Any]:
    z = _zscore(X)
    a, b = (0, 1) if X.shape[1] >= 2 else (0, 0)
    pts = [
        {"x": round(float(z[i, a]), 3), "y": round(float(z[i, b]), 3),
         "c": int(labels[i]), "v": round(float(y[i]), 3)}
        for i in range(X.shape[0])
    ]
    return {"x_label": f"{factors[a]}(z)", "y_label": f"{factors[b]}(z)", "points": pts[:1500]}


# --------------------------------------------------------------------------
# 报告导出（Markdown）
# --------------------------------------------------------------------------


def to_markdown(res: dict[str, Any]) -> str:
    m = res["meta"]
    p = m["params"]
    t = res["tree"]
    lines: list[str] = []
    add = lines.append

    add(f"# 数据分析报告：{m['target']} 的影响机制\n")
    add(f"- 样本量：{m['used_rows']}（原始 {m['rows']}）")
    add(f"- 因变量：**{m['target']}**；条件变量：{', '.join(m['factors'])}")
    add(f"- 校准：下分位 {p['low_pct']}% / 上分位 {p['high_pct']}%，云滴 {p['drops']}，等级 {p['levels']} 级")
    add(f"- 聚类：KMeans k={p['k']}，轮廓系数 {res['scenarios']['silhouette']}")
    add(f"- 决策树：深度 {p['tree_depth']}，训练精度 {t['accuracy']}，5 折交叉验证 {t['cv']['mean']}±{t['cv']['std']}")
    add(f"- 随机种子：{p['seed']}（同参数可复算）\n")

    add("## 一、数据体检\n")
    add("| 变量 | 类型 | 缺失 | 中位数 | 标准差 | 异常值 |")
    add("|---|---|---|---|---|---|")
    for c in res["profile"]["columns"]:
        add(f"| {c['name']} | {c['dtype']} | {c['missing']} | {c.get('median', '-')} | {c.get('std', '-')} | {c.get('outliers', '-')} |")
    if res["profile"]["warnings"]:
        add("\n**提示：**")
        for w in res["profile"]["warnings"]:
            add(f"- {w}")
    add("")

    add("## 二、校准结果（云模型分级）\n")
    for name, s in res["calibration"]["factors"].items():
        cnt = "/".join(str(x) for x in s["counts"])
        add(f"- **{name}**：等级 {s['levels']} 级，分布 {cnt}，切点 {s['thresholds']}，平均隶属度 {s['stats']['mean_mu']}")
    ty = res["calibration"]["target"]
    add(f"- **{m['target']}**（因变量）：分布 {'/'.join(str(x) for x in ty['counts'])}，切点 {ty['thresholds']}\n")

    add("## 三、异质性特征（情境分型）\n")
    add(f"KMeans 轮廓系数 **{res['scenarios']['silhouette']}**（越接近 1 越好，>0.3 说明分型可接受）。\n")
    cols = ["scenario", "n", *m["factors"], m["target"]]
    add("| " + " | ".join(cols) + " |")
    add("|" + "---|" * len(cols))
    for row in res["scenarios"]["stats"]:
        add("| " + " | ".join(str(row.get(c, "")) for c in cols) + " |")
    add("")

    add("## 四、组合效应（决策树规则）\n")
    add("变量重要性（Gini）：")
    for k, v in t["importances"].items():
        add(f"- {k}: {v}")
    add("\n**规则（支持度 = 命中样本数，置信度 = 该叶内主导类别占比）：**\n")
    for i, r in enumerate(t["rules"], 1):
        cond = " 且 ".join(r["conditions"]) if r["conditions"] else "（无分裂，全局）"
        add(f"{i}. **IF** {cond} → **THEN {m['target']} = {r['then']}**（n={r['support']}，置信度 {r['confidence']}）")
    add("")

    add("## 五、影响机制（因素网络）\n")
    add(f"按 |r| ≥ {res['network']['threshold']} 剪枝后保留 {len(res['network']['edges'])} 条边。\n")
    add("| 节点 | 度 | 关联强度 | 特征向量中心性 |")
    add("|---|---|---|---|")
    for n in res["network"]["nodes"]:
        add(f"| {n['id']} | {n['degree']} | {n['strength']} | {n['eigen']} |")
    add("\n**最强关联：**")
    for e in res["network"]["edges"][:6]:
        add(f"- {e['source']} — {e['target']}：r = {e['weight']}")
    add("")
    add("> 说明：网络边来自线性相关系数，代表**关联**而非因果。要论证因果，需要工具变量、DID、断点回归或面板固定效应等识别策略。\n")
    add("---")
    add("本报告由 analysis-core 自动生成，全部数字来自真实计算，未做任何文本层推断。")
    return "\n".join(lines)



def _pca_points(X: np.ndarray, y: np.ndarray, labels: np.ndarray, factors: Sequence[str]) -> dict[str, Any]:
    """PCA 前两主成分投影：比任选两个原始变量更能代表整体结构。"""
    Z = _robust_scale(X)
    Zc = Z - Z.mean(axis=0)
    U, S, Vt = np.linalg.svd(Zc, full_matrices=False)
    var = (S**2) / np.maximum((S**2).sum(), 1e-12)
    P = (U[:, :2] * S[:2]) if S.size >= 2 else np.column_stack([U[:, 0] * S[0], np.zeros(Z.shape[0])])
    pts = [
        {"x": round(float(P[i, 0]), 3), "y": round(float(P[i, 1]), 3),
         "c": int(labels[i]), "v": round(float(y[i]), 3)}
        for i in range(P.shape[0])
    ]
    load = {}
    for j, f in enumerate(factors):
        load[str(f)] = [round(float(Vt[0, j]), 3), round(float(Vt[1, j]), 3) if Vt.shape[0] > 1 else 0.0]
    return {
        "points": pts[:1500],
        "explained": [round(float(v), 4) for v in var[:2]],
        "loadings": load,
        "x_label": f"PC1 ({var[0] * 100:.1f}%)",
        "y_label": f"PC2 ({var[1] * 100:.1f}% )",
    }
