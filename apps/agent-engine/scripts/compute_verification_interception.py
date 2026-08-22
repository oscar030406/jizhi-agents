"""可执行验证拦截率统计（KR2 量化，消融维度 D）。

对 zero_prior 全部抓课批跑 content_verification（本地沙箱+AST，零 API），
量化「若交付前机器验算上线，能拦下多少算错的数字与跑不通的代码」。

抽取口径与课堂端 extractVerifiables 对齐并**扩到讲稿**：等宽字体标记的 text
元素=代码块，其余 text 元素剥 HTML 进数值复核；scenes[].actions 里的 speech
文本同样进数值复核（实测存量课的手算链主要在口播里，板书只有向量定义——
讲稿是交付内容，学习者听到算错的数字一样是事故）。interactive 场景的 widget
运行时 HTML 不算课件代码，跳过。数字规范化：上/下标 Unicode（₁²ₖ）与全角
符号折算成 ASCII，否则 dₖ=4、K₁ 这类教学记法全部漏检。

跑法：python scripts/compute_verification_interception.py
产物：data/experiments/verification_interception.json
"""

from __future__ import annotations

import glob
import pathlib
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.content_verification import (  # noqa: E402
    normalize_notation,  # 记法归一已移入服务层（产品桥同口径），此处只消费
    verify_arithmetic,
    verify_python_block,
)

MONO_RE = re.compile(r"consolas|monospace|courier", re.I)
TAG_RE = re.compile(r"<[^>]+>")


_KATEX_ANNOT = re.compile(r'<annotation encoding="application/x-tex">(.*?)</annotation>', re.S)


def _detex(t: str) -> str:
    """简单 TeX → 可解析算式。转不动的记法留原样（verify_arithmetic 解析不了会跳过）。"""
    t = html.unescape(t)
    t = t.replace("\\times", "*").replace("\\cdot", "*").replace("\\approx", "≈")
    t = re.sub(r"\^\{([^{}]+)\}", r"^\1", t)
    t = re.sub(r"\\text\{([^{}]*)\}", r"\1", t)
    t = re.sub(r"\\frac\{([^{}]+)\}\{([^{}]+)\}", r"(\1)/(\2)", t)
    return re.sub(r"\\[,;!:]|\\left|\\right", " ", t)


def _replace_katex_blocks(s: str) -> str:
    """把整棵 KaTeX span 树换成其原始 TeX。

    KaTeX 渲染树剥标签会把 10^7 摊平成 107（mathml+html 双份还会让内容重复），
    式子必须从 <annotation> 里的 TeX 源取。span 嵌套用括号计数扫描，正则啃不动。
    """
    out = []
    i = 0
    while True:
        j = s.find('<span class="katex">', i)
        if j == -1:
            out.append(s[i:])
            break
        out.append(s[i:j])
        depth = 0
        k = j
        for m in re.finditer(r"<span\b[^>]*>|</span>", s[j:]):
            depth += 1 if m.group(0).startswith("<span") else -1
            if depth == 0:
                k = j + m.end()
                break
        else:
            k = len(s)
        annot = _KATEX_ANNOT.search(s[j:k])
        if annot:
            out.append(f" {_detex(annot.group(1))} ")
        else:
            # 渲染时只出了 html 树（无 mathml/annotation，TeX 源不在了）：从渲染树
            # 重建——msupsub 子树的文本前补 ^（KaTeX 把指数放在这个包装里）。
            # 下标也走 msupsub，会被误写成 ^：d_k→d^k 含字母解析不了自动跳过，无害。
            out.append(f" {_flatten_katex_html(s[j:k])} ")
        i = k
    return "".join(out)


def _flatten_katex_html(block: str) -> str:
    parts = []
    i = 0
    while True:
        j = block.find('<span class="msupsub">', i)
        if j == -1:
            parts.append(TAG_RE.sub("", block[i:]))
            break
        parts.append(TAG_RE.sub("", block[i:j]))
        depth = 0
        k = j
        for m in re.finditer(r"<span\b[^>]*>|</span>", block[j:]):
            depth += 1 if m.group(0).startswith("<span") else -1
            if depth == 0:
                k = j + m.end()
                break
        else:
            k = len(block)
        exponent = TAG_RE.sub("", block[j:k]).strip()
        parts.append(f"^{exponent}" if exponent else "")
        i = k
    return html.unescape("".join(parts)).replace("×", "*").replace("−", "-")


def strip_html(s: str) -> str:
    s = _replace_katex_blocks(s)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</(p|div|li|h[1-6])>", "\n", s, flags=re.I)
    # HTML 上/下标先于剥标签处理：<sup>7</sup> 直接剥会把 10⁷ 变成 107（实测把
    # 6.7×10^7 判成算错）；下标同 Unicode 下标口径换成字母，绝不能变成数字。
    s = re.sub(r"<sup[^>]*>\s*(\d+)\s*</sup>", r"^\1", s, flags=re.I)
    s = re.sub(r"<sub[^>]*>[^<]*</sub>", "x", s, flags=re.I)
    text = html.unescape(TAG_RE.sub("", s))
    # &nbsp;（U+00A0）在代码块里是编译杀手（invalid non-printable character），
    # md→HTML 渲染链常把普通空格换成它
    return text.replace(" ", " ")


def main() -> None:
    files = sorted(glob.glob(str(ROOT / "data/eval/zero_prior/*.scenes.json")))
    # 公共课程墙的落盘课同为 stage/scenes 形状，一并纳入（--courses-dir 可另指）
    import argparse
    ap = argparse.ArgumentParser(); ap.add_argument("--courses-dir", default=None)
    args, _ = ap.parse_known_args()
    if args.courses_dir:
        files = sorted(glob.glob(str(pathlib.Path(args.courses_dir) / "*.json")))
    totals = {
        "courses": 0,
        "scenes": 0,
        "code_blocks": 0,
        "code_passed": 0,
        "code_failed": 0,
        "code_unverifiable": 0,
        "arith_checked": 0,
        "arith_passed": 0,
    }
    failures: list[dict] = []
    per_course: list[dict] = []

    for f in files:
        course = json.load(open(f, encoding="utf-8"))
        label = course.get("label", Path(f).stem)
        c_stats = {"label": label, "code_failed": 0, "arith_failed": 0}
        totals["courses"] += 1
        for scene in course.get("scenes", []):
            content = scene.get("content") or {}
            elements = content.get("elements") if isinstance(content, dict) else None
            # 课堂持久化格式把元素包在 content.canvas.elements（DSL 外壳）
            if elements is None and isinstance(content, dict):
                canvas = content.get("canvas")
                if isinstance(canvas, dict):
                    elements = canvas.get("elements")
            if not isinstance(elements, list):
                continue
            totals["scenes"] += 1
            for el in elements:
                if not isinstance(el, dict) or el.get("type") != "text":
                    continue
                raw = el.get("content")
                if not isinstance(raw, str):
                    continue
                mono = bool(
                    MONO_RE.search(str(el.get("defaultFontName", "")))
                    or re.search(r"font-family:\s*(consolas|monospace|courier)", raw, re.I)
                )
                text = strip_html(raw).strip()
                if not text:
                    continue
                # 段落里嵌一个行内 code span 就会命中 font-family——中文占比高的
                # 是散文不是代码，误进沙箱必然 SyntaxError 假失败
                if mono:
                    cjk = len(re.findall(r"[一-鿿]", text))
                    if cjk / max(1, len(text)) > 0.3:
                        mono = False
                if mono:
                    totals["code_blocks"] += 1
                    v = verify_python_block(text)
                    verdict = v.verdict
                    # 教学片段引用未定义符号（for epoch in range(epochs) 这种示意代码）
                    # 是「缺上下文不可验」，不是「代码算错」——KR2 原则：解析不了跳过，
                    # 绝不误判。与缺依赖同一类。
                    if verdict == "failed" and str(v.detail).startswith("NameError"):
                        verdict = "unverifiable"
                    key = f"code_{verdict}"
                    totals[key] = totals.get(key, 0) + 1
                    if verdict == "failed":
                        c_stats["code_failed"] += 1
                        failures.append(
                            {"course": label, "scene": scene.get("title"), "kind": "code",
                             "detail": v.detail, "head": text[:120]}
                        )
                else:
                    r = verify_arithmetic(normalize_notation(text))
                    totals["arith_checked"] += r.checked
                    totals["arith_passed"] += r.passed
                    if r.failures:
                        c_stats["arith_failed"] += len(r.failures)
                        for fl in r.failures:
                            failures.append(
                                {"course": label, "scene": scene.get("title"),
                                 "kind": "arith", "detail": fl}
                            )
            # 讲稿口播：交付内容的一部分，数值链主要在这里（实测）
            for act in scene.get("actions") or []:
                if isinstance(act, dict) and act.get("type") == "speech":
                    t = str(act.get("text") or "")
                    if not t:
                        continue
                    r = verify_arithmetic(normalize_notation(t))
                    totals["arith_checked"] += r.checked
                    totals["arith_passed"] += r.passed
                    if r.failures:
                        c_stats["arith_failed"] += len(r.failures)
                        for fl in r.failures:
                            failures.append(
                                {"course": label, "scene": scene.get("title"),
                                 "kind": "arith_speech", "detail": fl}
                            )
        per_course.append(c_stats)

    arith_failed = totals["arith_checked"] - totals["arith_passed"]
    out = {
        "caliber": (
            "zero_prior 全部抓课的 slide text 元素；等宽字体=代码块进沙箱，其余进"
            "数值等式 AST 复核（=容差1%/≈5%）。widget 运行时 HTML 不算课件代码。"
            "「拦截」=若 KR2 上线这些内容会在交付前被红行点名。"
        ),
        "totals": totals,
        "would_intercept": {
            "code_failed": totals["code_failed"],
            "arith_failed": arith_failed,
            "any": totals["code_failed"] + arith_failed,
        },
        "per_course": per_course,
        "failures": failures[:40],
    }
    dest = ROOT / "data/experiments/verification_interception.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    t = totals
    print(f"课程 {t['courses']} · 场景 {t['scenes']}")
    print(f"代码块 {t['code_blocks']}：通过 {t['code_passed']} · 失败 {t['code_failed']} · 缺依赖不可验 {t['code_unverifiable']}")
    print(f"数值等式 {t['arith_checked']}：通过 {t['arith_passed']} · 算错 {arith_failed}")
    print(f"可拦截问题合计 {out['would_intercept']['any']}")
    print(f"→ {dest}")


if __name__ == "__main__":
    main()
