# V2.6 架构说明

## 分层

```
index.html          外壳：顶部导航 / 左栏 / 中区 / 右栏（方法论）/ 底部状态栏
 ├─ ui.js           交互层：状态机、12 个页签、图表 SVG、AI 助手
 │   ├─ WK          Worker 调度器（进度 / 取消 / 超时 / 防重复）
 │   ├─ esc()       统一 HTML 转义（XSS 防护）
 │   └─ runQuality   数据质量：填补 / 严格CV / 泄漏审计
 ├─ core.js         算法层：云模型 / KMeans / CART / PCA / 贝叶斯网络 / 严格CV / 审计
 ├─ preprocess.js   预处理层：缺失诊断 / 五种填补 / Gower 距离
 └─ worker.js       Worker 内核：在 Blob 中与 core+preprocess 合并后独立运行
```

## 单文件构建

`build_workbench.py` 把 4 个 JS 与 3 份数据集合并成一个 HTML：

```
samples.js → window.__DATASETS__
preprocess.js + core.js + worker.js → window.__WORKER_SRC__（字符串）
preprocess.js + core.js + ui.js     → 主线程执行
```

Worker 通过 `Blob + URL.createObjectURL` 动态创建，**无外部文件依赖**，因此可以直接部署到 GitHub Pages。

## Worker 任务表

| task | 用途 | 输入 |
|---|---|---|
| `strictCV` | 严格无泄漏交叉验证 | rawX / yRaw / names / labels / opts |
| `bootstrap` | 聚类 + 规则 + 重要性稳定性 | X / y / B / seed |
| `bnLearn` | 贝叶斯结构搜索 | discrete / levels / opts |
| `bnInferBatch` | 多场景推断 | model / scenarios |
| `pca` | 主成分 | X / labels / y |
| `elbow` | 肘部曲线 | X / ks / seed |
| `repeatedCV` | 重复交叉验证 | X / y / repeats |
| `knnImpute` | 大数据 KNN 填补 | rows / names / fitOpts |

## 调度协议

```
主线程                       Worker
  postMessage({id,task,payload})
                             post({id,status:'start'})
  ← 忽略（非终态）
                             post({id,status:'progress',progress})
  ← onProgress(p)
                             post({id,status:'done',result})
  ← resolve(result) / 若无结果则超时 reject
```

**关键**：`start` / `pong` 属非终态消息，绝不能清 pending（V2.6 开发中踩过这个坑，见 CHANGELOG）。

## 降级路径

`typeof Worker === 'undefined'` 或 Blob 创建失败 → `WK.supported = false`：
- 底部状态栏显示「不可用（降级主线程）」
- `WK.run` 立即 reject `NO_WORKER`
- 调用方捕获后走同步 `C.crossValidateStrict(...)`，**结果一致，只是阻塞主线程**

## 状态与缓存

| 槽位 | 内容 |
|---|---|
| `S.rows` | 当前分析数据 |
| `S.rowsRaw` | 原始数据（不可被注入缺失污染） |
| `S.rowsWork` | 模拟缺失后的演示数据 |
| `S.res` | 主分析结果 |
| `S.extra` | 懒加载结果（elbow / robust / quality） |
