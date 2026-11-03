# 构建与 GitHub Pages 发布

本仓库 Pages 使用 **main 分支 /docs 目录**，公开入口：

https://11sj817.github.io/dac-workbench/

## 发布

```bash
npm ci
npm test
python tests/verify_glm_full.py
# 检查并提交本次源码、文档和验收证据
git commit -m "feat: update analysis workspace and validation"
python build_workbench.py
git add DAC-Workbench.html docs/index.html public/index.html
git commit -m "build: publish verified workbench"
git push origin main
```

使用本机凭据管理器，不把 token 放入脚本、远端 URL 或日志，不使用 `--force`。推送前检查远端有没有新提交。

GitHub Settings → Pages 设置为 Deploy from a branch、`main /docs`；已启用时无需每次重设。

## 核验

1. 检查 Pages 构建成功、公开 URL 返回成功。
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
