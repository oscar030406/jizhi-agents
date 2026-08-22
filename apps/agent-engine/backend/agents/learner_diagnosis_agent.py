from __future__ import annotations

from backend.schemas.learner import DiagnosisResult, LearnerProfile, PretestResult
from backend.services.feasibility import assess_feasibility
from backend.services.llm_gateway import LLMGateway, llm_gateway
from backend.services.personalization_service import build_personalization_blueprint

CONCEPT_FLOORS = {
    "agent_basics": 0.35,
    "rag": 0.45,
    "tool_calling": 0.45,
    "langgraph": 0.4,
    "evaluation": 0.5,
    "guardrails": 0.45,
    "deployment": 0.4,
}

SUMMARY_SYSTEM = (
    "你是学情诊断分析师。基于给定的掌握度向量、薄弱概念和推荐难度，"
    "用中文写一段面向培训管理者的诊断解读，并补充学习风险。数值结论已由系统算出，"
    "你只负责语义解释，不得更改难度或薄弱概念列表。只输出 JSON："
    '{"diagnosis_summary": str, "extra_risks": [str]}'
)


class LearnerDiagnosisAgent:
    """数值判定（掌握度、难度、薄弱概念）永远走确定性规则，保证可复算；
    LLM 只负责语义层的诊断解读，失败时用确定性模板。"""

    name = "LearnerDiagnosisAgent"

    def __init__(self, gateway: LLMGateway | None = None) -> None:
        self.gateway = gateway or llm_gateway
        self.last_engine = "deterministic"

    def run(
        self,
        profile: LearnerProfile,
        pretest: PretestResult,
        learning_goal: str | None = None,
    ) -> DiagnosisResult:
        mastery = dict(pretest.concept_scores)
        mastery.setdefault("agent_basics", profile.agent_level / 4)
        mastery.setdefault("rag", profile.rag_level / 4)
        mastery.setdefault("tool_calling", max(profile.agent_level, profile.python_level) / 4)
        mastery.setdefault("langgraph", min(profile.agent_level, profile.engineering_level) / 4)
        mastery.setdefault("evaluation", min(profile.engineering_level, profile.rag_level + 1) / 4)
        mastery.setdefault("guardrails", min(profile.agent_level + 1, 4) / 4)
        mastery.setdefault("deployment", profile.engineering_level / 4)
        mastery = {key: round(min(1.0, max(0.0, value)), 3) for key, value in mastery.items()}

        weak_concepts = [concept for concept, floor in CONCEPT_FLOORS.items() if mastery.get(concept, 0.0) < floor]
        if not weak_concepts:
            weak_concepts = sorted(mastery, key=mastery.get)[:2]

        difficulty = self._recommend_difficulty(mastery, learning_goal, profile)

        risks = []
        if profile.engineering_level <= 1:
            risks.append("engineering_foundation_weak")
        if "rag" in weak_concepts:
            risks.append("evidence_grounding_risk")
        if "evaluation" in weak_concepts:
            risks.append("cannot_self_verify_outputs")

        summary = (
            f"建议 {profile.name} 从 {difficulty} 难度起步。"
            f"薄弱概念：{'、'.join(weak_concepts)}。"
            f"学习计划应以证据约束的实操任务为主，并保持评测结果可见。"
        )
        self.last_engine = "deterministic"
        llm_summary, llm_risks = self._llm_interpretation(profile, mastery, weak_concepts, difficulty)
        if llm_summary:
            summary = llm_summary
            risks = list(dict.fromkeys(risks + llm_risks))
            self.last_engine = "llm+deterministic"
        blueprint = build_personalization_blueprint(
            profile,
            learning_goal or profile.learning_goal,
            mastery,
        )
        # 时间预算够不够是确定性判定，不问模型。要补的知识点数优先取蓝图里 gap>0 的，
        # 蓝图缺席才退回薄弱概念——前者是目标闭包算出来的，更贴这个目标真正的工作量。
        gaps = [gap for gap in blueprint.skill_gaps if gap.gap > 0] if blueprint else []
        feasibility = assess_feasibility(
            profile.time_budget_hours,
            len(gaps) or len(weak_concepts),
        )
        # 原来这里写死「预算 < 20 小时算紧」——那个 20 没有出处。现在这条风险由实测判据出。
        if feasibility and feasibility.verdict != "ok":
            risks.append(f"time_budget_{feasibility.verdict}")
        return DiagnosisResult(
            mastery_vector=mastery,
            weak_concepts=weak_concepts,
            recommended_difficulty=difficulty,
            learning_risks=risks,
            diagnosis_summary=summary,
            personalization_blueprint=blueprint,
            feasibility=feasibility,
        )

    def _recommend_difficulty(
        self,
        mastery: dict[str, float],
        learning_goal: str | None,
        profile: LearnerProfile | None = None,
    ) -> str:
        """推荐难度 = min(学习者就绪度, 目标难度上限)。

        修两个真实缺陷（Phase A 难度定标）：
        1) 就绪度用「能力尊重式」估计（均值 + 高分位混合），避免单个新领域空白把
           强通才拉到初级——一个资深工程师转 Agent 仍能承受高难度材料（配脚手架）。
        2) 目标感知：难度不超过目标本身需要的水平（目标难度来自知识库概念难度，
           数据驱动，独立于金标的人工目标表）。
        """
        readiness = self._effective_readiness(mastery, profile)
        if not learning_goal:
            return readiness
        from backend.services.concept_difficulty import goal_difficulty

        goal_level = goal_difficulty(learning_goal)  # 1-4
        readiness_int = ["L1", "L2", "L3", "L4"].index(readiness) + 1
        return f"L{min(readiness_int, goal_level)}"

    @classmethod
    def _effective_readiness(
        cls,
        mastery: dict[str, float],
        profile: LearnerProfile | None,
    ) -> str:
        """在领域掌握度之外保留可迁移的工程就绪度。

        Agent 领域暂时薄弱不等于无法处理高级工程任务。编程与工程能力均达到 4 级的
        学习者，允许在有脚手架和证据约束的情况下进入 L4；其余画像仍完全由领域掌握度
        决定。最终推荐难度仍受目标难度上限约束。
        """
        base = cls._readiness_level(mastery)
        if profile and profile.programming_level >= 4 and profile.engineering_level >= 4:
            return "L4"
        return base

    @staticmethod
    def _readiness_level(mastery: dict[str, float]) -> str:
        """能力尊重式就绪度：0.4·均值 + 0.6·75分位，奖励已展示的强项而非被空白拉平。"""
        values = sorted(mastery.values())
        if not values:
            return "L1"
        mean = sum(values) / len(values)
        p75 = values[min(len(values) - 1, int(0.75 * (len(values) - 1) + 0.5))]
        score = 0.4 * mean + 0.6 * p75
        if score < 0.33:
            return "L1"
        if score < 0.55:
            return "L2"
        if score < 0.75:
            return "L3"
        return "L4"

    def _llm_interpretation(
        self,
        profile: LearnerProfile,
        mastery: dict[str, float],
        weak_concepts: list[str],
        difficulty: str,
    ) -> tuple[str | None, list[str]]:
        if not self.gateway.is_enabled(self.name):
            return None, []
        user = (
            f"学习者：{profile.name}，背景：{profile.background}，"
            f"时间预算 {profile.time_budget_hours} 小时，偏好 {profile.learning_preference}。\n"
            f"掌握度向量：{mastery}\n薄弱概念：{weak_concepts}\n推荐难度：{difficulty}"
        )
        parsed = self.gateway.structured_chat(self.name, SUMMARY_SYSTEM, user, max_tokens=800)
        if not parsed:
            return None, []
        summary = parsed.get("diagnosis_summary")
        extra_risks = parsed.get("extra_risks")
        if not isinstance(summary, str) or not summary.strip():
            return None, []
        risks = [str(risk) for risk in extra_risks if str(risk).strip()] if isinstance(extra_risks, list) else []
        return summary.strip(), risks[:4]
