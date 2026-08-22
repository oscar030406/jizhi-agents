from __future__ import annotations

from backend.rag.claims import claim_statistics, extract_claims, verify_claims
from backend.schemas.learner import DiagnosisResult
from backend.schemas.resources import AuditResult, ClaimVerdict, LearningResources, RetrievalResult
from backend.services.llm_gateway import LLMGateway, llm_gateway

HALLUCINATION_TOLERANCE = 0.05
# 判官能看到的证据长度。实测被引用块中位 787 字符、p90 1163，300 只够看 21-38%。
JUDGE_EVIDENCE_CHARS = 1400
JUDGE_BATCH_SIZE = 20


def _short(text: str, limit: int = 40) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit].rstrip() + "…"

# 2026-08-04 口径重建：原提示词写「不确定时判 weak」，而 weak 既不进幻觉分子、
# 对 factuality 的影响也约 0.006/条——等于给判官一个零代价的安全选项，还明确劝它选。
# 实测那一轮 29 处改判**全是放松方向、0 处收紧**。现在改成：判 supported/weak 必须
# 从证据里回填原文片段，引不出原文一律 unsupported。
JUDGE_SYSTEM = (
    "你是垂直领域教学内容的事实审核裁判。你会收到编号的事实声明和证据片段。"
    "对每一条**先分类、再判支持**，两步都要做。只输出 JSON 对象："
    '{"verdicts": [{"index": 声明编号, "verdict": "not_a_claim|supported|weak|unsupported", "quote": "证据原文片段"}]}。'
    "第一步（必做，先问这个）：这句在陈述**领域事实**，还是别的东西？"
    "以下一律判 not_a_claim，quote 留空，不要再去核证据——"
    "①教学类比及其展开句：「想象你是快递分拣员」「分拣机器人接到指令…」「它需要借助其他设备…」；"
    "②面向学习者说的话：「你可以先运行这个案例」「最好的起点是…」；"
    "③对本讲义自身结构的回指与串场：「现在我们把前面学的零件组装起来」「根据上一节」「这确保了…」；"
    "④对我们自己出的测验题的解析：「选项C是 Memory tool 的功能」「选项A、B、C都是必要步骤」。"
    "教学材料里这类句子本来就多，判 not_a_claim 是正常且必要的，别因为怕漏而硬核它们。"
    "第二步（只对领域事实断言做）："
    "supported=证据里有原文直接支持，quote 必须是证据中的连续原文；"
    "weak=证据只部分沾边或需要额外推断，quote 填最接近的那段原文；"
    "unsupported=证据里找不到支持该声明的原文，或声明与证据矛盾——quote 留空。"
    "**引不出证据原文就必须判 unsupported，不许凭常识判 supported。**"
    "注意：声明用自己的话改写证据是允许的，只要意思被证据支持；"
    "但声明里的具体数值、方法名、API 名必须在证据中出现，否则判 unsupported。"
    "不要输出其他内容。"
)


class ContentAuditAgent:
    name = "ContentAuditAgent"

    def __init__(self, gateway: LLMGateway | None = None) -> None:
        self.gateway = gateway or llm_gateway
        self.last_engine = "deterministic"
        # 判官这一轮到底出没出场，供评测脚本如实统计（原来是靠 claims_supported
        # 反推，而那个谓词在 weak 上与判官触发条件正好相反，实测 7 条里 3 条是假的）
        self.last_judge_state = "not_run"

    def run(self, resources: LearningResources, diagnosis: DiagnosisResult, retrieval: RetrievalResult) -> AuditResult:
        source_set = set(retrieval.source_ids)
        target_set = set(resources.target_concepts)
        evidence_tags = {tag for chunk in retrieval.retrieved_chunks for tag in chunk.concept_tags}

        cited_items = [
            set(section.source_ids) for section in resources.lecture.sections
        ] + [set(resources.practice_task.source_ids)] + [set(item.source_ids) for item in resources.graded_quiz]
        valid_cited_items = [source_ids for source_ids in cited_items if source_ids.intersection(source_set)]
        citation_coverage = len(valid_cited_items) / max(1, len(cited_items))
        concept_coverage = len(target_set.intersection(evidence_tags)) / max(1, len(target_set))
        difficulty_match = 1.0 if resources.practice_task.difficulty == diagnosis.recommended_difficulty else 0.55

        claims = extract_claims(resources)
        verdicts = verify_claims(claims, retrieval.retrieved_chunks)
        self.last_engine = "deterministic"
        llm_overrides = self._llm_review(verdicts, retrieval)
        if llm_overrides:
            verdicts = llm_overrides
            self.last_engine = "llm+deterministic"
        stats = claim_statistics(verdicts)

        factuality_score = min(
            1.0,
            0.30
            + 0.30 * citation_coverage
            + 0.25 * concept_coverage
            + 0.15 * float(stats["support_rate"]),
        )

        flags = []
        suggestions = []
        if citation_coverage < 0.8:
            flags.append("low_citation_coverage")
            suggestions.append("Add citations from retrieved source_ids to every lecture section and quiz explanation.")
        if concept_coverage < 0.65:
            flags.append("weak_concept_evidence")
            suggestions.append("Retrieve more chunks for uncovered target concepts before publishing.")
        if difficulty_match < 0.8:
            flags.append("difficulty_mismatch")
            suggestions.append("Regenerate practice tasks at the diagnosed learner difficulty.")
        if float(stats["hallucination_rate"]) > HALLUCINATION_TOLERANCE:
            flags.append("unsupported_claims")
            suggestions.append("Rewrite or delete claims that no retrieved source can support, or cite valid source_ids.")
        if retrieval.missing_evidence_warning:
            flags.append("low_retrieval_confidence")
            suggestions.append(retrieval.missing_evidence_warning)

        revision_required = (
            factuality_score < 0.72
            or citation_coverage < 0.75
            or concept_coverage < 0.55
            or float(stats["hallucination_rate"]) > HALLUCINATION_TOLERANCE
        )
        # 逐条挑证据：把无据/弱据的具体声明列成质疑清单，让辩论从「再答一遍」
        # 变成「针对这几条补证据或删除」。上限 6 条，避免刷屏。
        challenges = [
            f"「{_short(v.claim)}」缺乏证据支持（引用 {', '.join(v.source_ids) or '无'}）"
            for v in verdicts
            if v.verdict == "unsupported"
        ][:6]
        if concept_coverage < 0.65:
            uncovered = target_set - evidence_tags
            if uncovered:
                challenges.append(f"目标概念 {', '.join(sorted(uncovered))} 缺少证据覆盖，需补检索或删减。")
        return AuditResult(
            factuality_score=round(factuality_score, 3),
            citation_coverage=round(citation_coverage, 3),
            difficulty_match=round(difficulty_match, 3),
            concept_coverage=round(concept_coverage, 3),
            hallucination_risk_flags=flags,
            revision_required=revision_required,
            revision_suggestions=suggestions,
            claims_total=int(stats["claims_total"]),
            claims_supported=int(stats["claims_supported"]),
            hallucination_rate=float(stats["hallucination_rate"]),
            claim_verdicts=verdicts,
            auditor_engine=self.last_engine,
            challenges=challenges,
            should_continue=revision_required,
        )

    def _llm_review(self, verdicts: list[ClaimVerdict], retrieval: RetrievalResult) -> list[ClaimVerdict] | None:
        """两级审核的第二级：确定性重叠是**检索接地筛**，判官才是判真伪的那一层。

        2026-08-04 口径重建，改了三件事（前一版三重削弱叠在一起，等于没人判真伪）：

        ① **全量复核，不再只看 disputed。** 字符重叠量的是「话题像不像」，不是
           「对不对」——用教材词汇编的谎话天然高度重叠。实测埋进去的假命题
           「RAG 会把参数量提高十倍」拿 0.28，初筛判 weak；旧逻辑下 supported
           占 88.6%，永远见不到判官，假阳性结构上漏得掉。
        ② **证据窗口 300 → 1400 字符。** 实测被引用块中位长 787、p90 1163，
           判官原来只看得到 21-38%，支撑句在后面就只能瞎猜。
        ③ **判 supported/weak 必须回填证据原文**（见 JUDGE_SYSTEM），引不出原文
           的一律按 unsupported 收——原来「不确定判 weak」是零代价安全选项。
        """
        if not self.gateway.is_enabled(self.name):
            self.last_judge_state = "disabled"
            return None
        if not verdicts:
            self.last_judge_state = "no_claims"
            return None

        evidence_lines = "\n".join(
            f"[{chunk.source_id}] {chunk.title}: {chunk.content[:JUDGE_EVIDENCE_CHARS]}"
            for chunk in retrieval.retrieved_chunks
        )
        merged = [verdict.model_copy() for verdict in verdicts]
        applied = False
        allowed = {"supported", "weak", "unsupported", "not_a_claim"}

        for start in range(0, len(verdicts), JUDGE_BATCH_SIZE):
            batch = list(enumerate(verdicts))[start : start + JUDGE_BATCH_SIZE]
            claim_lines = "\n".join(
                f"{order + 1}. {v.claim} （引用: {', '.join(v.source_ids) or '无'}）"
                for order, (_, v) in enumerate(batch)
            )
            user = f"事实声明：\n{claim_lines}\n\n证据片段：\n{evidence_lines}"
            parsed = self.gateway.structured_chat(
                self.name, JUDGE_SYSTEM, user, temperature=0.0, max_tokens=2400
            )
            if not parsed or not isinstance(parsed.get("verdicts"), list):
                continue
            for item in parsed["verdicts"]:
                if not isinstance(item, dict):
                    continue
                order = item.get("index")
                verdict = str(item.get("verdict", "")).lower()
                if not (isinstance(order, int) and 1 <= order <= len(batch) and verdict in allowed):
                    continue
                # 引不出证据原文就不算支持——把「不确定」的零成本出口堵上
                quote = str(item.get("quote") or "").strip()
                if verdict in {"supported", "weak"} and not quote:
                    verdict = "unsupported"
                original_index = batch[order - 1][0]
                merged[original_index] = merged[original_index].model_copy(update={"verdict": verdict})
                applied = True

        self.last_judge_state = "applied" if applied else "failed"
        return merged if applied else None
