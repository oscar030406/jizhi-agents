"""决策点的协商：两路信号冲突时才开会。

赛题第(3)②要的是「多智能体协同决策是否对**知识点**进行降维解释或生成进阶挑战」，
赛题解读的判定是「反馈响应本身要是一次**可见的协同决策**，不是 if-else 阈值分支」。
在此之前我们只有流水线（检索→生成→审核→仲裁），决策点那一侧没有协商结构——
设计稿 §7.4 自己写明了这个差距。

## 两路信号是什么，为什么是这两路

- **A 整场裁决**：`FeedbackDecisionAgent` 看整场得分 + 信心 + 留言，出升/降/保持。
- **B 知识点分布**：`concept_scores` 逐个知识点的掌握度，看有没有拖后腿的点。

B 独立于 A：整场 0.85 完全可以同时存在一个 0.2 的知识点。设计稿 §4.4 花整节论证
判定必须 per-KC 不能只看题级，这里是同一条原则落在决策上。

**Elo 评级不参与裁决**，只作参考信号并排展示。原因是实测的标定问题：
`rating_to_difficulty(pick_target_rating(r))` 在默认评级 1200 时建议 L1，
在 1450（很强）时才建议 L2——item rating（L1=1000 / L2=1150）相对 `DEFAULT_RATING=1200`
整体偏高。拿它当裁决依据会把每个学习者推到 L1。标定该修，但那是另一个变量，
不在这次改动里；在修好之前，这里如实标注它未校准。
（PLAYBOOK 不变量「校准暴露」：知道偏了就写出来，不装作没看见。）

## 三条纪律，都来自设计稿

- **只在冲突时唤起模型**（§7.3 按需 agent）。两路一致就不开会——没冲突时开会既贵又假。
  默认 `AGENT_GENERATION_MODE=deterministic` 下本模块一次 LLM 都不调。
- **传结构化建议，不传自由文本**（§7.5）。仲裁要能比较，两方各写一段散文没法裁。
- **仲裁不能推翻确定性层**（§7.6）。裁决必须落在给定候选里，且难度相对当前最多变化一级；
  模型越界一律驳回走确定性兜底。
"""

from __future__ import annotations

import json
from typing import Any

from backend.services.elo_rating import expected_score, initial_item_rating
from backend.services.llm_gateway import LLMGateway

AGENT_NAME = "DecisionNegotiationAgent"

#: 掌握度低于此值算「薄弱知识点」。与 FeedbackDecisionAgent._run_deterministic 同口径，
#: 两处改要一起改——不同口径会让协商记录和 because 链自相矛盾。
WEAK_THRESHOLD = 0.6

#: 目标成功率带：下界 0.75 = Math Garden 的目标正确率，上界 0.85 = Wilson 2019 的 85% 规则。
#: 只用于生成参考读数，不用于裁决（见模块头 Elo 标定说明）。
TARGET_BAND = (0.75, 0.85)

VALID_DIFFICULTIES = ("L1", "L2", "L3", "L4")

#: 会被知识点信号质疑的裁决：往前走，但底下有洞。
FORWARD_DECISIONS = ("advance_challenge", "keep_route")

#: 裁决改了，下一步动作的文案必须跟着改。留在原文案上就是 PLAYBOOK 不变量 7 说的那类
#: 不一致——UI 显示「补充练习」，正文却写「追加进阶挑战」。
ACTION_TEXT = {
    "downgrade_explanation": "针对最薄弱概念生成一份更简单的解释和两道聚焦练习。",
    "add_practice": "保持当前难度，针对薄弱知识点补一轮聚焦练习。",
    "advance_challenge": "追加进阶挑战：在更高难度上做一次综合任务。",
    "keep_route": "保持当前路线继续推进。",
}

ARBITER_SYSTEM = (
    "你是学习路线仲裁 Agent。两路信号对下一步给出了不同主张，你要在给定候选里选一个。"
    "一路看整场得分，一路看逐知识点掌握度。"
    "考虑学习者留言——那是另外两路都看不见的信息。"
    "硬约束：chosen_decision 必须是候选之一，chosen_difficulty 必须是候选之一，不得自创。"
    "rationale 说清采信哪一路、放弃哪一路，一句话，引用具体信号。只输出 JSON："
    '{"chosen_decision": str, "chosen_difficulty": str, "rationale": str}'
)


def _level(difficulty: str) -> int:
    return int(difficulty[1]) if difficulty in VALID_DIFFICULTIES else 2


def _band_reading(rating: float, difficulty: str) -> str:
    p = expected_score(rating, initial_item_rating(difficulty))
    return f"{difficulty} 档预期成功率 {p:.2f}（目标带 {TARGET_BAND[0]}–{TARGET_BAND[1]}）"


def negotiate(
    *,
    current_difficulty: str,
    rule_decision: str,
    rule_difficulty: str,
    rule_because: list[str],
    rule_engine: str,
    elo_rating: float,
    elo_difficulty: str,
    concept_scores: dict[str, float] | None = None,
    free_text: str = "",
    gateway: LLMGateway | None = None,
) -> dict[str, Any]:
    """两路信号的协商记录。无冲突时不调模型，只记录一致。

    返回结构对 UI 是稳定契约：
    `conflict` / `proposals` / `reference` / `arbitration` / `final_decision` / `final_difficulty`。
    `arbitration` 只在冲突时存在。
    """
    scores = concept_scores or {}
    weak = sorted((c for c, s in scores.items() if s < WEAK_THRESHOLD), key=lambda c: scores[c])
    going_forward = rule_decision in FORWARD_DECISIONS

    kc_basis = (
        [
            f"{len(weak)}/{len(scores)} 个知识点掌握度 < {WEAK_THRESHOLD}："
            + "、".join(f"{c} {scores[c]:.2f}" for c in weak[:3]),
            "带着未补的洞往前走，下一次的预期成功率会掉出目标带",
        ]
        if weak
        else [
            f"全部 {len(scores)} 个知识点掌握度 ≥ {WEAK_THRESHOLD}，没有拖后腿的点"
            if scores
            else "本次未采集逐知识点得分，该路信号缺席"
        ]
    )

    proposals: list[dict[str, Any]] = [
        {
            "source": "反馈决策 Agent",
            "signal": "整场得分",
            "decision": rule_decision,
            "difficulty": rule_difficulty,
            "engine": rule_engine,
            # 依据沿用裁决自己的 because 链，不重新措辞——重写等于制造第二份口径。
            "basis": list(rule_because),
        },
        {
            "source": "知识点掌握度",
            "signal": "逐知识点分布",
            # 有洞就主张原地补洞（难度不动），没洞就不反对整场裁决。
            "decision": "add_practice" if weak else rule_decision,
            "difficulty": current_difficulty if weak else rule_difficulty,
            "engine": "deterministic",
            "basis": kc_basis,
        },
    ]

    reference = {
        "source": "Elo 能力评级",
        "rating": round(elo_rating, 1),
        "difficulty": elo_difficulty,
        "basis": [_band_reading(elo_rating, elo_difficulty)],
        # 不参与裁决，且必须说明为什么——不写的话下一个人会直接拿它当判据。
        "note": "参考信号，不参与裁决：档位映射标定未校准（默认评级即建议 L1），修好前不作判据",
    }

    # 冲突判据：整场说往前走，知识点说底下有洞。恒不冲突的判据没有信息量，
    # 恒冲突的同样没有——这一条只在两路真的指向不同动作时为真。
    conflict = bool(weak) and going_forward
    if not conflict:
        return {
            "conflict": False,
            "proposals": proposals,
            "reference": reference,
            "final_decision": rule_decision,
            "final_difficulty": rule_difficulty,
        }

    decision_candidates = (rule_decision, "add_practice")
    difficulty_candidates = (rule_difficulty, current_difficulty)

    # 确定性兜底：先补洞。依据不是偏好，是 §6.1 的首排序键——带着 <0.6 的知识点升档，
    # 下一次预期成功率必然掉出 0.75–0.85 带。
    chosen_decision, chosen_difficulty = "add_practice", current_difficulty
    rationale = (
        f"采信知识点信号：整场 {rule_decision} 成立，但 {'、'.join(weak[:3])} 仍低于 "
        f"{WEAK_THRESHOLD}。先在当前难度 {current_difficulty} 补这几个点，补完再往前走——"
        f"带着未补的洞升档会让预期成功率掉出目标带 {TARGET_BAND[0]}–{TARGET_BAND[1]}。"
    )
    engine = "deterministic"

    if gateway is not None and gateway.is_enabled(AGENT_NAME):
        user = (
            f"当前难度：{current_difficulty}\n"
            f"候选动作：{decision_candidates[0]} / {decision_candidates[1]}\n"
            f"候选难度：{difficulty_candidates[0]} / {difficulty_candidates[1]}\n"
            f"两路提案：{json.dumps(proposals, ensure_ascii=False)}\n"
            f"学习者留言：{free_text or '无'}"
        )
        parsed = gateway.structured_chat(AGENT_NAME, ARBITER_SYSTEM, user, max_tokens=400)
        picked_d = str((parsed or {}).get("chosen_decision", ""))
        picked_diff = str((parsed or {}).get("chosen_difficulty", ""))
        reason = str((parsed or {}).get("rationale", "")).strip()
        # §7.6：仲裁不能推翻确定性层。越界（自创选项 / 跳档）一律驳回，走兜底。
        if (
            picked_d in decision_candidates
            and picked_diff in difficulty_candidates
            and reason
            and abs(_level(picked_diff) - _level(current_difficulty)) <= 1
        ):
            chosen_decision, chosen_difficulty, rationale, engine = (
                picked_d,
                picked_diff,
                reason,
                "llm",
            )

    return {
        "conflict": True,
        "proposals": proposals,
        "reference": reference,
        "arbitration": {
            "decision": chosen_decision,
            "difficulty": chosen_difficulty,
            "next_action": ACTION_TEXT.get(chosen_decision, ""),
            "rationale": rationale,
            "engine": engine,
            "overruled": [d for d in decision_candidates if d != chosen_decision][0],
        },
        "final_decision": chosen_decision,
        "final_difficulty": chosen_difficulty,
    }
