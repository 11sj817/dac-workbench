# 证据截图索引

本目录只保留**当前版本**的截图。历史版本的图已删除——它们展示的是旧 UI（
例如已修正的「机制强度」措辞、13 个横排标签页），留着会误导。

## 隐私说明

目录内所有截图都经过检查：

- **API Key 一律完全掩码**，界面只显示 `已设置 · N 位 · ****`，不显示任何明文字符
- 输入框里的 `••••••` 是浏览器密码框的默认渲染，不是真实内容
- 没有本机绝对路径、没有仓库 token、没有真实用户数据（使用的都是公开数据集）

## 当前版本截图

| 文件 | 内容 | 对应版本 |
|---|---|---|
| `v39_ai_page.png` | AI 助手页：浅色主题 + 左导航 + 证据入口 + 设置折叠 + **智谱 CORS 提示** | V3.8 |
| `v39_evidence_table.png` | 报告页证据登记表（HTML 版，8 列） | V3.7 |
| `v35_light.png` | 浅色纸面主题 + 左侧固定导航 | V3.5 |
| `v35_dark.png` | 深色主题（默认） | V3.5 |
| `v35_live.png` | 线上版本实测 | V3.5 |
| `ff_home.png` | **Firefox 159** 首页渲染 | V3.7 |
| `ff_auto.png` | Firefox 载入数据后 | V3.7 |
| `ff_full.png` | Firefox 全流程（摘要 + 证据入口 + 报告按钮） | V3.7 |
| `v30_glm.png` | 统计建模页（GLM 拟合结果） | V3.0 |
| `v30_live.png` | 线上 GLM 实测 | V3.0 |
| `gh_pages.png` | GitHub Pages 部署成功 | V2.x |

## 复现方式

截图都由 CDP（Chrome DevTools Protocol）或 WebDriver（Firefox）自动拍摄，
不是手工截屏。脚本在 `tests/`：

- `tests/ff_test.js` — Firefox 全流程（geckodriver）
- 其余为 Chrome CDP 脚本，随各版本提交记录可查

## 数据来源

截图中使用的都是公开数据集（Iris / Auto-MPG / WDBC / Wine / Abalone /
Student Performance / 合成企业数据），随页面内置，不含任何真实个人信息。
