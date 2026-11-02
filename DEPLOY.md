# 部署到 GitHub Pages（永久链接，不用开机）

目标：得到 `https://<你的用户名>.github.io/dac-workbench/`，永久在线、带 HTTPS、不需要本机开机。

---

## 方式 A：网页上传（最简单，不用装任何工具）

1. 打开 https://github.com/new
2. Repository name 填 `dac-workbench`，选 **Public**，点 Create repository
3. 在空仓库页面点 **uploading an existing file**
4. 把 `public/` 文件夹里的 **3 个文件** 拖进去：
   - `index.html`
   - `report.html`
   - `home.html`
5. 点 **Commit changes**
6. 进 **Settings → Pages**
   - Source 选 **Deploy from a branch**
   - Branch 选 **main**，目录选 **/ (root)**
   - 点 Save
7. 等 1~2 分钟，刷新页面，顶部会出现：
   `Your site is live at https://<用户名>.github.io/dac-workbench/`

> 注意：仓库根目录必须有 `index.html`，否则 Pages 会 404。

---

## 方式 B：命令行推送（改了代码想自动更新就用这个）

```bash
cd D:\reverse\dac-reverse-research

# 第一次：关联远程仓库（把 URL 换成你自己的）
git remote add origin https://github.com/<用户名>/dac-workbench.git

# 每次更新后
git add public/index.html
git commit -m "update workbench"
git push
```

推送后 GitHub Pages 会自动重新部署，约 1 分钟生效。

---

## 方式 C：Netlify 拖拽（比 Pages 更快，1 分钟出链接）

1. 打开 https://app.netlify.com/drop
2. 把整个 `public/` 文件夹拖进页面
3. 立刻得到一个 `https://xxx.netlify.app` 的地址（注册后可改域名、长期保留）

---

## 常见问题

**Q：Pages 打开是 404？**
检查仓库根目录有没有 `index.html`，并确认 Settings → Pages 的分支/目录选对了。

**Q：页面白屏？**
按 F12 看 Console。常见原因是把 `index.html` 改坏了（它已经内联了全部 JS，不能拆开）。

**Q：上传 xlsx 报错？**
`file://` 协议下某些浏览器会限制解析。用 `http://` 打开（Pages 就是 http(s)），或让用户另存为 CSV。

**Q：想换成自己的域名？**
Settings → Pages → Custom domain，填域名后在域名商处加 CNAME 记录指向 `<用户名>.github.io`。

**Q：我还想保留原来的临时隧道？**
可以。双击 `一键启动工作台.bat` 即可，两边互不影响。
