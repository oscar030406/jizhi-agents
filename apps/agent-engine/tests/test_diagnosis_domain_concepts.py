"""学情诊断与路径共用接入产物里的领域概念 ID。"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from backend.agents import learner_diagnosis_agent as agent
from backend.integration import personalize_service
from backend.integration.personalize_service import _resolve_mastery
from backend.schemas.learner import LearnerProfile
from backend.services import concept_graph
from backend.services import goal_concepts as concepts
from backend.services.concept_difficulty import goal_difficulty
from backend.services.personalization_service import build_personalization_blueprint


class _DisabledGateway:
    def is_enabled(self, _agent: str) -> bool:
        return False


@pytest.fixture()
def readiness_root(tmp_path: Path, monkeypatch) -> Path:
    root = tmp_path / "knowledge_base"
    root.mkdir()
    monkeypatch.setattr(concepts, "KB_DIR", root)
    monkeypatch.setattr(concept_graph, "KB_DIR", root)
    concept_graph._prereq_by_domain.cache_clear()
    concept_graph.load_prereq_edges.cache_clear()
    monkeypatch.setattr(personalize_service, "_bridge_gateway", lambda: _DisabledGateway())
    yield root
    concept_graph._prereq_by_domain.cache_clear()
    concept_graph.load_prereq_edges.cache_clear()


def write_readiness(root: Path, corpus: str, concept_ids: list[str]) -> None:
    target = root / f"{corpus}_intake"
    target.mkdir()
    (target / "readiness.json").write_text(
        json.dumps(
            {"concepts": [{"concept": concept, "sections": []} for concept in concept_ids]},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def test_main_domain_keeps_tuned_concept_floors() -> None:
    for corpus in ("ai", ""):
        floors = agent.concept_floors_for(corpus)
        assert floors.items() >= agent.CONCEPT_FLOORS.items()
        assert "deep_learning" in floors


def test_main_domain_accepts_ai_catalog_and_rejects_foreign_concepts() -> None:
    got = personalize_service.learner_blueprint_api(
        learning_goal="学习深度学习",
        corpus="ai",
        concept_mastery={"deep_learning": 0.2, "S7 连接配置": 0.9},
    )

    assert got["mastery_vector"]["deep_learning"] == 0.2
    assert "S7 连接配置" not in got["mastery_vector"]
    assert got["coverage"]["out_of_domain_concepts"] == ["S7 连接配置"]


def test_external_domain_uses_readiness_concept_ids(readiness_root: Path) -> None:
    write_readiness(readiness_root, "mfg", ["PLC扫描周期", "S7 连接配置"])

    floors = agent.concept_floors_for("mfg")

    assert set(floors) == {"PLC扫描周期", "S7 连接配置"}
    assert all(value == agent.DEFAULT_CONCEPT_FLOOR for value in floors.values())


def test_missing_or_invalid_readiness_is_empty_not_ai(readiness_root: Path) -> None:
    assert agent.concept_floors_for("missing") == {}
    broken = readiness_root / "broken_intake"
    broken.mkdir()
    (broken / "readiness.json").write_text("{ invalid", encoding="utf-8")
    assert agent.concept_floors_for("broken") == {}


def test_external_domain_only_marks_measured_below_floor_as_weak(readiness_root: Path) -> None:
    write_readiness(readiness_root, "mfg", ["PLC扫描周期", "S7 连接配置"])

    got = personalize_service.learner_blueprint_api(
        learning_goal="学习 PLC 扫描周期",
        corpus="mfg",
        concept_mastery={"PLC扫描周期": 0.2, "rag": 0.0},
    )

    assert got["mastery_vector"] == {"PLC扫描周期": 0.2}
    assert got["weak_concepts"] == ["PLC扫描周期"]
    assert got["unmeasured_concepts"] == ["S7 连接配置"]
    assert got["coverage"]["out_of_domain_concepts"] == ["rag"]
    assert all(
        skill["concept"] in {"PLC扫描周期", "S7 连接配置"}
        for skill in got["blueprint"]["required_skills"]
    )


def test_empty_external_measurement_does_not_create_weak_concepts(readiness_root: Path) -> None:
    write_readiness(readiness_root, "mfg", ["PLC扫描周期"])

    got = personalize_service.learner_blueprint_api(
        learning_goal="PLC扫描周期",
        corpus="mfg",
        concept_mastery={},
    )

    assert got["weak_concepts"] == []
    assert got["unmeasured_concepts"] == ["PLC扫描周期"]
    assert got["blueprint"]["skill_gaps"] == []


def test_same_named_concept_uses_external_domain_metadata(readiness_root: Path) -> None:
    """外域 ID 即使叫 deployment，也不能借走 AI 域的 L4 元数据。"""
    write_readiness(readiness_root, "mfg", ["deployment"])
    profile = LearnerProfile(
        id="same-name",
        name="同名概念测试",
        background="制造工程",
        programming_level=2,
        python_level=0,
        agent_level=0,
        rag_level=0,
        engineering_level=2,
        learning_goal="deployment",
        time_budget_hours=12,
        learning_preference="实操",
        corpus="mfg",
    )

    blueprint = build_personalization_blueprint(
        profile,
        "deployment",
        {"deployment": 0.2},
        "mfg",
    )

    assert [skill.concept for skill in blueprint.required_skills] == ["deployment"]
    assert blueprint.required_skills[0].required_level == "L2"
    assert goal_difficulty("deployment", "mfg") == 2
    assert _resolve_mastery('{"deployment": 0.2, "rag": 0.1}', "mfg") == {
        "deployment": 0.2
    }


def test_both_blueprint_api_allow_corpus_and_measured_mastery() -> None:
    root = Path(__file__).resolve().parents[1]
    for rel in ("backend/integration/personalize_api.py", "app/api/personalize.py"):
        src = (root / rel).read_text(encoding="utf-8")
        block = re.search(r"allowed = \{(.+?)\}", src, re.S)
        assert block, f"{rel} 找不到 allowed 白名单"
        assert '"corpus"' in block.group(1)
        assert '"concept_mastery"' in block.group(1)
