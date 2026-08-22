"""口径分辨力：埋进去的假命题必须被判无据，教材里真有的说法必须判有据。

2026-08-04 口径重建后加的门。评测口径改动一次能把幻觉率挪十几个百分点，
光看均值涨跌判断不了改对没有——只有「假的能不能抓出来、真的会不会误伤」
这两个方向同时立住，这套度量才有资格报数。
"""

from backend.rag.claims import claim_statistics, verify_claims
from backend.schemas.resources import KnowledgeChunk

CHUNK = KnowledgeChunk(
    source_id="ha07s04#s5",
    title="第7章 7.4 Agent 范式的框架化实现",
    content=(
        "工具调用的实现依赖一种约定的标记格式。模型在需要外部能力时，"
        "生成形如 [TOOL_CALL:工具名:参数] 的文本，Agent 解析这段文本，"
        "根据工具名在注册表中查到对应的函数并执行，再把执行结果回填进对话。"
        "注册工具使用 add_tool 方法，未注册的工具无法被调用。"
        "检索增强生成不修改模型权重，它在生成前把检索到的文档拼进上下文，"
        "让回答建立在外部证据上，从而降低编造的概率。"
    ),
    concept_tags=["tool_calling", "rag"],
    topic="agent",
    difficulty="L2",
    section="7.4",
)

# 教材里真有的说法（含改写），应当判有据
TRUE_CLAIMS = [
    "模型在需要外部能力时会生成形如 [TOOL_CALL:工具名:参数] 的文本，由 Agent 解析后执行",
    "Agent 解析出工具名后在注册表中查到对应函数并执行，再把执行结果回填进对话",
    "注册工具使用 add_tool 方法，未注册的工具无法被调用",
]

# 与教材矛盾或教材根本没说的，应当判无据
FALSE_CLAIMS = [
    "检索增强生成会把大模型的参数量提高十倍，因此显存需求翻倍",
    "工具调用的标记格式是 <invoke name=工具名>，Agent 按 XML 解析",
    "注册工具使用 register_plugin 方法，未注册的工具会自动降级为内置实现",
    "检索增强生成需要先对模型做一轮全参数微调，否则检索结果无法生效",
]


def _verdicts(claims):
    return verify_claims([(c, ["ha07s04#s5"]) for c in claims], [CHUNK])


def test_true_claims_are_not_flagged_as_hallucination():
    for v in _verdicts(TRUE_CLAIMS):
        assert v.verdict != "unsupported", f"教材里真有的说法被误伤：{v.claim}（{v.support_score}）"


def test_deterministic_layer_cannot_judge_truth_by_design():
    """确定性层量的是「话题像不像」，不是「对不对」——这条锁死这个已知边界。

    用教材词汇编的假命题（「RAG 会把参数量提高十倍」）与真命题共享大量二元组，
    重叠打分必然给它不低的分。所以确定性这层只能当**检索接地筛**用，
    判真伪必须落在判官那一级（见 content_audit_agent._llm_review）。
    任何把这一层的输出直接叫「幻觉率」的报表都是错的。
    """
    verdicts = _verdicts(FALSE_CLAIMS)
    caught = [v for v in verdicts if v.verdict == "unsupported"]
    assert len(caught) < len(FALSE_CLAIMS), (
        "确定性层意外抓住了全部假命题——若真如此，说明打分逻辑变了，"
        "本测试记录的边界需要重新评估"
    )


def test_concept_tag_hit_is_no_longer_a_free_pass():
    """概念标签命中过去是加 0.4 的通行证（0.4 > weak 阈值 0.25），
    句子里出现 rag 就永远进不了幻觉分子。改成乘性之后，低重叠不再被凭空抬过线。"""
    v = _verdicts(["检索增强生成会把大模型的参数量提高十倍，因此显存需求翻倍"])[0]
    assert v.verdict != "supported", (v.verdict, v.support_score)
    assert v.support_score < 0.55


def test_statistics_report_interval_and_weak_share():
    stats = claim_statistics(_verdicts(TRUE_CLAIMS + FALSE_CLAIMS))
    assert stats["hallucination_rate"] <= stats["hallucination_rate_upper"]
    assert stats["weak_rate"] >= 0.0
    # 严格下界 + weak 占比 == 宽口径上界，省得引用方自己减错
    assert abs(stats["hallucination_rate"] + stats["weak_rate"] - stats["hallucination_rate_upper"]) < 1e-6


def test_empty_claims_no_longer_scores_as_perfect():
    """断言数为 0 不该是「零幻觉满分」——那是在奖励把句子删光。"""
    stats = claim_statistics([])
    assert stats["insufficient_claims"] is True
    assert stats["support_rate"] == 0.0
