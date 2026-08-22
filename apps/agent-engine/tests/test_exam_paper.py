"""三大题组卷器：题库加载、按概念组卷可复现、机器判分归一化。"""
from backend.services.exam_paper import (
    assemble_paper,
    grade_machine_checkable,
    load_bank,
)


def test_bank_loads_five_exams():
    bank = load_bank()
    assert len(bank) == 120
    assert {q.section for q in bank} == {"choice", "fill", "solution"}
    assert sum(1 for q in bank if q.machine_checkable) >= 80


def test_assemble_paper_by_concepts_reproducible():
    p1 = assemble_paper("exam-rag", "RAG 方向理论卷", ["rag", "kv_cache", "lora"])
    p2 = assemble_paper("exam-rag", "RAG 方向理论卷", ["rag", "kv_cache", "lora"])
    assert p1.model_dump() == p2.model_dump()  # 组卷确定性
    assert p1.sections["choice"] and p1.sections["fill"] and p1.sections["solution"]
    # 全部题目与概念相关
    wanted = {"rag", "kv_cache", "lora"}
    for qs in p1.sections.values():
        for q in qs:
            assert wanted & {c.lower() for c in q.concepts}, q.bank_id


def test_grade_normalization():
    paper = assemble_paper("exam-x", "x", ["rag"])
    q_choice = paper.sections["choice"][0]
    answers = {q_choice.bank_id: f" {q_choice.answer.lower()} "}  # 大小写+空白归一
    result = grade_machine_checkable(paper, answers)
    assert result["detail"][q_choice.bank_id]["correct"] is True
    assert result["machine_score"] >= q_choice.score
    # 解答题必须进待评清单
    assert all(q.bank_id in result["pending_manual"] for q in paper.sections["solution"])
