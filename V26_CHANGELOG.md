# V2.6 变更记录

基线：V2.1-dev（`b8fddaa`）→ 本分支 `v2.6-dev`

> 说明：仓库中不存在 V2.2~V2.5 分支，本版本直接在 V2.1 上继续，版本号按需求命名为 v2.6。

## 新增

| 文件 | 说明 |
|---|---|
| `workbench/worker.js` | Worker 内核，8 类任务 |
| `V26_ARCHITECTURE.md` 等 7 份文档 | 架构/安全/性能/测试/指南/变更/发布说明 |

## 修改

| 文件 | 变更 |
|---|---|
| `workbench/ui.js` | 加 `esc()` 转义、`WK` 调度器、状态栏、AI 会话模式与发送预览 |
| `workbench/core.js` | 离散化改按列批量（性能 +100 倍） |
| `workbench/index.html` | 底部状态栏 + 取消按钮 + 样式 |
| `build_workbench.py` | 注入 `__WORKER_SRC__`（转义 `</`） |

## 修复的缺陷

1. **Worker 状态机把 `start` 当终态** → 任务永不 resolve（界面表现为"超时未完成"）
2. **构建期 `</script>` 提前闭合** → 整页 JS 失效、`__DATASETS__` 未定义
3. **离散化逐单元格调用** → 400 行严格 CV 超 80 秒

## V2.6.1 补齐

| 项 | 实现 |
|---|---|
| 多工作表选择 | `parseXLSXAll` + 角色弹层里的工作表下拉 |
| 变量角色系统 | 8 种角色（target/num/cat/id/weight/group/time/exclude），自动识别 + 手动改，目标唯一约束 |
| 项目管理 | 版本化 JSON（`dac-project/2.6`），导出/含数据导出/导入，校验 format 与版本 |
| Excel 导出 | 零依赖 `toXLSX`（deflate-raw + 手写 zip） |
| 10 万行压测 | 完成，暴露校准 29s 并优化到 1s |

## 仍未完成（诚实披露）

| 项 | 原因 |
|---|---|
| Firefox / Safari 实机测试 | 环境只有 Chrome 156 |
| xlsx 解析单元测试 | 依赖浏览器 `DecompressionStream`，Node 无此 API |
| 跨项目历史版本管理 | 只做了单项目快照，没做多版本树 |
| 变量角色与统计模型的联动 | 角色影响变量筛选，但 weight/group 尚未接入加权与分层估计 |

## 版本号说明

用户要求的基线是「V2.5-dev」，但仓库实际只有 `v2.0-dev` / `v2.1-dev`。
本版本号沿用用户的 `v2.6`，实际内容 = V2.1 + Worker + 安全 + 性能。
如需严格的 V2.2~V2.5 演进链，需要另开任务补齐。
