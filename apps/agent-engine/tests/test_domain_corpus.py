"""领域语料库切换 + 岗位技能地图（行业延伸口径）。

核心纪律：没建库的领域必须如实报空并说明原因，绝不回退到 AI 语料冒充命中。
"""
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
    from backend.integration.personalize_service import is_scratch_corpus

    for name in ("fullpath-probe", "timeout-probe", "test-foo", "tmp-x", "bodysize-probe"):
        assert is_scratch_corpus(name), name
    for name in ("smart-manufacturing", "iotdb", "odoo", "ai", "protein-design"):
        assert not is_scratch_corpus(name), f"{name} 是正经库，不许被误挡"
