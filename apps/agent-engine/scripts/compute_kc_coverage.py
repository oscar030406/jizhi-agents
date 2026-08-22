"""核心知识点覆盖率（评委指标三）：生成课程命中大纲知识成分数 / 金标总数。

口径全文 docs/05-evidence/metric-calibers-v1-20260809.md 指标三。要点：
- 金标（分母）独立于生成物构建（教材 TOC/概念清单），文件在 data/eval/kc_gold/，
  status 为 draft-* 的金标测出的数字只做管线试运行，禁入 metrics。
- 命中判定两级：本脚本做第一级（同义词表机械匹配，零成本可复现）；
  未命中清单交第二级判官复核（--emit-misses 输出待复核清单）。
- 「提及」与「讲解」区分：默认严格口径——同义词命中还须该 KC 的命中场景
  正文长度 ≥ MIN_CONTEXT 字（防标题一句带过记满分）。

用法：
  python scripts/compute_kc_coverage.py --gold data/eval/kc_gold/rag.json \
      --course ../classroom/data/classrooms/WM2ZxhLUyz.json [--emit-misses out.json]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# 命中场景的正文最低长度（字符），低于此视为「提及」不算「讲解」
MIN_CONTEXT = 120

TAG_RE = re.compile(r"<[^>]+>")


def scene_text(scene: dict) -> str:
    content = scene.get("content") or {}
    elements = content.get("elements")
    if elements is None and isinstance(content, dict):
        canvas = content.get("canvas")
        if isinstance(canvas, dict):
            elements = canvas.get("elements")
    parts: list[str] = []
    for el in elements or []:
        if isinstance(el, dict) and el.get("type") == "text" and isinstance(el.get("content"), str):
            parts.append(TAG_RE.sub("", el["content"]))
    # 测验题面/解析也算课程内容（口径：正文+教具+测验）
    quiz = content.get("questions") if isinstance(content, dict) else None
    if isinstance(quiz, list):
        for q in quiz:
            if isinstance(q, dict):
                parts.append(str(q.get("question", "")))
                parts.append(str(q.get("explanation", "")))
    return "\n".join(parts)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", required=True)
    ap.add_argument("--course", required=True)
    ap.add_argument("--emit-misses", default=None)
    args = ap.parse_args()

    gold = json.load(open(ROOT / args.gold if not pathlib.Path(args.gold).is_absolute() else args.gold, encoding="utf-8"))
    course = json.load(open(args.course, encoding="utf-8"))

    scenes = course.get("scenes", [])
    texts = [(s.get("title", f"scene{i}"), scene_text(s)) for i, s in enumerate(scenes)]

    # 命中规则（分辨力门实测校准：rag 金标打无关课「梯度下降」曾 33% 假阳）：
    # 特异词（≥5 字，或含拉丁字母的术语如 RAG/embedding/rerank）单独可判命中；
    # 泛词（2-4 字中文，如「评估」「构建」）单个不算，须同场景 ≥2 个不同泛词共现。
    def specific(n: str) -> bool:
        return len(n) >= 5 or bool(re.search(r"[A-Za-z]", n))

    hits, misses, mentions = [], [], []
    for kc in gold["knowledge_components"]:
        needles = [n for n in (kc["name"], *kc.get("synonyms", [])) if len(n) >= 2]
        best: tuple[str, int] | None = None
        for title, text in texts:
            low = text.lower()
            found = [n for n in needles if n.lower() in low]
            ok = any(specific(n) for n in found) or len(set(found)) >= 2
            if ok and (best is None or len(text) > best[1]):
                best = (title, len(text))
        if best and best[1] >= MIN_CONTEXT:
            hits.append({"kc": kc["id"], "scene": best[0]})
        elif best:
            mentions.append({"kc": kc["id"], "scene": best[0], "context_len": best[1]})
        else:
            misses.append({"kc": kc["id"], "name": kc["name"]})

    total = len(gold["knowledge_components"])
    print(f"课程：{course.get('stage', {}).get('name', args.course)}")
    print(f"金标：{gold['topic']}（{gold.get('status')}）{total} 个知识成分")
    print(f"机械命中（讲解级）：{len(hits)}/{total} = {len(hits)/total:.1%}")
    if mentions:
        print(f"仅提及（不计分，待判官复核）：{[m['kc'] for m in mentions]}")
    if misses:
        print(f"未命中（待判官第二级复核）：{[m['kc'] for m in misses]}")
    if str(gold.get("status", "")).startswith("draft"):
        print("⚠ 金标为草稿——本数字仅供管线试运行，禁入 metrics。")

    if args.emit_misses:
        json.dump(
            {"course": args.course, "misses": misses, "mentions": mentions},
            open(args.emit_misses, "w", encoding="utf-8"),
            ensure_ascii=False,
            indent=2,
        )
        print(f"待复核清单已写 {args.emit_misses}")


if __name__ == "__main__":
    main()
