# V2.9 变更记录

基线：V2.7.1（main `3754e8c`）→ 本分支 `v2.9-dev`

> 说明：仓库中不存在 V2.8 分支。本版本直接在 V2.7.1 上继续，按需求命名为 v2.9。

## 新增

| 文件 | 说明 |
|---|---|
| `workbench/bootstrap.js` | Bootstrap 引擎（~520 行）：4 种抽样、ARI/NMI/共聚类、规则签名、边频率、共识网络、诊断 |
| `tests/test_bootstrap.js` | 31 项测试 |
| 6 份文档 | METHODS / REPORT / CLUSTER / CART / BN / TEST |

## 修改

| 文件 | 变更 |
|---|---|
| `workbench/core.js` | `kmeans` 返回 `med`/`iqr`（供参考集映射到标准化空间） |
| `workbench/worker.js` | 新增 `bootstrapStability` 任务 |
| `workbench/ui.js` | 新增「Bootstrap」页签（实验设置 / 诊断 / ARI 直方图 / 共聚类热力图 / 规则频率 / 边频率） |
| `workbench/index.html` | 新增 Tab |
| `build_workbench.py` | 注入 `bootstrap.js`（主线程与 Worker 双份） |

## 修复的缺陷

1. **NMI 恒 NaN**：Map 键类型不一致（数字存、字符串查）
2. **UI `n is not defined`**：`map` 形参在 `filter` 里越界引用
3. **ARI 恒 1.000**：参考集与聚类中心尺度不一致，标签退化
4. 构建期 `bootstrap.js` 未进 Worker → PB 前补上

## 未完成（诚实披露）

| 项 | 说明 |
|---|---|
| **OOB 表现** | 有放回抽样本可算袋外样本，当前未实现；规则与网络都缺这一层 |
| **Block Bootstrap** | 时间序列依赖结构未处理，当前 IID 对时序数据不适用 |
| 共识聚类 | 有共聚类矩阵，但没反推一个稳定划分 |
| 规则数值阈值容差 | 签名是精确匹配，近似阈值会被合并 |
| Bootstrap 模型平均 | 网络未做结构平均 |
| CPT 稳定性 | 只做结构层，未做参数层 |
| B=500 全量跑时基准 | 只验证 B=30 |

## 解释边界（写进界面与文档）

- 稳定性 ≠ 准确率
- 边频率 ≠ 因果概率
- 共聚类分母 0 ≠ 不同簇
- 分位数区间 ≠ 严格置信区间（重采样间不独立）
