# 泄漏审计报告（LEAKAGE AUDIT）

> 函数：`core.js :: leakageAudit(cvResult, rawX, names)`
> 设计原则：**基于执行记录重算比对，不看代码里有没有某个函数**

---

## 二、六项检查

| ID | 检查项 | 判定方法 |
|---|---|---|
| `split-disjoint` | 训练折与验证折样本不重叠 | 对每折取 `trainIdx ∩ testIdx`（**两套索引基准都查**：压缩下标 + 原始行号） |
| `imputer-fit-on-train` | 填补器统计量来自训练折 | 用 `trainRawIdx` 重算训练折的 mean/median/mode，与 `imputeModel.fillValues[j]` 逐列比对 |
| `quantile-on-train` | 离散化分位数由训练折决定 | 每折每列的 `bounds` 必须落在该折训练值的 `[min, max]` 内 |
| `target-not-imputed` | 目标缺失被排除而非填补 | 检查 `excludedByTarget.length` + 填补器未含标签列 |
| `refit-per-fold` | 每折重新拟合 | 统计不同 `imputeModel` 实例数是否等于折数 |
| `strict-flag` | 以严格模式执行 | 检查 `cvResult.strict === true` |

状态取值：`PASS` / `FAIL` / `WARNING` / `NOT APPLICABLE`。

---

## 三、实测输出（红酒 + 10% 缺失）

```
严格无泄漏    失败项 0 / 共 6

训练折与验证折样本不重叠     PASS   全部 5 折均无交集
填补器统计量来自训练折       PASS   重算 55 个参数，全部一致
离散化分位数由训练折决定     PASS   校验 55 组界，均在训练折值域内
目标变量缺失样本被排除而非填补 PASS  排除 43 条；填补器未包含标签列
每折重新拟合预处理           PASS   5 折产生了 5 个独立填补器实例
评估以严格模式执行           PASS   crossValidateStrict 执行
```

---

## 四、审计能抓到的真实问题（已验证）

### 1. 索引重叠

测试 `审计：人为破坏索引重叠应 FAIL`：把验证样本塞进训练的 `trainIdx` → `split-disjoint` 判 **FAIL**，整体 `ok = false`。

### 2. 参数被篡改（模拟「用全量数据拟合」）

测试 `审计：篡改填补参数应 FAIL`：把 `fillValues[0]` 改成全量均值 + 1 → `imputer-fit-on-train` 判 **FAIL**。

### 3. 开发中真实踩到的坑（记录）

初版审计用 `rawX[trainIdx]` 重算，但 `trainIdx` 是**排除目标缺失后压缩矩阵的下标**，与原始 `rawX` 行号错位 → 重算值与记录值不符 → **误报 FAIL**。

修复：`records` 增补 `trainRawIdx` / `testRawIdx` 映射回原始行号，审计改用该基准。
这个 bug 恰好证明了审计是"真在算"——如果只是走形式，不会暴露这种错位。

---

## 五、审计的局限（必须说明）

1. **只能证明"记录与重算一致"**，不能证明"代码逻辑没有别的泄漏路径"。若有人同时篡改记录和参数，审计无法发现。
2. **不覆盖 PCA / KMeans** —— 这两个在 V2.1 仍用全量数据（它们不参与 CV 评估，但会影响可视化）。
3. **不覆盖贝叶斯网络** —— 网络结构仍用全量数据学习一次，未纳入 CV。
4. **`quantile-on-train` 只验证"界在值域内"**，不是逐值比对（因为填补后值域会变，逐值比对会产生误报）。
5. 审计结论不能替代人工 review。

---

## 六、结论

在本版本实测数据集上，**6 项检查全部通过**，可标记为「严格无泄漏」。

但按上述局限，若用于正式论文，建议同时报告：
- 本审计的 6 项结果
- 未覆盖项（PCA / BN / 超参数选择）
