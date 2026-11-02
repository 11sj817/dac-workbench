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


---

# V2.9.1 补丁（导航与前端体验）

## 修复：换数据后回不到起点

**现象**：选完一份数据、跑完分析后，点步骤条「1 数据」虽然面板切回去了，但
- 右栏仍显示旧数据的分析结果
- 顶栏数据集标签不变
- 换一份数据后旧结果依旧残留，导致点「5 结果」看到的是上一份数据的结论

**根因**：
1. `applyData()` 只替换了 `S.columns / S.rows / S.numeric`，**没有清空 `S.res`、`S.extra`、`S.target`、`S.factors`**
2. 步骤条点击后**没有滚动到顶部**，用户以为点了没反应（`window.scrollY` 停在 337+）

**修复**：
- 新增 `resetAnalysis()`：清空 `S.res`、`S.extra`、`S.target`、`S.factors`、`S.rowsWork`，状态栏复位
- `applyData()` 开头调用 `resetAnalysis()`
- 换数据后自动进入第 2 步并 `scrollTo(0)`
- 步骤条点击统一走 `gotoStep()`，末尾 `scrollTop()`

## 前端体验优化

| 改进 | 说明 |
|---|---|
| 结果区固定工具条 | 「↻ 重跑分析 / ⇄ 换一份数据 / ⎘ 导出报告」常驻，无需滚回顶部 |
| 步骤条可点 + 悬浮反馈 | `cursor:pointer`、`translateY(-1px)` |
| 键盘快捷键 | `1`~`5` 切换步骤，`Esc` 回第 1 步 |
| 顶栏数据集徽章可点 | 点「鸢尾花…」直接回第 1 步换数据 |
| 无结果跳到 4/5 步 | 停在参数页并明确提示，不再静默跳转 |
| 响应式 | ≤1180px 右栏下移（不隐藏）；≤820px 紧凑；≤560px 双列统计 |

## 实测（CDP 驱动）

```
分析完成              完成 · 0.48s
结果工具条            存在
滚动到 337 后点步骤1    panel-1 可见，scrollY → 0
当前高亮              1 数据
换数据集（wine→iris）   右栏立即变为新数据的体检（150 行 × 5 列）
换数据后步骤           2 变量
旧工具条                已移除
顶栏标签                鸢尾花（UCI Iris，150 条）
console.error          0
```
