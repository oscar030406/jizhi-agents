r"""双向细目表：课程题目 × 认知层级 × 学习目标覆盖。

为什么用规则而不是叫 LLM 打标：细目表是给评委看的教学证据，
再叫一次 LLM 判定就又变成自证。这里的分类规则全部写在 RULES 里，
任何人都能照着复核一遍——与项目"每个数字一条命令"的口径一致。

层级取布卢姆前三级（本项目题型只到应用层）：
  记忆 remember  —— 认出/复述事实、定义、名称、数值
  理解 understand —— 解释机制、判断表述正误、比较概念
  应用 apply     —— 代入具体输入算结果、给定场景选做法、读代码得输出

用法：python scripts\build_blueprint.py [--concept llm_basics] [--md]
"""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CURRICULUM = ROOT / "data" / "curriculum"

# 规则按优先级从高到低匹配；命中即定级。每条都给了判据，便于人工复核。
RULES: list[tuple[str, str, str]] = [
    # (层级, 正则, 判据说明)
    ("应用", r"计算|算出|输出(结果|形状|张量)|结果是什么|经过.{0,12}后|代入|给定|若.{0,20}则|"
             r"执行.{0,10}代码|运行.{0,10}后|形状为|shape|返回值|得到.{0,6}(结果|输出)",
     "题干要求代入具体输入求结果或读代码得输出"),
    ("应用", r"应用场景|在.{0,12}场景[下中]|最合适的|应该(选择|使用|采用)|如何配置|怎样实现",
     "题干给场景要求选做法"),
    ("理解", r"为什么|原因|之所以|作用是|目的是|意义(是|在于)|机制|如何(实现|工作|影响)|"
             r"描述(是)?正确|说法正确|最准确|以下哪项(理解|描述|说法)|区别|相比|不同于",
     "题干考解释机制或判断表述正误"),
    ("记忆", r"是什么|定义|指的是|属于|名称|叫做|包括|由.{0,10}组成|以下哪(个|项)是",
     "题干考认出事实/定义/名称"),
]

FALLBACK = ("理解", "未命中任何规则，按最常见层级兜底——**需人工复核**")


def classify(question: str) -> tuple[str, str, bool]:
    """返回 (层级, 判据, 是否需人工复核)。"""
    for level, pattern, why in RULES:
        if re.search(pattern, question):
            return level, why, False
    return FALLBACK[0], FALLBACK[1], True


def walk_lessons(course: dict):
    for ch in course.get("chapters", []) or []:
        for lesson in ch["lessons"]:
            yield ch.get("title", ""), lesson
    for lesson in course.get("lessons", []) or []:
        yield "", lesson


def build(concept: str) -> dict:
    course = json.loads((CURRICULUM / f"{concept}.json").read_text(encoding="utf-8"))
    rows: list[dict] = []
    for chapter_title, lesson in walk_lessons(course):
        for q in lesson.get("check_understanding", []) or []:
            level, why, review = classify(q["question"])
            rows.append({
                "来源": f"{lesson['lesson_id']} 穿插检查",
                "章": chapter_title,
                "课时": lesson["title"],
                "学习目标数": len(lesson.get("objectives", []) or []),
                "题干": q["question"],
                "层级": level,
                "判据": why,
                "需复核": review,
                "溯源块": q.get("source_ids", []),
            })
        # 判题练习与分级项目是货真价实的应用层证据，不计入就会让细目表显得"只考理解"
        if lesson.get("graded_exercise"):
            ex = lesson["graded_exercise"]
            rows.append({
                "来源": f"{lesson['lesson_id']} 判题练习",
                "章": chapter_title, "课时": lesson["title"],
                "学习目标数": len(lesson.get("objectives", []) or []),
                "题干": ex.get("title") or ex.get("function_name", "判题练习"),
                "层级": "应用", "判据": "写代码并由机器判分，天然是应用层",
                "需复核": False, "溯源块": [],
            })
        if lesson.get("hands_on"):
            rows.append({
                "来源": f"{lesson['lesson_id']} 动手任务",
                "章": chapter_title, "课时": lesson["title"],
                "学习目标数": len(lesson.get("objectives", []) or []),
                "题干": lesson["hands_on"].get("title", "动手任务"),
                "层级": "应用", "判据": "带验收标准的动手产出", "需复核": False, "溯源块": [],
            })

    for proj in course.get("projects", []) or []:
        rows.append({
            "来源": f"分级项目 {proj.get('level', '')}", "章": "结业", "课时": "-",
            "学习目标数": 0, "题干": proj.get("title", ""),
            "层级": "应用", "判据": "公开/私榜双榜机器判分的完整项目",
            "需复核": False, "溯源块": [],
        })
    if course.get("capstone"):
        rows.append({
            "来源": "结业微项目", "章": "结业", "课时": "-", "学习目标数": 0,
            "题干": course["capstone"].get("title", ""), "层级": "应用",
            "判据": "双榜判分的结业项目", "需复核": False, "溯源块": [],
        })

    for field, label in (("theory_exam", "结业理论卷"), ("final_quiz", "结业测验")):
        for q in course.get(field, []) or []:
            level, why, review = classify(q["question"])
            rows.append({
                "来源": label, "章": "结业", "课时": "-", "学习目标数": 0,
                "题干": q["question"], "层级": level, "判据": why,
                "需复核": review, "溯源块": q.get("source_ids", []),
            })
    return {"concept": concept, "title": course.get("title", concept), "rows": rows}


def to_markdown(bp: dict) -> str:
    rows = bp["rows"]
    dist = Counter(r["层级"] for r in rows)
    by_lesson: dict[str, Counter] = defaultdict(Counter)
    for r in rows:
        by_lesson[r["课时"]][r["层级"]] += 1
    need_review = [r for r in rows if r["需复核"]]
    traced = sum(1 for r in rows if r["溯源块"])

    out = [
        f"# 双向细目表 · {bp['title']}",
        "",
        "> 由 `scripts/build_blueprint.py` 生成，分类规则写在脚本 `RULES` 里，可照着复核。",
        "> 层级取布卢姆前三级（本项目题型只到应用层）。",
        "",
        "## 一、总体分布",
        "",
        "| 认知层级 | 题数 | 占比 |",
        "|---|---:|---:|",
    ]
    total = len(rows)
    for level in ("记忆", "理解", "应用"):
        n = dist.get(level, 0)
        out.append(f"| {level} | {n} | {n / total * 100:.0f}% |" if total else f"| {level} | 0 | - |")
    out += [
        f"| **合计** | **{total}** | 100% |",
        "",
        f"- 每题均带溯源块：**{traced}/{total}**（{traced / total * 100:.0f}%）",
        f"- 规则未命中需人工复核：**{len(need_review)}** 题",
        "",
        "## 二、逐课时分布",
        "",
        "| 课时 | 记忆 | 理解 | 应用 | 小计 |",
        "|---|---:|---:|---:|---:|",
    ]
    for lesson_title, c in by_lesson.items():
        s = sum(c.values())
        out.append(f"| {lesson_title} | {c.get('记忆', 0)} | {c.get('理解', 0)} | {c.get('应用', 0)} | {s} |")
    out += ["", "## 三、逐题明细", "", "| 来源 | 层级 | 题干 | 判据 | 溯源块 |", "|---|---|---|---|---|"]
    for r in rows:
        stem = r["题干"].replace("|", "/")[:48]
        src = "、".join(r["溯源块"][:2]) or "—"
        flag = " ⚠需复核" if r["需复核"] else ""
        out.append(f"| {r['来源']} | {r['层级']}{flag} | {stem} | {r['判据'][:22]} | `{src}` |")
    return "\n".join(out) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--concept", default="")
    ap.add_argument("--md", action="store_true", help="同时落盘 docs/blueprint_<concept>.md")
    args = ap.parse_args()

    concepts = [args.concept] if args.concept else [
        p.stem for p in sorted(CURRICULUM.glob("*.json")) if p.stem != "catalog"
    ]
    for concept in concepts:
        bp = build(concept)
        if not bp["rows"]:
            print(f"⚠ {concept}：无题目，跳过")
            continue
        dist = Counter(r["层级"] for r in bp["rows"])
        review = sum(1 for r in bp["rows"] if r["需复核"])
        print(f"{concept}: {len(bp['rows'])} 题 · 记忆 {dist.get('记忆', 0)} / "
              f"理解 {dist.get('理解', 0)} / 应用 {dist.get('应用', 0)} · 待复核 {review}")
        if args.md:
            path = ROOT.parent.parent / "docs" / "05-evidence" / "blueprints" / f"blueprint_{concept}.md"
            path.write_text(to_markdown(bp), encoding="utf-8")
            print(f"  → {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
