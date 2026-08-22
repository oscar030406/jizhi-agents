from __future__ import annotations

from typing import Any

from backend.rag.evidence import evidence_by_concept
from backend.schemas.learner import DiagnosisResult, LearnerProfile
from backend.schemas.resources import (
    AuditResult,
    EvidencePlan,
    KnowledgeChunk,
    LearningResources,
    LectureResource,
    PracticeTask,
    QuizItem,
    RetrievalResult,
)
from backend.services.goal_concepts import goal_concepts
from backend.services.llm_gateway import LLMGateway, llm_gateway

CONSTRAINT_RESTATEMENT = "只输出被上述证据支持的结论；证据未覆盖的主题一律不写；冲突信息客观并列，不臆断。"

GENERATION_SYSTEM = (
    "你是垂直领域技能培训的教学资源生成专家。根据学习者画像、诊断结果和证据片段，"
    "生成个性化中文学习资源。硬性约束：1) 所有事实性内容只能来自给定证据片段，"
    "禁止编造证据之外的结论；2) 每个讲义小节、实操任务和题目解析都必须在 source_ids "
    "中引用支撑它的证据编号；3) 难度、举例方式要贴合画像；4) 不确定的内容宁可不写；"
    "5) 证据没有覆盖的主题一律不生成。"
    "先做溯源规划：在 evidence_plan 里列出你将引用的 source_ids 和一句约束复述，再写正文。"
    "只输出一个 JSON 对象，结构："
    '{"evidence_plan": {"planned_source_ids": [str], "constraint_restatement": str, "out_of_scope_note": str}, '
    '"lecture": {"title": str, "sections": [{"heading": str, "body": str, "source_ids": [str]}]}, '
    '"practice_task": {"title": str, "scenario": str, "environment_setup": [str], "steps": [str], '
    '"verification_points": [str], "common_pitfalls": [str], "deliverable": str, '
    '"acceptance_checks": [str], "source_ids": [str]}, '
    '"graded_quiz": [{"question": str, "options": {"A": str, "B": str, "C": str, "D": str}, '
    '"answer": str, "explanation": str, "concept_tags": [str], "source_ids": [str]}]}'
    "。practice_task 是实操指南：environment_setup 列环境与前置条件；steps 每步可执行；"
    "verification_points 给每个关键步的预期结果与自检方法；common_pitfalls 列常见失败与排查，"
    "全部内容同样只能来自证据片段。"
)

REVISION_SYSTEM = (
    "你是教学资源修订专家。审核裁判对当前资源提出了问题，请在保持原有结构和优点的前提下修订，"
    "并遵守与生成时相同的硬性约束（只引用给定证据、逐块标注 source_ids、中文输出）。"
    "只输出修订后的完整 JSON，结构与输入资源一致。"
)

# 消融对照臂提示词（2026-07-22 九档矩阵）。均仅供消融，不进产品路径。
COT_SUFFIX = (
    "生成前先在草稿中逐步推理：学习者需要什么、证据里有什么、如何组织——"
    "推理过程不要输出，最终只输出要求的 JSON 对象。"
)

SELF_CRITIQUE_SYSTEM = (
    "你是刚才生成教学资源的同一个模型，现在批评自己的初稿。"
    "逐条检查：1) 哪些事实性断言在给定证据片段里找不到支持；2) 哪些引用 source_id 与内容不符；"
    "3) 哪些内容超出证据边界。只输出 JSON："
    '{"problems": [str]（具体到句子的问题清单，最多 8 条；没有问题输出空数组）}'
)

# 消融 direct 档专用：裸 LLM 直生，无证据约束——用于测量"没有受控知识库+审核时模型会怎样"。
# 绝不可用于产品路径（违反证据不变量）。
BARE_GENERATION_SYSTEM = (
    "你是教学资源生成专家。凭你自身的知识为学习者生成个性化中文学习资源，"
    "没有资料库可引用。内容要具体、专业、自信，包含事实性结论与数字。"
    "只输出一个 JSON 对象，结构："
    '{"lecture": {"title": str, "sections": [{"heading": str, "body": str}]}, '
    '"practice_task": {"title": str, "scenario": str, "steps": [str], "deliverable": str, '
    '"acceptance_checks": [str]}, '
    '"graded_quiz": [{"question": str, "options": {"A": str, "B": str, "C": str, "D": str}, '
    '"answer": str, "explanation": str}]}'
    "。讲义 3-6 节；实操任务 4-6 步；测试题 4-5 道。"
)


def _quote(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit].rstrip() + "…"


class ResourceGenerationAgent:
    name = "ResourceGenerationAgent"

    def __init__(self, gateway: LLMGateway | None = None) -> None:
        self.gateway = gateway or llm_gateway
        self.last_engine = "deterministic"
        # 降级原因：护栏拒收（模型答了但违反证据不变量）还是调用/解析失败。
        # 两者性质完全不同——前者是护栏在干活，后者是基础设施故障，评测报告
        # 原来把它们压成同一个 fallback 布尔量，正向证据被写成了不可声称的理由。
        self.last_reject_reason = ""

    def run(
        self,
        profile: LearnerProfile,
        learning_goal: str,
        diagnosis: DiagnosisResult,
        retrieval: RetrievalResult,
        prompt_style: str = "default",
    ) -> LearningResources:
        """prompt_style: default | cot（消融 cot_single 档用，生成前显式逐步推理）。"""
        # 目标概念在前（与检索同序）：跨领域目标不被基础薄弱概念挤出 [:7] 截断
        target_concepts = list(dict.fromkeys(goal_concepts(learning_goal) + diagnosis.weak_concepts))
        self.last_reject_reason = ""
        llm_result = self._run_llm(profile, learning_goal, diagnosis, retrieval, target_concepts,
                                   prompt_style=prompt_style)
        if llm_result is not None:
            self.last_engine = "llm"
            return llm_result
        self.last_engine = "deterministic"
        return self._run_deterministic(profile, learning_goal, diagnosis, retrieval, target_concepts)

    def self_critique(self, resources: LearningResources, retrieval: RetrievalResult) -> list[str]:
        """同模型自批评（消融 self_refine 档）：让生成模型自查初稿，返回问题清单。
        LLM 不可用返回空（调用方按无问题处理）。"""
        if not self.gateway.is_enabled(self.name):
            return []
        user = (
            f"证据片段（生成时给定的全部证据）：\n{self._evidence_block(retrieval.retrieved_chunks)}\n"
            f"你的初稿 JSON：\n{resources.model_dump_json()}"
        )
        parsed = self.gateway.structured_chat(
            self.name, SELF_CRITIQUE_SYSTEM, user, max_tokens=1200, temperature=0.0)
        problems = (parsed or {}).get("problems")
        return [str(p) for p in problems if str(p).strip()] if isinstance(problems, list) else []

    def run_bare(self, profile: LearnerProfile, learning_goal: str,
                 difficulty: str = "L2") -> LearningResources | None:
        """裸 LLM 直生（仅供消融 direct 反面基线）：无检索、无引用约束、不接审核门禁。
        LLM 不可用或输出不成形时返回 None（调用方退回确定性模板）。"""
        if not self.gateway.is_enabled(self.name):
            return None
        user = (
            f"学习者背景：{profile.background}，编程 {profile.programming_level}/4。\n"
            f"学习目标：{learning_goal}\n"
            f"要求：难度 {difficulty}，讲义 3-6 节，实操 4-6 步，测试题 4-5 道。"
        )
        parsed = self.gateway.structured_chat(
            self.name, BARE_GENERATION_SYSTEM, user, max_tokens=4800, temperature=0.4)
        if not parsed:
            return None
        try:
            sections = [
                {"heading": str(s["heading"]), "body": str(s["body"]), "source_ids": []}
                for s in parsed["lecture"]["sections"]
            ]
            if len(sections) < 2:
                return None
            task = parsed["practice_task"]
            steps = [str(x) for x in task.get("steps", []) if str(x).strip()]
            quiz = []
            for item in parsed["graded_quiz"]:
                options = item.get("options")
                answer = str(item.get("answer", ""))
                if not isinstance(options, dict) or answer not in options:
                    continue
                quiz.append(QuizItem(
                    question=str(item["question"]),
                    options={str(k): str(v) for k, v in options.items()},
                    answer=answer,
                    explanation=str(item.get("explanation", "")),
                    concept_tags=goal_concepts(learning_goal)[:1],
                    difficulty=difficulty,
                    source_ids=[],
                ))
            if not steps or len(quiz) < 3:
                return None
            self.last_engine = "llm"
            return LearningResources(
                lecture=LectureResource(
                    title=str(parsed["lecture"].get("title") or f"直接生成：{learning_goal}"),
                    sections=sections,
                ),
                practice_task=PracticeTask(
                    title=str(task.get("title") or "直接实操任务"),
                    scenario=str(task.get("scenario", "")),
                    steps=steps,
                    deliverable=str(task.get("deliverable", "")),
                    acceptance_checks=[str(x) for x in task.get("acceptance_checks", []) if str(x).strip()]
                    or ["结果可以展示"],
                    difficulty=difficulty,
                    source_ids=[],
                ),
                graded_quiz=quiz,
                target_concepts=goal_concepts(learning_goal),
            )
        except (KeyError, TypeError, ValueError):
            return None

    def revise(
        self,
        resources: LearningResources,
        audit: AuditResult,
        retrieval: RetrievalResult,
        diagnosis: DiagnosisResult,
    ) -> tuple[LearningResources, str, str]:
        """Respond to auditor objections. Returns (resources, action, note) for the debate record."""
        llm_result = self._revise_llm(resources, audit, retrieval, diagnosis)
        if llm_result is not None:
            self.last_engine = "llm"
            return llm_result, "llm_rewrite", "按审核意见重写了被质疑的内容并补齐引用。"
        self.last_engine = "deterministic"
        revised = self._revise_deterministic(resources, audit, retrieval, diagnosis)
        return revised, "attach_evidence_and_recalibrate", "确定性修订：为缺引用的块补挂最强证据，并把任务难度对齐诊断结果。"

    # ------------------------------------------------------------------ LLM engine

    def _run_llm(
        self,
        profile: LearnerProfile,
        learning_goal: str,
        diagnosis: DiagnosisResult,
        retrieval: RetrievalResult,
        target_concepts: list[str],
        prompt_style: str = "default",
    ) -> LearningResources | None:
        if not self.gateway.is_enabled(self.name) or not retrieval.retrieved_chunks:
            return None
        system = GENERATION_SYSTEM + (COT_SUFFIX if prompt_style == "cot" else "")
        # 一次会话贪 7 个概念会把 JSON 写到超过 max_tokens 被截断（api 实测：12k 字符
        # finish_reason=length 两连败→兜底，四条演示轨全成模板句）。按诊断排序取最薄弱
        # 的前 4 个概念——输出装得下，教学上也更聚焦（一次别贪多）。
        focus_concepts = target_concepts[:4]
        blueprint = diagnosis.personalization_blueprint
        mix = blueprint.resource_mix if blueprint else None
        length_band = mix.section_length_band if mix else "120-200"
        mix_rules = self._mix_rules(mix)
        user = (
            f"学习者画像：{profile.name}，背景：{profile.background}，"
            f"编程 {profile.programming_level}/4，Agent {profile.agent_level}/4，RAG {profile.rag_level}/4，"
            f"工程 {profile.engineering_level}/4；偏好：{profile.learning_preference}；"
            f"约束：{'、'.join(profile.constraints) or '无'}；时间预算：{profile.time_budget_hours} 小时。\n"
            f"学习目标：{learning_goal}\n"
            f"诊断：推荐难度 {diagnosis.recommended_difficulty}，薄弱概念 {', '.join(diagnosis.weak_concepts)}。\n"
            f"个性化蓝图：{blueprint.model_dump_json() if blueprint else '无'}\n"
            f"目标概念（只写这些，别的概念不展开）：{', '.join(focus_concepts)}\n"
            f"证据片段（只能引用这些 source_id）：\n{self._evidence_block(retrieval.retrieved_chunks)}\n"
            f"要求：讲义 {min(4, len(focus_concepts))} 节以内，每节 heading 含目标概念名、"
            f"body 用画像偏好的讲法写 {length_band} 字；实操任务 4-6 步；测试题 4-5 道，"
            f"难度 {diagnosis.recommended_difficulty}。{mix_rules}"
            f"整个 JSON 必须完整闭合，宁可每节写短。"
        )
        parsed = self.gateway.structured_chat(self.name, system, user, max_tokens=6400, temperature=0.4)
        if parsed is None:
            self.last_reject_reason = "llm_call_or_parse_failed"
            return None
        validated = self._validate_payload(parsed, retrieval, diagnosis, target_concepts, learning_goal)
        if validated is None:
            self.last_reject_reason = "guardrail_evidence_invariant"
        return validated

    def _revise_llm(
        self,
        resources: LearningResources,
        audit: AuditResult,
        retrieval: RetrievalResult,
        diagnosis: DiagnosisResult,
    ) -> LearningResources | None:
        if not self.gateway.is_enabled(self.name):
            return None
        problem_claims = [v.claim for v in audit.claim_verdicts if v.verdict == "unsupported"][:8]
        user = (
            f"审核意见：{'；'.join(audit.revision_suggestions) or '无'}\n"
            f"被判定无证据支持的声明：{'；'.join(problem_claims) or '无'}\n"
            f"推荐难度：{diagnosis.recommended_difficulty}\n"
            f"证据片段（只能引用这些 source_id）：\n{self._evidence_block(retrieval.retrieved_chunks)}\n"
            f"当前资源 JSON：\n{resources.model_dump_json()}"
        )
        parsed = self.gateway.structured_chat(self.name, REVISION_SYSTEM, user, max_tokens=4800, temperature=0.2)
        return self._validate_payload(parsed, retrieval, diagnosis, resources.target_concepts, resources.lecture.title)

    def _validate_payload(
        self,
        parsed: dict[str, Any] | None,
        retrieval: RetrievalResult,
        diagnosis: DiagnosisResult,
        target_concepts: list[str],
        learning_goal: str,
    ) -> LearningResources | None:
        if not parsed:
            return None
        valid_ids = set(retrieval.source_ids)

        def clean_ids(raw: Any) -> list[str]:
            if not isinstance(raw, list):
                return []
            return [sid for sid in raw if isinstance(sid, str) and sid in valid_ids]

        try:
            lecture_data = parsed["lecture"]
            sections = []
            for section in lecture_data["sections"]:
                source_ids = clean_ids(section.get("source_ids"))
                if not source_ids:
                    return None  # 证据不变量：无引用的小节直接判失败，走兜底
                sections.append(
                    {"heading": str(section["heading"]), "body": str(section["body"]), "source_ids": source_ids}
                )
            if len(sections) < 2:
                return None
            task_data = parsed["practice_task"]
            task_sources = clean_ids(task_data.get("source_ids")) or [retrieval.source_ids[0]]

            def clean_list(key: str) -> list[str]:
                raw = task_data.get(key, [])
                return [str(x) for x in raw if str(x).strip()] if isinstance(raw, list) else []
            quiz_items = []
            for item in parsed["graded_quiz"]:
                options = item.get("options")
                answer = str(item.get("answer", ""))
                if not isinstance(options, dict) or answer not in options:
                    return None
                quiz_items.append(
                    QuizItem(
                        question=str(item["question"]),
                        options={str(k): str(v) for k, v in options.items()},
                        answer=answer,
                        explanation=str(item.get("explanation", "")),
                        concept_tags=[str(tag) for tag in item.get("concept_tags", [])] or target_concepts[:1],
                        difficulty=diagnosis.recommended_difficulty,
                        source_ids=clean_ids(item.get("source_ids")) or task_sources[:1],
                    )
                )
            if len(quiz_items) < 3:
                return None
            steps = [str(step) for step in task_data.get("steps", []) if str(step).strip()]
            checks = [str(check) for check in task_data.get("acceptance_checks", []) if str(check).strip()]
            if not steps:
                return None
            used_sources = list(dict.fromkeys(retrieval.source_ids))
            return LearningResources(
                lecture=LectureResource(title=str(lecture_data.get("title") or f"个性化讲义：{learning_goal}"), sections=sections),
                practice_task=PracticeTask(
                    title=str(task_data.get("title") or "实操任务"),
                    scenario=str(task_data.get("scenario", "")),
                    steps=steps,
                    deliverable=str(task_data.get("deliverable", "")),
                    acceptance_checks=checks or ["每个事实性结论都有 source_id 引用。"],
                    difficulty=diagnosis.recommended_difficulty,
                    source_ids=task_sources,
                    environment_setup=clean_list("environment_setup"),
                    verification_points=clean_list("verification_points"),
                    common_pitfalls=clean_list("common_pitfalls"),
                ),
                graded_quiz=quiz_items,
                used_sources=used_sources,
                target_concepts=target_concepts,
                evidence_plan=self._parse_evidence_plan(parsed.get("evidence_plan"), valid_ids, used_sources),
                personalization_blueprint=diagnosis.personalization_blueprint,
            )
        except (KeyError, TypeError, ValueError):
            return None

    @staticmethod
    def _parse_evidence_plan(raw: Any, valid_ids: set[str], used_sources: list[str]) -> EvidencePlan:
        planned = []
        restatement = CONSTRAINT_RESTATEMENT
        out_of_scope = ""
        if isinstance(raw, dict):
            planned = [sid for sid in raw.get("planned_source_ids", []) if isinstance(sid, str) and sid in valid_ids]
            restatement = str(raw.get("constraint_restatement") or CONSTRAINT_RESTATEMENT)
            out_of_scope = str(raw.get("out_of_scope_note") or "")
        return EvidencePlan(
            planned_source_ids=planned or used_sources[:5],
            constraint_restatement=restatement,
            out_of_scope_note=out_of_scope,
        )

    # ------------------------------------------------------- deterministic engine

    def _run_deterministic(
        self,
        profile: LearnerProfile,
        learning_goal: str,
        diagnosis: DiagnosisResult,
        retrieval: RetrievalResult,
        target_concepts: list[str],
    ) -> LearningResources:
        chunks = retrieval.retrieved_chunks
        evidence_map = evidence_by_concept(chunks, target_concepts)
        fallback_sources = [chunk.source_id for chunk in chunks[:3]]

        blueprint = diagnosis.personalization_blueprint
        learner_type = blueprint.learner_type if blueprint is not None else "practice_builder"
        mix = blueprint.resource_mix if blueprint is not None else None
        structure = self._deterministic_structure(learner_type)
        mix_note = (
            f"本节按配比计划呈现：支架档 {mix.scaffold_level}，类比取自{mix.analogy_domain}。"
            if mix is not None
            else f"结合你的学习偏好（{profile.learning_preference}），先复现上述要点，再进入下方实操。"
        )
        sections = []
        for concept in target_concepts[:7]:
            evidence_chunks = evidence_map.get(concept) or chunks[:1]
            primary = evidence_chunks[0]
            source_ids = [chunk.source_id for chunk in evidence_chunks[:2]]
            citations = ", ".join(source_ids)
            sections.append(
                {
                    "heading": structure["heading"].format(concept=concept),
                    "body": (
                        f"{concept} 的证据要点：{_quote(primary.content, 400)} "
                        f"{mix_note}"
                        f"来源：[{citations}]。"
                    ),
                    "source_ids": source_ids,
                }
            )
        lecture = LectureResource(
            title=f"个性化讲义：{learning_goal}",
            sections=sections,
        )
        anchor_chunk = chunks[0] if chunks else None
        scenario_evidence = _quote(anchor_chunk.content, 300) if anchor_chunk else "先检索证据，再基于证据生成并留下审核记录。"
        practice = PracticeTask(
            title=f"{diagnosis.recommended_difficulty} 实操：证据约束的 Agent 工作流",
            scenario=(
                f"依据证据要点：{scenario_evidence} "
                f"请构建一个小型文档问答 Agent，显式记录检索、工具调用和审核输出。"
            ),
            steps=structure["steps"],
            deliverable=structure["deliverable"],
            acceptance_checks=structure["checks"],
            difficulty=diagnosis.recommended_difficulty,
            source_ids=fallback_sources,
            environment_setup=[
                "Python 3.11+ 与本课依赖（requirements.txt）已安装",
                f"知识库切片就绪：本次检索到 {len(chunks)} 个证据块（{', '.join(fallback_sources)}）",
            ],
            verification_points=[
                f"完成第 {i} 步后：{check}" for i, check in enumerate(structure["checks"], start=1)
            ],
            common_pitfalls=[
                "生成结果没有 source_id 引用——回到检索步确认证据块已注入提示词",
                "答案引用了检索结果之外的编号——属于锚定越界，应删除该结论或补检索",
            ],
        )
        quiz = []
        for index, concept in enumerate(target_concepts[:6], start=1):
            evidence_chunks = evidence_map.get(concept) or chunks[:1]
            primary = evidence_chunks[0]
            quiz.append(
                QuizItem(
                    question=f"关于 {concept}，哪种设计最能降低幻觉风险？",
                    options={
                        "A": "只提醒模型小心，不提供任何来源。",
                        "B": "附上检索到的证据并强制 source_id 引用。",
                        "C": "向评审隐藏中间检索状态。",
                        "D": "调高 temperature 追求更有创意的输出。",
                    },
                    answer="B",
                    explanation=(
                        f"{concept} 的证据要点：{_quote(primary.content, 120)}"
                        f"（来源：{', '.join(chunk.source_id for chunk in evidence_chunks[:2])}）"
                    ),
                    concept_tags=[concept],
                    difficulty=diagnosis.recommended_difficulty,
                    source_ids=[chunk.source_id for chunk in evidence_chunks[:2]],
                )
            )
        used_sources = list(dict.fromkeys(retrieval.source_ids))
        return LearningResources(
            lecture=lecture,
            practice_task=practice,
            graded_quiz=quiz,
            used_sources=used_sources,
            target_concepts=target_concepts,
            evidence_plan=EvidencePlan(
                planned_source_ids=used_sources[:5],
                constraint_restatement=CONSTRAINT_RESTATEMENT,
                out_of_scope_note="确定性引擎：仅复用检索命中的证据，未命中概念不虚构。",
            ),
            personalization_blueprint=blueprint,
        )

    def _revise_deterministic(
        self,
        resources: LearningResources,
        audit: AuditResult,
        retrieval: RetrievalResult,
        diagnosis: DiagnosisResult,
    ) -> LearningResources:
        source_ids = list(dict.fromkeys(retrieval.source_ids))
        chunk_by_id = {chunk.source_id: chunk for chunk in retrieval.retrieved_chunks}
        citation_text = ", ".join(f"[{source_id}]" for source_id in source_ids[:3])
        revised_sections = []
        for section in resources.lecture.sections:
            body = section.body
            section_sources = section.source_ids or source_ids[:2]
            anchor = chunk_by_id.get(section_sources[0]) if section_sources else None
            if anchor:
                anchor_quote = _quote(anchor.content, 300)
                if anchor_quote[:40] not in body:
                    body = f"{body} 证据补充：{anchor_quote}"
            if citation_text not in body:
                body = f"{body} 证据锚点：{citation_text}。"
            revised_sections.append(section.model_copy(update={"body": body, "source_ids": section_sources}))
        resources.lecture.sections = revised_sections
        resources.practice_task.source_ids = resources.practice_task.source_ids or source_ids[:3]
        if resources.practice_task.difficulty != diagnosis.recommended_difficulty:
            resources.practice_task = resources.practice_task.model_copy(
                update={"difficulty": diagnosis.recommended_difficulty}
            )
        for item in resources.graded_quiz:
            item.source_ids = item.source_ids or source_ids[:2]
        resources.used_sources = source_ids
        return resources

    # ---------------------------------------------------------------- shared bits

    _SCAFFOLD_RULES = {
        "full": "写法用完整支架：每节先给类比铺垫，再分步拆解，配一个完整可跟做的示例；",
        "faded": "写法用渐进支架：给出示例骨架但留 1-2 处关键步骤让学习者自己补全；",
        "minimal": "写法删冗余：跳过基础铺垫，直接讲机制差异点、边界条件与失败模式；",
    }

    @classmethod
    def _mix_rules(cls, mix) -> str:
        """把结构化配比计划翻译成生成硬指令。mix 为 None 时返回空串（旧链路不受影响）。"""
        if mix is None:
            return ""
        rules = [cls._SCAFFOLD_RULES.get(mix.scaffold_level, "")]
        if mix.diagram_count:
            rules.append(
                f"全文至少 {mix.diagram_count} 节包含文字图示（以「图：」开头、"
                f"用→连接的流程描述，如「图：输入→检索→生成→审核」）；"
            )
        if mix.code_example_count:
            # 注意：不能要求围栏代码块——模型会在 JSON 字符串里写裸换行导致解析必败。
            rules.append(
                f"全文合计给出 {mix.code_example_count} 个简短可运行代码示例"
                f"（写在 body 字符串内，换行一律转义为 \\n，不要用 ``` 围栏）；"
            )
        rules.append(f"所有类比和举例场景一律取自「{mix.analogy_domain}」；")
        return "".join(r for r in rules if r)

    @staticmethod
    def _evidence_block(chunks: list[KnowledgeChunk]) -> str:
        return "\n".join(
            f"[{chunk.source_id}] {chunk.title}（{chunk.difficulty}）：{_quote(chunk.content, 800)}" for chunk in chunks
        )

    def _goal_concepts(self, learning_goal: str) -> list[str]:
        """兼容旧调用；概念提取的唯一实现位于 services.goal_concepts。"""
        return goal_concepts(learning_goal)

    @staticmethod
    def _deterministic_structure(learner_type: str) -> dict[str, Any]:
        if learner_type == "guided_beginner":
            return {
                "heading": "{concept} 类比与分步",
                "opening": "先用直观类比建立概念边界，再拆成可观察的小步骤。",
                "sequence": "类比→流程→最小示例→即时自检",
                "steps": [
                    "用一句生活类比说明目标概念解决什么问题。",
                    "按输入、处理、输出画出最小流程，并标出 source_id。",
                    "在半成品模板中补全检索与生成两个步骤。",
                    "逐项运行并记录每一步的输入、输出和错误。",
                    "按提示加入审核步骤，检查每条结论是否有来源。",
                ],
                "deliverable": "一份分步流程图、一个可运行的最小示例和一份自检记录。",
                "checks": [
                    "能够用自己的话解释每一步，而不是只复制代码。",
                    "最小示例可以运行，并能看到检索、生成和审核中间结果。",
                    "每个事实性结论至少有一个 source_id 引用。",
                ],
            }
        if learner_type == "systems_engineer":
            return {
                "heading": "{concept} 接口契约与失败模式",
                "opening": "从状态机、接口契约和故障边界出发组织内容。",
                "sequence": "契约→并发/超时→失败注入→指标验证",
                "steps": [
                    "定义组件接口、状态转移和结构化错误契约。",
                    "实现可替换的检索、生成与审核组件，并保留 trace_id。",
                    "注入超时、空证据、冲突证据和无效模型响应。",
                    "验证取消、降级、重试边界和幂等行为。",
                    "记录覆盖率、幻觉率、P95 延迟和 fallback 率。",
                ],
                "deliverable": "一个具备接口契约、故障注入脚本和指标报告的可部署服务切片。",
                "checks": [
                    "组件可替换且失败不会破坏 WorkflowRun schema。",
                    "空证据和冲突证据会触发拒绝、修订或仲裁。",
                    "质量指标与延迟指标均可由命令复算。",
                ],
            }
        return {
            "heading": "{concept} 机制与可运行示例",
            "opening": "先解释核心机制，再通过可运行示例定位常见错误。",
            "sequence": "机制→示例→错误诊断→验收清单",
            "steps": [
                "定义任务目标和结构化输出格式。",
                "准备 3-5 个带 source_id 的知识片段。",
                "补全检索、生成与审核模板并运行。",
                "定位一次引用缺失或难度不匹配问题并修复。",
                "按验收清单保存 trace 和最终结果。",
            ],
            "deliverable": "一个可运行的 API 端点和一份包含错误修复过程的 trace JSON。",
            "checks": [
                "每个事实性结论至少有一个 source_id 引用。",
                "一次响应包含诊断、资源、审核和学习路径。",
                "能够解释并修复至少一种常见失败。",
            ],
        }

