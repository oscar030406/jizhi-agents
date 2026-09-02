"""领域语料库切换 + 岗位技能地图（行业延伸口径）。

核心纪律：没建库的领域必须如实报空并说明原因，绝不回退到 AI 语料冒充命中。
"""
import pytest

from backend.integration.personalize_service import (
    DOMAIN_CORPORA,
    domain_corpora,
    evidence_retrieve_api,
    skill_map_api,
)


def test_default_corpus_still_retrieves():
    result = evidence_retrieve_api("注意力机制 QKV", top_k=3)
    assert result["corpus"] == "default"
    assert result["chunks"], "默认 AI 语料必须仍能命中"


def test_unbuilt_domain_returns_empty_with_reason():
    result = evidence_retrieve_api("数控机床刀具补偿", corpus="manufacturing")
    assert result["chunks"] == []
    assert "尚未建设" in result["missing_evidence_warning"]
    assert "管理者" in result["missing_evidence_warning"]
    assert "data/knowledge_base" not in result["missing_evidence_warning"]


def test_corpus_name_is_path_safe():
    result = evidence_retrieve_api("x", corpus="../../etc")
    assert result["chunks"] == []


def test_skill_map_reports_real_coverage_and_corpus_status():
    payload = skill_map_api()
    assert payload["market_stats"]["sample"]  # 真实调研口径必须在
    assert len(payload["jobs"]) >= 10
    job = payload["jobs"][0]
    assert 0 <= job["covered_count"] <= len(job["skills"])
    for skill in job["skills"]:
        # 判为覆盖的必须留下可复核的证据 id
        assert (not skill["covered"]) or skill["source_id"]
    status = {c["corpus"]: c for c in payload["corpora"]}
    # 对外状态是**扫盘发现 + 质量闸**，不是写死的名单。
    #
    # 这条断言 2026-08-21 改过一次方向：曾经锁的是「不多不少种子六个」，
    # 那是硬编码白名单时代的写法。名单挡住了先期小样，但也把「管理者上传新库后
    # 自动注册」堵死了——而那正是本项目对泛化的定义。现在改成：种子六个一个不许少
    # （声明了却没建的域要如实报 available=false），盘上多出来的库照报，
    # 靠 `eligible` 区分够不够格对外露面，且没过闸的必须说得出原因。
    assert set(DOMAIN_CORPORA) <= set(status)
    assert status["ai"]["available"] and status["ai"]["chunk_count"] > 0
    for c in payload["corpora"]:
        assert "eligible" in c and "gate" in c
        if not c["eligible"]:
            assert c["gate"]["reasons"], f"{c['corpus']} 被挡下却说不出原因"


def test_domain_corpora_picks_up_new_library_on_disk(tmp_path, monkeypatch):
    """流水线建出来的新库不重启就要出现在枚举里——这是 G8 跨端联动的先决条件。"""
    import backend.rag.retriever as retriever

    fake = tmp_path / "corpora"
    (fake / "brandnew").mkdir(parents=True)
    (fake / "brandnew" / "knowledge_index.jsonl").write_text("{}\n", encoding="utf-8")
    (fake / "half-built").mkdir()  # 只有目录没有索引：半成品，不该露面
    monkeypatch.setattr(retriever, "CORPORA_DIR", fake)

    names = domain_corpora()
    assert set(DOMAIN_CORPORA) <= set(names)
    assert "brandnew" in names
    assert "half-built" not in names


# ── 词表闸三态（2026-08-23 线上实锤倒逼）─────────────────────────────

def test_没开概念抽取不算词表闸失败(tmp_path, monkeypatch):
    """`extract_concepts` 是可选开关、默认关（抽概念要调 LLM 花钱）。

    没开时 `gate1_vocabulary` 也写 `False`，但那是「这次没做」不是「做了没达标」。
    线上实锤：`smart-manufacturing` 1412 块、三指标全过（事实性 0.805、幻觉率 0.054），
    就因为没开概念抽取被判 eligible=False，学习端整个不认这个库。

    与 ⑦ 站 trial_verdict 的三态同一个道理——把没测当没过就是虚报。
    """
    from backend.integration import personalize_service as ps

    monkeypatch.setattr(
        ps,
        "_readiness",
        lambda name: {
            "readiness": {"gate1_vocabulary": False},
            "vocabulary_note": "未抽取——概念抽取要调 LLM，本次 run 的 extract_concepts 开关是关的",
        },
    )
    verdict, why = ps._vocabulary_verdict("probe")
    assert verdict == "skipped", f"没抽应当是 skipped 不是 failed：{why}"


def test_抽了但词表太少才算失败(monkeypatch):
    from backend.integration import personalize_service as ps

    monkeypatch.setattr(
        ps,
        "_readiness",
        lambda name: {"readiness": {"gate1_vocabulary": False}, "vocabulary_note": ""},
    )
    verdict, why = ps._vocabulary_verdict("probe")
    assert verdict == "failed" and "2 条" in why


def test_词表够就通过(monkeypatch):
    from backend.integration import personalize_service as ps

    monkeypatch.setattr(ps, "_readiness", lambda name: {"readiness": {"gate1_vocabulary": True}})
    assert ps._vocabulary_verdict("probe")[0] == "passed"


def test_没有就绪度记录不当失败(monkeypatch):
    """全新库、报告还没写出来时不许直接判死。"""
    from backend.integration import personalize_service as ps

    monkeypatch.setattr(ps, "_readiness", lambda name: {})
    assert ps._vocabulary_verdict("probe")[0] == "skipped"


def test_一次性验证库不对学习者露面():
    """实锤：全链验证建的 `fullpath-probe`（300 块随机字节）过了块数闸，
    出现在学习者的知识库下拉里——选中它会拿乱码生成一门课。

    用命名约定不用手工黑名单：名单要人记得维护，约定不用。
    """
    from backend.integration import personalize_service as ps
    from backend.integration.personalize_service import is_scratch_corpus

    for name in (
        "fullpath-probe",
        "timeout-probe",
        "test-foo",
        "tmp-x",
        "bodysize-probe",
        "fullprobe-20260901",
    ):
        assert is_scratch_corpus(name), name
    for name in ("smart-manufacturing", "iotdb", "odoo", "ai", "protein-design"):
        assert not is_scratch_corpus(name), f"{name} 是正经库，不许被误挡"
    gate = ps._corpus_gate("fullprobe-20260901", chunks=300, retrievable=True)
    assert gate["passed"] is False
    assert any("一次性验证库" in reason for reason in gate["reasons"])


# ── 岗位技能图谱的域化（2026-08-30 静默错配修复）─────────────────────────
#
# 病症：`skill_map_api` 无域参数、整表 lru_cache(1)，不管学员在哪个域都回主库那
# 14 个 AI 岗位，返回体里连一格「这是哪个域」都没有。唯一的诚实分支活在浏览器里
# （/skills 页一个 localStorage 判断），绕过页面直取接口就穿帮。


def test_未登记岗位要求的域如实报空而不是拿主域顶替():
    from backend.integration.personalize_service import skill_map_api

    payload = skill_map_api("smart-manufacturing")
    assert payload["domain"] == "smart-manufacturing"
    assert payload["jobs"] == [], "外域不许出现主库的 AI 岗位"
    assert payload["reason"], "报空必须说得出为什么"
    assert payload["corpora"], "语料库状态照常带，这是「为什么没有」的现场证据"


def test_登记了岗位要求就按这个域自己的库判覆盖(tmp_path, monkeypatch):
    """`job_requirements` 目前所有域都是 null，这条路只能靠构造数据走一遍。

    两件事一起验：岗位清单取自域注册清单（不是 job_skill_map.json），
    覆盖判定用的是这个域自己的检索器（不是主库）。
    """
    import json

    from backend.integration import personalize_service as ps
    from backend.rag import retriever as retriever_mod
    from backend.schemas.resources import KnowledgeChunk, RetrievalResult

    (tmp_path / "domain_registry.json").write_text(
        json.dumps({"corpora": [{
            "corpus": "widgets",
            "job_requirements": {"jobs": [{
                "job_id": "hydraulic_tech",
                "title": "液压设备维护技师",
                "skills": ["液压系统日常点检", 42],  # 非字符串条目要被跳过，不许把整张图带崩
            }]}},
        ]}),
        encoding="utf-8",
    )
    monkeypatch.setattr(ps, "KB_DIR", tmp_path)

    chunks = [
        KnowledgeChunk(
            source_id=f"widget{i}#s1", title=f"点检手册 {i}", topic="maintenance",
            difficulty="L2", concept_tags=[], section="s1", content="液压回路点检要点。" * 12,
            score=0.9,
        )
        for i in (1, 2)
    ]

    class _DomainRetriever:
        fallback = None  # _judge 据此认定「这个后端支持关掉词法兜底」

        def search(self, query, concept_tags=None, top_k=6, allow_lexical_fallback=True):
            assert allow_lexical_fallback is False, "覆盖判定不许吃词法兜底"
            return RetrievalResult(
                retrieved_chunks=chunks, source_ids=[c.source_id for c in chunks],
                evidence_summary="", missing_evidence_warning=None,
            )

    monkeypatch.setattr(
        retriever_mod, "get_corpus_retriever",
        lambda name: _DomainRetriever() if name == "widgets" else None,
    )
    # 主库检索器一旦被碰就是回退，直接判失败
    monkeypatch.setattr(
        retriever_mod, "get_retriever",
        lambda: pytest.fail("外域覆盖判定碰了主库检索器"),
    )

    ps.skill_map_api.cache_clear()
    try:
        payload = ps.skill_map_api("widgets")
    finally:
        ps.skill_map_api.cache_clear()  # 构造出来的结果不许留在缓存里

    assert payload["domain"] == "widgets" and "reason" not in payload
    job = payload["jobs"][0]
    assert job["title"] == "液压设备维护技师"
    assert [s["skill"] for s in job["skills"]] == ["液压系统日常点检"]
    assert job["covered_count"] == 1 and job["skills"][0]["source_id"] == "widget1#s1"
