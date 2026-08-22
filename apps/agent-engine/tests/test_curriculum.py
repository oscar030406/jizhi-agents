"""策展课程库资产校验：入库的课程 JSON 必须永远通过（生产门禁的回归面）。

校验的是 data/curriculum/ 下已提交的静态资产，不触网、不依赖生成流水线。
"""

import json
import re
from pathlib import Path

import pytest

from backend.schemas.curriculum import Catalog, Course
from backend.services.goal_concepts import KEYWORD_CONCEPTS

ROOT = Path(__file__).resolve().parents[1]
CUR_DIR = ROOT / "data" / "curriculum"
CITATION_RE = re.compile(r"\[([a-z]{2}\d{2}s\d{2}#s\d+)\]")  # 与 build_curriculum 保持一致


def _index_source_ids() -> set[str]:
    ids = set()
    with open(ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl", encoding="utf-8") as f:
        for line in f:
            ids.add(json.loads(line)["source_id"])
    return ids


def _course_files() -> list[Path]:
    return sorted(p for p in CUR_DIR.glob("*.json") if p.name != "catalog.json")


def test_catalog_schema_and_gatekeeper_keywords():
    catalog = Catalog.model_validate_json((CUR_DIR / "catalog.json").read_text(encoding="utf-8"))
    graph = json.loads((ROOT / "data" / "knowledge_base" / "concept_graph.json").read_text(encoding="utf-8"))
    concept_ids = {c.concept_id for c in catalog.concepts}
    assert concept_ids == {k for k in graph if k != "_meta"}, "目录必须覆盖概念图全部概念"
    # 守门关键词与引擎 goal_concepts 同源（防双端漂移）
    for kw, concept in KEYWORD_CONCEPTS.items():
        entry = next((c for c in catalog.concepts if c.concept_id == concept), None)
        assert entry is not None and kw in entry.keywords, f"关键词 {kw} 未同步进目录 {concept}"
    # 视频白名单必须带 uid（合规做成数据结构）
    for acc in catalog.video_account_whitelist:
        assert acc.get("uid"), "白名单账号缺 uid"


def _bank_ids() -> set[str]:
    path = ROOT / "data" / "quiz" / "interview_bank.jsonl"
    if not path.is_file():
        return set()
    return {json.loads(line)["bank_id"] for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}


@pytest.mark.parametrize("path", _course_files(), ids=lambda p: p.stem)
def test_course_asset_passes_gates(path: Path):
    course = Course.model_validate_json(path.read_text(encoding="utf-8"))
    valid_ids = _index_source_ids()
    assert course.course_id == path.stem
    lessons = course.all_lessons()
    assert lessons, "课程无课时"
    assert course.minutes_total == sum(lesson.estimated_minutes for lesson in lessons)
    # 理论卷（学期课）：出处必须来自面试题库
    if course.theory_exam:
        bank = _bank_ids()
        for q in course.theory_exam:
            assert 0 <= q.answer_index < len(q.options)
            assert q.source_ids and all(s in bank for s in q.source_ids), "理论卷出处不在题库"
    # 分级项目阶梯：等级齐全且有序
    if course.projects:
        levels = [p.level for p in course.projects]
        assert levels == sorted(levels), f"项目应按 L1→L3 排列：{levels}"
        assert len({p.project_id for p in course.projects}) == len(course.projects)

    for lesson in lessons:
        for sec in lesson.sections:
            marks = CITATION_RE.findall(sec.body_md)
            assert marks, f"{lesson.lesson_id}「{sec.heading}」正文无引用标记"
            unknown = [m for m in marks if m not in valid_ids]
            assert not unknown, f"{lesson.lesson_id}「{sec.heading}」引用了知识库不存在的 source_id：{unknown}"
            assert set(sec.source_ids) == set(dict.fromkeys(marks)), "source_ids 与正文标记不一致"
        # 生产门禁落盘结果：引用全覆盖；judge 复核要么全过、要么明确标注未获复核
        assert lesson.audit.citation_coverage == 1.0, f"{lesson.lesson_id} 引用覆盖率非 100%"
        judged_ok = lesson.audit.sections_supported == lesson.audit.sections_total
        judge_unavailable = any("未获独立复核" in n for n in lesson.audit.notes)
        assert judged_ok or judge_unavailable, f"{lesson.lesson_id} judge 复核未全过：{lesson.audit.notes}"

        for q in lesson.check_understanding:
            assert 0 <= q.answer_index < len(q.options)
            assert all(s in valid_ids for s in q.source_ids)

    # 结业测评二选一：短课=final_quiz；学期课=theory_exam（面试题库口径）
    assert len(course.final_quiz) >= 3 or len(course.theory_exam) >= 12, "缺结业测评"
    for q in course.final_quiz:
        assert 0 <= q.answer_index < len(q.options)
        assert all(s in valid_ids for s in q.source_ids)

    # 视频只允许白名单账号（无视频=合法：宁缺毋滥）
    catalog = Catalog.model_validate_json((CUR_DIR / "catalog.json").read_text(encoding="utf-8"))
    whitelist_uids = {a["uid"] for a in catalog.video_account_whitelist}
    videos = [course.video_intro] + [lesson.video_intro for lesson in lessons]
    for v in videos:
        if v is not None:
            assert v.uid in whitelist_uids, f"视频账号 uid {v.uid} 不在白名单"


def _exec_eval(code: str, expressions: list[str], preamble: str = "") -> list[tuple[bool, str]]:
    """与 build_curriculum._exec_and_eval 同语义的最小实现（测试独立，不 import scripts）。"""
    import math

    ns: dict = {"math": math}
    try:
        exec(preamble + "\n" + code, ns)  # noqa: S102 - 仓库自产资产
    except Exception as e:  # noqa: BLE001
        return [(False, f"exec fail {e}")] * len(expressions)
    out = []
    for expr in expressions:
        try:
            out.append((True, repr(eval(expr, ns))))  # noqa: S307
        except Exception as e:  # noqa: BLE001
            out.append((False, str(e)))
    return out


@pytest.mark.parametrize("path", _course_files(), ids=lambda p: f"{p.stem}-judged")
def test_course_exercises_machine_verified(path: Path):
    """判题资产的入库不变量：solution 全过（expected 一致）、starter 必挂、纯标准库。"""
    course = Course.model_validate_json(path.read_text(encoding="utf-8"))
    exercises = [(l.lesson_id, l.graded_exercise, "") for l in course.all_lessons() if l.graded_exercise]
    if course.capstone:
        exercises.append(("capstone", course.capstone, course.capstone.dataset_code))
    for p in course.projects:
        exercises.append((p.project_id or p.title, p, p.dataset_code))
    for owner, ex, preamble in exercises:
        exprs = [c.expression for c in ex.test_cases]
        assert any(c.hidden for c in ex.test_cases), f"{owner}: 缺隐藏用例"
        sol = _exec_eval(ex.solution_code, exprs, preamble)
        for case, (ok, got) in zip(ex.test_cases, sol):
            assert ok, f"{owner}·{case.name}: 参考答案执行失败 {got}"
            assert got == case.expected_repr, f"{owner}·{case.name}: expected 与参考答案不一致"
        starter = _exec_eval(ex.starter_code, exprs, preamble)
        assert not all(
            ok and got == c.expected_repr for c, (ok, got) in zip(ex.test_cases, starter)
        ), f"{owner}: starter 直接通过全部用例"
        banned = ("import numpy", "import torch", "open(", "import os", "import random")
        assert not any(b in ex.solution_code + ex.starter_code for b in banned), f"{owner}: 出现禁用内容"
