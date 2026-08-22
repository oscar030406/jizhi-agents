"""岗位技能清单数据契约：#4 画像目标维度与覆盖率双口径共同依赖此文件。"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VOCAB = {"llm_basics", "agent_basics", "rag", "langgraph", "tool_calling",
         "context_engineering", "evaluation", "deployment", "guardrails"}


def _load():
    return json.loads((ROOT / "data" / "jobs" / "job_skill_map.json").read_text(encoding="utf-8"))


def test_job_skill_map_schema():
    data = _load()
    jobs = data["jobs"]
    assert len(jobs) >= 10
    seen = set()
    for j in jobs:
        assert j["job_id"] not in seen
        seen.add(j["job_id"])
        assert j["title"] and j["summary"]
        assert set(j["core_concepts"]) <= VOCAB, (j["job_id"], set(j["core_concepts"]) - VOCAB)
        assert len(j["skills"]) >= 5, j["job_id"]
        assert j["evidence"], j["job_id"]


def test_provenance_present():
    data = _load()
    assert "不爬" in data["_provenance"]["method"]  # 合规口径入档
