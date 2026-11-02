# Bootstrap 方法说明

> 引擎：`workbench/bootstrap.js`
> 接口：`DACBootstrap.run(data, opt, onProgress)` / `sampleIndices` / `summarize` / `diagnose`

## 一、支持的重采样方案

| method | 抽样单位 | 适用 | 不适用 |
|---|---|---|---|
| `iid` | 单条记录 | 独立同分布横截面数据 | 重复测量、面板、时间序列 |
| `group` | **整组** | 同一受试者/企业/地区多次观测 | — |
| `stratified` | 层内独立抽样 | 需要保持层结构的抽样调查 | 层太小（每层 < 2） |
| `weighted` | 按权重概率（PPS 系统抽样） | 复杂抽样设计、事后分层 | 权重与样本量混淆时 |

**关键约束**（写进代码注释与文档）：
- 普通行级 IID 抽样会拆散同一受试者的多条记录 → 低估方差、高估稳定性。有此结构必须用 `group`。
- **时间序列不能用 IID 冒充**。本引擎未实现 Block Bootstrap，时间依赖数据应禁用或明确标注局限性。

## 二、抽样实现细节

```js
sampleIndices({ n, B, seed, fraction, replacement, method, groups, strata, weights })
```

- 用的是 **mulberry32** 确定性 PRNG，同 seed 逐位复现
- `fraction` 控制每次抽 多少比例（默认 1，即 n 条）
- `replacement=false` 时走洗牌取前 k 个
- 分组抽样：先按组聚合，再**整组重复抽取**，组内记录完整进入
- 加权抽样：系统抽样（cumulative weight + 等距起点），O(n+k) 而非 O(nk)

## 三、每次重采样保存什么

```js
{ b, idx, ok, error, ms, labels, sizes, emptyClusters, inertia, silhouette,
  accuracy, rules, rootVar, splits, graph, score }
```

- `idx`：原始样本索引（有放回时含重复，保留对应关系）
- 失败的那次记 `error`，**不计入成功率分母之外**，也不会被当成"无边/无规则"

## 四、评价指标

| 指标 | 定义 | 性质 |
|---|---|---|
| ARI | 调整兰德指数 | **标签置换不变**，修正随机一致 |
| NMI | 互信息 / 熵的算术平均 | 标签置换不变 |
| 共聚类概率 C(i,j) | 同簇次数 / 共同参与次数 | 分母为 0 时返回 **NaN**，不是 0 |
| 规则签名 | 条件排序后拼接 | 与节点编号无关 |
| 边频率 | 方向出现次数 / **成功学习次数** | 失败不稀释分母 |

## 五、置信区间

`p05 ~ p95` 是**分位数区间**（2.5% / 97.5%），不是严格的 95% 置信区间。
Bootstrap 重采样之间**不独立**，不能把分位数区间直接当频率派置信区间宣称。
