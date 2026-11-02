# DAC Workbench

> 基于 DAC（数据驱动分析方法）思想的可交互数据分析工作台。
> 纯前端单文件，零依赖、零后端，所有计算在浏览器本地完成。

**在线体验：https://11sj817.github.io/dac-workbench/**

仓库：https://github.com/11sj817/dac-workbench

---

## 它做什么

按 DAC 方法论的四个环节，把「一堆 Excel」变成「能写进论文的结论」：

| 环节 | 方法 | 对应文献 |
|---|---|---|
| 1. 数据校准 | 正态云模型（分位数定标 + 云滴 Monte Carlo 隶属度） | 书 3.4 |
| 2. 异质性分型 | KMeans + 轮廓系数 + 肘部曲线 + PCA 可视化 + 情境自动命名 | 书 4 章 |
| 3. 组合效应 | CART 决策树 → IF-THEN 规则 + 支持度/置信度 + 5 折交叉验证 | 书 5 章 |
| 4. 影响机制 | 相关网络 + **贝叶斯网络（BIC 结构学习 + 敏感度分析）** | 书 6 章 |

参考：李海林、林春培《复杂系统影响因素研究的数据驱动分析方法》，清华大学出版社，ISBN 9787302685456。

## 功能清单

- 数据：拖拽上传 xlsx / csv；内置 3 份公开数据（红酒质量、学生成绩、企业绩效）
- 体检：缺失、IQR 异常值、偏度、类型识别，表头可点排序
- 校准：分位数 / 云滴数 / 等级数可调，实时隶属度曲线
- 分型：k 可调、轮廓系数、PCA 散点、肘部曲线、情境自动命名
- 规则：人话规则（`IF 融资约束 = 高 且 专利数量 = 低 → 绩效 = 低`）、变量重要性、单因素对照
- 网络：相关网络 + 阈值剪枝 + 点击高亮
- 贝叶斯网络：结构学习、CPT、敏感度表（`固定融资约束=高 → 高绩效概率 18.2%`）
- 稳健性：7 组参数变体自动对比，判定结论是否稳健
- AI 助手：可接入 DeepSeek / OpenAI / 通义，**AI 只推荐参数和写文字，数字必须来自本地计算**，并做数字溯源校验
- 导出：Markdown 报告、JSON 结果、校准后 CSV、参数快照、打印 PDF

## 本地打开

直接双击 `DAC-Workbench.html`（xlsx 解析在 `file://` 下可能被浏览器限制，CSV 不受影响）。

或起一个静态服务：

```bash
python -m http.server 8788 --directory public
# 打开 http://127.0.0.1:8788
```

## 重新构建

```bash
python data/make_samples.py      # 生成示例数据集（需要 pandas）
python build_workbench.py        # 合并 workbench/* + data/samples.js → DAC-Workbench.html
```

产物：`DAC-Workbench.html`（约 190 KB，自包含）。

## 目录

```
workbench/core.js      算法内核（CSV/XLSX 解析、云模型、KMeans、CART、PCA、贝叶斯网络）
workbench/ui.js        交互层（步骤流、11 个结果 Tab、AI 助手）
workbench/index.html   结构与样式
data/samples.js        三份示例数据（红酒 / 学生 / 企业）
data/make_samples.py   示例数据生成脚本
public/                可直接部署的静态站点
DAC研究报告.html        DAC 原站的深度逆向研究报告
```

## 数据来源

- Wine Quality：UCI ML Repository，Cortez et al., 2009（公开数据集）
- Student Performance：UCI ML Repository，Cortez & Silva, 2008（公开数据集）
- 企业创新绩效：本项目合成（完全虚构，不含任何真实企业信息）

## 许可

代码 MIT。示例数据遵循各自原始许可（UCI 数据集可自由用于研究与教学）。

---

**注意**：网络边与贝叶斯网络的方向代表条件依赖，**不是因果证明**。要论证因果需借助工具变量、DID、断点回归等识别策略。

