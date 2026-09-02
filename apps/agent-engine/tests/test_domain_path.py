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
    assert "管理者" in path["reason"]
    assert "盘上" not in path["reason"]
    assert "readiness.json" not in path["reason"]


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


def test_thin_external_vocabulary_stays_on_readiness_concept_ids():
    """词表再薄也只能用 readiness 概念；索引标签不能另造学习者概念空间。"""
    from backend.services.goal_concepts import domain_concepts

    path = build_domain_path("iotdb")
    ids = {
        concept["id"]
        for stage in path["stages"]
        for concept in stage["concepts"]
    }
    readiness_ids = set(domain_concepts("iotdb"))

    assert path["source"] == "intake"
    assert ids == readiness_ids
    assert path["concept_count"] == len(readiness_ids) == 2
    assert path["edge_count"] == 0
    assert path["thin_vocabulary"]["concepts_in_report"] == 2


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


def test_ai_path_comes_from_root_engine_artifacts_and_covers_deep_learning():
    """AI 与外域走同一引擎合同；手工 learning-path.json 不再参与。"""
    path = build_domain_path("ai")
    ids = {
        concept["id"]
        for stage in path["stages"]
        for concept in stage["concepts"]
    }

    assert path["source"] == "index-graph"
    assert path["artifact_id"].startswith("sha256:")
    assert path["generated_at"]
    assert path["edge_count"] > 0
    assert "deep_learning" in ids
    assert path["personalization"]["matched_mastery"] == 0


def test_main_domain_aliases_share_the_ai_path():
    for alias in ("", "default", "AI"):
        path = build_domain_path(alias)
        assert path["corpus"] == "ai"
        assert path["source"] == "index-graph"


def test_partial_mastery_keeps_unscored_concepts_unmeasured():
    path = build_domain_path(
        CORPUS,
        mastery_vector={"S7 连接配置": 0.95},
        mastery_corpus=CORPUS,
    )
    statuses = {
        concept["id"]: concept["status"]
        for stage in path["stages"]
        for concept in stage["concepts"]
    }

    assert statuses["S7 连接配置"] == "mastered"
    assert all(
        status == "unmeasured"
        for concept_id, status in statuses.items()
        if concept_id != "S7 连接配置"
    )
    assert path["personalization"]["counts"]["unmeasured"] == len(statuses) - 1


def test_mastery_vector_is_corpus_partitioned_even_when_concept_ids_are_identical():
    """异域同名/同 ID 也不能串：分区先于概念匹配。"""
    path = build_domain_path(
        "ai",
        mastery_vector={"llm_basics": 0.95},
        mastery_corpus="smart-manufacturing",
    )
    concept = next(
        concept
        for stage in path["stages"]
        for concept in stage["concepts"]
        if concept["id"] == "llm_basics"
    )

    assert concept["status"] == "unmeasured"
    assert "mastery" not in concept
    assert path["personalization"]["matched_mastery"] == 0
    assert path["personalization"]["corpus_match"] is False
    assert path["personalization"]["match_mode"] == "exact-concept-id"
    assert "尚无" in path["personalization"]["reason"]


def test_mastery_vector_matches_exact_concept_id_not_title_or_substring():
    """同域也只认概念 ID；场景标题或子串再像都不能猜。"""
    path = build_domain_path(
        "ai",
        mastery_vector={"大语言模型原理": 0.95, "llm": 0.95},
        mastery_corpus="ai",
    )
    concept = next(
        concept
        for stage in path["stages"]
        for concept in stage["concepts"]
        if concept["id"] == "llm_basics"
    )

    assert concept["status"] == "unmeasured"
    assert path["personalization"]["matched_mastery"] == 0
    assert path["personalization"]["match_mode"] == "exact-concept-id"


def test_production_app_domain_path_is_post_and_consumes_mastery():
    """线上启动的是 app.main；不能只让 backend.main 的同名路由正确。"""
    from fastapi.testclient import TestClient

    from app.config.settings import settings
    from app.main import app

    client = TestClient(app)
    url = "/internal/v1/personalize/domain-path/ai"
    headers = {"x-internal-token": settings.ai_service_token}
    assert client.get(url, headers=headers).status_code == 405
    response = client.post(
        url,
        headers=headers,
        json={"masteryCorpus": "ai", "masteryVector": {"llm_basics": 0.9}},
    )
    assert response.status_code == 200
    path = response.json()["data"]
    concept = next(
        concept
        for stage in path["stages"]
        for concept in stage["concepts"]
        if concept["id"] == "llm_basics"
    )
    assert concept["status"] == "mastered"
    assert path["personalization"]["matched_mastery"] == 1
