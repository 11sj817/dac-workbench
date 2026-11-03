# 6.5 验收记录

日期：2026-11-03。源码基线：`b2dcde3`。本轮使用合成数据和公开示例，不包含用户私有业务数据。

## 自动化

| 边界 | 结果 | 复现 |
|---|---|---|
| JavaScript 回归 | 18 套通过，含原有算法及新回归 | `npm test` |
| 时间/目标/配置 | 倒序、乱序、同时间、无效时间、六类、OOF、BN/Bootstrap/参数扫描 | `node tests/test_contract_revision.js` |
| GLM 频率复制 | 六种 family 与复制观测比较 | `node tests/test_glm_revision.js` |
| GLM 独立参考 | 171/171，0 豁免、0 跳过 | `python tests/verify_glm_full.py` |
| 界面集成 | 实际 UI 事件、上传导出、项目恢复 | `node tests/test_workspace.js` |

统计记录见 [evidence/v65-glm-reference.json](evidence/v65-glm-reference.json)，参考环境为 NumPy 2.4.4、SciPy 1.18.1、statsmodels 0.15.0。

六个 family 均覆盖无权重和频率权重，另有 n=10、df=8、t=2.2 小样本反例。检查系数、SE、统计量、p、CI、deviance、Pearson、自由度、似然、AIC、BIC、离散参数及收敛。

## 界面路径

1. 操作指引加载示例，确认没有隐式运行。
2. 取消因子，逐步前进、运行并打开各模块。
3. 通过真实文件 change 事件导入 120 行六类 CSV。
4. 只保留一个变量，运行主分析、严格/嵌套验证、BN、规则 Bootstrap。
5. 核对六类保留、未选列不进入验证、OOF 可独立重算。
6. 点击生成 Word、会话、Excel 和含数据项目，再解析生成文件。
7. 改变当前选择后导入该项目，核对数据指纹、类型、因子、种子 0 并重新计算。
8. 切换主题/外观，检查未捕获 JavaScript 错误。

可用 `DAC_SITE_HTML` 对下载的公开产物执行相同路径。可设置 `DAC_UI_ARTIFACTS` 保存生成文件以独立检查。

## 实机边界

已登记 Edge 通道返回 `PRIVILEGED_NATIVE_PIPE_UNAVAILABLE`。只读隔离检查通过不代表页面连接成功。本轮 DOM 测试不写成真实浏览器点击。

真实浏览器排版、手机触控、Worker 进度/取消、跨浏览器、原生 Word 排版及 AI 提供商连接尚未完成本轮验收。响应式样式和深浅主题已实现；实现与实机验证分别记录。

## 发布

发布验收检查远端 main、Pages 构建、公开文件 SHA-256，并对下载产物重跑界面路径。发布证据记录在 `evidence/v65-release.json`，只在真实核验后写入。构建摘要与源码提交由生成文件中的 `window.__BUILD__` 给出。
