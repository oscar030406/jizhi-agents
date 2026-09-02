from __future__ import annotations

from backend.schemas.learner import DiagnosisResult, LearnerProfile
from backend.schemas.resources import AuditResult, LearningPath, LearningPathStage, LearningResources
from backend.services.concept_graph import (
    concept_meta,
    isolated_corpus,
    load_graph,
    prerequisite_closure,
    topological_order,
)

_LEVELS = ["L1", "L2", "L3", "L4"]


class LearningPathPlannerAgent:
    """按概念前置图 + 学习者薄弱点动态生成学习路径（PLAYBOOK Phase B-2）。

    取代原死模板：不同画像（薄弱概念、推荐难度不同）→ 不同的前置闭包与拓扑顺序 → 不同的路径。
    """

    name = "LearningPathPlannerAgent"

    def run(
        self,
        profile: LearnerProfile,
        diagnosis: DiagnosisResult,
        resources: LearningResources,
        audit: AuditResult,
    ) -> LearningPath:
        blueprint = diagnosis.personalization_blueprint
        if not blueprint or blueprint.goal_mapping_status != "mapped":
            raise RuntimeError("学习路径生成失败：缺少已映射的领域个性化蓝图。")
        graph = load_graph()
        # 独立建出来的库按自己的前置图排（`isolated_corpus` 只对有 <corpus>_intake 的库
        # 返回域名）。此前这里拿的是全域并集：接入流水线给智能制造造了 51 条边，
        # 却和 AI、具身的边拍在一张平表里，学习者学智能制造时闭包里能长出 AI 概念。
        # 主库（ai/空）仍走并集——它的索引本来就含具身子域，硬过滤反而劈开了该在一起的两半。
        domain = isolated_corpus(blueprint.corpus)
        # 学习者本次需要的概念 = 技能缺口 + 薄弱概念 + 目标概念；扩展到前置闭包。
        gap_concepts = [
            gap.concept
            for gap in blueprint.skill_gaps
            if gap.gap > 0
        ]
        gap_priority = {
            gap.concept: gap.priority
            for gap in blueprint.skill_gaps
        }
        needed = list(dict.fromkeys(gap_concepts + diagnosis.weak_concepts + resources.target_concepts))
        closure = prerequisite_closure(needed, domain) if graph else needed
        ordered = topological_order(closure, domain) if graph else needed

        rec_rank = _rank(diagnosis.recommended_difficulty)
        weak_set = set(diagnosis.weak_concepts) | set(gap_concepts)
        base_hours = max(2, min(8, profile.time_budget_hours // 4))

        # 核心阶段：难度不超过推荐难度的概念，按难度分档成阶段
        core = [c for c in ordered if _rank(_concept_level(c, graph, domain)) <= rec_rank]
        advanced = [c for c in ordered if _rank(_concept_level(c, graph, domain)) > rec_rank]
        if not core:
            core = ordered[:1] or needed[:1]

        stages: list[LearningPathStage] = []
        stage_no = 0
        for level in _LEVELS:
            level_concepts = [c for c in core if _concept_level(c, graph, domain) == level]
            level_concepts.sort(key=lambda concept: gap_priority.get(concept, 10_000))
            if not level_concepts:
                continue
            stage_no += 1
            gap_here = [c for c in level_concepts if c in weak_set]
            titles = "、".join(_concept_title(c, graph, domain) for c in level_concepts)
            misconceptions = [
                misconception
                for concept in level_concepts
                for misconception in concept_meta(concept, domain).get("misconceptions", [])
            ][:2]
            practice = (
                resources.practice_task.title
                if resources.practice_task.difficulty == level
                else f"围绕 {titles} 做一个证据约束的小实操，产出可运行片段并记录 trace。"
            )
            goals = [f"掌握：{titles}"]
            if gap_here:
                goals.append(
                    f"重点补齐薄弱点："
                    f"{'、'.join(_concept_title(c, graph, domain) for c in gap_here)}"
                )
            if misconceptions:
                goals.append(f"规避常见误区：{'；'.join(misconceptions)}")
            stages.append(
                LearningPathStage(
                    stage_id=f"stage-{stage_no}",
                    title=f"阶段{stage_no}·{level} {titles}",
                    difficulty=level,
                    goals=goals,
                    concepts=level_concepts,
                    practice_task=practice,
                    assessment=f"针对 {titles} 的分阶测验 + 证据引用检查",
                    estimated_hours=base_hours + (_rank(level) - 1),
                )
            )

        # 审核未过则插入证据修订阶段
        if audit.revision_required and stages:
            stages.insert(
                min(1, len(stages)),
                LearningPathStage(
                    stage_id="stage-revise",
                    title="证据修订巩固",
                    difficulty=diagnosis.recommended_difficulty,
                    goals=["为缺引用的结论补齐 source_id", "重做被审核判为无据的部分"],
                    concepts=list(weak_set)[:4] or resources.target_concepts[:3],
                    practice_task="把生成资源修订到审核通过：引用覆盖与概念覆盖达标。",
                    assessment="审核事实性≥0.75 且无低置信检索警告",
                    estimated_hours=2,
                ),
            )

        # 进阶展望（超出当前推荐难度的概念）
        if advanced:
            titles = "、".join(_concept_title(c, graph, domain) for c in advanced)
            stages.append(
                LearningPathStage(
                    stage_id="stage-advanced",
                    title=f"进阶展望·{titles}",
                    difficulty=_concept_level(advanced[-1], graph, domain),
                    goals=[f"达成当前阶段后再挑战：{titles}"],
                    concepts=advanced,
                    practice_task=f"完成核心阶段后，选做 {titles} 的开放任务。",
                    assessment="开放任务 + 自评 trace",
                    estimated_hours=base_hours + 2,
                )
            )

        prereq_titles = [
            _concept_title(c, graph, domain)
            for c in ordered
            if c not in weak_set and c not in resources.target_concepts
        ]
        return LearningPath(
            learning_path=stages,
            stage_goals=[stage.title for stage in stages],
            prerequisites=prereq_titles[:4],
            estimated_time=sum(stage.estimated_hours for stage in stages),
            assessment_plan=[stage.assessment for stage in stages],
        )


def _rank(level: str) -> int:
    return _LEVELS.index(level) + 1 if level in _LEVELS else 2


def _concept_level(concept: str, graph: dict, domain: str | None) -> str:
    meta = concept_meta(concept, domain)
    return str(meta.get("difficulty") or "L2")


def _concept_title(concept: str, graph: dict, domain: str | None) -> str:
    meta = concept_meta(concept, domain)
    return str(meta.get("title") or concept.replace("_", " "))
