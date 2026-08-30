"""域级学习路径：钉住三条会让页面开始说谎的性质。

用盘上真实的 `smart-manufacturing_intake/readiness.json` 当尺子——这条路径整个是
读盘算出来的，造一份假 readiness 只能测到我自己写的形状，测不到「真语料排得出阶来」。
"""

from backend.services.concept_graph import available_prereq_domains, load_prereq_edges
from backend.services.domain_path import build_domain_path

CORPUS = "smart-manufacturing"


def test_smart_manufacturing_has_stages():
    """真库排得出阶。空手而归就是接线又断了（这次修的病）。"""
    path = build_domain_path(CORPUS)
    assert path["source"] == "intake"
    assert path["concept_count"] > 0
    assert path["edge_count"] > 0
    assert path["stages"]
    assert sum(len(s["concepts"]) for s in path["stages"]) == path["concept_count"]
    # 分档上限：十几阶等于没分档
    assert len(path["stages"]) <= 6
    assert path["reason"] is None
    # 口径必须跟着走，前端才有话可写
    assert "未经人工复核" in path["caliber"]


def test_missing_corpus_says_why_instead_of_faking_it():
    """没有就说没有。**不许回退到 AI 域**——冒充主域数据正是要防的那件事。"""
    path = build_domain_path("nonexistent-corpus")
    assert path["source"] == "none"
    assert path["reason"]
    assert path["stages"] == []
    assert path["concept_count"] == 0


def test_stage_order_respects_prerequisites():
    """前置的阶不得晚于本概念的阶。这条一破，路径就是在教人倒着学。"""
    path = build_domain_path(CORPUS)
    stage_of = {c["name"]: s["index"] for s in path["stages"] for c in s["concepts"]}
    broken = set(path["cycles_broken"])  # 环上被丢掉的回边不参与约束
    for stage in path["stages"]:
        for concept in stage["concepts"]:
            for pre in concept["prereq"]:
                if f"{pre}→{concept['name']}" in broken:
                    continue
                assert stage_of[pre] <= stage["index"], f"{pre} 排在了 {concept['name']} 之后"


def test_prereq_edges_are_domain_scoped():
    """域过滤：智造域的边不许把 AI 域的概念带进来，反之亦然。"""
    assert CORPUS in available_prereq_domains()
    sm = load_prereq_edges(CORPUS)
    ai = load_prereq_edges("ai")
    assert sm and ai
    assert not set(sm) & set(ai)
    # 不传域仍是全域并集：既有四个调用点的行为一字不变
    everything = load_prereq_edges()
    assert set(sm) <= set(everything) and set(ai) <= set(everything)


def test_thin_vocabulary_falls_back_to_index_tags_and_says_so():
    """概念表薄的库改用索引标注，但必须在 source/caliber 里说清换了口径。

    iotdb 是这条路径的真实来源：2716 个证据块、概念表只有 2 条（语料无章节序）。
    退回索引标注是为了让这个库也有路径，代价是排序含义从「前置顺序」变成
    「教材着墨多少」——这个代价不许藏。
    """
    from backend.services.domain_path import TAG_CALIBER, build_domain_path

    path = build_domain_path("iotdb")
    assert path["source"] == "index-tags"
    assert path["concept_count"] > 2, "索引标注应该比概念表厚，否则这条兜底没意义"
    assert path["edge_count"] == 0, "标注之间没有前置边，不许伪造"
    assert path["caliber"] == TAG_CALIBER
    assert "不是前置顺序" in path["caliber"]
    assert path["thin_vocabulary"]["concepts_in_report"] == 2
    # 每个概念的 because 要说得出自己是怎么来的
    first = path["stages"][0]["concepts"][0]
    assert "证据块" in first["because"]
    assert first["prereq"] == []


def test_独立库的闭包不长出别域概念_主库仍走并集():
    """按域取边的真正消费者是路径规划：独立建出来的库排自己的，主库保持并集。

    钉住两件事：
    1. `isolated_corpus` 只认有 `<corpus>_intake` 的库——主库（ai）不过滤，
       因为它的索引里并着具身子域，硬过滤会把该在一起的两半劈开；
    2. 智能制造的已知概念集里没有 AI 域概念，否则闭包会把别域前置排进来。
    """
    from backend.services.concept_graph import isolated_corpus, known_concepts

    assert isolated_corpus("smart-manufacturing") == "smart-manufacturing"
    assert isolated_corpus("ai") is None
    assert isolated_corpus("") is None

    sm = known_concepts("smart-manufacturing")
    ai = known_concepts("ai")
    assert sm, "智能制造有 66 个概念，取不到说明域过滤没接上"
    assert not (sm & ai), f"跨域串味：{sorted(sm & ai)[:5]}"
    assert sm <= known_concepts(), "域内概念必须是全域并集的子集"
