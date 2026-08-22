"""概念抽取的纯函数部分：证据闸、支撑下限、归并保粒度。

用假 `ask` 注入模型输出，不发真请求。钉住的三条都是**会悄悄毁掉词表**的：
证据不校验 → 幻觉概念混进命名空间；不设支撑下限 → 5.6 倍冗余；
归并用二分类 → 子面被吞进上位面，学习者本该单独学的东西消失。
"""

from backend.rag.concepts import (
    ConceptCandidate,
    extract_from_sections,
    json_only,
    merge_candidates,
    normalize,
    prune,
    to_vocabulary,
    vocabulary_report,
)

BODY = "注意力机制通过 softmax 对相似度归一化。自注意力是查询、键、值同源的特例。"


def ask_returning(*payloads):
    """依次返回给定输出的假 ask。"""
    seq = list(payloads)

    def ask(_system, _user):
        return seq.pop(0) if seq else None

    return ask


def test_normalize_strips_wrappers_and_fullwidth():
    assert normalize(" 「注意力机制」 ") == "注意力机制"
    assert normalize("注意力  机制") == "注意力 机制"


def test_evidence_must_be_a_substring_of_the_body():
    """证据对不上正文的概念当场丢——压幻觉概念的机械闸。"""
    got = extract_from_sections(
        [("s1", BODY)],
        ask_returning(
            {
                "concepts": [
                    {"name": "注意力机制", "evidence": "注意力机制通过 softmax 对相似度归一化。"},
                    {"name": "Transformer", "evidence": "Transformer 由编码器和解码器组成。"},
                ]
            }
        ),
    )
    assert set(c.name for c in got.values()) == {"注意力机制"}


def test_caps_per_section():
    many = {"concepts": [{"name": f"概念{i}", "evidence": BODY[:10]} for i in range(20)]}
    got = extract_from_sections([("s1", BODY)], ask_returning(many))
    assert len(got) <= 8


def test_support_counts_distinct_sections():
    payload = {"concepts": [{"name": "注意力机制", "evidence": "注意力机制通过 softmax 对相似度归一化。"}]}
    got = extract_from_sections([("s1", BODY), ("s2", BODY)], ask_returning(payload, payload))
    assert next(iter(got.values())).support == 2


def test_prune_drops_single_section_candidates():
    found = {
        "a": ConceptCandidate(name="A", sections={"s1", "s2"}),
        "b": ConceptCandidate(name="B", sections={"s1"}),
    }
    kept = prune(found)
    assert set(kept) == {"a"}


def test_merge_keeps_narrower_concepts_as_their_own():
    """自注意力不许被并进注意力机制——归并必须是三分类。"""
    found = {
        "注意力机制": ConceptCandidate(name="注意力机制", sections={"s1", "s2"}, evidence=["x"]),
        "自注意力机制": ConceptCandidate(name="自注意力机制", sections={"s1", "s3"}, evidence=["y"]),
    }
    merged, log = merge_candidates(found, ask_returning({"relation": "a_narrower"}))
    assert len(merged) == 2
    assert log == []


def test_merge_folds_true_synonyms():
    found = {
        "注意力机制": ConceptCandidate(name="注意力机制", sections={"s1", "s2"}, evidence=["x"]),
        "注意力": ConceptCandidate(name="注意力", sections={"s3"}, evidence=["y"]),
    }
    merged, log = merge_candidates(found, ask_returning({"relation": "same"}))
    assert len(merged) == 1
    kept = next(iter(merged.values()))
    assert kept.support == 3  # 两边的节数合并
    assert len(log) == 1


def test_report_lists_what_was_dropped_not_only_what_survived():
    found = {
        "a": ConceptCandidate(name="A", sections={"s1", "s2"}),
        "b": ConceptCandidate(name="B", sections={"s1"}),
    }
    kept = prune(found)
    rep = vocabulary_report(found, kept, ["X → Y"])
    assert rep["candidates"] == 2 and rep["kept"] == 1
    assert rep["dropped_low_support"] == ["B"]
    assert rep["merged"] == ["X → Y"]


def test_vocabulary_sorted_by_support():
    merged = {
        "a": ConceptCandidate(name="A", sections={"s1"}),
        "b": ConceptCandidate(name="B", sections={"s1", "s2", "s3"}),
    }
    vocab = to_vocabulary(merged)
    assert [v["concept"] for v in vocab] == ["B", "A"]


def test_json_only_survives_fences_and_prefixes():
    assert json_only('```json\n{"a": 1}\n```') == {"a": 1}
    assert json_only("好的，结果如下：{\"a\": 2} 以上") == {"a": 2}
    assert json_only("没有 JSON") is None


def test_identifier_shaped_names_are_rejected():
    """提示词写了排除条款，实测照样漏——判据必须在代码里。

    这批反例全部来自 IoTDB 那次真实翻车：28 个「概念」里 17 个是这种。
    """
    from backend.rag.concepts import looks_like_identifier

    for bad in [
        "SessionPool",            # API 类名
        "DataReplicationFactor",  # 配置参数
        "FIELD",                  # SQL 关键字
        "TTL",
        "GROUP BY子句",
        "基础鉴权(Basic Auth",     # 括号残缺
        "session_pool",           # snake_case
        "一",                     # 截断
    ]:
        assert looks_like_identifier(bad), bad

    for good in ["时序数据模型", "集群部署与扩容", "查询语言", "会话与连接管理"]:
        assert not looks_like_identifier(good), good


def test_extraction_drops_identifier_shaped_candidates():
    got = extract_from_sections(
        [("s1", BODY, ["查询", "注意力"])],
        ask_returning(
            {
                "concepts": [
                    {"name": "注意力机制", "evidence": "注意力机制通过 softmax 对相似度归一化。"},
                    {"name": "SessionPool", "evidence": "注意力机制通过 softmax 对相似度归一化。"},
                ]
            }
        ),
    )
    assert set(c.name for c in got.values()) == {"注意力机制"}


def test_heading_path_is_offered_as_the_candidate_pool():
    """给了标题路径就必须发给模型——只发正文等于把闭集做成开集。"""
    seen = {}

    def ask(system, user):
        seen["user"] = user
        return {"concepts": []}

    extract_from_sections([("s1", BODY, ["集群部署", "副本配置"])], ask)
    assert "候选池" in seen["user"]
    assert "集群部署 / 副本配置" in seen["user"]


def test_sections_without_heading_path_still_work():
    """标题路径取不到时（.po 之类）退回只发正文，不炸。"""
    got = extract_from_sections(
        [("s1", BODY)],
        ask_returning(
            {"concepts": [{"name": "注意力机制", "evidence": "注意力机制通过 softmax 对相似度归一化。"}]}
        ),
    )
    assert len(got) == 1
