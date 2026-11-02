# 证据索引（全部脱敏）

## 一、本目录文件

| 文件 | 内容 | 脱敏处理 |
|---|---|---|
| `demo_ui_01.png` | DAC-Next demo 初始界面 | 无第三方数据 |
| `demo_ui_02_scene.png` | 异质性分型（PCA 平面，k=3，轮廓 0.466） | 使用虚构数据 |
| `demo_ui_03_rules.png` | 组合效应规则（8 条，人话化） | 使用虚构数据 |
| `demo_ui_04_net.png` | 影响机制网络（15 条边） | 使用虚构数据 |
| `demo_ui_05_calib.png` | 云模型校准（隶属度曲线） | 使用虚构数据 |
| `demo_ui_06_report.png` | 自动生成的 Markdown 报告 | 使用虚构数据 |
| `dac_portal.html` | 门户页 DOM 快照 | 公共页面 |
| `dac_login_old.html` | 旧站登录页 DOM 快照 | **已移除**任何会话标识 |

## 二、REA Evidence

| 工具 | Evidence ID | 用途 |
|---|---|---|
| `list_browser_targets`（CDP 9333） | `ev_d7833c9f4df5ca79c39ac9da5a03c72c6a5d3e1c676e0d778318119bf4b4c9e0` | 确认独立 Chrome 实例可用；仅列 DAC 域页面（首次为空，因为还没打开页面） |
| `list_browser_targets`（CDP 9334） | `ev_a60f51a9134647ae249591a15fd07ca15550aa654cc367c0382f61e82ef1f305` | 干净 profile 下成功枚举到门户页 target `8EF0183546D96647DF2BCA8720F41077` |
| `inspect_web_page` | `ev_8ef3fa787149a7bfe8b24ff5dea5b79cbe7de958d97415c9cb1d19f3061d8f01` | 门户页完整快照：238 个 DOM 节点、A11y 树、脚本清单、存储指纹 |

### inspect_web_page 的关键观测（A 类）

| 观测项 | 结果 |
|---|---|
| 页面标题 | `AI For Service — AI智能服务` |
| DOM 节点数 | 238（含 ::before 伪元素节点） |
| 外部脚本 | **0 个** |
| 内联脚本 | **1 个**，4817 字节 |
| 内联脚本内容 | ① canvas 粒子动画（80 个粒子 + 连线）② 卡片鼠标光晕 ③ "更多服务"toast |
| 外部资源请求 | 0（`network.requests` 为空） |
| localStorage / sessionStorage / IndexedDB | **全部为空** |
| 页面存储用量 | 0 字节 |
| 无障碍树 | 只有静态文本与链接，无表单控件、无 ARIA 角色 |
| WebSocket | 无 |

**结论（A 类）**：门户页是**纯手写静态页**——没有任何前端框架（无 Vue/React/Angular）、没有构建产物、没有 ECharts/D3/Ant Design、没有接口调用、没有任何状态存储。
它唯一"智能"的地方是粒子动画的视觉效果。

> 这条观测很重要：它排除了"新站是现代化重写"的假设，也说明**门户与 DAC 应用之间是硬编码外链，不是 SSO 集成**。

> 环境：Chrome/156.0.8078.48，独立 profile（`.chrome-profile2`），仅监听 `127.0.0.1:9334`，不接入日常浏览器。

## 三、明确不保存的内容

- 账号、密码、Cookie、Authorization、CSRF token
- 任何真实用户的邮箱/学号/访问次数
- 完整 HAR、原始请求体
- 服务器 settings 中的密钥与邮件账号

## 四、可复现说明

所有对旧站的观测都是**只读 GET 与表单 POST**，未做漏洞利用、未做接口模糊测试、未拖库。
若需复核，请自行在浏览器手动登录后按 `04_DAC完整操作手册.md` 的请求序列操作。
