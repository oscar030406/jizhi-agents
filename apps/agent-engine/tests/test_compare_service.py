"""同题异人对比：确定性模式下差异必须存在且逐处可归因。"""
import os

from backend.services.compare_service import compare_generate

GOAL = "学会搭一个带审核的 RAG 问答系统"


def test_compare_two_profiles_differ_and_attributed(monkeypatch):
    monkeypatch.setenv("AGENT_GENERATION_MODE", "deterministic")
    report = compare_generate(GOAL, ["zero_beginner", "backend_to_agent"])

    assert len(report.entries) == 2
    a, b = report.entries
    # 差异化画像必须产生不同难度（零基础 vs 高工程能力）
    assert a.profile.recommended_difficulty != b.profile.recommended_difficulty
    # 每处差异都有归因，且归因非空
    assert report.differences
    for diff in report.differences:
        assert diff.observation and diff.because
    # 难度差异必须被归因到掌握向量
    dims = {d.dimension for d in report.differences}
    assert "difficulty" in dims
    # trace 引擎标注如实存在（防伪底线）
    assert a.resources.engines and b.resources.engines
    assert set(a.resources.engines.values()) == {"deterministic"}


def test_compare_rejects_single_profile():
    try:
        compare_generate(GOAL, ["zero_beginner"])
        raise AssertionError("应当拒绝单画像对比")
    except ValueError:
        pass
