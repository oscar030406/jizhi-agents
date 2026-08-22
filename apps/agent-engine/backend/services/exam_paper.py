"""三大题理论卷组卷器（v4 §3.3）：选择 + 填空 + 解答，对齐人工期末卷范式。

题源：`data/quiz/human_exams/*.jsonl`（五套人工期末卷 120 题，含标准答案与逐题解析，
教材登记制口径=出题参照/试卷范式锚点）。组卷=按课程概念过滤 + 三段配额 + 溯源标注。
机器可判：选择题（答案字母）与数值填空（machine_checkable=true）走自动判分；
解答题展示评分要点（solution_steps）供自评/教师评。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Sequence

from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[2]
HUMAN_EXAMS_DIR = ROOT / "data" / "quiz" / "human_exams"

DEFAULT_QUOTA = {"choice": 8, "fill": 4, "solution": 2}


class ExamQuestion(BaseModel):
    bank_id: str
    exam_source: str            # 来源试卷名（溯源标注，登记制口径）
    section: str                # choice / fill / solution
    score: int
    question: str
    options: Dict[str, str] = Field(default_factory=dict)
    answer: str
    solution_steps: str
    concepts: List[str] = Field(default_factory=list)
    machine_checkable: bool = False
    difficulty: str = "L3"


class ExamPaper(BaseModel):
    paper_id: str
    title: str
    total_score: int
    sections: Dict[str, List[ExamQuestion]]   # section -> questions
    provenance: str


def load_bank() -> List[ExamQuestion]:
    bank: List[ExamQuestion] = []
    for path in sorted(HUMAN_EXAMS_DIR.glob("*.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            d = json.loads(line)
            bank.append(ExamQuestion(
                bank_id=d["bank_id"],
                exam_source=d["exam"],
                section=d["section"],
                score=int(d["score"]),
                question=d["question"],
                options=d.get("options") or {},
                answer=str(d["answer"]),
                solution_steps=d.get("solution_steps", ""),
                concepts=list(d.get("concepts", [])),
                machine_checkable=bool(d.get("machine_checkable", False)),
                difficulty=str(d.get("difficulty", "L3")),
            ))
    return bank


def _concept_match(q: ExamQuestion, wanted: set[str]) -> int:
    """匹配度：命中概念数（0=不相关）。概念词表为小写下划线英文。"""
    return len(wanted & {c.lower() for c in q.concepts})


def assemble_paper(
    paper_id: str,
    title: str,
    concepts: Sequence[str],
    quota: Dict[str, int] | None = None,
) -> ExamPaper:
    """按概念组卷：每段先取匹配度最高的题，优先 machine_checkable（填空段）。"""
    quota = quota or dict(DEFAULT_QUOTA)
    wanted = {c.lower() for c in concepts}
    bank = load_bank()

    sections: Dict[str, List[ExamQuestion]] = {}
    for section, n in quota.items():
        pool = [q for q in bank if q.section == section and _concept_match(q, wanted) > 0]
        # 排序：匹配度降序 → 填空段可机判优先 → bank_id 稳定序（组卷可复现）
        pool.sort(key=lambda q: (-_concept_match(q, wanted),
                                 not q.machine_checkable if section == "fill" else False,
                                 q.bank_id))
        sections[section] = pool[:n]

    total = sum(q.score for qs in sections.values() for q in qs)
    return ExamPaper(
        paper_id=paper_id,
        title=title,
        total_score=total,
        sections=sections,
        provenance=(
            "题目选自五套人工期末试卷（教材登记制：出题参照口径），含原卷标准答案与解析；"
            "组卷按课程概念匹配，过程确定性可复现。"
        ),
    )


def grade_machine_checkable(paper: ExamPaper, answers: Dict[str, str]) -> Dict[str, object]:
    """机器判分：选择题字母比对；可机判填空做归一化字符串/数值比对。
    解答题不判（返回待评清单）。"""
    score = 0
    detail = {}
    pending = []
    for qs in paper.sections.values():
        for q in qs:
            given = (answers.get(q.bank_id) or "").strip()
            if q.section == "solution" or not q.machine_checkable:
                pending.append(q.bank_id)
                continue
            ok = _normalize(given) == _normalize(q.answer)
            detail[q.bank_id] = {"correct": ok, "expected": q.answer}
            if ok:
                score += q.score
    return {"machine_score": score, "detail": detail, "pending_manual": pending}


def _normalize(text: str) -> str:
    t = text.strip().rstrip("。.").replace(" ", "").replace("，", ",").upper()
    try:
        return f"{float(t):g}"   # 数值等价（"2.0"=="2"）
    except ValueError:
        return t
