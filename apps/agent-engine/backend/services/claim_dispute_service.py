from __future__ import annotations

import re

from backend.schemas.resources import (
    AuditResult,
    ClaimDispute,
    ClaimVerdict,
    LearningResources,
)

_SENTENCE_SPLIT = re.compile(r"(?<=[。！？!?])\s*")


def build_claim_disputes(
    before: LearningResources,
    after: LearningResources,
    objection: AuditResult,
    re_audit: AuditResult,
) -> tuple[list[ClaimDispute], str]:
    """把真实审核争议映射为逐 claim 的生成方修订与再审裁决。"""
    disputed = [verdict for verdict in objection.claim_verdicts if verdict.verdict != "supported"]
    if not disputed:
        return [], ""

    after_claims = _resource_sentences(after)
    re_audit_verdicts = list(re_audit.claim_verdicts)
    disputes: list[ClaimDispute] = []
    diff_lines: list[str] = []
    for verdict in disputed:
        revised_claim = _best_revision(verdict.claim, after_claims)
        judge = _best_verdict(revised_claim or verdict.claim, re_audit_verdicts)
        judge_decision = _judge_decision(revised_claim, judge)
        confidence = judge.support_score if judge else re_audit.factuality_score
        auditor_position = _auditor_position(verdict, objection)
        generator_response = (
            "已收窄绝对化表述并补充证据边界。"
            if revised_claim
            else "未找到足够证据，已删除该事实性声明。"
        )
        disputes.append(
            ClaimDispute(
                claim=verdict.claim,
                auditor_position=auditor_position,
                cited_evidence=verdict.source_ids,
                generator_response=generator_response,
                revised_claim=revised_claim,
                judge_decision=judge_decision,
                confidence=round(max(0.0, min(1.0, confidence)), 3),
            )
        )
        diff_lines.append(
            f"- 原声明：{verdict.claim}\n"
            f"+ 修订：{revised_claim or '[删除：证据不足]'}"
        )
    return disputes, "\n".join(diff_lines)


def _resource_sentences(resources: LearningResources) -> list[str]:
    sentences: list[str] = []
    for section in resources.lecture.sections:
        parts = [part.strip() for part in _SENTENCE_SPLIT.split(section.body) if part.strip()]
        sentences.extend(parts or [section.body.strip()])
    return sentences


def _best_revision(original: str, candidates: list[str]) -> str:
    if not candidates:
        return ""
    ranked = sorted(
        ((candidate, _similarity(original, candidate)) for candidate in candidates if candidate != original),
        key=lambda item: item[1],
        reverse=True,
    )
    if not ranked or ranked[0][1] < 0.08:
        return candidates[0] if len(candidates) == 1 else ""
    return ranked[0][0]


def _best_verdict(claim: str, verdicts: list[ClaimVerdict]) -> ClaimVerdict | None:
    if not verdicts:
        return None
    return max(verdicts, key=lambda verdict: _similarity(claim, verdict.claim))


def _judge_decision(revised_claim: str, verdict: ClaimVerdict | None) -> str:
    if not revised_claim:
        return "rejected"
    if verdict is None:
        return "escalated"
    if verdict.verdict == "supported":
        return "supported"
    if verdict.verdict in {"weak", "disputed"}:
        return "escalated"
    return "rejected"


def _auditor_position(verdict: ClaimVerdict, audit: AuditResult) -> str:
    if audit.challenges:
        return audit.challenges[0]
    if verdict.verdict == "weak":
        return "该声明只有部分证据支持，需要收窄表述。"
    return "该声明缺少可核验的证据支持。"


def _similarity(left: str, right: str) -> float:
    left_tokens = _char_ngrams(left)
    right_tokens = _char_ngrams(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def _char_ngrams(text: str, size: int = 2) -> set[str]:
    normalized = re.sub(r"\s+", "", text.lower())
    if len(normalized) <= size:
        return {normalized} if normalized else set()
    return {normalized[index : index + size] for index in range(len(normalized) - size + 1)}
