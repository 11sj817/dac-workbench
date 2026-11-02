# -*- coding: utf-8 -*-
"""把 12 篇 Markdown 报告 + 6 张图 + 6 张截图打包成**单文件可浏览 HTML**。

特点：
- 单文件自包含：CSS/JS 内联，截图 base64 内联，可离线打开、可直接发人；
- 左侧目录 + 全文搜索 + 打印友好；
- Mermaid / MathJax 走 CDN，离线时自动降级为源码块（仍可读）。
"""
from __future__ import annotations

import base64
import html
import re
from pathlib import Path

ROOT = Path(r"PROJDIR\dac-reverse-research")
OUT = ROOT / "DAC研究报告.html"

SECTIONS = [
    ("00_README.md", "总览", None),
    ("01_产品定位与研究背景.md", "一、产品定位", None),
    ("02_网站整体功能分析.md", "二、网站功能分析", None),
    ("03_DAC数据分析功能说明.md", "三、功能说明", None),
    ("04_DAC完整操作手册.md", "四、操作手册", None),
    ("05_算法与数学原理研究.md", "五、算法与数学原理", None),
    ("06_系统技术架构分析.md", "六、技术架构", None),
    ("07_新旧网站功能对比.md", "七、新旧对比", None),
    ("08_产品缺陷与用户体验分析.md", "八、缺陷与体验", None),
    ("09_DAC创新功能设计.md", "九、创新设计", None),
    ("10_实际测试方案.md", "十、测试方案", None),
    ("11_最终研究结论.md", "十一、最终结论", None),
    ("diagrams/01_网站架构图.md", "图 1 · 网站架构", "diagrams"),
    ("diagrams/02_DAC页面路由图.md", "图 2 · 页面路由", "diagrams"),
    ("diagrams/03_DAC功能结构图.md", "图 3 · 功能结构", "diagrams"),
    ("diagrams/04_数据处理流程图.md", "图 4 · 数据流", "diagrams"),
    ("diagrams/05_算法关系图.md", "图 5 · 算法关系", "diagrams"),
    ("diagrams/06_产品创新架构图.md", "图 6 · 创新架构", "diagrams"),
    ("evidence/INDEX.md", "附 · 证据索引", "appendix"),
]

IMG_RE = re.compile(r"!\[([^\]]*)\]\(<?([^)<>]+)>?\)")


# ---------------------------------------------------------------- inline
def _inline(text: str) -> str:
    """行内转换：代码、加粗、斜体、链接、图片、数学公式保留。"""
    stash: list[str] = []

    def keep(s: str) -> str:
        stash.append(s)
        return f"\x00{len(stash) - 1}\x00"

    # 数学公式整体保留（交给 MathJax）
    text = re.sub(r"\$\$[\s\S]*?\$\$", lambda m: keep(m.group(0)), text)
    text = re.sub(r"\$[^$\n]+\$", lambda m: keep(m.group(0)), text)
    # 行内代码
    text = re.sub(r"`([^`]+)`", lambda m: keep(f"<code>{html.escape(m.group(1))}</code>"), text)
    # 图片
    def img(m: re.Match) -> str:
        alt, src = m.group(1), m.group(2).strip()
        p = (ROOT / src).resolve()
        if p.exists() and p.suffix.lower() == ".png":
            b64 = base64.b64encode(p.read_bytes()).decode()
            return keep(f'<img alt="{html.escape(alt)}" src="data:image/png;base64,{b64}">')
        return keep(f'<span class="missing-img">[图片缺失: {html.escape(src)}]</span>')

    text = IMG_RE.sub(img, text)
    text = re.sub(
        r"<(https?://[^>\s]+)>",
        lambda m: keep(
            '<a href="' + m.group(1) + '" target="_blank" rel="noreferrer">' + m.group(1) + "</a>"
        ),
        text,
    )
    text = html.escape(text)
    # 链接
    text = re.sub(
        r"\[([^\]]+)\]\(([^)\s]+)\)",
        lambda m: f'<a href="{m.group(2)}" target="_blank" rel="noreferrer">{m.group(1)}</a>',
        text,
    )
    # 加粗 / 斜体
    text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<em>\1</em>", text)
    # 恢复占位
    for i in range(20):
        text = re.sub(rf"\x00{i}\x00", lambda m: stash[int(m.group(0)[1:-1])], text)
    return text


# ---------------------------------------------------------------- block
def md_to_html(md: str) -> str:
    lines = md.splitlines()
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]

        # 代码块 / mermaid
        if line.startswith("```"):
            lang = line[3:].strip()
            i += 1
            buf: list[str] = []
            while i < n and not lines[i].startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            body = "\n".join(buf)
            if lang == "mermaid":
                out.append(f'<div class="mermaid">{html.escape(body)}</div>')
            else:
                out.append(f'<pre class="code"><code>{html.escape(body)}</code></pre>')
            continue

        # 表格
        if line.startswith("|") and i + 1 < n and re.match(r"^\|[\s:|-]+\|?\s*$", lines[i + 1]):
            head = [c.strip() for c in line.strip().strip("|").split("|")]
            i += 2
            rows: list[list[str]] = []
            while i < n and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            t = ['<div class="tw"><table><thead><tr>']
            t += [f"<th>{_inline(c)}</th>" for c in head]
            t.append("</tr></thead><tbody>")
            for r in rows:
                t.append("<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in r) + "</tr>")
            t.append("</tbody></table></div>")
            out.append("".join(t))
            continue

        # 分隔线
        if re.match(r"^-{3,}\s*$", line):
            out.append("<hr>")
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            lvl = len(m.group(1))
            txt = _inline(m.group(2))
            anchor = re.sub(r"[^\w\u4e00-\u9fa5]+", "-", m.group(2))[:60]
            out.append(f'<h{lvl} id="{anchor}">{txt}</h{lvl}>')
            i += 1
            continue

        # 引用
        if line.startswith(">"):
            buf: list[str] = []
            while i < n and lines[i].startswith(">"):
                buf.append(lines[i].lstrip(">").strip())
                i += 1
            out.append("<blockquote>" + _inline(" ".join(buf)) + "</blockquote>")
            continue

        # 列表
        if re.match(r"^\s*([-*]|\d+\.)\s+", line):
            ordered = bool(re.match(r"^\s*\d+\.", line))
            items: list[str] = []
            while i < n and re.match(r"^\s*([-*]|\d+\.)\s+", lines[i]):
                items.append(re.sub(r"^\s*([-*]|\d+\.)\s+", "", lines[i]))
                i += 1
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>" + "".join(f"<li>{_inline(x)}</li>" for x in items) + f"</{tag}>")
            continue

        # 空行
        if not line.strip():
            i += 1
            continue

        # 段落
        buf = [line]
        i += 1
        while i < n and lines[i].strip() and not re.match(
            r"^(#{1,6}\s|```|\||>|\s*([-*]|\d+\.)\s)", lines[i]
        ):
            buf.append(lines[i])
            i += 1
        out.append(f"<p>{_inline(' '.join(buf))}</p>")

    return "\n".join(out)


# ---------------------------------------------------------------- build
CSS = """
:root{
  --bg:#0b1016; --side:#0e1620; --card:#111a24; --line:#1f2d3a; --txt:#dbe7f3;
  --dim:#8ba0b3; --acc:#4c9aff; --acc2:#22d3ee; --warn:#f59e0b;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--txt);
     font:15px/1.85 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.layout{display:grid;grid-template-columns:286px 1fr;min-height:100vh}
aside{position:sticky;top:0;height:100vh;overflow:auto;background:var(--side);
      border-right:1px solid var(--line);padding:18px 14px}
aside h1{font-size:15px;margin:0 0 4px;letter-spacing:.5px}
aside h1 b{color:var(--acc2)}
aside .sub{font-size:11.5px;color:var(--dim);margin-bottom:14px;line-height:1.6}
#q{width:100%;background:#0a1119;border:1px solid var(--line);border-radius:8px;
   color:var(--txt);padding:8px 10px;font-size:12.5px;margin-bottom:12px;outline:none}
#q:focus{border-color:var(--acc)}
nav a{display:block;color:var(--dim);text-decoration:none;font-size:12.8px;
      padding:6px 9px;border-radius:7px;border-left:2px solid transparent}
nav a:hover{background:#13202c;color:var(--txt)}
nav a.on{background:#12283d;color:#fff;border-left-color:var(--acc)}
nav .grp{font-size:10.5px;color:#5d7387;letter-spacing:1px;margin:14px 0 6px;padding-left:9px}
main{padding:34px 46px 120px;max-width:1020px}
section{margin-bottom:64px;padding-bottom:34px;border-bottom:1px solid var(--line)}
section:last-child{border:0}
h2{font-size:24px;margin:8px 0 18px;padding-bottom:10px;border-bottom:1px solid var(--line)}
h3{font-size:17px;margin:26px 0 10px;color:#cfe4f7}
h4{font-size:15px;margin:20px 0 8px;color:var(--acc2)}
p{margin:10px 0}
a{color:var(--acc)}
code{background:#16222e;padding:1px 6px;border-radius:5px;font-size:12.8px;
     font-family:Consolas,"Cascadia Mono",monospace;color:#a8dcff}
pre.code{background:#0c1520;border:1px solid var(--line);border-radius:10px;
         padding:14px 16px;overflow:auto;font-size:12.6px;line-height:1.7}
pre.code code{background:none;padding:0;color:#cfe3f5}
.tw{overflow:auto;margin:12px 0;border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:13px;min-width:520px}
th,td{padding:8px 11px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{background:#0f1a25;color:#9fb6c9;font-weight:600;white-space:nowrap}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:#101d29}
blockquote{margin:12px 0;padding:10px 16px;border-left:3px solid var(--acc2);
           background:#0f1a24;border-radius:0 8px 8px 0;color:#bcd2e4}
hr{border:0;border-top:1px solid var(--line);margin:26px 0}
img{max-width:100%;border-radius:10px;border:1px solid var(--line);margin:10px 0;display:block}
ul,ol{margin:10px 0 10px 22px}
li{margin:5px 0}
.mermaid{background:#0c1520;border:1px solid var(--line);border-radius:10px;
         padding:14px;margin:14px 0;overflow:auto;font-size:12.5px;color:#9fb6c9;
         white-space:pre;font-family:Consolas,monospace}
.tag{display:inline-block;font-size:11px;color:var(--dim);border:1px solid var(--line);
     padding:1px 8px;border-radius:20px;margin-right:6px}
mark{background:#4a3a0b;color:#ffe9a8;padding:0 2px;border-radius:3px}
#top{position:fixed;right:22px;bottom:22px;background:#132234;border:1px solid var(--line);
     color:var(--txt);border-radius:10px;padding:9px 14px;cursor:pointer;font-size:12.5px}
@media(max-width:900px){
  .layout{grid-template-columns:1fr}
  aside{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line)}
  main{padding:22px 18px 90px}
}
@media print{
  aside,#top{display:none}
  .layout{display:block}
  main{max-width:none;padding:0}
  body{background:#fff;color:#111}
  section{page-break-after:always;border:0}
  h2{color:#111}
}
"""

JS = """
document.querySelectorAll('nav a').forEach(a=>{
  a.addEventListener('click',()=>{
    document.querySelectorAll('nav a').forEach(x=>x.classList.remove('on'));
    a.classList.add('on');
  });
});
const secs=[...document.querySelectorAll('section')];
const links=[...document.querySelectorAll('nav a')];
const io=new IntersectionObserver(es=>{
  es.forEach(e=>{
    if(e.isIntersecting){
      links.forEach(l=>l.classList.toggle('on', l.getAttribute('href')==='#'+e.target.id));
    }
  });
},{rootMargin:'-45% 0px -50% 0px'});
secs.forEach(s=>io.observe(s));

const q=document.getElementById('q');
q.addEventListener('input',()=>{
  const v=q.value.trim().toLowerCase();
  links.forEach(l=>{
    const sec=document.querySelector(l.getAttribute('href'));
    const hit=!v||sec.textContent.toLowerCase().includes(v);
    l.style.display=hit?'':'none';
  });
});
q.addEventListener('keydown',e=>{
  if(e.key!=='Enter')return;
  const v=q.value.trim().toLowerCase();
  if(!v)return;
  for(const s of secs){
    const i=s.textContent.toLowerCase().indexOf(v);
    if(i>=0){ s.scrollIntoView({behavior:'smooth'}); break; }
  }
});
document.getElementById('top').onclick=()=>window.scrollTo({top:0,behavior:'smooth'});
"""


def build_gallery() -> tuple[str, str]:
    """把 evidence/*.png 内联成图集，返回 (html, nav 项)。"""
    captions = {
        "demo_ui_01": "初始界面：数据 / 变量角色 / 参数三栏 + 6 个结果 Tab",
        "demo_ui_02_scene": "异质性分型：PCA 主成分平面（PC1 解释 83.9%），三簇清晰分离",
        "demo_ui_03_rules": "组合效应：变量重要性 + 单因素对照 + 8 条人话规则",
        "demo_ui_04_net": "影响机制：相关网络（|r|≥0.2 剪枝）+ 节点中心性",
        "demo_ui_05_calib": "云模型校准：多等级隶属度曲线（Ex / En / He）",
        "demo_ui_06_report": "自动生成的 Markdown 分析报告（含全部数字）",
    }
    imgs: list[str] = []
    for p in sorted((ROOT / "evidence").glob("*.png")):
        if p.stem.startswith("report_html"):
            continue
        b64 = base64.b64encode(p.read_bytes()).decode()
        cap = captions.get(p.stem, p.stem)
        imgs.append(
            f'<figure style="margin:18px 0"><img alt="{html.escape(cap)}" '
            f'src="data:image/png;base64,{b64}">'
            f'<figcaption style="font-size:12.5px;color:#8ba0b3;margin-top:6px">'
            f"{html.escape(p.name)} — {html.escape(cap)}</figcaption></figure>"
        )
    body = (
        '<section id="s-gallery"><h2>附 · 截图图集（demo 实跑）</h2>'
        "<p>以下截图全部来自本地 <code>analysis-core</code> 在 1000 条虚构企业数据上的真实运行，"
        "未经任何修饰。用于证明第 3、5、8、9 章中关于「可实现性」的判断。</p>"
        + "".join(imgs)
        + "</section>"
    )
    nav = '<div class="grp">附录</div><a href="#s-gallery">附 · 截图图集</a>'
    return body, nav


def build() -> Path:
    parts: list[str] = []
    nav: list[str] = []
    gallery, gallery_nav = build_gallery()
    last_group = None
    for fname, title, group in SECTIONS:
        p = ROOT / fname
        if not p.exists():
            continue
        sid = "s-" + re.sub(r"[^\w]+", "-", p.stem)
        raw_md = p.read_text(encoding="utf-8")
        raw_md = re.sub(r"^#\s+.*\n+", "", raw_md, count=1)
        body = md_to_html(raw_md)
        parts.append(f'<section id="{sid}"><h2>{html.escape(title)}</h2>{body}</section>')
        gkey = group or "main"
        if gkey != last_group:
            gname = {"diagrams": "图表", "appendix": "附录"}.get(group, "正文")
            nav.append(f'<div class="grp">{gname}</div>')
            last_group = gkey
        nav.append(f'<a href="#{sid}">{html.escape(title)}</a>')

    nav.append(gallery_nav)

    doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DAC 深度逆向研究报告 · 华侨大学数据分析平台</title>
<style>{CSS}</style>
</head><body>
<div class="layout">
<aside>
  <h1>DAC <b>深度逆向研究</b></h1>
  <div class="sub">华侨大学数据驱动分析平台<br>2026-11-02 · 证据分级 A/B/C</div>
  <input id="q" placeholder="搜索全文，回车跳转…">
  <nav>{''.join(nav)}</nav>
</aside>
<main>
<h2 style="margin-top:0">DAC 数据分析平台 · 深度逆向研究报告</h2>
<p><span class="tag">对象 dac.hqu.edu.cn</span><span class="tag">旧站 dacc.w1.luyouxia.net</span>
<span class="tag">12 篇报告</span><span class="tag">6 张架构图</span><span class="tag">REA 证据</span>
<span class="tag">可运行 demo</span></p>
<p>本文件是单文件离线版，所有 Markdown 正文、架构图源码与截图均已内联，
可直接发给别人用浏览器打开。Mermaid 图与 LaTeX 公式需要联网加载渲染库，离线时降级为可读源码。</p>
{''.join(parts)}
{gallery}
</main>
</div>
<button id="top">↑ 顶部</button>
<script>{JS}</script>
<script type="module">
try{{
  const m=await import('https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs');
  m.default.initialize({{startOnLoad:false,theme:'dark',themeVariables:{{fontSize:'13px'}}}});
  await m.default.run({{querySelector:'.mermaid'}});
}}catch(e){{/* 离线：保留源码块 */}}
</script>
<script>
window.addEventListener('load',()=>{{
  if(!window.MathJax){{
    const s=document.createElement('script');
    s.src='https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js';
    s.async=true;
    s.onload=()=>MathJax.typesetPromise();
    document.head.appendChild(s);
  }}
}});
</script>
</body></html>"""

    OUT.write_text(doc, encoding="utf-8")
    return OUT


if __name__ == "__main__":
    p = build()
    print("built:", p, f"{p.stat().st_size/1024:.1f} KB")

