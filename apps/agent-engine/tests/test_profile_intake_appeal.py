from backend.services.profile_appeal import build_appeal_challenge, grade_appeal
from backend.services.profile_intake import extract_profile_seed


def test_intake_extracts_levels_with_evidence():
    seed = extract_profile_seed("写过爬虫，调过 OpenAI API，没部署过服务，后端转行")
    assert seed.levels["python"] == 2
    assert seed.levels["agent"] == 2
    assert seed.background_hint == "后端工程"
    assert not seed.unmatched
    # 每个命中档位都有证据（关键词 + 理由），可审计
    dims = {e.dimension for e in seed.evidence}
    assert {"python", "agent"} <= dims
    for e in seed.evidence:
        assert e.keyword and e.reason


def test_intake_same_dimension_takes_highest_level():
    seed = extract_profile_seed("学过语法，也做过架构重构过大系统")
    assert seed.levels["programming"] == 4


def test_intake_unmatched_is_honest():
    seed = extract_profile_seed("今天天气不错")
    assert seed.unmatched
    assert seed.levels == {}


def test_appeal_challenge_serves_two_questions_at_claimed_difficulty():
    ch = build_appeal_challenge("rag", 3)
    assert len(ch.questions) == 2
    assert all("rag" in q.concept_tags for q in ch.questions)
    assert any(q.difficulty == "L3" for q in ch.questions)
    # 答案不外泄给前端
    assert not any(hasattr(q, "answer") for q in ch.questions)


def test_appeal_python_dimension_uses_direct_questions():
    ch = build_appeal_challenge("python", 2)
    assert all("python" in q.concept_tags for q in ch.questions)
    assert not ch.proxy_note  # 题库已有直接概念题，不再需要 proxy 标注


def test_appeal_all_correct_passes_and_partial_fails():
    from backend.services.data_loader import load_pretest_questions

    ch = build_appeal_challenge("rag", 2)
    key = {q.id: q.answer for q in load_pretest_questions()}
    right = {q.id: key[q.id] for q in ch.questions}
    verdict = grade_appeal("rag", 2, right)
    assert verdict.passed and verdict.correct == 2

    wrong = dict(right)
    first = ch.questions[0].id
    wrong[first] = "A" if right[first] != "A" else "B"
    verdict = grade_appeal("rag", 2, wrong)
    assert not verdict.passed
    # because 链逐题留证 + 判定结论
    assert len(verdict.because) == 3
    assert "未通过" in verdict.because[-1]
