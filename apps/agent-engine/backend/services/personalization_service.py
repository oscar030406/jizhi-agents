from __future__ import annotations

from backend.schemas.learner import (
    LearnerProfile,
    PersonalizationBlueprint,
    ResourceMix,
    SkillGap,
    SkillRequirement,
)
from backend.services.concept_difficulty import concept_difficulty_map
from backend.services.concept_graph import concept_meta, prerequisite_closure, topological_order
from backend.services.goal_concepts import goal_concepts

TARGET_MASTERY = {"L1": 0.45, "L2": 0.60, "L3": 0.75, "L4": 0.90}


def build_personalization_blueprint(
    profile: LearnerProfile,
    learning_goal: str,
    mastery_vector: dict[str, float],
) -> PersonalizationBlueprint:
    """构造可复算的 goal→skill→gap→content 个性化蓝图。"""
    direct_concepts = goal_concepts(learning_goal)
    required_concepts = topological_order(prerequisite_closure(direct_concepts))
    if not required_concepts:
        required_concepts = direct_concepts

    difficulty_map = concept_difficulty_map()
    requirements: list[SkillRequirement] = []
    unsorted_gaps: list[tuple[int, int, SkillGap]] = []
    for order, concept in enumerate(required_concepts):
        meta = concept_meta(concept)
        level = str(meta.get("difficulty") or f"L{difficulty_map.get(concept, 2)}")
        if level not in TARGET_MASTERY:
            level = "L2"
        target = TARGET_MASTERY[level]
        current = round(max(0.0, min(1.0, mastery_vector.get(concept, 0.0))), 3)
        gap_value = round(max(0.0, target - current), 3)
        relationship = "目标直接要求" if concept in direct_concepts else "目标前置技能"
        requirements.append(
            SkillRequirement(
                concept=concept,
                required_level=level,
                target_mastery=target,
                reason=f"{relationship}；概念图标注难度为 {level}。",
            )
        )
        unsorted_gaps.append(
            (
                -round(gap_value * 1000),
                order,
                SkillGap(
                    concept=concept,
                    current_mastery=current,
                    target_mastery=target,
                    gap=gap_value,
                    priority=1,
                    reason=(
                        f"当前掌握度 {current:.2f}，目标掌握度 {target:.2f}；"
                        f"{relationship}。"
                    ),
                ),
            )
        )

    sorted_gaps = [item[2] for item in sorted(unsorted_gaps, key=lambda item: (item[0], item[1]))]
    skill_gaps = [gap.model_copy(update={"priority": index + 1}) for index, gap in enumerate(sorted_gaps)]
    learner_type = _learner_type(profile, mastery_vector)
    content, practice, assessment = _strategies(learner_type, profile.learning_preference)
    resource_mix = _resource_mix(profile, learner_type)
    refined_goal = (
        f"围绕“{learning_goal.strip()}”，按前置关系补齐 "
        f"{len([gap for gap in skill_gaps if gap.gap > 0])} 项技能缺口，"
        f"最终完成可运行、可审核、可评测的学习产物。"
    )
    return PersonalizationBlueprint(
        refined_goal=refined_goal,
        required_skills=requirements,
        skill_gaps=skill_gaps,
        learner_type=learner_type,
        content_strategy=content,
        practice_strategy=practice,
        assessment_strategy=assessment,
        resource_mix=resource_mix,
    )


def _learner_type(profile: LearnerProfile, mastery_vector: dict[str, float]) -> str:
    values = list(mastery_vector.values())
    average = sum(values) / len(values) if values else 0.0
    if average < 0.40 or profile.programming_level <= 1 or profile.engineering_level <= 1:
        return "guided_beginner"
    if average >= 0.70 or (profile.engineering_level >= 3 and profile.programming_level >= 3):
        return "systems_engineer"
    return "practice_builder"


# 支架档按 learner_type（基础轴）：expertise reversal——低基础高辅助、高基础删冗余。
_SCAFFOLD = {
    "guided_beginner": ("full", "160-220", ["L1", "L2"]),
    "practice_builder": ("faded", "120-200", ["L2"]),
    "systems_engineer": ("minimal", "100-160", ["L2", "L3"]),
}

# 类比情境按背景关键词（兴趣情境化）：转型者用本行做类比。命中即止，顺序=优先级。
_ANALOGY_DOMAINS = [
    (("后端", "数据库", "backend", "服务端"), "后端工程场景（接口契约、缓存失效、数据库查询）"),
    (("算法", "科研", "论文", "数学"), "算法与数学场景（矩阵、概率、优化）"),
    (("前端", "页面", "vue", "react"), "前端工程场景（组件、状态、渲染）"),
    (("零基础", "非计算机", "文科", "转行"), "生活场景（旅行、点餐、快递分拣）"),
]


def _resource_mix(profile: LearnerProfile, learner_type: str) -> ResourceMix:
    """基础轴定支架/篇幅/难度带，偏好轴定教具与代码配比，背景定类比域。纯规则可复算。"""
    scaffold, length_band, quiz_band = _SCAFFOLD.get(learner_type, _SCAFFOLD["practice_builder"])
    pref = profile.learning_preference
    likes_visual = "图" in pref
    likes_code = ("代码" in pref) or ("实操" in pref) or ("项目" in pref)
    # 底线配额：可视化与代码人人≥1（普适增益），偏好只加码不清零。
    visual_widgets = 2 if likes_visual else 1
    diagrams = 2 if likes_visual else 1
    code_examples = 3 if likes_code else 1
    background = profile.background.lower()
    # 兜底档改成生活场景。原来是「通用软件场景（配置、日志、接口调用）」——
    # 背景关键词不命中就落它，实测让一个零基础学生学注意力机制时，
    # 整节课在讲 default.yaml 被 prod.yaml 覆盖。配置/日志只对已经在写后端的人成立，
    # 不能当所有人的默认。见 docs/03-design/openmaic_quality_gap_diagnosis.md R1。
    analogy = next(
        (domain for keys, domain in _ANALOGY_DOMAINS if any(k in background for k in keys)),
        "日常生活场景（排队、找东西、看菜单点餐）",
    )
    rationale = [
        f"学习者类型 {learner_type} → 支架档 {scaffold}、每节 {length_band} 字、"
        f"测验难度带 {'/'.join(quiz_band)}（基础轴双向调支架：低基础加完整例题与导读，"
        f"高基础主动撤——expertise reversal 表明冗余辅助对高基础是认知负荷，删冗余不是省事是必要）",
        f"学习偏好「{pref[:20]}…」→ 教具 {visual_widgets}、图示 {diagrams}、"
        f"代码示例 {code_examples}（偏好轴只调呈现配比，底线人人≥1）",
        f"背景「{profile.background[:20]}…」→ 类比域「{analogy}」（兴趣情境化）",
    ]
    return ResourceMix(
        scaffold_level=scaffold,
        visual_widget_count=visual_widgets,
        diagram_count=diagrams,
        code_example_count=code_examples,
        analogy_domain=analogy,
        section_length_band=length_band,
        quiz_difficulty_band=list(quiz_band),
        rationale=rationale,
    )


def _strategies(learner_type: str, preference: str) -> tuple[list[str], list[str], list[str]]:
    preference_note = f"优先适配学习偏好：{preference}"
    if learner_type == "guided_beginner":
        return (
            ["先用生活类比建立直觉", "再用流程图拆解机制", "最后给出最小分步示例", preference_note],
            ["使用填空式或半成品练习", "每步只引入一个新概念", "提供即时自检提示"],
            ["概念辨析题", "步骤排序题", "最小闭环验收"],
        )
    if learner_type == "systems_engineer":
        return (
            ["先给状态机与接口契约", "分析并发、失败模式和边界条件", "以观测指标验证设计", preference_note],
            ["实现可替换组件", "注入异常与超时", "完成压力与回归检查"],
            ["契约测试", "故障恢复验证", "P95延迟与质量指标"],
        )
    return (
        ["解释核心机制", "提供可运行示例", "定位常见错误", preference_note],
        ["从模板补全关键步骤", "逐步减少提示", "按验收清单自查"],
        ["代码运行结果", "错误诊断题", "端到端功能验收"],
    )
