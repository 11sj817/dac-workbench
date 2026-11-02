# GitHub 账号与仓库约定

## 账号

| 项 | 值 |
|---|---|
| 账号 | **11sj817** |
| 主页 | https://github.com/11sj817 |
| 后续所有 GitHub 操作 | 一律使用此账号（不再切换） |

## 当前保留的仓库

| 仓库 | 用途 | 地址 |
|---|---|---|
| **dac-workbench** | DAC 数据分析工作台（唯一保留） | https://github.com/11sj817/dac-workbench |
| 站点 | GitHub Pages（main / docs） | https://11sj817.github.io/dac-workbench/ |

## 已删除的仓库（本地有完整备份）

| 仓库 | 原地址 | 备份位置 | 大小 |
|---|---|---|---|
| yunqingyan.xyz | github.com/11sj817/yunqingyan.xyz | `<本地备份目录>/yunqingyan.xyz.git` | 1,085 KB |
| miniature-octo-fiesta | github.com/11sj817/miniature-octo-fiesta | 空仓库，无需备份 | 0 |

> 备份为 **bare mirror**，含全部分支与提交历史。恢复方法：
> ```bash
> git clone <本地备份目录>/yunqingyan.xyz.git yunqingyan-restore
> cd yunqingyan-restore
> git remote set-url origin https://github.com/11sj817/yunqingyan.xyz.git
> git push --mirror
> ```

## 本地 Git 配置

```bash
# 项目内已配置（仅本仓库生效）
git config user.name "DAC Workbench"
git config user.email "dac-workbench@users.noreply.local"

# 远程地址（干净的，不含 token）
git remote -v
# origin  https://github.com/11sj817/dac-workbench.git (fetch)
# origin  https://github.com/11sj817/dac-workbench.git (push)
```

## 更新站点的标准流程

```bash
python data/make_samples.py     # 若换数据
python build_workbench.py       # 生成 DAC-Workbench.html
cp DAC-Workbench.html docs/index.html
git add -A && git commit -m "update"
git push                        # Pages 约 1 分钟后生效
```

## 安全约定

- 不把 API Key / Token 写进仓库、README、日志。
- 推送时如需内嵌 token，**推送后立刻把 remote 改回干净 URL**。
- 敏感凭据只走：`git credential fill`（本机凭据管理器）或环境变量。

## 账号选择弹窗的处理约定（重要）

推送时如果弹出 GitHub「Select an account」对话框：

1. **永远选第一个 `11sj817`**
2. 绝对**不要**选 `x-access-token` —— 那是把 token 拼进 remote URL 产生的伪账号

**为什么会冒出 x-access-token**：当 remote 写成
`https://x-access-token:<token>@github.com/...` 时，Git Credential Manager 会把它当成独立账号写入凭据管理器：
`LegacyGeneric:target=git:https://x-access-token@github.com`

**清理命令**（已执行过一次）：

```powershell
cmdkey /delete:"LegacyGeneric:target=git:https://x-access-token@github.com"
```

**正确的推送方式**（不污染 remote、不产生伪账号）：

```powershell
$token = (( "protocol=https`nhost=github.com`n`n" | git credential fill ) -split "`n" |
          Where-Object { $_ -like 'password=*' }) -replace '^password=',''
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token"))
git -c http.extraheader="Authorization: Basic $b64" push origin main
```

这样 token 只存在这一条命令的 header 里，**不写 remote、不写凭据管理器、不进 shell history 文件**。
