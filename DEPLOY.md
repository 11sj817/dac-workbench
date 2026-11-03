# 构建与 GitHub Pages 发布

本仓库使用 **GitHub Actions 验证后发布 Pages**；发布内容仍来自 `docs/`，公开入口：

https://11sj817.github.io/dac-workbench/

## 发布

```bash
npm ci
npm test
python data/verify_sources.py --check
# 统计内核改变时另跑 python tests/verify_glm_full.py
# 检查并提交本次源码、文档和验收证据
git commit -m "feat: update analysis workspace and validation"
python build_workbench.py
python build_workbench.py --check
git add DAC-Workbench.html docs/index.html public/index.html
git commit -m "build: publish verified workbench"
git push origin main
```

使用本机凭据管理器，不把 token 放入脚本、远端 URL 或日志，不使用 `--force`。推送前检查远端有没有新提交。

GitHub Settings → Pages 的构建源为 **GitHub Actions**（`build_type=workflow`）。工作流 `.github/workflows/pages.yml` 使用固定的 action 提交，先核验数据指纹、源码与三个产物一致性，再运行所有测试及打包产物的界面测试；成功后才上传并部署。PR 仅检查不发布。发布队列串行化，防止多个版本交叉部署。

构建不在 CI 中隐式改写已提交产物；`--check` 失败必须在源码分支重新构建和提交。没有后端、数据库或运行时密钥的静态分析功能可独立使用；AI 接口仍由用户配置。

## 核验

1. 检查本次提交的 `Verify and publish DAC` 工作流中 verify/deploy 均成功，公开 URL 返回成功。
2. 下载公开 HTML，与 `docs/index.html` 比较完整 SHA-256。
3. 核对 `window.__BUILD__` 的摘要与源码提交。源码提交不同于包含产物的部署提交是正常的。
4. 对下载产物执行界面集成测试：

```powershell
$env:DAC_SITE_HTML = 'C:\Temp\deployed.html'
node tests/test_workspace.js
Remove-Item Env:DAC_SITE_HTML
```

DOM 测试执行下载产物的实际处理器，不替代真实浏览器视觉、手机或 Worker 验收。

## 本地与其他托管

`python -m http.server 8788 --directory public`，或把 `public/` 交给静态托管。便携使用 `DAC-Workbench.html`。修改 `workbench/` 源码，生成文件会在下次构建被覆盖。

## 回退

```bash
git revert <发布提交> <源码提交>
git push origin main
```

重新检查 Pages 和公开文件哈希。历史报告中的旧入口、文件大小和测试数量不能作为当前状态证据。

若需要撤回 Actions 迁移，可把 Pages 构建源改回 `legacy`，source 设为 `main /docs`，并撤销本版提交。回退不需要重写 Git 历史；切回后仍需检查公开 HTML 指纹。
