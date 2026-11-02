# V2.6 测试报告

## 一、单元测试（Node）

| 套件 | 数量 | 结果 |
|---|---|---|
| `tests/test_core.js` | 33 | **33 / 33** |
| `tests/test_v21.js` | 32 | **32 / 32** |
| 合计 | 65 | **100%** |

## 二、浏览器实机验证（CDP 驱动 Chrome 156）

| 项 | 结果 |
|---|---|
| 页面加载 | ✅ 无 console.error |
| Worker 初始化 | ✅ 状态栏显示「已启用」 |
| Worker 任务 ping | ✅ 返回 pong |
| Worker 任务 elbow | ✅ 5 ms，返回 2 个 k |
| Worker 任务 strictCV | ✅ 89 ms（60 行测试数据） |
| UI 严格 CV 全流程 | ✅ 8 s 完成 |
| 泄漏审计 | ✅ 6/6 PASS，verdict = 严格无泄漏 |
| 主线程响应性 | ✅ 计算期间 300 万次循环仅 8~16 ms |
| XSS（列名注入 `<img onerror>`） | ✅ DOM 中无 `__XSS__` |
| 状态栏 / 取消按钮 | ✅ 存在且可点击 |

## 三、实测数据（红酒 + 10% 缺失）

```
测试准确率   61.9%
平衡准确率   62.3%
Macro-F1     61.9%
训练-测试差距 8.4 pp
排除目标缺失  43 条
审计          严格无泄漏，失败项 0/6
```

## 四、开发中被测试抓出的 3 个真实缺陷

| # | 缺陷 | 表现 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | Worker 状态机 | 任务永不返回，界面"超时" | 主线程把 `status:'start'` 当终态，清掉 pending | `start`/`pong` 视为非终态直接 return |
| 2 | 构建期 script 提前闭合 | `__DATASETS__` 未定义、整页空白 | Worker 源码里的 `</` 未转义，内联 script 被截断 | `json.dumps(...).replace("</", "<\\/")` |
| 3 | 离散化 O(n·p) 次调用 | 严格 CV >80s 无响应 | 每个单元格调用一次 `calibrateWith` | 改为按列批量 |

> 这 3 个都不是"写完就过"的问题，是自动化 + 实机测试真正跑出来的。

## 五、未执行的测试（诚实披露）

| 项 | 原因 |
|---|---|
| Firefox / Safari | 环境只有 Chrome 156 |
| xlsx 导入单测 | 依赖浏览器 `DecompressionStream`，Node 无此 API |
| 10 万行压测 | 未做 |
| 项目导入导出 | **本轮未实现**（见 CHANGELOG 未完成项） |
| 多工作表选择 | 未实现 |


---

# 附录：V2.6.1 补充验证

| 项 | 结果 |
|---|---|
| 变量角色按钮 | ✅ 存在，点击打开弹层 |
| 角色弹层内容 | ✅ 12 个角色下拉（每列一个） |
| 报告页导出按钮 | ✅ 9 个：Markdown / JSON / PDF / CSV / **Excel(xlsx)** / **项目JSON** / **项目含数据** / **导入项目** / 参数快照 |
| `DACCore.toXLSX` | ✅ 可用（零依赖写 xlsx） |
| `DACCore.parseXLSXAll` | ✅ 可用（多工作表） |
| 10 万行压测 | ✅ 完成，见 V26_PERFORMANCE_REPORT 附录 |

## V2.6.1 修的问题

| # | 问题 | 根因 |
|---|---|---|
| 4 | 变量角色按钮不显示 | 按钮加在了 `ui.js` 而不是 `index.html` 的面板里 |
| 5 | 10 万行校准 29 秒 | 逐值跑 Monte Carlo，未做值域预计算 |

## 仍未完成

- Firefox / Safari 实机测试（环境只有 Chrome 156）
- xlsx 解析的单元测试（依赖浏览器 `DecompressionStream`）
