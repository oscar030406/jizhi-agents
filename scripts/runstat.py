"""Per-run grounding + guardrail numbers. Usage: python runstat.py <run_id> [<run_id> ...]

正文 = scene.content.elements 里剥 HTML 后的文字，**排除 📖 开头的摘录注入块**
（那些是 injectExcerpts() 逐字搬来的语料原文，不是模型写的，算进护栏会把语料
自带的 URL/措辞记到模型头上）。

本脚本原是 WO-K2 那一轮写在会话 scratchpad 里的临时工具，L2 的复算要靠它，2026-08-17 晚按用户裁决落进 `scripts/`。**除了把写死的绝对路径改成按 __file__ 推导，一个字都没动**——动了 K2 报告里那些数就不再可复算。
"""
import glob
import json
import os
import re
import statistics
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

RUNS = os.path.join(ROOT, "apps", "agent-engine", "data", "knowledge_base", "intake_runs")
HAN = re.compile(r"[\u4e00-\u9fff]")
TAG = re.compile(r"<[^>]+>")
# 铁律 10 规定的通识句自然措辞（B 版明确禁止 [推断] 这类元标记，所以只能按措辞找）
CAVEAT = re.compile(r"(?:课程|本课|课程的)?资料(?:里)?(?:没有|未|不曾)(?:直接)?(?:讲到|覆盖|提到|说明|涉及)"
                    r"|按同类系统的一般做法|同类系统的通常做法|通常的做法是")
IMG = re.compile(r"!\[[^\]]*\]\(")
URL = re.compile(r"https?://")


def body_and_excerpts(content):
    """Return (model-authored plain text, list of injected excerpt texts)."""
    body, exc = [], []
    for el in (content or {}).get("elements", []) or []:
        raw = el.get("content")
        if not isinstance(raw, str):
            continue
        txt = TAG.sub("", raw)
        (exc if "\U0001F4D6" in txt else body).append(txt)
    return "\n".join(body), exc


def scan(run_id):
    rows = []
    for path in sorted(glob.glob(os.path.join(RUNS, run_id, "trial_courses", "*.json"))):
        if "kc_misses" in path:
            continue
        course = json.load(open(path, encoding="utf-8"))
        tier = os.path.basename(path).replace(".json", "")
        for i, sc in enumerate(course.get("scenes", []), 1):
            a = sc.get("audit") or {}
            claims = a.get("claims") or []
            if not claims:
                continue
            p = sc.get("pipeline") or {}
            asm = p.get("assembly") or {}
            body, exc = body_and_excerpts(sc.get("content"))
            rows.append(dict(
                tier=tier, scene=i, rounds=a.get("rounds"), verdict=a.get("verdict"),
                n=len(claims),
                grounded=sum(1 for c in claims
                             if c.get("verdict") == "supported" and (c.get("sourceIds") or [])),
                nosrc=sum(1 for c in claims if not (c.get("sourceIds") or [])),
                supported=sum(1 for c in claims if c.get("verdict") == "supported"),
                unusable=(not a.get("corpus")) or not a.get("evidenceCount"),
                injected=asm.get("injected") or 0,
                excerpt_blocks=len(exc),
                asm_missing=p.get("assembly") is None,
                han=len(HAN.findall(body)),
                caveat=len(CAVEAT.findall(body)),
                img=len(IMG.findall(body)), url=len(URL.findall(body)),
                warn=(p.get("bridgeWarnings") or []),
            ))
    return rows


def report(run_id, rows=None):
    rows = rows if rows is not None else scan(run_id)
    ok = [r for r in rows if not r["unusable"]]
    N = sum(r["n"] for r in ok)
    print(f"\n### {run_id}  屏={len(rows)}（可用 {len(ok)}）")
    for r in rows:
        print(f"  {r['tier']:9s}屏{r['scene']} r={r['rounds']} {str(r['verdict']):8s} "
              f"n={r['n']:2d} 有据={r['grounded']:2d} 无源={r['nosrc']:2d} "
              f"汉字={r['han']:5d} 注入={r['injected']}/块{r['excerpt_blocks']} "
              f"通识句={r['caveat']} img={r['img']} url={r['url']}"
              f"{' ASM_MISSING' if r['asm_missing'] else ''}"
              f"{' [未挂语料]' if r['unusable'] else ''} {r['warn'] or ''}")
    if N:
        G = sum(r["grounded"] for r in ok)
        S = sum(r["nosrc"] for r in ok)
        SUP = sum(r["supported"] for r in ok)
        print(f"  合计 n={N} 有据={G}/{N}={G/N:.3f} 无源={S}/{N}={S/N:.3f} "
              f"supported={SUP}/{N}={SUP/N:.3f}")
        print(f"  护栏 汉字中位={statistics.median(r['han'] for r in ok):.0f} "
              f"断言中位={statistics.median(r['n'] for r in ok):.1f} "
              f"注入合计={sum(r['injected'] for r in ok)} "
              f"通识句合计={sum(r['caveat'] for r in ok)} "
              f"img={sum(r['img'] for r in ok)} url={sum(r['url'] for r in ok)}")
    return rows


if __name__ == "__main__":
    for rid in sys.argv[1:]:
        report(rid)
