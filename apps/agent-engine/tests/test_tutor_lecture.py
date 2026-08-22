"""讲义驱动导学测试：假网关验证出题/判分/诚实降级契约，不发真实请求。"""
from backend.integration.personalize_service import run_tutor_turn
from backend.services.tutor_service import TutorRequest, lecture_tutor_turn

LECTURE = (
    "注意力机制让模型在生成每个词时，给上下文中的不同位置分配权重。"
    "权重越高的位置对当前输出影响越大。多头注意力则是并行跑多组注意力，各自关注不同的关系。"
)


class FakeGateway:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def is_enabled(self, agent):
        return True

    def structured_chat(self, agent, system, user, **kwargs):
        self.calls.append((agent, user))
        return self.payload


class DisabledGateway:
    def is_enabled(self, agent):
        return False

    def structured_chat(self, *args, **kwargs):
        raise AssertionError("disabled gateway must not be called")


def _req(**kwargs):
    return TutorRequest(lecture_text=LECTURE, scene_title="注意力机制", course_title="大模型原理", **kwargs)


def test_lecture_ask_generates_question_from_lecture():
    gw = FakeGateway({"question": "为什么权重高的位置影响更大？",
                      "expected_points": ["权重决定该位置对输出的影响力", "注意力按位置逐词分配权重"]})
    turn = lecture_tutor_turn(_req(), gateway=gw)
    assert turn.mode == "ask"
    assert turn.question == "为什么权重高的位置影响更大？"
    assert len(turn.expected_points) == 2
    assert turn.engine == "llm"
    # 走 fast 档的 ConversationTutor 路由，讲义正文进了提示词
    agent, user = gw.calls[0]
    assert agent == "ConversationTutor"
    assert "注意力机制" in user and "权重" in user


def test_lecture_grade_returns_verdict_with_anchored_quote():
    quote = "权重越高的位置对当前输出影响越大"
    gw = FakeGateway({"verdict": "partial", "because": ["提到了权重的作用", "漏了多头注意力"],
                      "explanation": "多头注意力是并行的多组注意力。", "quote": quote})
    turn = lecture_tutor_turn(
        _req(learner_answer="权重高影响大", question="注意力权重起什么作用？",
             expected_points=["权重决定影响力", "多头并行"]),
        gateway=gw)
    assert turn.mode == "verdict"
    assert turn.verdict == "partial"
    assert turn.quote == quote
    assert turn.because and turn.explanation


def test_lecture_grade_drops_fabricated_quote():
    gw = FakeGateway({"verdict": "correct", "because": ["要点全覆盖"],
                      "explanation": "解释", "quote": "讲义里根本没有这句话"})
    turn = lecture_tutor_turn(_req(learner_answer="回答", question="Q"), gateway=gw)
    assert turn.verdict == "correct"
    assert turn.quote == ""  # 引不出讲义原文的引用必须丢弃


def test_lecture_unavailable_when_gateway_disabled():
    turn = lecture_tutor_turn(_req(), gateway=DisabledGateway())
    assert turn.mode == "unavailable"
    assert turn.because


def test_lecture_unavailable_on_bad_llm_output():
    # 出题轮拿不到问题 → 不用模板凑题
    assert lecture_tutor_turn(_req(), gateway=FakeGateway(None)).mode == "unavailable"
    assert lecture_tutor_turn(_req(), gateway=FakeGateway({"question": "  "})).mode == "unavailable"
    # 判分轮裁决不合法 → 不猜对错
    turn = lecture_tutor_turn(_req(learner_answer="答", question="Q"), gateway=FakeGateway({"verdict": "maybe"}))
    assert turn.mode == "unavailable"


def test_decision_follows_answer_history_not_course_content():
    """降维/推进/进阶只看答对序列与目标带，跟课程内容无关。"""
    from backend.services.tutor_service import _lecture_decision

    assert _lecture_decision([])[0] == "probe"
    assert _lecture_decision([True, False])[0] == "simplify"          # 上一问没答到位 → 降维
    assert _lecture_decision([False, True])[0] == "advance"           # 答对且带内 → 推进
    assert _lecture_decision([True, True, True])[0] == "challenge"    # 连对 3 题 → 进阶
    # 答对但滚动正确率低于目标带底（70%）→ 不加难度，先巩固
    assert _lecture_decision([False, False, True])[0] == "simplify"


def test_ask_steers_by_history_and_profile():
    gw = FakeGateway({"question": "换个角度：多头注意力为什么要并行多组？",
                      "expected_points": ["每组关注不同关系"]})
    turn = lecture_tutor_turn(
        _req(lecture_history=[{"question": "权重起什么作用？", "answer": "不知道", "verdict": "incorrect"}],
             prior_mastery=0.3),
        gateway=gw)
    assert turn.mode == "ask" and turn.decision_type == "simplify"
    assert turn.asked == 1 and turn.correct == 0 and turn.mastery_estimate == 0.0
    _, user = gw.calls[0]
    assert "出题指令" in user and "本节历史掌握度 30%" in user
    assert "权重起什么作用？" in user  # 已问过的问题回传，防重复出题
    assert any("目标带" in b for b in turn.because)


def test_verdict_carries_decision_and_running_mastery():
    gw = FakeGateway({"verdict": "correct", "because": ["要点全覆盖"], "explanation": "解释", "quote": ""})
    turn = lecture_tutor_turn(
        _req(learner_answer="答", question="Q",
             lecture_history=[{"question": "Q1", "answer": "a", "verdict": "correct"},
                              {"question": "Q2", "answer": "a", "verdict": "correct"}]),
        gateway=gw)
    assert turn.verdict == "correct"
    assert turn.decision_type == "challenge"     # 连对 3 题 → 下一步进阶
    assert turn.asked == 3 and turn.correct == 3 and turn.mastery_estimate == 1.0
    assert any("目标带" in b for b in turn.because)
    # 判分口径没被改：这轮的判分提示词仍只吃讲义正文 + 要点 + 回答
    _, user = gw.calls[0]
    assert "学习者的回答：答" in user and "出题指令" not in user


def test_run_tutor_turn_routes_lecture_requests():
    # 默认 env 下 LLM 未启用：讲义分支应返回 unavailable（而非 404/编题），概念分支不受影响
    payload = run_tutor_turn(_req(), "t-lecture")
    assert payload["mode"] == "unavailable"
    assert payload["traceId"] == "t-lecture"
    legacy = run_tutor_turn(TutorRequest(concept="llm_basics"), "t-legacy")
    assert legacy["decision"]["type"] == "probe"
