from __future__ import annotations

from backend.rag.retriever import get_corpus_retriever
from backend.schemas.learner import DiagnosisResult
from backend.schemas.resources import RetrievalResult


class KnowledgeRetrievalAgent:
    name = "KnowledgeRetrievalAgent"
    max_diversified_chunks = 12

    def run(self, learning_goal: str, diagnosis: DiagnosisResult, top_k: int = 7) -> RetrievalResult:
        blueprint = diagnosis.personalization_blueprint
        if not blueprint or blueprint.goal_mapping_status != "mapped":
            raise RuntimeError("知识检索失败：学习目标尚未映射到当前领域概念词表。")
        retriever = get_corpus_retriever(blueprint.corpus)
        if retriever is None:
            raise RuntimeError(f"知识检索失败：领域「{blueprint.corpus}」没有可用检索索引。")
        required_concepts = self._required_concepts(diagnosis)
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
            query = f"{learning_goal} {concept}"
            candidate = self._pick_tagged(retriever, query, concept, source_ids)
            # 语义门（余弦 ≥0.60）是按「这块内容支持这次查询」定的，不保证补进来的块
            # 带着我们要的那个概念。缺概念时显式再问一次词法后端——**这一步是为生成补素材，
            # 不是覆盖判定**，两把尺的分工见 embedding_retriever.search 的 docstring。
            #
            # 2026-09-04 实测：主库补进 48 块 ib 语料后，
            # 「搭建可评测并可部署的 Agentic RAG 工作流 deep_learning」过语义门的块
            # 从 1 块涨到 3 块，越过了 MIN_CHUNKS=2，于是 embedding 检索不再回落 TF-IDF——
            # 而 deep_learning 的证据一直是 TF-IDF 给的（库里最高的 d2l 块余弦 0.5693，
            # 从来就没过过 0.60）。旧行为靠「语义块不够」这个副作用凑巧兜住，
            # 加语料就塌。这里把那次兜底改成写明的一步。
            fallback = getattr(retriever, "fallback", None)
            if candidate is None and fallback is not None:
                candidate = self._pick_tagged(fallback, query, concept, source_ids)
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

    @staticmethod
    def _pick_tagged(retriever, query: str, concept: str, seen: set[str]):
        """在一个检索后端里找第一块真的带着 `concept` 标签、且还没选过的证据。"""
        result = retriever.search(query, concept_tags=[concept], top_k=3)
        return next(
            (
                chunk
                for chunk in result.retrieved_chunks
                if concept in chunk.concept_tags and chunk.source_id not in seen
            ),
            None,
        )

    def _required_concepts(self, diagnosis: DiagnosisResult) -> list[str]:
        blueprint = diagnosis.personalization_blueprint
        if not blueprint or blueprint.goal_mapping_status != "mapped":
            raise RuntimeError("知识检索失败：缺少已裁决的领域个性化蓝图。")
        return list(dict.fromkeys(skill.concept for skill in blueprint.required_skills))

