"""决策点协商：冲突判据、确定性兜底、以及仲裁不得推翻硬约束。

这一层的价值全在「冲突判据要有信息量」——恒真和恒假的判据都等于没有协商。
所以前两个用例专门钉住「什么情况**不**开会」。
"""

from backend.agents.decision_negotiation import WEAK_THRESHOLD, negotiate


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
        raise AssertionError("未启用的网关不该被调用——没冲突时开会既贵又假")


def _call(**overrides):
    kwargs = dict(
        current_difficulty="L2",
        rule_decision="advance_challenge",
        rule_difficulty="L3",
        rule_because=["测验得分 0.85，信心 4/5，当前难度 L2"],
        rule_engine="deterministic",
        elo_rating=1230.0,
        elo_difficulty="L1",
        concept_scores={"rag": 0.9, "tool_calling": 0.2},
        free_text="",
        gateway=None,
    )
    kwargs.update(overrides)
    return negotiate(**kwargs)


def test_no_conflict_when_every_concept_is_solid():
    result = _call(concept_scores={"rag": 0.9, "tool_calling": 0.8}, gateway=DisabledGateway())
    assert result["conflict"] is False
    assert "arbitration" not in result
    assert result["final_decision"] == "advance_challenge"
    assert result["final_difficulty"] == "L3"


def test_no_conflict_when_rule_is_not_going_forward():
    """规则本来就要降档补课，知识点信号没有异议——两路同向，不开会。"""
    result = _call(
        rule_decision="downgrade_explanation",
        rule_difficulty="L1",
        gateway=DisabledGateway(),
    )
    assert result["conflict"] is False
    assert result["final_difficulty"] == "L1"


def test_conflict_falls_back_to_patching_the_hole():
    """整场说升档、知识点说有洞：确定性兜底先补洞，难度退回当前档。"""
    result = _call()
    assert result["conflict"] is True
    arb = result["arbitration"]
    assert arb["engine"] == "deterministic"
    assert result["final_decision"] == "add_practice"
    assert result["final_difficulty"] == "L2"
    assert arb["overruled"] == "advance_challenge"
    assert "tool_calling" in arb["rationale"]
    # 动作文案必须跟着裁决改，不能留在「追加进阶挑战」上
    assert "进阶" not in arb["next_action"]


def test_elo_is_reference_only_and_says_so():
    result = _call()
    assert result["reference"]["difficulty"] == "L1"
    assert "不参与裁决" in result["reference"]["note"]
    # L1 既没进候选动作也没成为结论——标定没校准前它不该影响任何人
    assert result["final_difficulty"] != "L1"


def test_llm_arbitration_is_adopted_when_within_bounds():
    result = _call(
        gateway=FakeGateway(
            {
                "chosen_decision": "advance_challenge",
                "chosen_difficulty": "L3",
                "rationale": "留言里说 tool_calling 那题看错了题干，不是不会",
            }
        )
    )
    arb = result["arbitration"]
    assert arb["engine"] == "llm"
    assert result["final_decision"] == "advance_challenge"
    assert result["final_difficulty"] == "L3"


def test_llm_cannot_invent_an_option():
    result = _call(
        gateway=FakeGateway(
            {
                "chosen_decision": "downgrade_explanation",  # 不在候选里
                "chosen_difficulty": "L2",
                "rationale": "我觉得应该降档",
            }
        )
    )
    assert result["arbitration"]["engine"] == "deterministic"
    assert result["final_decision"] == "add_practice"


def test_llm_cannot_jump_two_levels():
    result = _call(
        current_difficulty="L1",
        rule_difficulty="L2",
        gateway=FakeGateway(
            {
                "chosen_decision": "advance_challenge",
                "chosen_difficulty": "L4",  # 相对 L1 跳三级，且不在候选里
                "rationale": "他很强",
            }
        ),
    )
    assert result["arbitration"]["engine"] == "deterministic"
    assert result["final_difficulty"] == "L1"


def test_missing_concept_scores_is_stated_not_faked():
    """没采集逐知识点得分时，该路信号缺席——不能假装它同意。"""
    result = _call(concept_scores={}, gateway=DisabledGateway())
    assert result["conflict"] is False
    kc = result["proposals"][1]
    assert "缺席" in kc["basis"][0]


def test_weak_threshold_is_the_documented_one():
    """口径写死在常量上，改了这里也会连带 FeedbackDecisionAgent 的 because 链。"""
    assert WEAK_THRESHOLD == 0.6
