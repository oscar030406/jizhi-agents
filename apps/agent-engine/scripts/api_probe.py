"""硅基流动连通性探针：3 次小请求，量延迟，看真实错误。"""
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import backend  # noqa: F401  触发 .env 加载
import httpx

KEY = os.environ["SILICONFLOW_API_KEY"]
MODEL = os.environ.get("PROBE_MODEL", "Qwen/Qwen3-30B-A3B-Instruct-2507")

import requests

LONG_PROMPT = "用 500 字介绍注意力机制的直觉。"


def probe(label: str, do_request, n: int = 2) -> None:
    for i in range(n):
        t0 = time.time()
        try:
            status, usage, err = do_request()
            extra = f" err={err}" if err else ""
            print(f"[{label} {i+1}] {time.time()-t0:.1f}s HTTP {status} usage={usage}{extra}")
        except Exception as e:
            print(f"[{label} {i+1}] {time.time()-t0:.1f}s EXC {type(e).__name__}: {e}")


def _err_of(body: dict) -> str:
    # 非 200 时把平台报错原文带出来（403 可能是余额尽/模型未授权，语义完全不同）
    if not isinstance(body, dict):
        return ""
    return str(body.get("message") or body.get("error") or "")[:160]


def via_httpx():
    with httpx.Client(trust_env=False, timeout=120) as client:
        r = client.post(
            "https://api.siliconflow.cn/v1/chat/completions",
            headers={"Authorization": f"Bearer {KEY}"},
            json={"model": MODEL, "max_tokens": 800,
                  "messages": [{"role": "user", "content": LONG_PROMPT}]},
        )
    body = r.json() if "json" in r.headers.get("content-type", "") else {}
    return r.status_code, body.get("usage"), "" if r.status_code == 200 else _err_of(body) or r.text[:160]


def via_requests():
    s = requests.Session()
    s.trust_env = False  # 网关同款：绕过 Clash 的代理环境变量
    r = s.post(
        "https://api.siliconflow.cn/v1/chat/completions",
        headers={"Authorization": f"Bearer {KEY}"},
        json={"model": MODEL, "max_tokens": 800,
              "messages": [{"role": "user", "content": LONG_PROMPT}]},
        timeout=120,
    )
    try:
        body = r.json()
    except ValueError:
        body = {}
    return r.status_code, body.get("usage"), "" if r.status_code == 200 else _err_of(body) or r.text[:160]


print("代理环境变量:", {k: v for k, v in os.environ.items()
                    if k.upper() in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")})
probe("httpx", via_httpx)
probe("requests", via_requests)
