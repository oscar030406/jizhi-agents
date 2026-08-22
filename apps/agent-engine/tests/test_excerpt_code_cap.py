"""摘录代码形态上限：自撰区归 lint，摘录区归检索侧机械上限。

对症 2A 复测 beginner 的摘录区代码违规——b1-tool-calling 命中的 ha04s01#s2 是
L1 档语料，却带 21 行无注释的生产级 class，难度上限放不下这一刀。
"""
from backend.integration.personalize_service import (
    evidence_retrieve_api,
    longest_code_block,
)

# 取证锚点：这一块是 L2 难度、22 行代码。beginner 的难度上限就是 L2（纯 L1 语料太薄），
# 所以难度这一刀放行它，只有代码形态这一刀能拦下。
CULPRIT = "ha04s01#s2"
# 三个命中全是长代码块的真实 query，用来打兜底分支
ALL_OVER_LIMIT_QUERY = "LangGraph 状态图 编译 节点 边"


def test_longest_code_block_counts_unclosed_fence():
    """未闭合围栏按到文末算——注入器会截断原文，半截围栏照样贴整段代码。"""
    assert longest_code_block("没有代码") == 0
    assert longest_code_block("```python\na = 1\n\nb = 2\n```") == 2
    assert longest_code_block("```python\na = 1\nb = 2\nc = 3") == 3
    # 取最长的那块，不是求和
    assert longest_code_block("```py\na\n```\n文字\n```py\nb\nc\nd\n```") == 3


def test_culprit_chunk_passes_difficulty_cap_but_not_code_cap():
    """病灶取证：难度档合规、代码形态不合规——两道上限确实各管一段。"""
    hit = next(
        c for c in evidence_retrieve_api("智能体 工具调用 LLM 客户端", top_k=12)["chunks"]
        if c["source_id"] == CULPRIT
    )
    assert hit["difficulty"] == "L2"          # beginner 上限就是 L2，难度这一刀拦不住
    assert longest_code_block(hit["content"]) > 5


def test_code_cap_skips_with_reason_and_never_returns_empty():
    query = "智能体 工具调用 LLM 客户端"
    plain = evidence_retrieve_api(query, top_k=6)
    capped = evidence_retrieve_api(query, top_k=6, max_code_lines=5)

    # 过滤真生效：超限块从 chunks 消失，且以带理由的形式进 skipped
    assert any(longest_code_block(c["content"]) > 5 for c in plain["chunks"])
    assert all(longest_code_block(c["content"]) <= 5 for c in capped["chunks"])
    dropped = {c["source_id"] for c in plain["chunks"]} - {c["source_id"] for c in capped["chunks"]}
    assert dropped
    assert dropped <= {s["source_id"] for s in capped["skipped"]}
    assert all("行代码块" in s["reason"] for s in capped["skipped"])

    # 兜底哲学：绝不因过滤严导致零证据裸生成（幻觉风险更大）
    assert capped["chunks"]
    assert len(capped["chunks"]) <= 6


def test_code_cap_keeps_one_when_everything_is_over_limit():
    """全军覆没也要留一块，理由照常带出——零证据=裸生成，幻觉风险比超档更糟。"""
    plain = evidence_retrieve_api(ALL_OVER_LIMIT_QUERY, top_k=6)
    assert plain["chunks"] and all(
        longest_code_block(c["content"]) > 5 for c in plain["chunks"]
    ), "这个 query 的命中必须全部超限，否则测不到兜底分支"

    result = evidence_retrieve_api(ALL_OVER_LIMIT_QUERY, top_k=6, max_code_lines=5)
    assert len(result["chunks"]) == 1
    # 保底取的是「最温和」的一块，不是随便一块
    assert longest_code_block(result["chunks"][0]["content"]) == min(
        longest_code_block(c["content"]) for c in plain["chunks"]
    )
    assert any("无合规替代块" in s["reason"] for s in result["skipped"])


def test_no_cap_keeps_old_behaviour():
    """不传参数时与旧版一致：不过滤、不产生代码理由的 skipped。"""
    result = evidence_retrieve_api("智能体 工具调用 LLM 客户端", top_k=6)
    assert not any("行代码块" in s["reason"] for s in result["skipped"])
