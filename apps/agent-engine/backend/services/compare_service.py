"""同题异人对比生成：同一学习目标 × N 组画像 → 并排资源 + 逐处差异归因。

赛题第五(1)款"明确体现对不同背景学习者的适配能力"的直接兑现。
差异归因是机械规则（诊断结果/个性化蓝图的结构化字段），不是 LLM 事后解释——
每处差异都能指回画像的具体维度，可复算。
"""
from __future__ import annotations

import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, List, Optional, Set, Tuple

from pydantic import BaseModel, Field

from backend.orchestration.workflow import AgentTrainingWorkflow
from backend.rag.claims import _tokens, extract_claims
from backend.schemas.learner import LearnerProfile
from backend.schemas.resources import LearningResources
from backend.services.cost_meter import CostReport, cost_from_telemetry
from backend.services.data_loader import get_learner_profile
from backend.services.llm_gateway import LLMGateway


class ProfileSnapshot(BaseModel):
    profile_id: str
    name: str
    background: str
    levels: Dict[str, int]
    mastery_vector: Dict[str, float]
    recommended_difficulty: str
    weak_concepts: List[str]
    learner_type: str = ""
    skill_gaps: List[str] = Field(default_factory=list)
    content_strategy: List[str] = Field(default_factory=list)
    resource_mix: dict | None = None  # 结构化配比计划快照（只加不减）


class ResourceSnapshot(BaseModel):
    lecture_title: str
    section_headings: List[str]
    section_count: int
    task_title: str
    task_difficulty: str
    task_steps: int
    quiz_count: int
    quiz_difficulties: List[str]
    engines: Dict[str, str]  # agent -> llm|deterministic（trace 如实标注，演示防伪）


class AttributedDifference(BaseModel):
    """一处差异 + 它归因到的画像/诊断事实。"""
    dimension: str          # difficulty / sections / task / strategy
    observation: str        # 差异本身（含涉及的画像名）
    because: List[str]      # 机械归因：来自诊断与蓝图的结构化字段


class ComparisonEntry(BaseModel):
    profile: ProfileSnapshot
    resources: ResourceSnapshot
    cost: CostReport | None = None  # 成本实测（§2.8）；字段只加不减
    full_run: dict | None = None  # 完整 WorkflowRun：评委"点进这一列体验学径"用（引擎反正跑了，扔掉才是浪费）


class OutOfScopeCitation(BaseModel):
    """claim 引用了本画像检索结果之外的 source_id（锚定越界）。"""
    profile_name: str
    claim: str
    invalid_source_ids: List[str]


class SuspectedConflict(BaseModel):
    """同一 source_id 下两画像 claim 呈否定对立（保守启发式，宁漏勿误）。"""
    source_id: str
    profile_a: str
    claim_a: str
    profile_b: str
    claim_b: str


class FactInvarianceReport(BaseModel):
    """「个性化改变教学表达、绝不改变知识事实」的机器检查结果。"""
    checked_claims: int
    out_of_scope_citations: List[OutOfScopeCitation] = Field(default_factory=list)
    suspected_conflicts: List[SuspectedConflict] = Field(default_factory=list)
    passed: bool


class ComparisonReport(BaseModel):
    learning_goal: str
    entries: List[ComparisonEntry]
    differences: List[AttributedDifference]
    fact_invariance: Optional[FactInvarianceReport] = None  # 只加不减，旧 JSON 仍可解析


def _snapshot_profile(profile: LearnerProfile, diagnosis) -> ProfileSnapshot:
    bp = diagnosis.personalization_blueprint
    return ProfileSnapshot(
        profile_id=profile.id,
        name=profile.name,
        background=profile.background,
        levels={
            "programming": profile.programming_level,
            "python": profile.python_level,
            "agent": profile.agent_level,
            "rag": profile.rag_level,
            "engineering": profile.engineering_level,
        },
        mastery_vector={k: round(v, 3) for k, v in diagnosis.mastery_vector.items()},
        recommended_difficulty=diagnosis.recommended_difficulty,
        weak_concepts=diagnosis.weak_concepts,
        learner_type=bp.learner_type if bp else "",
        skill_gaps=[f"{g.concept}(缺口 {g.gap:.2f})" for g in (bp.skill_gaps if bp else [])],
        content_strategy=list(bp.content_strategy) if bp else [],
        resource_mix=bp.resource_mix.model_dump() if bp and bp.resource_mix else None,
    )


def _snapshot_resources(run) -> ResourceSnapshot:
    res = run.resources
    return ResourceSnapshot(
        lecture_title=res.lecture.title,
        section_headings=[s.heading for s in res.lecture.sections],
        section_count=len(res.lecture.sections),
        task_title=res.practice_task.title,
        task_difficulty=res.practice_task.difficulty,
        task_steps=len(res.practice_task.steps),
        quiz_count=len(res.graded_quiz),
        quiz_difficulties=sorted({q.difficulty for q in res.graded_quiz}),
        engines={step.agent: str(step.artifacts["engine"])
                 for step in run.trace if "engine" in step.artifacts},
    )


def _mastery_fact(snapshot: ProfileSnapshot, concept: str) -> str:
    value = snapshot.mastery_vector.get(concept)
    return f"{snapshot.name} 掌握向量 {concept}={value:.2f}" if value is not None else \
        f"{snapshot.name} 画像未覆盖 {concept}"


def _diff_attribution(entries: List[ComparisonEntry]) -> List[AttributedDifference]:
    diffs: List[AttributedDifference] = []

    # 1) 难度差异 → 归因掌握向量与学习者类型
    difficulties = {e.profile.name: e.profile.recommended_difficulty for e in entries}
    if len(set(difficulties.values())) > 1:
        because = []
        for e in entries:
            mean = sum(e.profile.mastery_vector.values()) / max(1, len(e.profile.mastery_vector))
            because.append(
                f"{e.profile.name}：掌握向量均值 {mean:.2f}"
                + (f"，学习者类型「{e.profile.learner_type}」" if e.profile.learner_type else "")
                + f" → 推荐难度 {e.profile.recommended_difficulty}"
            )
        diffs.append(AttributedDifference(
            dimension="difficulty",
            observation="同一目标下推荐难度不同：" + "；".join(f"{k}={v}" for k, v in difficulties.items()),
            because=because,
        ))

    # 2) 讲义小节差异 → 归因薄弱概念
    for entry in entries:
        others = [e for e in entries if e is not entry]
        unique = set(entry.resources.section_headings)
        for other in others:
            unique -= set(other.resources.section_headings)
        for heading in sorted(unique):
            matched = [c for c in entry.profile.weak_concepts if c.replace("_", " ") in heading.lower() or c in heading]
            because = [_mastery_fact(entry.profile, c) + "（薄弱，讲义补基础）" for c in matched] or [
                f"{entry.profile.name} 薄弱概念 {entry.profile.weak_concepts} 驱动内容选择"
            ]
            diffs.append(AttributedDifference(
                dimension="sections",
                observation=f"小节「{heading}」仅出现在 {entry.profile.name} 的讲义中",
                because=because,
            ))

    # 3) 实操任务难度差异 → 归因诊断难度
    task_diffs = {e.profile.name: e.resources.task_difficulty for e in entries}
    if len(set(task_diffs.values())) > 1:
        diffs.append(AttributedDifference(
            dimension="task",
            observation="实操任务难度不同：" + "；".join(f"{k}={v}" for k, v in task_diffs.items()),
            because=[f"{e.profile.name} 诊断推荐难度 {e.profile.recommended_difficulty}" for e in entries],
        ))

    # 4) 资源配比差异 → 归因配比计划的 because 链（配比适配的活证）
    mixes = {e.profile.name: e.profile.resource_mix for e in entries if e.profile.resource_mix}
    if len(mixes) >= 2:
        summaries = {
            name: (
                f"支架 {m['scaffold_level']}/教具 {m['visual_widget_count']}/图示 {m['diagram_count']}"
                f"/代码例 {m['code_example_count']}/每节 {m['section_length_band']} 字"
            )
            for name, m in mixes.items()
        }
        if len(set(summaries.values())) > 1:
            diffs.append(AttributedDifference(
                dimension="mix",
                observation="资源配比计划不同：" + "；".join(f"{k}：{v}" for k, v in summaries.items()),
                because=[f"{name}：{r}" for name, m in mixes.items() for r in m.get("rationale", [])],
            ))

    # 5) 内容策略差异 → 直接引用蓝图
    strategies = {e.profile.name: e.profile.content_strategy for e in entries if e.profile.content_strategy}
    if len(strategies) >= 2 and len({tuple(v) for v in strategies.values()}) > 1:
        diffs.append(AttributedDifference(
            dimension="strategy",
            observation="个性化蓝图的内容策略不同",
            because=[f"{k}：{'；'.join(v[:3])}" for k, v in strategies.items()],
        ))
    return diffs


_NEGATION = re.compile(r"不|没有|无法")
# ponytail: 否定对立启发式（否定词标志不同 + 高 token 重叠）只抓明显矛盾，
# 宁可漏报不误报；升级路径 = 用 judge 档 LLM 对同 source_id 的 claim 对做蕴含/矛盾判定。
_CONFLICT_OVERLAP = 0.6


def fact_invariance_check(
    entries_with_resources: List[Tuple[str, LearningResources, Set[str]]],
) -> FactInvarianceReport:
    """事实不变量检查：个性化只许改教学表达，不许改知识事实。

    输入：[(画像名, 该画像生成的资源, 该画像本次检索到的 source_id 集合)]。
    1) 锚定一致性：每条 claim 引用的 source_ids 必须都在本画像的检索结果内；
    2) 跨画像冲突：不同画像引用同一 source_id 的 claim，若一条含否定词
       （不/没有/无法）另一条不含且关键 token 高度重叠，记为疑似冲突。
    """
    checked = 0
    out_of_scope: List[OutOfScopeCitation] = []
    by_source: Dict[str, List[Tuple[str, str]]] = {}  # source_id -> [(profile, claim)]

    for profile_name, resources, allowed_ids in entries_with_resources:
        for claim_text, cited_ids in extract_claims(resources):
            checked += 1
            invalid = sorted(set(cited_ids) - allowed_ids)
            if invalid:
                out_of_scope.append(OutOfScopeCitation(
                    profile_name=profile_name, claim=claim_text, invalid_source_ids=invalid))
            for sid in cited_ids:
                by_source.setdefault(sid, []).append((profile_name, claim_text))

    conflicts: List[SuspectedConflict] = []
    for sid, claim_list in by_source.items():
        for i, (pa, ca) in enumerate(claim_list):
            for pb, cb in claim_list[i + 1:]:
                if pa == pb:
                    continue  # 只比跨画像
                if bool(_NEGATION.search(ca)) == bool(_NEGATION.search(cb)):
                    continue
                ta, tb = _tokens(ca), _tokens(cb)
                if not ta or not tb:
                    continue
                if len(ta & tb) / min(len(ta), len(tb)) >= _CONFLICT_OVERLAP:
                    conflicts.append(SuspectedConflict(
                        source_id=sid, profile_a=pa, claim_a=ca, profile_b=pb, claim_b=cb))

    return FactInvarianceReport(
        checked_claims=checked,
        out_of_scope_citations=out_of_scope,
        suspected_conflicts=conflicts,
        passed=not out_of_scope and not conflicts,
    )


def compare_generate_profiles(learning_goal: str, profiles: List[LearnerProfile],
                              gateway=None) -> ComparisonReport:
    """同一目标 × N 画像（对象直传，支持评委现场拨出来的临时画像），
    各走一遍完整七 Agent 闭环，产出并排快照 + 归因差异。
    引擎只有真实模型一条路（回归测试用 FakeGateway 注入罐头输出）；
    gateway 可注入每请求模型配置（ai_learn modelConfig 桥接）。"""
    if len(profiles) < 2:
        raise ValueError("对比至少需要 2 个画像")

    # 每个画像一个独立 gateway，两个理由，缺一个都不能并行：
    #   1. telemetry 是 gateway 上的可变状态，`reset_telemetry()` 会清掉同进程里别人的计数。
    #      原来串行跑碰不到，一并行就会互相抹账——成本那一列直接失真。
    #   2. 注入版（ai_learn 的 per-request modelConfig）要沿用同一份 env，
    #      所以按 `gateway.env` 复制，不是凭空造一个读全局 env 的。
    # 路由与模型配置一个字没变：同 env 构造出来的 gateway，route_for 结果逐字相同。
    env = gateway.env if gateway is not None else None

    def _one(profile: LearnerProfile):
        wf = AgentTrainingWorkflow(gateway=LLMGateway(env=env))
        started = time.perf_counter()
        run = wf.run(profile, learning_goal=learning_goal)
        duration_ms = int((time.perf_counter() - started) * 1000)
        return profile, run, wf.gateway.telemetry_snapshot(), duration_ms

    # 只并行两侧的生成段——判官/仲裁链在 wf.run 内部，语义不动。
    # I/O 密集（等上游 HTTP），线程池够用，不上进程。
    #
    # `COMPARE_PARALLEL=0` 退回串行：这不是"以防万一"的开关，是**消融对照的必需品**。
    # 验证并行没改语义，唯一干净的办法是同一个引擎进程、同一份索引、同一批画像，
    # 只翻这一个开关跑两遍再逐字段比。第一次验的时候没有它，只好拿重启前的旧进程当基线，
    # 结果两边检索后端不同（旧进程走 TF-IDF 分数 ~0.33，新进程走 bge-m3 ~0.77），
    # 差异全是环境差异，压根验不出并发的影响。
    if os.environ.get("COMPARE_PARALLEL") == "0":
        results = [_one(p) for p in profiles]
    else:
        with ThreadPoolExecutor(max_workers=len(profiles)) as pool:
            results = list(pool.map(_one, profiles))  # map 保序，entries 顺序仍等于入参顺序

    entries: List[ComparisonEntry] = []
    raw: List[Tuple[str, LearningResources, Set[str]]] = []
    for profile, run, telemetry, duration_ms in results:
        entries.append(ComparisonEntry(
            profile=_snapshot_profile(profile, run.diagnosis),
            resources=_snapshot_resources(run),
            cost=cost_from_telemetry(telemetry, duration_ms),
            full_run=run.model_dump(mode="json"),
        ))
        raw.append((profile.name, run.resources,
                    set(run.retrieval.source_ids)
                    | {c.source_id for c in run.retrieval.retrieved_chunks}))
    return ComparisonReport(
        learning_goal=learning_goal,
        entries=entries,
        differences=_diff_attribution(entries),
        fact_invariance=fact_invariance_check(raw),
    )


def compare_generate(learning_goal: str, profile_ids: List[str]) -> ComparisonReport:
    """预设画像 id 版（CLI 与回归测试入口）。"""
    return compare_generate_profiles(
        learning_goal, [get_learner_profile(pid) for pid in profile_ids])
