# V2.1 改造前审查（PRE-AUDIT）

> 审查对象：DAC Workbench V2.0（commit 34969cd）
> 审查日期：2026-11-02
> 方法：逐行读码 + 追踪调用链 + 构造分布漂移数据实测

---

## 一、现有数据处理流程（V2.0 真实路径）

`ui.js :: compute()` 的执行顺序：

```
S.rows（原始，可能含 null）
   ↓  keep = rows.filter(所有列非 null)          ← ① 完整案例删除（隐式、无提示）
   ↓  X = keep 的 x 列；yv = keep 的 y 列
   ↓  cal[f] = C.calibrate(X.map(r => r[i]), params)   ← ② 分位数用【全量 X】算
   ↓  calY = C.calibrate(yv, params)                   ← ③ 分位数用【全量 y】算
   ↓  km = C.kmeans(X, k)                              ← ④ robustScale 用【全量 X】
   ↓  Xc = 用 cal 的 codes（全量校准结果）
   ↓  tree = C.cart(Xc, yc)                            ← 训练集 = 全量
   ↓  cv = C.crossValidate(Xc, yc, ...)                ← ⑤ 五折用的是【已全量校准】的 Xc
   ↓  pc = C.pca(X, ...)                               ← ⑥ PCA 用全量
```

**关键代码位置**

| 行号（V2.0） | 内容 | 风险 |
|---|---|---|
| `ui.js:238` | `const keep = S.rows.filter(...)` | 缺失值一律删行，无填补选项 |
| `ui.js:245` | `C.calibrate(X.map(r => r[i]), params)` | 分位数来自**全部样本** |
| `ui.js:246` | `C.calibrate(yv, params)` | 目标分位数来自全部样本 |
| `ui.js:280` | `C.crossValidate(Xc, yc, ...)` | CV 的每一折都用了全局分位数 |

---

## 二、发现的问题（按严重度）

### 🔴 严重 1：交叉验证存在数据泄漏

`Xc` 是**用全量数据的分位数**做出来的等级码，再喂给 `crossValidate`。

后果：验证折的分位数信息已经通过 `cal` 进入了训练折的特征空间。这是教科书级的泄漏 —— 虽然只有 2 个统计量（lo/hi），泄漏量小，但**严格意义上不合格**，审稿人问「你怎么处理的预处理泄漏」时无法自圆其说。

### 🔴 严重 2：缺失值只有"删行"一条路

`keep = rows.filter(...)` 要求**所有列**非空。400 行数据若每列 10% 缺失，完整行只剩 `400 × 0.9^12 ≈ 113` 行 —— 实测正是 107 行。真实问卷数据下会直接崩掉。

### 🟠 中等 3：缺失机制未区分

不区分 MCAR / MAR / MNAR，不区分「目标缺失」和「特征缺失」。目标变量缺失时同样被删行（这点结果上正确，但过程无记录）。

### 🟠 中等 4：无预处理参数留痕

`calibrate` 返回的 `lo/hi` 没有被记录进 `result.json` 的显式字段，无法事后审计「这一折用的是哪组分位数」。

### 🟡 轻微 5：极端值隶属度下溢

（V2.1 开发中发现）当数值远超所有云心时，`exp(-d²/2En²)` 下溢为 0，所有等级隶属度都是 0，代码按「第一个 mu > -1 的等级」判定，**错误地归入最低档**。

---

## 三、改造计划

| 阶段 | 内容 |
|---|---|
| 1 | 新建 `workbench/preprocess.js`：`fitImputer` / `transformImputer` / `diagnoseMissing` / Gower 距离 |
| 2 | `core.js` 拆出 `buildClouds` / `assignCodes`，新增 `calibrateWith(values, bounds)` 支持外部切点 |
| 3 | 新增 `crossValidateStrict`：每折内部 填补→分位数→离散化→建模 |
| 4 | 新增 `leakageAudit`：基于执行记录重算比对 |
| 5 | UI 新增「数据质量」页签 |
| 6 | 测试：32 项（10 类泄漏场景） |
| 7 | 修 `assignCodes` 下溢兜底 |

---

## 四、明确不做的事

- 不替换云模型公式（Ex/En/He 保持书 3.4.1 定义）
- 不改 CART 的 Gini 分裂
- 不改 KMeans 的 robustScale
- 不改报告格式（只增量追加章节）
