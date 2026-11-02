# -*- coding: utf-8 -*-
"""用真实 Key 跑 AI 两个核心功能，并做数字溯源校验。"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(r"PROJDIR\dac-reverse-research")
KEY = sys.argv[1] if len(sys.argv) > 1 else ""
BASE = "https://api.deepseek.com/v1"
MODEL = "deepseek-chat"

if not KEY:
    print("用法: python _ai_live_test.py <key>")
    sys.exit(2)

brief = json.loads((ROOT / "workbench" / "_brief.json").read_text(encoding="utf-8"))


def call(messages, max_tokens=1400, temperature=0.25):
    body = json.dumps({"model": MODEL, "messages": messages,
                       "temperature": temperature, "max_tokens": max_tokens}).encode()
    req = urllib.request.Request(
        BASE + "/chat/completions", data=body, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}",
                 "User-Agent": "dac-workbench-test/1.0"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=90) as r:
        j = json.loads(r.read().decode())
    return j["choices"][0]["message"]["content"], j.get("usage", {}), time.time() - t0


def collect_numbers(o, acc=None):
    acc = acc if acc is not None else set()
    if isinstance(o, bool):
        pass
    elif isinstance(o, (int, float)):
        acc.add(abs(float(o)))
    elif isinstance(o, list):
        for x in o:
            collect_numbers(x, acc)
    elif isinstance(o, dict):
        for v in o.values():
            collect_numbers(v, acc)
    return acc


def expand(base):
    s = set(base)
    arr = [x for x in base if 0 < x < 1e6][:60]
    for i in range(len(arr)):
        for j in range(i + 1, len(arr)):
            a, b = arr[i], arr[j]
            s.add(abs(a - b))
            s.add(abs((a - b) / (a or 1) * 100))
            s.add(a / b)
            s.add(b / a)
    return s


def audit(text, res):
    base = collect_numbers(res)
    for k in ("factors", "rules", "columns", "labels"):
        v = res.get(k)
        if isinstance(v, list):
            base.add(float(len(v)))
    allow = sorted(expand(base))
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", text)]
    bad = []
    for n in nums:
        if n <= 4:
            continue
        hit = False
        for cand in (n, n / 100.0, n * 100.0):
            for y in allow:
                if abs(y - cand) <= max(0.02, abs(y) * 0.02):
                    hit = True
                    break
            if hit:
                break
        if not hit:
            bad.append(n)
    return sorted(set(bad))[:8]


lines: list[str] = []
lines.append("# AI 接入实测报告\n")
lines.append(f"- 时间：{time.strftime('%Y-%m-%d %H:%M:%S')}")
lines.append(f"- 服务：{BASE} · 模型 {MODEL}")
lines.append(f"- Key：`{KEY[:4]}…{KEY[-4:]}`（长度 {len(KEY)}）")
lines.append(f"- 数据：{brief['dataset']}（{brief['used']} 条有效样本）\n")

# ---------- 测试 1：参数建议 ----------
print("[1/2] 让 AI 给参数建议 ...")
p1 = f"""你是一位管理学研究方法顾问。以下是用户数据的体检结果与当前分析参数：
{json.dumps(brief, ensure_ascii=False, indent=1)}

请只输出 JSON，不要解释，格式：
{{"target":"","factors":[""],"lowPct":25,"highPct":75,"levels":3,"k":3,"treeDepth":3,"netThreshold":0.2,"reason":"一句话说明为什么这样选"}}
要求：factors 必须来自 columns；k 在 2-6；treeDepth 1-4；levels 2-4；netThreshold 0.1-0.5。"""

try:
    t1, u1, d1 = call([{"role": "user", "content": p1}])
    ok_json = False
    plan = None
    m = re.search(r"\{[\s\S]*\}", t1)
    if m:
        try:
            plan = json.loads(m.group(0))
            ok_json = True
        except Exception as e:  # noqa: BLE001
            plan = {"parse_error": str(e)}
    lines.append("## 1. 生成分析方案\n")
    lines.append(f"- 耗时：{d1:.1f}s · 用量 prompt={u1.get('prompt_tokens')} / completion={u1.get('completion_tokens')}")
    lines.append(f"- JSON 解析：{'✅ 成功' if ok_json else '❌ 失败'}")
    if plan:
        lines.append(f"- 建议：`{json.dumps(plan, ensure_ascii=False)}`")
    lines.append("\n<details><summary>原始返回</summary>\n\n```\n" + t1[:2500] + "\n```\n</details>\n")
    print(f"    HTTP OK · {d1:.1f}s · json={ok_json}")
except Exception as e:  # noqa: BLE001
    lines.append("## 1. 生成分析方案\n\n❌ 调用失败：%s\n" % e)
    print("    FAILED:", e)
    ok_json = False

# ---------- 测试 2：解读结果 ----------
print("[2/2] 让 AI 解读结果 ...")
p2 = f"""你是论文写作助手。下面是一次数据分析的真实结果（JSON）：
{json.dumps(brief, ensure_ascii=False, indent=1)}

请用中文写 3 段：
1) 数据与分型：样本、情境划分、各情境特征；
2) 条件组合规则：挑 2 条最重要的规则，说明业务含义；
3) 机制与边界：哪个变量最关键（给出概率变化），并声明"相关不等于因果"。
要求：只能使用 JSON 里出现过的数字；不要编造变量名；语气客观。"""

try:
    t2, u2, d2 = call([{"role": "user", "content": p2}])
    bad = audit(t2, brief)
    lines.append("## 2. 解读分析结果\n")
    lines.append(f"- 耗时：{d2:.1f}s · 用量 prompt={u2.get('prompt_tokens')} / completion={u2.get('completion_tokens')}")
    lines.append(f"- 数字溯源校验：{'✅ 全部命中' if not bad else '⚠️ 未命中 → ' + ', '.join(str(x) for x in bad)}")
    lines.append("\n### 生成正文\n\n" + t2 + "\n")
    print(f"    HTTP OK · {d2:.1f}s · 未命中数字={bad}")
except Exception as e:  # noqa: BLE001
    lines.append("## 2. 解读分析结果\n\n❌ 调用失败：%s\n" % e)
    print("    FAILED:", e)

out = ROOT / "AI_TEST_REPORT.md"
out.write_text("\n".join(lines), encoding="utf-8")
print("\n报告已写入:", out)
