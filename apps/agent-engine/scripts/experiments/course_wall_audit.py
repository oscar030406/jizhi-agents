r"""课程墙体检：现有课够不够格挂在首页，缺什么，按什么顺序补。

    python scripts/experiments/course_wall_audit.py --json data/eval/course_wall_audit.json

## 为什么要这一份

2026-08-13 用户看完首页的判断是「一无顺序、二数量少、三质量勉勉强强」。
「勉勉强强」得先量出来是哪几处勉强，否则补课就是照着感觉补。

本脚本只量**机械可判**的东西，一条 LLM 都不调：
渲染事故、资源形态齐不齐、审核账单、AI 味词、代码块形态、篇幅分布。
判官能判的（讲得对不对、深不深）不在这里，那是 `run_real_llm_eval.py` 的活。

判据来源：
- AI 味词表：`apps/classroom/lib/generation/data/ai-tells.json`
  （教材零命中才进表，见 `docs/05-evidence/textbook-prose-ladder-20260813.md`）
- 资源形态三种：赛题第五(2)款点名的定制讲义 / 分阶测试题 / 实操指南
- 代码形态阶梯：`textbook_code_ladder.py` 量出来的入门段 import/def/class 全 0%
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

_HERE = Path(__file__).resolve()
_REPO = _HERE.parents[4]
CLASSROOMS = _REPO / "apps" / "classroom" / "data" / "classrooms"
AI_TELLS = _REPO / "apps" / "classroom" / "lib" / "generation" / "data" / "ai-tells.json"

#: KaTeX 渲染失败时 throwOnError:false 会把报错标记直接写进 HTML 存起来。
#: 这是**事故**不是风格问题：学习者看到的是一段红色的报错文本。
KATEX_ERR = re.compile(r"katex-error|KaTeX parse error|ParseError", re.I)

#: 裸露的 markdown 记号（渲染器没吃掉的）。摘录块内的不算——那是另一条渲染路径。
#
# ⚠️ 第一版还查了「行首 # 号」当 markdown 标题，结果 70 处命中里绝大多数是
# **Python 注释**（`# 重要性低于阈值则丢弃`）——判据撞上代码块，
# 「21/23 门有裸记号」是探测器自己造出来的。收紧成只查粗体与表格分隔线，
# 并且先把等宽段落（代码）剔掉再查。
RAW_MD = re.compile(r"\*\*[^*\n]{1,40}\*\*|\|\s*-{3,}\s*\|")

#: 画布里的等宽段落是代码，不是行文。查裸记号之前先剔掉。
MONO_P = re.compile(r"<p[^>]*monospace[^>]*>.*?</p>", re.S)

TAG = re.compile(r"<[^>]+>")
ENT = [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&amp;", "&")]
EXCERPT_BLOCK = re.compile(r"📖[\s\S]*?——\s*摘自《[^《》]*》\s*\[[^\]]+\]")


def plain(html: str) -> str:
    t = re.sub(r"<br\s*/?>", "\n", html)
    t = re.sub(r"</(p|div|li|h[1-6])>", "\n", t)
    t = TAG.sub("", t)
    for a, b in ENT:
        t = t.replace(a, b)
    return t


def audit_course(path: Path, tells: list[str]) -> dict:
    d = json.loads(path.read_text(encoding="utf-8"))
    scenes = d.get("scenes", [])
    name = (d.get("stage") or {}).get("name", "?")

    forms = Counter()
    widgets = Counter()
    katex_err = 0
    raw_md = 0
    excerpts = 0
    cjk = 0
    tell_hits: Counter = Counter()
    audit = Counter()
    thin_scenes = 0
    speech_chars = 0

    for s in scenes:
        c = s.get("content") or {}
        kind = c.get("type")
        forms[kind] += 1
        if kind == "interactive":
            widgets[c.get("widgetType")] += 1

        scene_cjk = 0
        for el in c.get("canvas", {}).get("elements", []):
            h = el.get("content")
            if not isinstance(h, str):
                continue
            katex_err += len(KATEX_ERR.findall(h))
            text = plain(MONO_P.sub('', h))
            # 摘录区剥掉：AI 味与裸记号只算我们自己写的
            own = EXCERPT_BLOCK.sub("", text)
            excerpts += len(EXCERPT_BLOCK.findall(text))
            raw_md += len(RAW_MD.findall(own))
            n = len(re.findall(r"[一-鿿]", own))
            cjk += n
            scene_cjk += n
            for w in tells:
                k = own.count(w)
                if k:
                    tell_hits[w] += k
        # 口播另算：它是另一条生成路径，08-13 已量出 AI 味集中在这里
        for a in s.get("actions", []):
            if isinstance(a, dict) and isinstance(a.get("text"), str):
                speech_chars += len(re.findall(r"[一-鿿]", a["text"]))
        if scene_cjk < 200 and kind == "slide":
            thin_scenes += 1

        au = s.get("audit") or {}
        if au:
            audit[au.get("verdict") or "?"] += 1
            audit["flagged"] += int(au.get("flaggedCount") or 0)
            audit["claims"] += int(au.get("totalClaims") or 0)

    has_quiz = forms.get("quiz", 0) > 0
    has_procedural = widgets.get("procedural-skill", 0) > 0
    return {
        "id": path.stem,
        "name": name,
        "scenes": len(scenes),
        "cjk": cjk,
        "speech_cjk": speech_chars,
        "forms": dict(forms),
        "widgets": dict(widgets),
        "excerpts": excerpts,
        "excerpt_per_scene": round(excerpts / max(len(scenes), 1), 2),
        "katex_errors": katex_err,
        "raw_markdown": raw_md,
        "thin_slides": thin_scenes,
        "ai_tells": dict(tell_hits),
        "ai_tell_total": sum(tell_hits.values()),
        "audit": dict(audit),
        # 赛题第五(2)：三种资源形态齐不齐
        "form_count": 1 + int(has_quiz) + int(has_procedural),
        "missing_forms": [
            f for f, ok in (("分阶测试题", has_quiz), ("实操指南", has_procedural)) if not ok
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()

    tells = json.loads(AI_TELLS.read_text(encoding="utf-8"))["aiTells"]
    rows = [audit_course(p, tells) for p in sorted(CLASSROOMS.glob("*.json"))]
    rows.sort(key=lambda r: (-r["katex_errors"], -r["raw_markdown"], r["form_count"], -r["scenes"]))

    print(f"{'课程':<26}{'页':>3}{'千字':>5}{'摘录':>5}{'教具':>5}{'形态':>5}"
          f"{'渲染事故':>7}{'裸记号':>6}{'AI味':>5}{'薄页':>5}")
    print("-" * 88)
    for r in rows:
        widgets = sum(r["widgets"].values())
        print(f"{r['name'][:24]:<26}{r['scenes']:>3}{r['cjk'] // 1000:>5}{r['excerpts']:>5}"
              f"{widgets:>5}{r['form_count']:>5}{r['katex_errors']:>7}{r['raw_markdown']:>6}"
              f"{r['ai_tell_total']:>5}{r['thin_slides']:>5}")

    n = len(rows)
    print(f"\n合计 {n} 门课")
    print(f"  渲染事故（KaTeX 报错烤进 HTML）：{sum(1 for r in rows if r['katex_errors'])} 门")
    print(f"  裸 markdown 记号漏出：{sum(1 for r in rows if r['raw_markdown'])} 门")
    print(f"  一个教具都没有：{sum(1 for r in rows if not sum(r['widgets'].values()))} 门")
    print(f"  没有测试题：{sum(1 for r in rows if '分阶测试题' in r['missing_forms'])} 门")
    print(f"  三种资源形态齐（讲义+测试题+实操指南）：{sum(1 for r in rows if r['form_count'] == 3)} 门")
    print(f"  摘录数 ≤2（教材接地薄）：{sum(1 for r in rows if r['excerpts'] <= 2)} 门")
    print(f"  命中 AI 味词：{sum(1 for r in rows if r['ai_tell_total'])} 门，"
          f"合计 {sum(r['ai_tell_total'] for r in rows)} 处")

    tell_all: Counter = Counter()
    for r in rows:
        tell_all.update(r["ai_tells"])
    if tell_all:
        print("  逐词：" + "、".join(f"{w}×{c}" for w, c in tell_all.most_common(10)))

    if args.json:
        args.json.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n落盘 {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
