r"""教师盲测材料包：从课程数据抽课时 → 剥来源痕迹 → 随机编号 → 按人随机排序。

协议见 docs/teacher_blind_review_protocol.md。这个脚本负责协议里最容易做砸的两步：
**去痕迹**（引用角标/审核指纹/模型名一律不能留）与**随机化**（编号与顺序都随机，
对照表单独存放，评审拿到的目录里没有任何来源线索）。

劣化对照（D 组）需要人工植入错误——脚本只生成待植入的模板并在对照表里标出，
不自动造错：造错这件事必须有人看过，否则可能植入一个恰好正确的说法。

用法：
  python scripts\export_blind_review_kit.py --out dist\blind_review --reviewers 5
  python scripts\export_blind_review_kit.py --selftest
"""
from __future__ import annotations

import argparse
import json
import random
import re
import string
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CURRICULUM = ROOT / "data" / "curriculum"

CITATION_RE = re.compile(r"\[[a-z]{2}\d{2}s\d{2}#s\d+\]")
# 型号名一旦出现在正文就等于告诉评审"这是 AI 写的"
MODEL_HINTS = re.compile(
    r"(DeepSeek[-\w.]*|Qwen[\w./-]*|GLM[-\w.]*|zai-org/\S+|Hunyuan[-\w.]*|GPT-[\w.]+|"
    r"由 AI 生成|大模型生成|本课时由.*生成)"
)


def strip_traces(text: str) -> str:
    """剥掉引用角标与模型名——盲测材料不能带来源指纹。"""
    text = CITATION_RE.sub("", text)
    text = MODEL_HINTS.sub("〔略〕", text)
    return re.sub(r"[ \t]+\n", "\n", text)


def lesson_to_markdown(lesson: dict) -> str:
    """课时 → 评审可读的纯文本。审核指纹、判官模型、graded_exercise 的答案一律不出现。"""
    parts = [f"# {lesson['title']}", ""]
    if lesson.get("objectives"):
        parts += ["**学完这一课，你能：**", ""]
        parts += [f"- {strip_traces(o)}" for o in lesson["objectives"]]
        parts.append("")
    for i, sec in enumerate(lesson.get("sections", []) or [], 1):
        parts += [f"## {i}. {strip_traces(sec['heading'])}", "", strip_traces(sec["body_md"]), ""]
    checks = lesson.get("check_understanding") or []
    if checks:
        parts += ["## 随堂检查题", ""]
        for i, q in enumerate(checks, 1):
            parts.append(f"**{i}. {strip_traces(q['question'])}**")
            for oi, opt in enumerate(q.get("options", [])):
                parts.append(f"- {chr(65 + oi)}. {strip_traces(str(opt))}")
            parts.append("")
    if lesson.get("key_terms"):
        parts += ["## 关键术语", ""]
        for t in lesson["key_terms"]:
            parts.append(f"- **{t['term']}** —— {strip_traces(t['definition'])}")
        parts.append("")
    return "\n".join(parts)


def source_excerpt_to_markdown(title: str, blocks: list[dict]) -> str:
    """人写对照（C 组）：教材原文节选，排版成同样式。"""
    parts = [f"# {title}", ""]
    for i, b in enumerate(blocks, 1):
        parts += [f"## {i}. {b['title']}", "", b["content"], ""]
    return "\n".join(parts)


def _code(rng: random.Random) -> str:
    return "M-" + "".join(rng.choice(string.ascii_uppercase + string.digits) for _ in range(4))


def build_kit(out_dir: Path, reviewers: int, seed: int) -> dict:
    rng = random.Random(seed)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "materials").mkdir(exist_ok=True)

    pool: list[dict] = []  # 候选课时：(concept, lesson)
    for path in sorted(CURRICULUM.glob("*.json")):
        if path.stem == "catalog":
            continue
        course = json.loads(path.read_text(encoding="utf-8"))
        lessons = [l for ch in (course.get("chapters") or []) for l in ch["lessons"]]
        lessons += course.get("lessons") or []
        for lesson in lessons:
            if len(lesson.get("sections") or []) >= 3:  # 太薄的不进盲测
                pool.append({"concept": path.stem, "lesson": lesson})
    if not pool:
        raise SystemExit("没有可用课时——先跑 build_curriculum.py")

    # 人写对照素材：从知识库原文取块
    index_path = ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"
    # 只取活块：人写对照素材要的是这个库现在的正文，不是被顶替的那一代。
    from backend.rag.ingest import read_index_rows

    kb = read_index_rows(index_path)
    kb_by_section: dict[str, list[dict]] = {}
    for c in kb:
        kb_by_section.setdefault(c["source_id"].split("#")[0], []).append(c)
    fat_sections = [s for s, blocks in kb_by_section.items() if sum(len(b["content"]) for b in blocks) > 4000]

    manifest: list[dict] = []
    for r in range(1, reviewers + 1):
        picks: list[tuple[str, str, str]] = []  # (组别, 说明, 正文)
        ai_lessons = rng.sample(pool, k=min(4, len(pool)))
        for item in ai_lessons:
            picks.append((
                "A/B",
                f"{item['concept']} · {item['lesson']['lesson_id']}",
                lesson_to_markdown(item["lesson"]),
            ))
        sec = rng.choice(fat_sections)
        blocks = sorted(kb_by_section[sec], key=lambda b: b["source_id"])[:5]
        picks.append(("C", f"人写对照 · {sec}", source_excerpt_to_markdown(blocks[0]["title"], blocks)))
        trap = rng.choice(ai_lessons)
        picks.append((
            "D",
            f"劣化对照（待人工植入 2 处错误）· {trap['concept']} · {trap['lesson']['lesson_id']}",
            "<!-- 组织人：请在本文中人工植入 2 处语料外的事实性断言，并在对照表登记植入位置 -->\n\n"
            + lesson_to_markdown(trap["lesson"]),
        ))
        rng.shuffle(picks)
        for order, (group, note, body) in enumerate(picks, 1):
            code = _code(rng)
            (out_dir / "materials" / f"{code}.md").write_text(body, encoding="utf-8")
            manifest.append({"reviewer": r, "order": order, "code": code, "group": group, "source": note})

    # 对照表单独存放：评审拿到的是 materials/，组织人拿这一份
    key_path = out_dir / "KEY_组织人保管_勿发给评审.json"
    key_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")

    for r in range(1, reviewers + 1):
        mine = [m for m in manifest if m["reviewer"] == r]
        lines = [f"# 评审 {r} 号 · 材料清单", "", "请按顺序评阅，每份填一张判分表。", ""]
        lines += [f"{m['order']}. `{m['code']}.md`" for m in sorted(mine, key=lambda x: x["order"])]
        (out_dir / f"评审{r}号_清单.md").write_text("\n".join(lines) + "\n", encoding="utf-8")

    return {"materials": len(manifest), "reviewers": reviewers, "out": str(out_dir)}


def selftest() -> None:
    dirty = "这是正文 [hl01s02#s1]。由 DeepSeek-V3.2 生成，复核模型 zai-org/GLM-5.2。"
    clean = strip_traces(dirty)
    assert "hl01s02" not in clean, clean
    assert "DeepSeek" not in clean and "GLM" not in clean, clean
    assert "这是正文" in clean
    lesson = {
        "title": "测试课", "objectives": ["目标一 [ha01s01#s1]"],
        "sections": [{"heading": "小节 [ha01s01#s2]", "body_md": "正文 [ha01s01#s3]", "source_ids": []}],
        "check_understanding": [{"question": "问 [ha01s01#s4]", "options": ["A项", "B项"], "answer_index": 0}],
        "key_terms": [{"term": "术语", "definition": "释义 [ha01s01#s5]", "source_id": "x"}],
    }
    md = lesson_to_markdown(lesson)
    assert "#s" not in md, md
    assert "answer_index" not in md and "正确答案" not in md, "判分答案不能出现在盲测材料里"
    assert "术语" in md and "问" in md
    print("selftest OK")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=ROOT / "dist" / "blind_review")
    ap.add_argument("--reviewers", type=int, default=5)
    ap.add_argument("--seed", type=int, default=20260905)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        selftest()
        return
    report = build_kit(args.out, args.reviewers, args.seed)
    print(f"✅ 盲测材料包就绪：{report['materials']} 份 / {report['reviewers']} 位评审 → {report['out']}")
    print("   materials/ 发给评审；KEY_组织人保管_勿发给评审.json 自己留着")
    print("   ⚠ D 组材料需人工植入 2 处错误后才能发出（文件头有标记）")
    if not sys.stdout.isatty():
        return


if __name__ == "__main__":
    main()
