from __future__ import annotations

from backend.schemas.resources import ArbitrationDecision, AuditResult, DebateRound

PUBLISH_FLOOR = 0.62
#: 幻觉率放行上限。原来是下面那行条件里的字面量 0.10，抽出来是因为接入流水线的
#: ⑦ 站也要拿同一条线判新库（`domain_intake._grade_trial`）——两处各写一个数字，
#: 早晚会只改一处。
HALLUCINATION_CEILING = 0.10


class ArbitrationAgent:
    """辩论到达轮数上限后仍有分歧时的最终裁决。

    规则是显式阈值而不是 LLM：仲裁是流水线的最后一道闸，
    必须可解释、可复算，答辩时能一句话说清放行标准。
    """

    name = "ArbitrationAgent"
    last_engine = "deterministic"

    def run(self, final_audit: AuditResult, debate: list[DebateRound]) -> ArbitrationDecision:
        rounds = len(debate)
        remaining = "、".join(final_audit.hallucination_risk_flags) or "无"
        unresolved = len(final_audit.challenges)
        challenge_note = f"仍有 {unresolved} 条质疑未消解。" if unresolved else ""
        if (
            final_audit.factuality_score >= PUBLISH_FLOOR
            and final_audit.hallucination_rate <= HALLUCINATION_CEILING
        ):
            return ArbitrationDecision(
                action="publish_with_warnings",
                rationale=(
                    f"经过 {rounds} 轮修订，事实性得分 {final_audit.factuality_score} 已达放行线 {PUBLISH_FLOOR}，"
                    f"剩余风险标记（{remaining}）随资源一并展示给使用者。{challenge_note}"
                ),
                final_factuality=final_audit.factuality_score,
            )
        return ArbitrationDecision(
            action="block_pending_human_review",
            rationale=(
                f"经过 {rounds} 轮修订，事实性得分 {final_audit.factuality_score} 仍低于放行线 {PUBLISH_FLOOR} "
                f"或幻觉率 {final_audit.hallucination_rate} 超限，拦截并转人工审核。风险标记：{remaining}。{challenge_note}"
            ),
            final_factuality=final_audit.factuality_score,
        )
