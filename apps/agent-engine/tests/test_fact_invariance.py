"""事实不变量检查（PLAYBOOK §2.7）：个性化改表达、不改事实，机器可查。"""
from backend.schemas.resources import (
    LearningResources,
    LectureResource,
    LectureSection,
    PracticeTask,
)
from backend.services.compare_service import compare_generate, fact_invariance_check

GOAL = "学会搭一个带审核的 RAG 问答系统"


def test_deterministic_compare_passes_fact_invariance(monkeypatch):
    monkeypatch.setenv("AGENT_GENERATION_MODE", "deterministic")
    report = compare_generate(GOAL, ["zero_beginner", "backend_to_agent"])

    fi = report.fact_invariance
    assert fi is not None
    # 确定性引擎全部引用库内块：锚定不越界、无疑似事实冲突
    assert fi.out_of_scope_citations == []
    assert fi.suspected_conflicts == []
    assert fi.passed is True
    assert fi.checked_claims > 0


def _fake_resources(source_ids):
    return LearningResources(
        lecture=LectureResource(title="假讲义", sections=[
            LectureSection(
                heading="小节",
                body="LangGraph 图编排把多智能体调度建模为带条件边的状态图。",
                source_ids=source_ids,
            ),
        ]),
        practice_task=PracticeTask(
            title="假任务", scenario="请按步骤完成练习。", steps=["s1"],
            deliverable="d", acceptance_checks=["c"], difficulty="L1",
        ),
        graded_quiz=[],
        used_sources=source_ids,
        target_concepts=["multi_agent"],
    )


def test_out_of_scope_citation_is_caught():
    entries = [
        ("画像甲", _fake_resources(["kb::ch1::s1"]), {"kb::ch1::s1"}),
        ("画像乙", _fake_resources(["kb::nowhere::999"]), {"kb::ch1::s1"}),
    ]
    fi = fact_invariance_check(entries)
    assert fi.passed is False
    assert len(fi.out_of_scope_citations) == 1
    v = fi.out_of_scope_citations[0]
    assert v.profile_name == "画像乙"
    assert v.invalid_source_ids == ["kb::nowhere::999"]


def test_negation_conflict_heuristic():
    a = _fake_resources(["kb::ch1::s1"])
    b = _fake_resources(["kb::ch1::s1"])
    b.lecture.sections[0].body = "LangGraph 图编排不把多智能体调度建模为带条件边的状态图。"
    fi = fact_invariance_check([("画像甲", a, {"kb::ch1::s1"}), ("画像乙", b, {"kb::ch1::s1"})])
    assert fi.passed is False
    assert len(fi.suspected_conflicts) == 1
    assert fi.suspected_conflicts[0].source_id == "kb::ch1::s1"
