r"""一次性数据修复：把审计查出的两类机械缺陷从已生成的课程数据里抹掉，无需重新生成。

背景：docs 的 36 课时审计（course-content-audit 工作流）确认两个管线 bug 的存量污染——
  1. 选项正文残留洗牌前的字母标号（"A. xxx"），渲染按位置另加字母 → 双标号打架。
  2. 多篇课时的下篇重复了上篇的小节（同 heading 出现两次）。

管线侧已在 build_curriculum.py 修好（_strip_option_prefix / _OPTION_PREFIX_RE 与小节去重守卫），
但缓存里是旧数据、重建会命中缓存。本脚本直接改存量：course JSON + .lesson_cache，两边一起改，
保持单一真源。**只做确定性、不改语义的修复**——答案键、解析文字、算术错误另走定向补丁。

用法：python scripts\repair_course_data.py [--dry-run]
可重复执行（幂等）。
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CURRICULUM = ROOT / "data" / "curriculum"
CACHE = ROOT / "data" / ".lesson_cache"

_PREFIX_RE = re.compile(r"^\s*[A-Da-d]\s*[\.\．、\)）]\s*")


def strip_prefix(opt: str) -> str:
    return _PREFIX_RE.sub("", opt) if isinstance(opt, str) else opt


def fix_question(q: dict) -> int:
    """剥选项前缀，返回改动的选项数。answer_index 不动（位置不变，只去正文噪音）。"""
    opts = q.get("options") or []
    n = 0
    new = []
    for o in opts:
        s = strip_prefix(o)
        if s != o:
            n += 1
        new.append(s)
    q["options"] = new
    return n


def dedup_sections(lesson: dict) -> int:
    """同名小节改名消歧（不删）：源文分篇时下篇常与上篇覆盖同一子主题、正文不同——
    都是有效内容，删了丢深入版。后出现的挂「（深入精读）」短签，heading 不再撞车。
    返回改名的小节数。after_section 不动（没有删节、下标不变）。"""
    secs = lesson.get("sections") or []
    seen: set[str] = set()
    renamed = 0
    for s in secs:
        h = (s.get("heading") or "").strip()
        if h and h in seen:
            s["heading"] = f"{h}（深入精读）"
            renamed += 1
        seen.add((s.get("heading") or "").strip())
    return renamed


def walk_lessons(course: dict):
    for ch in course.get("chapters", []):
        yield from ch.get("lessons", [])
    yield from course.get("lessons", [])


def all_questions(course: dict):
    for l in walk_lessons(course):
        yield from l.get("check_understanding", []) or []
    yield from course.get("theory_exam", []) or []
    yield from course.get("final_quiz", []) or []


def repair_course_file(path: Path, dry: bool) -> dict:
    course = json.loads(path.read_text(encoding="utf-8"))
    opt_fixed = sum(fix_question(q) for q in all_questions(course))
    sec_dropped = sum(dedup_sections(l) for l in walk_lessons(course))
    if not dry and (opt_fixed or sec_dropped):
        path.write_text(json.dumps(course, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"file": path.name, "options_stripped": opt_fixed, "sections_renamed": sec_dropped}


def repair_cache(dry: bool) -> dict:
    """缓存里每个 lesson 单独一个 JSON（结构=一个 lesson），同样修。"""
    opt_fixed = sec_dropped = 0
    for f in CACHE.glob("*/*.json"):
        lesson = json.loads(f.read_text(encoding="utf-8"))
        n = sum(fix_question(q) for q in lesson.get("check_understanding", []) or [])
        d = dedup_sections(lesson)
        if n or d:
            opt_fixed += n
            sec_dropped += d
            if not dry:
                f.write_text(json.dumps(lesson, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"cache_options_stripped": opt_fixed, "cache_sections_renamed": sec_dropped}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    report = []
    for path in sorted(CURRICULUM.glob("*.json")):
        if path.stem == "catalog":
            continue
        report.append(repair_course_file(path, args.dry_run))
    cache = repair_cache(args.dry_run)
    print(json.dumps({"mode": "dry-run" if args.dry_run else "applied",
                      "courses": report, "cache": cache}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
