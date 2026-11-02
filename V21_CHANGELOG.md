# V2.1 变更记录

> 版本：v2.1 · 2026-11-02 · 分支 `v2.1-dev`
> 基线：V2.0（commit 34969cd）

---

## 新增文件

| 文件 | 行数 | 用途 |
|---|---|---|
| `workbench/preprocess.js` | 425 | 缺失诊断、五种填补器、Gower 距离、完整案例删除 |
| `tests/test_v21.js` | 390 | 32 项泄漏与填补测试 |
| `V21_PRE_AUDIT.md` | — | 改造前审查 |
| `IMPUTATION_REPORT.md` | — | 缺失值处理报告 |
| `CV_VALIDATION_REPORT.md` | — | 交叉验证报告 |
| `LEAKAGE_AUDIT_REPORT.md` | — | 泄漏审计报告 |
| `TEST_REPORT_V21.md` | — | 测试报告 |

## 修改文件

| 文件 | 变更 |
|---|---|
| `workbench/core.js` | 拆出 `buildClouds`/`assignCodes`；新增 `calibrateWith`、`crossValidateStrict`、`leakageAudit`；`assignCodes` 加下溢兜底 |
| `workbench/ui.js` | 新增「数据质量」页签（诊断/填补/严格CV/审计）；状态加 `rowsWork`/`rowsRaw` |
| `workbench/index.html` | 新增 Tab 按钮 |
| `build_workbench.py` | 内嵌 `preprocess.js` |

---

## 破坏性变更

| 项 | 影响 |
|---|---|
| `crossValidateStrict` 的 `records[].trainIdx` | 是**压缩矩阵下标**（排除目标缺失后），不是原始行号。审计必须用 `trainRawIdx` |
| `calibrate` 内部重构 | 输出结构不变，数值不变（33 项回归测试通过） |

## 行为变更（有意义的）

| 项 | V2.0 | V2.1 |
|---|---|---|
| 缺失值 | 一律删行 | 可选 5 种策略，目标缺失仍排除 |
| CV 分位数 | 全量 | 每折训练集 |
| 训练-测试差距（红酒） | 4.7 pp | **9.0 pp**（更诚实） |
| 极端值校准 | 误分到最低档 | 按距最近云心兜底 |

---

## 修复的 bug

### 1. `assignCodes` 浮点下溢（V2.1 新发现）

```js
// 修复前：值远离所有云心时 exp() 全为 0 → bestK 保持 0（最低档）
// 修复后：
if (best <= 1e-12) {
  let bestD = Infinity, k2 = 0;
  for (...) { if (|v - clouds[k].ex| < bestD) k2 = k; }
  bestK = k2;
}
```

影响：极端离群值不再被错误归入最低等级。

### 2. 审计索引基准错位（V2.1 开发中）

见 `LEAKAGE_AUDIT_REPORT.md` 第四节第 3 条。

### 3. UI TDZ 错误（V2.1 开发中）

`const WR` 声明在使用之后 → `ReferenceError: Cannot access 'WR' before initialization` → 页签白屏。已修正声明顺序。

---

## 测试

| 套件 | 数量 | 结果 |
|---|---|---|
| `tests/test_core.js`（V2.0 回归） | 33 | **33 / 33** |
| `tests/test_v21.js`（V2.1 新增） | 32 | **32 / 32** |
| 合计 | 65 | **100%** |
