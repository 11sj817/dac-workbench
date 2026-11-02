# 算法变更记录（ALGORITHM CHANGELOG）

## V2.0 — 2026-11-02

### 变更概览

| 模块 | 破坏性 | 影响 |
|---|---|---|
| `crossValidate` | ⚠️ **是**（返回值结构扩展） | CV 指标全部重算，旧数值会变 |
| `bicScore` | ⚠️ **是**（参数数公式） | 网络结构可能变稀疏 |
| `bnLearn` | 否（新增字段） | 新增 Reverse、日志、alpha |
| `bnInfer` | ⚠️ **是**（新增 impossible 分支） | 不可能证据时返回 `posterior: null` |
| `kmeans` | 否（新增字段） | 空簇不再出现 |
| `calibrate` / `pca` / `cart` | 否 | 行为不变 |

---

### 1. `crossValidate(X, y, featureNames, labels, opt, folds)`

**V1 返回**

```js
{ folds: 5, mean, std, scores: [0.63, 0.66, ...] }
```

**V2 返回**

```js
{
  k: 5,                    // 实际折数（可能因小类别降级）
  folds: 5,                // 成功完成的折数
  perFold: [{ fold, nTrain, nTest, trainAccuracy, trainBalanced, testAccuracy, balancedAccuracy, macroF1 }],
  warning: string|null,    // 样本不足 / 空等级提示
  mean, std,               // 测试准确率
  trainMean, trainStd,     // 训练准确率
  gap,                     // trainMean - mean（过拟合指标）
  oof: {                   // 各折测试集合并后的整体评价
    accuracy, balancedAccuracy, macroF1,
    perClass: [{ cls, support, tp, fp, fn, precision, recall, f1 }],
    confusion: [[...]],    // 混淆矩阵
    n
  }
}
```

**算法变更**：

- 随机切分 → **分层切分**（`stratifiedFolds`）
- 单指标 → **Accuracy / Balanced Accuracy / Macro-F1 / 每类 P-R-F1 / 混淆矩阵**
- 无小样本处理 → **自动降折 + 显式警告**
- 无过拟合诊断 → **训练-测试差距 `gap`**

**代码兼容性**：`cv.mean`、`cv.std`、`cv.folds` 仍存在，UI 无需改动即可用。

---

### 2. `bicScore(data, nStates, node, parents)`

**变更**：

```diff
- const params = q * (k - 1);                    // q = 实际出现的父配置数
+ const params = Math.pow(k, parents.length) * (k - 1);   // 理论父配置数
```

**理由**：BIC 惩罚项必须反映模型自由度。用实际出现数会低估惩罚，导致**偏爱高入度结构**。

**副作用**：学到的边可能减少。**这不是退化，是修正**。若需对比，可在 `bnLearn` 传 `maxParents` 控制上限。

---

### 3. `bnLearn(discrete, names, levels, opt)`

**新增 opt**：

| 参数 | 默认 | 说明 |
|---|---|---|
| `maxParents` | 2 | 单节点父节点上限 |
| `maxIter` | 20 | 最大搜索步数 |
| `seed` | 42 | 随机起点种子 |
| `randomStart` | false | 是否先用随机边初始化 |
| `alpha` | 1 | CPT 的 Dirichlet 平滑系数（0 = 不平滑） |

**新增返回字段**：

```js
{
  log: [{ step, op: 'add'|'del'|'rev', from, to, gain }],
  converged: boolean,
  iterations: number,
  alpha: number
}
```

**新增操作**：**Reverse**（翻转边方向），联合计算两端节点的分数变化。

---

### 4. `bnInfer(model, evidence)`

**变更**：

- 新增联合空间上限 `BN_MAX_JOINT = 200000`，超限**抛错**（V1 会静默卡死）
- 证据概率为 0 时返回 `{ impossible: true, posterior: null, message }`，而不是全 0 数组
- 正常情况额外返回 `evidence`、`evidenceProb`

**破坏性**：调用方必须先判 `if (inf.impossible)` 再读 `posterior`。

---

### 5. `kmeans(X, k, opt)`

**变更**：

- 空簇救援（最远点重分配）
- 返回 `emptyClusters` 计数

**行为变化**：V1 可能出现「实际簇数 < k」，V2 保证 k 个非空簇（样本数 ≥ k 时）。

---

### 6. 新增导出函数

| 函数 | 用途 |
|---|---|
| `evalMetrics(yTrue, yPred, nClasses)` | 分类指标 + 混淆矩阵 |
| `stratifiedFolds(y, K, seed)` | 分层切分（可单独用于其他算法） |

---

## 数值变化说明（重要）

修复 BIC 后，**贝叶斯网络结构可能与 V1 不同**。以红酒数据（400 行，3 等级）为例：

| 版本 | 边数 | 说明 |
|---|---|---|
| V1（`q×(k−1)`） | 5 | 惩罚不足，倾向多加边 |
| V2（`k^Pa×(k−1)`） | 见页面实际显示 | 惩罚正确，更稀疏 |

**这不是「结果变差了」，而是「V1 的惩罚算错了」。** 若论文中引用过 V1 的结构，需重新生成并在方法部分注明算法版本。

---

## 未变更的部分（行为保持）

- 云模型校准（`calibrate`）：Ex/En/He 公式、分位数定标、云滴 Monte Carlo 全部保持原样
- KMeans++ 初始化、robust 缩放（median/IQR + clip ±5）
- CART 的 Gini 分裂、规则抽取、变量重要性
- PCA 的 Jacobi 特征分解
- 相关网络（Pearson + 阈值剪枝）
- 报告生成格式（仅新增 CV 与 BN 段落）
