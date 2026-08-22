from __future__ import annotations

from backend.rag.retriever import get_retriever
from backend.schemas.learner import DiagnosisResult
from backend.schemas.resources import RetrievalResult
from backend.services.goal_concepts import goal_concepts


class KnowledgeRetrievalAgent:
    name = "KnowledgeRetrievalAgent"
    max_diversified_chunks = 12

    def run(self, learning_goal: str, diagnosis: DiagnosisResult, top_k: int = 7) -> RetrievalResult:
        retriever = get_retriever()
        required_concepts = self._required_concepts(learning_goal, diagnosis)
        # 目标概念在前：学习目标决定检索主轴，薄弱概念补充——否则跨领域目标
        # （如深度学习）会被基础薄弱概念淹没（2026-07 迁移实验发现）
        query_tags = list(dict.fromkeys(required_concepts + diagnosis.weak_concepts))
        primary = retriever.search(learning_goal, concept_tags=query_tags, top_k=top_k)

        chunks = list(primary.retrieved_chunks)
        source_ids = {chunk.source_id for chunk in chunks}
        covered = {tag for chunk in chunks for tag in chunk.concept_tags}
        for concept in required_concepts:
            if concept in covered or len(chunks) >= self.max_diversified_chunks:
                continue
            supplement = retriever.search(
                f"{learning_goal} {concept}",
                concept_tags=[concept],
                top_k=3,
            )
            candidate = next(
                (
                    chunk
                    for chunk in supplement.retrieved_chunks
                    if concept in chunk.concept_tags and chunk.source_id not in source_ids
                ),
                None,
            )
            if candidate is None:
                continue
            chunks.append(candidate)
            source_ids.add(candidate.source_id)
            covered.update(candidate.concept_tags)

        missing = [concept for concept in required_concepts if concept not in covered]
        warning = primary.missing_evidence_warning
        if missing:
            extra = f"缺少目标技能证据：{', '.join(missing)}"
            warning = f"{warning}；{extra}" if warning else extra
        return RetrievalResult(
            retrieved_chunks=chunks,
            source_ids=[chunk.source_id for chunk in chunks],
            evidence_summary=(
                f"主检索 {len(primary.retrieved_chunks)} 个片段，按目标技能补充后共 {len(chunks)} 个；"
                f"覆盖 {len(required_concepts) - len(missing)}/{len(required_concepts)} 个目标技能。"
            ),
            missing_evidence_warning=warning,
        )

    def _required_concepts(self, learning_goal: str, diagnosis: DiagnosisResult) -> list[str]:
        blueprint = diagnosis.personalization_blueprint
        blueprint_concepts = [
            skill.concept for skill in blueprint.required_skills
        ] if blueprint else []
        return list(dict.fromkeys(goal_concepts(learning_goal) + blueprint_concepts))

