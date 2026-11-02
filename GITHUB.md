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
| yunqingyan.xyz | github.com/11sj817/yunqingyan.xyz | `PROJDIR\github-backup\yunqingyan.xyz.git` | 1,085 KB |
| miniature-octo-fiesta | github.com/11sj817/miniature-octo-fiesta | 空仓库，无需备份 | 0 |

> 备份为 **bare mirror**，含全部分支与提交历史。恢复方法：
> ```bash
> git clone PROJDIR\github-backup\yunqingyan.xyz.git yunqingyan-restore
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
