"""LLM 路径测试：用假网关验证「LLM 优先、确定性兜底」的双引擎契约，不发真实请求。"""

from backend.agents.content_audit_agent import ContentAuditAgent
from backend.agents.feedback_decision_agent import FeedbackDecisionAgent
from backend.agents.knowledge_retrieval_agent import KnowledgeRetrievalAgent
from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
from backend.agents.resource_generation_agent import ResourceGenerationAgent
from backend.schemas.learner import FeedbackInput
from backend.services.data_loader import get_learner_profile, load_pretest_questions
from backend.services.quiz_service import estimate_pretest_from_profile


class FakeGateway:
    def __init__(self, payload):
        self.payload = payload

    def is_enabled(self, agent):
        return True

    def structured_chat(self, agent, system, user, **kwargs):
        return self.payload


class DisabledGateway:
    def is_enabled(self, agent):
        return False

    def structured_chat(self, agent, system, user, **kwargs):
        raise AssertionError("disabled gateway must not be called")


def _context(profile_id: str = "python_no_agent"):
    profile = get_learner_profile(profile_id)
    diagnosis = LearnerDiagnosisAgent().run(profile, estimate_pretest_from_profile(profile, load_pretest_questions()))
    retrieval = KnowledgeRetrievalAgent().run(profile.learning_goal, diagnosis)
    return profile, diagnosis, retrieval


def _valid_generation_payload(retrieval):
    sid = retrieval.source_ids[0]
    quiz_item = {
        "question": "证据门控的作用是什么？",
        "options": {"A": "提高创意", "B": "让输出可追溯", "C": "隐藏中间状态", "D": "降低成本"},
        "answer": "B",
        "explanation": "证据门控要求生成前检索、生成后核验。",
        "concept_tags": ["rag"],
        "source_ids": [sid],
    }
    return {
        "lecture": {
            "title": "LLM 生成的讲义",
            "sections": [
                {"heading": "rag 证据门控", "body": "生成内容必须能追溯到证据来源。", "source_ids": [sid]},
                {"heading": "agent_basics 闭环", "body": "Agent 应用要暴露中间状态。", "source_ids": [sid]},
            ],
        },
        "practice_task": {
            "title": "构建证据约束问答",
            "scenario": "基于给定文档构建问答 Agent。",
            "steps": ["定义输出格式", "接入检索", "增加审核"],
            "deliverable": "可运行 API",
            "acceptance_checks": ["每个结论有引用"],
            "source_ids": [sid],
        },
        "graded_quiz": [quiz_item, dict(quiz_item), dict(quiz_item)],
    }


def test_generation_uses_llm_payload_when_valid():
    profile, diagnosis, retrieval = _context()
    agent = ResourceGenerationAgent(gateway=FakeGateway(_valid_generation_payload(retrieval)))
    resources = agent.run(profile, profile.learning_goal, diagnosis, retrieval)
    assert agent.last_engine == "llm"
    assert resources.lecture.title == "LLM 生成的讲义"
    assert all(section.source_ids for section in resources.lecture.sections)


def test_generation_falls_back_on_fabricated_sources():
    profile, diagnosis, retrieval = _context()
    payload = _valid_generation_payload(retrieval)
    payload["lecture"]["sections"][0]["source_ids"] = ["kb999_not_retrieved"]
    agent = ResourceGenerationAgent(gateway=FakeGateway(payload))
    resources = agent.run(profile, profile.learning_goal, diagnosis, retrieval)
    assert agent.last_engine == "deterministic"
    assert resources.lecture.sections


def test_generation_deterministic_when_gateway_disabled():
    profile, diagnosis, retrieval = _context()
    agent = ResourceGenerationAgent(gateway=DisabledGateway())
    resources = agent.run(profile, profile.learning_goal, diagnosis, retrieval)
    assert agent.last_engine == "deterministic"
    assert resources.graded_quiz


def test_feedback_rejects_illegal_difficulty_jump():
    payload = {
        "feedback_type": "advancement",
        "decision": "advance_challenge",
        "updated_difficulty": "L4",  # 当前 L1，跳两级非法
        "next_action": "直接做开放任务",
        "explanation": "模型认为可以跳级",
    }
    agent = FeedbackDecisionAgent(gateway=FakeGateway(payload))
    decision = agent.run(FeedbackInput(learner_profile_id="x", quiz_score=0.9, confidence=5), current_difficulty="L1")
    assert agent.last_engine == "deterministic"
    assert decision.updated_difficulty in {"L1", "L2", "L3"}


def test_audit_judge_rehabilitates_disputed_claims():
    """两级审核：初筛存疑的声明由 judge 终裁。judge 判 supported 后幻觉率应下降。"""
    profile, diagnosis, retrieval = _context()
    resources = ResourceGenerationAgent(gateway=DisabledGateway()).run(profile, profile.learning_goal, diagnosis, retrieval)
    # 剥掉引用制造"初筛全存疑"的局面
    for section in resources.lecture.sections:
        section.source_ids = []
    resources.practice_task.source_ids = []
    for item in resources.graded_quiz:
        item.source_ids = []
    baseline = ContentAuditAgent(gateway=DisabledGateway()).run(resources, diagnosis, retrieval)
    assert baseline.hallucination_rate > 0.05

    # 口径 v2：判 supported/weak 必须回填证据原文，引不出原文按 unsupported 收
    override = {"verdicts": [{"index": i + 1, "verdict": "supported", "quote": "证据原文片段"}
                             for i in range(24)]}
    audited = ContentAuditAgent(gateway=FakeGateway(override)).run(resources, diagnosis, retrieval)
    assert audited.auditor_engine == "llm+deterministic"
    assert audited.hallucination_rate < baseline.hallucination_rate
    assert audited.claims_supported > baseline.claims_supported


def test_audit_judge_reviews_every_claim_not_just_disputed():
    """口径 v2：判官全量复核。

    原契约是「初筛 supported 的不再复核」，理由是省调用。但确定性重叠量的是
    「话题像不像」不是「对不对」——用教材词汇编的假命题会被初筛判 supported，
    从而永远见不到判官（实测 supported 占 88.6%）。埋假冒烟证实：
    「工具调用的标记格式是 <invoke name=工具名>」初筛 supported、判官 unsupported。
    所以判官必须看到每一条。
    """
    profile, diagnosis, retrieval = _context()
    resources = ResourceGenerationAgent(gateway=DisabledGateway()).run(
        profile, profile.learning_goal, diagnosis, retrieval)
    baseline = ContentAuditAgent(gateway=DisabledGateway()).run(resources, diagnosis, retrieval)
    assert baseline.claims_total > 0

    seen: list[int] = []

    class CountingGateway:
        def is_enabled(self, agent):
            return True

        def structured_chat(self, agent, system, user, **kwargs):
            seen.append(len(user))
            return {"verdicts": []}

    ContentAuditAgent(gateway=CountingGateway()).run(resources, diagnosis, retrieval)
    assert seen, "判官必须被调用，即使初筛没有存疑声明"


def test_judge_verdict_without_quote_is_treated_as_unsupported():
    """「不确定判 weak」曾是零代价的安全出口：weak 不进幻觉分子、对分数几乎无影响。
    现在判 supported/weak 必须引出证据原文，引不出就按无据收。"""
    profile, diagnosis, retrieval = _context()
    resources = ResourceGenerationAgent(gateway=DisabledGateway()).run(
        profile, profile.learning_goal, diagnosis, retrieval)

    no_quote = {"verdicts": [{"index": i + 1, "verdict": "supported"} for i in range(24)]}
    audited = ContentAuditAgent(gateway=FakeGateway(no_quote)).run(resources, diagnosis, retrieval)
    assert audited.hallucination_rate > 0.0



def test_diagnosis_uses_llm_summary():
    profile = get_learner_profile("zero_beginner")
    payload = {"diagnosis_summary": "该学习者需要从概念识别起步。", "extra_risks": ["needs_scaffolded_examples"]}
    agent = LearnerDiagnosisAgent(gateway=FakeGateway(payload))
    result = agent.run(profile, estimate_pretest_from_profile(profile, load_pretest_questions()))
    assert agent.last_engine == "llm+deterministic"
    assert result.diagnosis_summary == "该学习者需要从概念识别起步。"
    assert "needs_scaffolded_examples" in result.learning_risks
    assert result.recommended_difficulty == "L1"  # 数值判定不受 LLM 影响
