from __future__ import annotations

from backend.schemas.learner import FeedbackInput
from backend.schemas.resources import FeedbackDecision
from backend.services.llm_gateway import LLMGateway, llm_gateway

VALID_DECISIONS = {"downgrade_explanation", "add_practice", "advance_challenge", "keep_route"}
VALID_DIFFICULTIES = {"L1", "L2", "L3", "L4"}

DECISION_SYSTEM = (
    "你是学习反馈决策 Agent。根据测验得分、信心等级和学习者留言，决定下一步动作。"
    "可选 decision：downgrade_explanation（降维解释）、add_practice（补充练习）、"
    "advance_challenge（进阶挑战）、keep_route（保持路线）。"
    "updated_difficulty 必须是 L1-L4 之一，且相对当前难度最多变化一级。"
    "because 逐条列出裁决依据（引用具体分数/信心/薄弱概念，2-4 条）。"
    "只输出 JSON："
    '{"feedback_type": str, "decision": str, "updated_difficulty": str, '
    '"next_action": str, "explanation": str, "because": [str]}'
)


class FeedbackDecisionAgent:
    name = "FeedbackDecisionAgent"

    def __init__(self, gateway: LLMGateway | None = None) -> None:
        self.gateway = gateway or llm_gateway
        self.last_engine = "deterministic"

    def run(self, feedback: FeedbackInput, current_difficulty: str = "L2") -> FeedbackDecision:
        llm_decision = self._run_llm(feedback, current_difficulty)
        if llm_decision is not None:
            self.last_engine = "llm"
            return llm_decision
        self.last_engine = "deterministic"
        return self._run_deterministic(feedback, current_difficulty)

    def _run_llm(self, feedback: FeedbackInput, current_difficulty: str) -> FeedbackDecision | None:
        if not self.gateway.is_enabled(self.name):
            return None
        user = (
            f"当前难度：{current_difficulty}\n测验得分：{feedback.quiz_score}\n"
            f"信心等级（1-5）：{feedback.confidence}\n学习者留言：{feedback.free_text or '无'}"
        )
        parsed = self.gateway.structured_chat(self.name, DECISION_SYSTEM, user, max_tokens=600)
        if not parsed:
            return None
        decision = str(parsed.get("decision", ""))
        difficulty = str(parsed.get("updated_difficulty", ""))
        if decision not in VALID_DECISIONS or difficulty not in VALID_DIFFICULTIES:
            return None
        if abs(int(difficulty[1]) - int(current_difficulty[1])) > 1:
            return None
        next_action = str(parsed.get("next_action", "")).strip()
        explanation = str(parsed.get("explanation", "")).strip()
        if not next_action or not explanation:
            return None
        raw_because = parsed.get("because")
        because = [str(b) for b in raw_because if str(b).strip()] if isinstance(raw_because, list) else []
        return FeedbackDecision(
            feedback_type=str(parsed.get("feedback_type", "adaptive")),
            decision=decision,
            updated_difficulty=difficulty,
            next_action=next_action,
            explanation=explanation,
            because=because or [
                f"测验得分 {feedback.quiz_score:.2f}，信心 {feedback.confidence}/5（LLM 未给出依据，回填信号）"],
        )

    def _run_deterministic(self, feedback: FeedbackInput, current_difficulty: str) -> FeedbackDecision:
        current_level = int(current_difficulty[1]) if current_difficulty in VALID_DIFFICULTIES else 2
        lower_difficulty = f"L{max(1, current_level - 1)}"
        higher_difficulty = f"L{min(4, current_level + 1)}"
        weak = sorted(
            (c for c, s in (feedback.concept_scores or {}).items() if s < 0.6),
            key=lambda c: feedback.concept_scores[c])[:3]
        base_facts = [
            f"测验得分 {feedback.quiz_score:.2f}，{_confidence_label(feedback)}，当前难度 {current_difficulty}",
        ] + ([f"薄弱概念（得分<0.6）：{'、'.join(weak)}"] if weak else [])
        if feedback.quiz_score < 0.45 or (feedback.confidence is not None and feedback.confidence <= 2):
            return FeedbackDecision(
                feedback_type="remediation",
                decision="downgrade_explanation",
                updated_difficulty=lower_difficulty,
                next_action="针对最薄弱概念生成一份更简单的解释和两道聚焦练习。",
                explanation="得分或信心偏低，说明学习者需要先获得降维解释再继续推进。",
                because=base_facts + [
                    f"触发降维阈值：得分<0.45 或 信心≤2 → 难度 {current_difficulty}→{lower_difficulty}"],
            )
        if feedback.quiz_score < 0.75:
            return FeedbackDecision(
                feedback_type="practice",
                decision="add_practice",
                updated_difficulty=f"L{current_level}",
                next_action="保持当前路线，增加一道带提示的引导式实现练习。",
                explanation="学习者接近掌握，但还需要一轮练习巩固。",
                because=base_facts + ["处于巩固区间：0.45≤得分<0.75 → 难度保持，补练习"],
            )
        return FeedbackDecision(
            feedback_type="advancement",
            decision="advance_challenge",
            updated_difficulty=higher_difficulty,
            next_action="追加进阶挑战：组合 RAG、一次工具调用和审核 trace 可视化。",
            explanation="得分和信心都较高，可以进入更开放的任务。",
            because=base_facts + [
                f"触发进阶阈值：得分≥0.75 且信心>2 → 难度 {current_difficulty}→{higher_difficulty}"],
        )


def _confidence_label(feedback) -> str:
    """信心的诚实措辞：采集到才报数字，没采集就直说。默认 3 假装成测量值是旧事故。"""
    if feedback.confidence is None:
        return "信心未采集"
    return f"信心 {feedback.confidence}/5"
