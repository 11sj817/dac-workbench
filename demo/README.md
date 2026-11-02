# DAC-Next 基础 Demo

> 用 4 个 Python 文件重写 DAC 的分析链路：**纯函数、零重依赖、可复算**。

## 为什么重写

原系统的问题不是"功能少"，而是**状态散在进程内全局变量里**、**图表是死的 SVG**、**结果不可复现**。
这个 demo 只证明三件事：

1. 那条方法论链路（校准 → 分型 → 规则 → 网络）能在 1 秒内跑完；
2. 每一步都能给出人话解释与图表；
3. 同一份数据 + 同一组参数 + 同一种子 = 同一份结果。

## 文件

| 文件 | 作用 | 行数级别 |
|---|---|---|
| `analysis_core.py` | 全部算法：体检、相关、云模型校准、KMeans、CART、规则、网络、PCA、报告 | ~700 |
| `app.py` | 零依赖 HTTP 服务（标准库 `http.server`），提供上传/运行/报告接口 | ~250 |
| `static/index.html` | 单页前端：6 个 Tab，SVG 自绘图表，无 CDN | ~600 |
| `run_cli.py` | 命令行跑通全链路，产出 `report.md` + `result.json` | ~60 |

## 跑起来

```bash
# 命令行（最快验证）
python demo/run_cli.py
#   elapsed ≈ 0.9s
#   silhouette = 0.466  tree acc = 64.1%  cv = 63.1%±2.8%

# 网页
python demo/app.py
#   打开 http://127.0.0.1:8765
#   自动模式（直接跑示例）：http://127.0.0.1:8765/?auto=1&tab=net
```

依赖：`numpy`、`pandas`、`openpyxl`。**不需要 sklearn / Flask / ECharts / 任何 CDN**。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/sample` | 载入内置示例（1000 条虚构企业数据） |
| POST | `/api/upload` | multipart，字段 `file`（xlsx/csv） |
| POST | `/api/run` | JSON：`dataset_id, target, factors[], low_pct, high_pct, drops, levels, k, tree_depth, net_threshold, seed` |
| GET | `/api/run/<run_id>` | 取回某次运行结果 |
| GET | `/api/report/<run_id>` | 取回 Markdown 报告 |

## 已实现的关键改进（对照原系统）

| 原系统 | 本 demo |
|---|---|
| 校准参数拼进变量名字符串 `名,low,high,iter` | 显式 JSON 参数 |
| 状态存全局变量，多 worker 丢数据 | 纯函数 + `runs/<id>/snapshot.json` |
| KMeans 无 k 控制 | k 可调，实时给轮廓系数 |
| 无交叉验证 | 默认 5 折 CV |
| 规则是等级编码（`融资约束 > 1`） | 人话规则（`融资约束 = 高`） |
| 图表是静态 SVG | 可交互 SVG（散点/PCA/网络/隶属度曲线） |
| 无法导出 | Markdown + JSON 一键下载 |
| 无体检 | 缺失/异常/共线/偏度/重复行全检 |
| 极端值把 KMeans 拆出 n=1 的簇 | 稳健标准化（中位数/IQR + 截断） |

## 已知局限（下一步）

1. 无鉴权、无配额、无多租户（生产前必须补）；
2. 上传文件落本地磁盘，无清理策略；
3. 前端是原生 JS，生产建议换 React + ECharts；
4. 机制网络目前是相关网络，**不是因果**——贝叶斯网络/偏相关尚未实现；
5. 大文件（>10 万行）需要异步任务队列。
