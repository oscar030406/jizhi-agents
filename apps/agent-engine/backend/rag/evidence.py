from __future__ import annotations

from typing import Iterable, List

from backend.schemas.resources import KnowledgeChunk


def evidence_by_concept(chunks: Iterable[KnowledgeChunk], concepts: Iterable[str]) -> dict[str, List[KnowledgeChunk]]:
    concept_set = {concept.lower() for concept in concepts}
    mapping: dict[str, List[KnowledgeChunk]] = {concept: [] for concept in concepts}
    for chunk in chunks:
        chunk_tags = {tag.lower() for tag in chunk.concept_tags}
        for concept in concept_set.intersection(chunk_tags):
            original = next(c for c in concepts if c.lower() == concept)
            mapping[original].append(chunk)
    return mapping


def summarize_evidence(chunks: List[KnowledgeChunk], limit: int = 4) -> str:
    if not chunks:
        return "No evidence retrieved."
    return " | ".join(f"{chunk.title}: {chunk.content[:120]} [{chunk.source_id}]" for chunk in chunks[:limit])

