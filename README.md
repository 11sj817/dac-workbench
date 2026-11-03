# DAC Workbench

在浏览器里完成云校准、样本分型、组合规则、贝叶斯网络和验证的中文数据分析工作台。

**[打开在线工作台](https://11sj817.github.io/dac-workbench/)** · [版本说明](RELEASE_NOTES.md) · [数据来源核验](DATA_SOURCES.md) · [前端设计](FRONTEND_DESIGN.md) · [方法与限制](LIMITATIONS.md)

当前版本 **6.6 · Research Beta**，更新于 **2026-11-03**。无需注册或部署后端，数据在本机浏览器中计算；AI 助手为可选功能，需要单独配置接口。

## 用来做什么

适合教学、研究探索，以及对一份表格提出这些问题：

- 样本是否存在不同类型，各类有什么共同特征？
- 哪些条件组合与目标类别共同出现？
- 改变参数、抽样和验证切分后，发现是否稳定？
- 模型在验证样本上的表现与多数类基线相比如何？

采用 DAC 数据驱动分析的思路。校准、分型、规则和网络提供不同观察角度；正式结论仍需领域判断、对照及外部数据。

## 五步开始

1. **导入数据**：选择内置示例或拖入 CSV/XLSX，CSV 会先显示导入预览。
2. **选择变量**：指定目标和条件变量，确认目标类型；在角色设置中标记 ID、时间、分组和权重列。
3. **校准**：调整分位数、云滴数和等级数。无序/有序类别及二分类目标保留原始标签；连续值与计数目标生成 DAC 等级。
4. **运行分析**：设置聚类数、树深、网络阈值和随机种子，点击“运行完整分析”。
5. **验证与导出**：在数据质量页运行严格/嵌套验证，再做 Bootstrap；下载报告或“导出项目（含数据）”以便重开。

仅参数项目不含原始数据，重开时需先提供匹配的数据。含数据项目文件包含原始表格，请按原始数据的保密要求保管。

## 功能

| 模块 | 输出 |
|---|---|
| 数据准备 | 缺失与异常检查、角色设置、工作表选择、稳定行号 |
| 云模型校准 | 构造式正态云、分位数定标、等级分布、隶属度 |
| 异质性分型 | KMeans、轮廓系数、PCA、簇特征与样本下钻 |
| 组合规则 | CART、支持度/置信度、变量重要性、等级条件和参考范围 |
| 关系分析 | 相关网络、BN 结构学习、按目标类别查看条件概率 |
| 验证 | 严格 CV、时间/分组切分、嵌套验证、逐行 OOF 记录 |
| 稳定性 | 参数扫描、Bootstrap 分型/规则/BN 稳定性 |
| GLM | Gaussian、Binomial、Poisson、Gamma(log/inverse)、Negative Binomial |
| AI 助手 | 可选接口、流式回复、停止生成、聚合数据发送预览 |
| 交付 | Markdown、JSON、CSV、XLSX、Word、会话与项目文件 |

## 6.6 更新

- **来源透明**：UCI 官方文件逐行核对，记录源文件行号及 SHA-256；区分公开样本、合成演示与未核验的上传数据。来源状态和严格 CV 状态分别展示。
- **前端体验**：长摘要默认折叠，模块图标统一为本地 SVG，窄屏补全步骤导航及触控尺寸，来源详情可展开、下载。
- **稳定性**：Worker 超时真正终止线程并释放资源；重复运行、延迟上传、切换数据和修改参数不会继续显示旧结果。
- **导出边界**：仅参数项目不再通过元数据携带内置样本数据行；重新打开项目时不信任项目自称的“官方来源”。
- **发布检查**：GitHub Actions 在测试、样本指纹、源码与三个构建产物一致性全部通过后发布 Pages。

### 6.5 计算修复

- 界面改为分组模块导航、分步配置和当前分析摘要；保留浅色/深色主题，增加键盘焦点、跳转链接及窄屏布局。
- 统一目标编码和已选变量，六类目标不被云等级数合并；规则条件独立使用每列标签。
- 时间验证按真实时间构建训练集，处理倒序、乱序、重复与无效时间。
- 嵌套验证保留分析配置，汇总指标可从逐行 OOF 记录重算。
- 修复 GLM 频率权重、小样本 Student-t、Gamma inverse 和信息准则口径。
- 修复项目恢复、种子 0、导出标签和项目版本信息，保留原有 AI 流式能力。

## 本地使用与开发

运行站点不需要 npm 依赖。双击 `DAC-Workbench.html`，或运行：

```bash
python -m http.server 8788 --directory public
```

打开 `http://127.0.0.1:8788`。建议通过 HTTP(S) 使用文件导入与 Worker。

开发环境：Node.js ≥22.12、Python 3。Node 依赖只用于界面集成测试：

```bash
npm ci
npm test
python data/verify_sources.py --check
python build_workbench.py
python build_workbench.py --check
```

独立统计参考验证需要 NumPy、SciPy、statsmodels：

```bash
python -m pip install numpy scipy statsmodels
python tests/verify_glm_full.py --output evidence/v65-glm-reference.json
```

`DAC_NODE` 可指定 Node 可执行文件。脚本逐项检查系数、SE、p/CI、deviance、Pearson、自由度、似然和 AIC/BIC，失败返回非零退出码，不跳过 Gamma inverse。

## 构建与发布

编辑 `workbench/` 后运行 `python build_workbench.py`。同一构建生成三份内容一致的文件：

- `DAC-Workbench.html`：便携单文件。
- `public/index.html`：静态服务器入口。
- `docs/index.html`：本仓库 GitHub Pages 入口。

构建信息包含源码提交、工作区状态和正文摘要。源码提交与发布提交可以不同，应同时核对正文摘要和文件哈希。`--check` 只检查已提交产物，不改写文件。GitHub Actions 验证后将 `docs/` 作为一个制品发布。流程见 [DEPLOY.md](DEPLOY.md)。

## 验证和边界

6.6 包含 **19 套 JavaScript 测试**，保留 6.5 的 **171 项 GLM 参考对账**（本轮不修改统计内核）。界面测试执行实际事件处理器，覆盖六类 CSV 上传、取消变量、严格/嵌套验证、Bootstrap、文件生成及项目重开，另有来源与任务取消/超时回归检查。当前验收见 [VALIDATION_V66.md](VALIDATION_V66.md)。

DOM 集成测试不能证明真实浏览器排版、手机触控、Worker 调度和 AI 提供商连接已通过。Gamma inverse 通过指定合成样本对账，也不代表任意数据都收敛。详见[验收记录](VALIDATION_V65.md)。

目前仍不支持多项/有序 logit、分析权重（aweights）及聚类稳健标准误。网络方向和条件敏感度不构成因果证明。完整边界见 [LIMITATIONS.md](LIMITATIONS.md)。

## 数据和参考

内置 Iris、Wine Quality、Student Performance、Abalone、Auto MPG、WDBC 已与 UCI 官方文件逐行核对；七种公开配置共 2250 行，其中 Student 两种配置共用同一份 400 行数据。企业创新绩效为完全虚构的合成数据。核验一致不等于原研究或当前模型无偏，上传数据真实性也不会被平台自动确认。引用、转换、许可与可复核记录见 [DATA_SOURCES.md](DATA_SOURCES.md)。

方法参考：李海林、林春培《复杂系统影响因素研究的数据驱动分析方法》，清华大学出版社，ISBN 9787302685456。本项目是独立研究实现，不承诺与原站实现或数值等价。

## 目录

```text
workbench/            页面、交互、算法、预处理、Worker
data/                 示例数据及生成脚本
tests/                算法、配置一致性、统计参考及 DOM 测试
evidence/             验收与统计对账记录
docs/                 GitHub Pages 产物
public/               静态部署产物
build_workbench.py    统一构建入口
```

历史研究资料和版本报告保留在仓库中；当前能力、入口及限制以本 README 和 6.5 文档为准。
