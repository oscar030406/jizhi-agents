"""动态追问导学：探测→答错降维→答对推进→连对进阶，决策逐条有据。"""
from backend.services.tutor_service import TutorRequest, tutor_turn, _load_pool


def _answer(item_id, correct, pool):
    item = next(p for p in pool if p.question_id == item_id)
    idx = item.answer_index if correct else (item.answer_index + 1) % len(item.options)
    return {"question_id": item_id, "selected_index": idx}


def test_first_turn_probes_with_reason(monkeypatch):
    monkeypatch.setenv("AGENT_GENERATION_MODE", "deterministic")
    turn = tutor_turn(TutorRequest(concept="llm_basics"))
    assert turn.decision.type == "probe"
    assert turn.question is not None and turn.question.options
    assert turn.question.source_ids  # 题目锚定语料
    assert turn.decision.because


def test_wrong_answer_simplifies_with_cited_explanation(monkeypatch):
    monkeypatch.setenv("AGENT_GENERATION_MODE", "deterministic")
    pool = _load_pool("llm_basics")
    first = pool[0].question_id
    turn = tutor_turn(TutorRequest(concept="llm_basics",
                                   history=[_answer(first, False, pool)]))
    assert turn.decision.type == "simplify"
    assert turn.explanation is not None and turn.explanation.source_ids
    assert turn.explanation.section_excerpt
    assert any("答错" in b for b in turn.decision.because)


def test_streak_triggers_challenge(monkeypatch):
    monkeypatch.setenv("AGENT_GENERATION_MODE", "deterministic")
    pool = _load_pool("llm_basics")
    history = [_answer(p.question_id, True, pool) for p in pool[:3]]
    turn = tutor_turn(TutorRequest(concept="llm_basics", history=history))
    assert turn.decision.type == "challenge"
    assert turn.challenge and turn.mastery_estimate == 1.0


def test_correct_advances_forward(monkeypatch):
    monkeypatch.setenv("AGENT_GENERATION_MODE", "deterministic")
    pool = _load_pool("llm_basics")
    turn = tutor_turn(TutorRequest(concept="llm_basics",
                                   history=[_answer(pool[0].question_id, True, pool)]))
    assert turn.decision.type == "advance"
    assert turn.question.question_id != pool[0].question_id
