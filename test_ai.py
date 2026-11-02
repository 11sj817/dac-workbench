# -*- coding: utf-8 -*-
"""AI 接入连通性测试：验证 Key、模型、CORS（能否前端直连）。"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

UA = {"User-Agent": "dac-workbench-test/1.0", "Content-Type": "application/json"}


def post(url: str, key: str, model: str, timeout: int = 45) -> tuple[int, dict | str, float]:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": "只回复两个字：可用"}],
        "temperature": 0,
        "max_tokens": 16,
    }).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={**UA, "Authorization": f"Bearer {key}"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read().decode("utf-8", "replace")
            return r.status, data, time.time() - t0
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace"), time.time() - t0
    except Exception as e:  # noqa: BLE001
        return -1, str(e), time.time() - t0


def check_cors(base: str, key: str) -> str:
    """浏览器预检：看服务端是否回 Access-Control-Allow-Origin。"""
    req = urllib.request.Request(
        base.rstrip("/") + "/chat/completions", method="OPTIONS",
        headers={
            "Origin": "https://11sj817.github.io",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
            **UA,
        })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            allow = r.headers.get("Access-Control-Allow-Origin")
            return f"预检 {r.status} · ACAO={allow or '（缺失）'}"
    except urllib.error.HTTPError as e:
        return f"预检 {e.code} · ACAO={e.headers.get('Access-Control-Allow-Origin') or '（缺失）'}"
    except Exception as e:  # noqa: BLE001
        return f"预检失败：{e}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", default="")
    ap.add_argument("--keyfile", default=r"PROJDIR\api-key.txt")
    ap.add_argument("--base", default="https://api.deepseek.com/v1")
    ap.add_argument("--model", default="deepseek-chat")
    args = ap.parse_args()

    key = args.key.strip()
    if not key:
        try:
            key = open(args.keyfile, encoding="utf-8").read().strip()
        except FileNotFoundError:
            print(f"✗ 找不到 key 文件：{args.keyfile}")
            print("  把 key 单独写进这个文件（一行，别加引号），再跑一次。")
            return 2
    if not key:
        print("✗ key 为空")
        return 2

    masked = key[:4] + "…" + key[-4:] if len(key) > 10 else "…"
    print(f"Key      : {masked}（长度 {len(key)}）")
    print(f"Base URL : {args.base}")
    print(f"Model    : {args.model}")
    print("-" * 56)

    status, data, ms = post(args.base.rstrip("/") + "/chat/completions", key, args.model)
    print(f"请求     : HTTP {status}  耗时 {ms*1000:.0f}ms")
    if status == 200:
        try:
            j = json.loads(data)
            content = j["choices"][0]["message"]["content"].strip()
            usage = j.get("usage", {})
            print(f"返回     : {content!r}")
            print(f"用量     : prompt={usage.get('prompt_tokens')} completion={usage.get('completion_tokens')}")
            print("✓ Key 与模型可用")
        except Exception as e:  # noqa: BLE001
            print(f"✓ HTTP 200 但解析异常：{e}")
            print(data[:300])
    else:
        print(f"✗ 失败：{data[:300]}")

    print("-" * 56)
    print("CORS     :", check_cors(args.base, key))
    print("说明：若 ACAO 缺失，浏览器里前端会报 'Failed to fetch'，需要改用支持 CORS 的服务商或加一层代理。")
    return 0 if status == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
