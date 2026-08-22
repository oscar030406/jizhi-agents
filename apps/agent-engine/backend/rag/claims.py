from __future__ import annotations

import re
from typing import Iterable, List, Sequence, Tuple

from backend.schemas.resources import ClaimVerdict, KnowledgeChunk, LearningResources

# 断句：闭合标点（右引号/右括号）跟着上一句走，不然会切出 '’这就是工具调用' 这种
# 带前导标点的残片——残片本身没意义，还会让下面所有 ^ 锚定的豁免规则失效。
SENTENCE_SPLIT = re.compile(
    r"(?<=[。！？!?][”’\"'）)】」』])"          # 句末标点 + 闭合引号/括号：切在闭合之后
    r"|(?<=[。！？!?])(?![”’\"'）)】」』])"      # 句末标点后面没有闭合标点：直接切
    r"|(?<=[a-z\)\]])\.\s"                      # 英文句号（保留原有分支）
)
# 二字缩写（AI/ML/IO）也是实义 token，原来的 {2,}（总长≥3）把它们全吃了
LATIN_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_\-]{1,}")
# 数值是最典型的幻觉载体：把 92% 写成 12%、1750 亿写成 1300 亿，原来一分不掉，
# 因为 token 规则里根本没有数字。
NUM_TOKEN = re.compile(r"\d+(?:[.,]\d+)*%?")
CJK_RUN = re.compile(r"[一-鿿]+")
#: 敢下结论的最小断言数。低于它只标 `insufficient_claims`，不出判词——分母个位数的
#: 比率不是成绩。接入流水线 ⑦ 站判新库时用的是同一条（`domain_intake._grade_trial`）。
MIN_CLAIMS_FOR_VERDICT = 5
# 引用标记形如 [ha08s03#s1]：它既不是事实内容，也永远匹配不上证据正文
# （chunk 侧 token 来自标题+正文，不含 source_id），留着只会稀释重叠率的分母。
CITATION_MARK = re.compile(r"\[[^\]\n]{2,40}\]")
# 未闭合的围栏也要剥：生成内容里代码块常常被截断，`(?:```|\Z)` 让它一直吃到结尾
CODE_FENCE = re.compile(r"```.*?(?:```|\Z)", re.DOTALL)
INLINE_CODE = re.compile(r"`[^`\n]+`")
# 引用行和面向学习者的指令句不是事实声明，不进入幻觉率分母。
CITATION_PREFIX = re.compile(
    r"^\s*[\(（]?\s*(?:(?:证据|相关|参考|引用)?(?:来源|锚点|出处|依据)|参考|引用|出处|依据)\s*[:：]"
    r"|^\s*sources?\s*[:：]",
    re.IGNORECASE,
)
# 「请」不能裸匹配——「请求」「申请」是本领域最高频的技术词，实测 720 条
# 「Pydantic 模型可以直接用作请求和响应的类型定义」这类该核的事实句被它豁免掉了。
LEARNER_DIRECTED = re.compile(
    # 「请」要认句中祈使（请构建/请注意），但不能命中「请求」——本领域最高频的技术词，
    # 也不能命中「申请/邀请/敬请」。
    r"(?<![申邀敬])请(?![求假])"
    r"|你可以|你需要|你会|你的|你是|你自己|的你[，,、]|对你来说"
    r"|^\s*建议|我们建议|建议你|建议大家"
)
# 教学类比与讲授元话语也不是事实声明。生成指令明文允许「教学类比自由发挥」，
# 但抽取器原来照收——「就像快递公司检查包裹」被当成待核事实判 unsupported，
# 于是讲解越生动幻觉率越高（api 实测：beginner run 15 条 unsupported 里 10 条是
# 类比/元话语，把 0.203 的幻觉率灌出来一大半）。类比不指涉领域事实，
# 核它等于要求教材语料里含有快递公司。
PEDAGOGICAL_ANALOGY = re.compile(
    r"就像|就好比|好比|打个比方|想象一下|类比|比喻|如同|仿佛|像极了|像.{0,12}一样"
    # 个性化语域的跨域类比（「这与后端服务中X类似」「相当于事务状态机」）——
    # 把内容嫁接到学习者已有心智模型正是个性化的本职，语料里不该有目标域黑话
    r"|类似|正如|相当于|好似"
    # 映射式类比（把 X 看作 Y）——与上面的比喻词同一性质，原词表漏了动词式
    r"|看作|看成|视作|视为|理解为|当作|比作|想成"
    # 代入式类比：「想象你是个快递分拣员」「假设你在超市结账」
    r"|想象你|想象一个|假设你|设想你|把你自己当"
)
# 类比是**段落级**的：开篇一句「想象你是个快递分拣员」，后面两三句全在这个虚构
# 场景里展开（「分拣机器人接到指令…」「它需要借助其他设备…」），延续句本身不含
# 任何比喻词，句级豁免抓不到。实测单例 8 条 unsupported 里 4 条是这种延续句。
# 所以整段命中类比就整段不进分母。
PARAGRAPH_SPLIT = re.compile(r"\n\s*\n")
# 但「类似/相当于/正如」这些是高频比较词，出现在事实句里很正常——拿它们传染整段，
# 实测把一门课的断言数从 27 砍到 4，分母直接塌了。所以只有**开虚构场景的类比框架**
# 才传染整段；单纯的比较词仍按句级豁免。
ANALOGY_FRAME = re.compile(
    r"就像|就好比|好比|打个比方|想象一下|想象你|想象一个|假设你|设想你|把你自己当|比作"
)
ANALOGY_PARAGRAPH_MAX_CHARS = 500
# 实操任务的规格句：「验收标准包括…」「要求支持…」是我们出的题目要求，
# 是规范性语句不是领域事实断言，核它等于要求教材里印着我们的作业题
SPEC_SENTENCE = re.compile(
    r"^(验收标准|评估目标|评估需|交付物|任务要求|模拟一个|设计一个|实现一个|构建一个)"
    r"|要求(支持|覆盖|实现|包含)|需(要)?(支持|覆盖|在.{0,16}场景|保持)"
)
TEACHING_META = re.compile(
    r"^(这就是|这一步|每一步|接下来|下一步|首先|然后|最后|总结一下|回顾一下|换句话说|"
    r"也就是说|简单来说|一句话总结)|不能跳过|必须按顺序|我们(刚才|现在|接下来)|这就叫"
    # 测验元话语是对我们自己出的题的陈述，教材语料里不可能有，与上面同一豁免动机
    r"|正确答案|该选项|各选项|因此选|故选|答案为|本题"
    # 讲授元话语：对前文的回指与小结。核它等于要求教材里印着我们这份讲义的结构。
    r"|^这确保|^这意味着|^这就保证|^这样(就|一来)|根据讲义|根据上一节|根据前面|如前所述"
    r"|^步骤(非常)?清晰|^步骤如下|^流程如下"
)

SUPPORTED_THRESHOLD = 0.55
WEAK_THRESHOLD = 0.25
# 概念标签命中原来是加 0.4 的通行证：0.4 > WEAK_THRESHOLD 0.25，意味着句子里
# 只要出现概念标签就永远进不了幻觉分子（实测假命题「RAG 会把参数量提高十倍」
# 拿 0.400/weak 不计幻觉）。降成乘性加成，命中只放大既有重叠，不凭空送分。
CONCEPT_ANCHOR_BONUS = 0.4
# 断句后的实义长度下限（剥掉引用标记与标点之后）。原来是 8 且不剥标记，
# '[ha08s03#s1]' 长 13 照过，这类残渣 100% 判 unsupported，白送幻觉。
MIN_CJK_CLAIM_CHARS = 12
MIN_LATIN_CLAIM_WORDS = 5
# 证据块正文里代码占比超过这个数时，中文断言与它做 token 重叠没有意义
# （知识库 745 块里 427 块含代码），此时只用剥掉代码后的自然语言部分比对。
CODE_HEAVY_RATIO = 0.75


def extract_claims(resources: LearningResources) -> List[Tuple[str, List[str]]]:
    """Pull atomic factual statements out of generated resources.

    Each claim keeps the source_ids its containing block cites, so verification
    checks the evidence the generator actually claimed to use.
    """
    claims: List[Tuple[str, List[str]]] = []
    for section in resources.lecture.sections:
        for sentence in _factual_sentences(section.body):
            claims.append((sentence, list(section.source_ids)))

    # 只审「断言性正文」。分母边界的判据是：这句话在断言领域事实，还是我们自己
    # 写给学习者的指令 / 我们自己出的题？
    #   进分母：section.body（讲义正文）、task.scenario（场景描述）、quiz.explanation
    #   不进分母：steps / acceptance_checks / verification_points / deliverable
    #             （祈使指令与验收规格，核它等于要求教材里印着我们的作业题）
    #             common_pitfalls（实测里是「症状——处置」式排障建议，是我们的操作
    #             经验不是领域断言；离线复算显示它贡献的全是假阳性）
    #             environment_setup（安装命令，由 KR2 沙箱真跑验证，不是文本核对）
    #             quiz.question（疑问句不是断言）、quiz.options（**干扰项按设计就是
    #             错的**，把它当断言核会凭空制造幻觉）
    # 覆盖率不是 100%，所以对外必须同时报 audited_char_ratio，别把「只审了一半」
    # 说成「全篇幻觉率」。
    task = resources.practice_task
    task_fields: List[str] = [task.scenario]
    for field in task_fields:
        # 规格句豁免只在任务这个来源生效——讲义里出现同样句式仍然要核
        for sentence in _factual_sentences(field):
            if not SPEC_SENTENCE.search(sentence):
                claims.append((sentence, list(task.source_ids)))

    for item in resources.graded_quiz:
        for sentence in _factual_sentences(item.explanation):
            claims.append((sentence, list(item.source_ids)))
    return claims


def _factual_sentences(text: str) -> List[str]:
    """按段落取事实句：整段命中类比就整段跳过（类比是段落级的，见 PARAGRAPH_SPLIT）。"""
    out: List[str] = []
    for para in PARAGRAPH_SPLIT.split(text or ""):
        if not para.strip():
            continue
        if ANALOGY_FRAME.search(para) and len(para) <= ANALOGY_PARAGRAPH_MAX_CHARS:
            continue
        out.extend(s for s in _split_sentences(para) if _is_factual(s))
    return out


def audited_char_ratio(resources: LearningResources) -> float:
    """被审文本量 / 生成文本总量。对外报幻觉率时必须一起给，说明分母覆盖多少正文。"""
    def _text(value) -> str:
        if isinstance(value, str):
            return value
        if isinstance(value, list):
            return " ".join(str(v) for v in value)
        if isinstance(value, dict):
            return " ".join(str(v) for v in value.values())
        return ""

    task = resources.practice_task
    audited = sum(len(_text(x)) for x in
                  [s.body for s in resources.lecture.sections]
                  + [task.scenario]
                  + [i.explanation for i in resources.graded_quiz])
    total = audited + sum(len(_text(getattr(task, name, None))) for name in
                          ("steps", "acceptance_checks", "verification_points",
                           "deliverable", "environment_setup", "common_pitfalls"))
    total += sum(len(_text(i.question)) + len(_text(getattr(i, "options", None)))
                 for i in resources.graded_quiz)
    total += sum(len(_text(s.heading)) for s in resources.lecture.sections)
    return round(audited / max(1, total), 3)


def _is_factual(sentence: str) -> bool:
    if CITATION_PREFIX.match(sentence) or LEARNER_DIRECTED.search(sentence):
        return False
    if PEDAGOGICAL_ANALOGY.search(sentence) or TEACHING_META.search(sentence):
        return False
    return True


def verify_claims(
    claims: Iterable[Tuple[str, List[str]]],
    chunks: Sequence[KnowledgeChunk],
) -> List[ClaimVerdict]:
    chunk_by_id = {chunk.source_id: chunk for chunk in chunks}
    verdicts: List[ClaimVerdict] = []
    for claim_text, cited_ids in claims:
        cited_chunks = [chunk_by_id[sid] for sid in cited_ids if sid in chunk_by_id]
        if not cited_chunks:
            verdicts.append(
                ClaimVerdict(claim=claim_text, source_ids=list(cited_ids), verdict="unsupported", support_score=0.0)
            )
            continue
        best_score = 0.0
        best_source = cited_chunks[0].source_id
        # 引用标记不参与打分：它不是事实内容，也永远匹配不上证据正文，
        # 留在分母里只会让短句被平白拉低。
        scored_text = CITATION_MARK.sub(" ", claim_text)
        claim_tokens = _tokens(scored_text)
        claim_lower = scored_text.lower()
        for chunk in cited_chunks:
            # 两种口径取最大：断言是中文散文时，证据块里的代码是噪声（剥掉才比得了）；
            # 断言本身就是教材里的代码时，剥掉反而把真支撑删了。取 max 两头都不亏。
            full_tokens = _tokens(f"{chunk.title} {chunk.content}")
            prose_tokens = _tokens(f"{chunk.title} {_prose_of(chunk.content)}")
            overlap = max(
                len(claim_tokens & full_tokens),
                len(claim_tokens & prose_tokens),
            ) / max(1, len(claim_tokens))
            # 概念标签命中只放大既有重叠，不再凭空送 0.4 的免疫金牌
            hit = any(_tag_hit(tag, claim_lower) for tag in chunk.concept_tags)
            score = min(1.0, overlap * (1 + CONCEPT_ANCHOR_BONUS) if hit else overlap)
            if score > best_score:
                best_score = score
                best_source = chunk.source_id
        if best_score >= SUPPORTED_THRESHOLD:
            verdict = "supported"
        elif best_score >= WEAK_THRESHOLD:
            verdict = "weak"
        else:
            verdict = "unsupported"
        verdicts.append(
            ClaimVerdict(
                claim=claim_text,
                source_ids=list(cited_ids),
                verdict=verdict,
                support_score=round(best_score, 3),
                matched_source_id=best_source,
            )
        )
    return verdicts


def claim_statistics(verdicts: Sequence[ClaimVerdict]) -> dict[str, float | int]:
    """统计口径 v2（2026-08-04 审计后重建）。

    `hallucination_rate` 仍是严格下界（只数 unsupported），但**不再单独对外报**：
    weak 是「证据不足以支持」的灰区，RAGTruth / FACTS Grounding 的通行口径把它算
    幻觉。这里同时给出 `hallucination_rate_upper = (unsupported + weak)/total`，
    对外一律报区间。

    断言数为 0 时不再返回「零幻觉、满分」——那是在奖励「什么都不说」（修订环节
    删句子就能把分数刷上去）。改成标记 insufficient_claims，由调用方单列。
    """
    # not_a_claim 是判官认定的「这句不该拿证据核」，不进分母（但单独计数，
    # 免得靠豁免规则悄悄缩分母——豁免率本身要能被看见）。
    not_claims = sum(1 for v in verdicts if v.verdict == "not_a_claim")
    verdicts = [v for v in verdicts if v.verdict != "not_a_claim"]
    total = len(verdicts)
    if total == 0:
        return {
            "claims_total": 0,
            "claims_supported": 0,
            "hallucination_rate": 0.0,
            "hallucination_rate_upper": 0.0,
            "weak_rate": 0.0,
            "support_rate": 0.0,
            "insufficient_claims": True,
            "not_a_claim_count": not_claims,
        }
    unsupported = sum(1 for v in verdicts if v.verdict == "unsupported")
    fully_supported = sum(1 for v in verdicts if v.verdict == "supported")
    weak = sum(1 for v in verdicts if v.verdict == "weak")
    return {
        "claims_total": total,
        "claims_supported": total - unsupported,
        "hallucination_rate": round(unsupported / total, 3),
        "hallucination_rate_upper": round((unsupported + weak) / total, 3),
        "weak_rate": round(weak / total, 3),
        "support_rate": round((fully_supported + 0.6 * weak) / total, 3),
        "insufficient_claims": total < MIN_CLAIMS_FOR_VERDICT,
        "not_a_claim_count": not_claims,
    }


def _tag_hit(tag: str, claim_lower: str) -> bool:
    """概念标签命中判定：带词边界，避免 'rag' 命中 'storage' 这种子串误伤。"""
    tag = tag.lower().strip()
    if not tag:
        return False
    return re.search(rf"(?<![a-z0-9_]){re.escape(tag)}(?![a-z0-9_])", claim_lower) is not None


def _prose_of(text: str) -> str:
    """取证据块里的自然语言部分。

    知识库 745 块里 427 块含代码。中文断言与 Python 源码在字符集层面就不相交，
    token 重叠恒接近 0——「Agent 的核心是观察→思考→行动」引一个纯代码块会得 0.000，
    这不是幻觉，是度量对不上。代码占比过高时只留散文部分比对。
    """
    stripped = INLINE_CODE.sub(" ", CODE_FENCE.sub(" ", text))
    if not text:
        return text
    if (len(text) - len(stripped)) / len(text) >= CODE_HEAVY_RATIO:
        return stripped
    return stripped if stripped.strip() else text


def _core_length_ok(part: str) -> bool:
    """按剥掉引用标记与标点后的实义长度判，中英分档。"""
    core = CITATION_MARK.sub("", part).strip(" \t　“”‘’\"'（）()【】[]《》「」『』。，、；：!！?？…—-")
    if not core:
        return False
    cjk = len(CJK_RUN.findall(core) and "".join(CJK_RUN.findall(core)))
    if cjk * 2 >= len(core):
        return cjk >= MIN_CJK_CLAIM_CHARS
    return len(core.split()) >= MIN_LATIN_CLAIM_WORDS


def _split_sentences(text: str) -> List[str]:
    # 围栏代码块不是断言（整段代码会被当成一条超长 claim，靠体量薅重叠分）。
    # 但**行内代码必须留着**：`add_tool` 这种方法名正是要核的东西，剥掉之后
    # 句子变成「可以使用  这个便利方法」，判官核无可核——实测被误判 unsupported。
    text = CODE_FENCE.sub(" ", text)
    parts = [part.strip().lstrip(" 　”’\"'）)】」』》") for part in SENTENCE_SPLIT.split(text) if part and part.strip()]
    return [part for part in parts if part and _core_length_ok(part)]


def _tokens(text: str) -> set[str]:
    tokens = {match.group(0).lower() for match in LATIN_TOKEN.finditer(text)}
    tokens.update(match.group(0) for match in NUM_TOKEN.finditer(text))
    # 逐个连续汉字段取双字组：原来先把全文汉字抽成一条连续序列再配对，
    # 会跨过中间的英文/数字拼出 '解的' 这种伪 token（'缓解LLM的幻觉'）。
    for seg in CJK_RUN.findall(text):
        tokens.update(seg[i : i + 2] for i in range(len(seg) - 1))
    return tokens
