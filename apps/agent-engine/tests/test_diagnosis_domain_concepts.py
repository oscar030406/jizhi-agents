"""学情诊断的概念集按域取（#6 跨域污染）。

实锤：新号在智能制造域生成的 ROS2 课，第 7 页「补漏：四个薄弱概念简释」
讲的是智能体 / RAG / 工具调用 / 语言图——`CONCEPT_FLOORS` 是 AI 域硬编码表，
被所有域共用。

这里测的是**产品代码本身**：只把金标根目录指到 tmp，函数逻辑一行不替。
（第一版在 monkeypatch 里重实现了一遍 `concept_floors_for`，那等于测自己的副本——
测试通过也证明不了产品对。）
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.agents import learner_diagnosis_agent as agent


@pytest.fixture()
def gold_root(tmp_path, monkeypatch) -> Path:
    """把金标根目录指到 tmp，按真实结构造：一文件一主题，主题里带成分。"""
    root = tmp_path / "kc_gold_derived"
    root.mkdir(parents=True)
    monkeypatch.setattr(agent, "GOLD_ROOT", root)
    return root


def make_corpus(root: Path, corpus: str, topics: dict[str, list[str]]) -> None:
    d = root / corpus
    d.mkdir(parents=True)
    (d / "_freeze.json").write_text(
        json.dumps({"corpus": corpus, "topics": len(topics)}), encoding="utf-8"
    )
    for topic, components in topics.items():
        # 主题名可能带 /（投目录树时金标拿路径当名字），文件名要换掉
        (d / f"{topic.replace(chr(47), chr(45))}.json").write_text(
            json.dumps(
                {"topic": topic, "knowledge_components": [{"id": c, "name": c} for c in components]},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )


def test_主域用手工调过的概念表(gold_root: Path) -> None:
    assert agent.concept_floors_for("ai") == agent.CONCEPT_FLOORS
    assert "rag" in agent.concept_floors_for("ai")


def test_跟随培训领域时按主域处理(gold_root: Path) -> None:
    assert agent.concept_floors_for(None) == agent.CONCEPT_FLOORS
    assert agent.concept_floors_for("") == agent.CONCEPT_FLOORS


def test_非主域取金标的主题层不取成分层(gold_root: Path) -> None:
    """成分层实测 370 个（`1-Nav2规划器` 这种），学习者 mastery 里一个都没有——
    `get(c, 0.0)` 全返回 0、全部判弱；而且「你有 370 个薄弱概念」等于没说。

    主题层与 ai 域那 7 个粒度可比，也才是人读得懂的诊断结论。
    """
    make_corpus(
        gold_root,
        "mfg",
        {
            "mfg-01-PLC基础": ["扫描周期", "梯形图", "定时器"],
            "mfg-02-机器人操作": ["坐标系", "示教", "碰撞检测"],
        },
    )
    floors = agent.concept_floors_for("mfg")
    assert set(floors) == {"mfg-01-PLC基础", "mfg-02-机器人操作"}
    assert all(v == agent.DEFAULT_CONCEPT_FLOOR for v in floors.values())
    # 成分名不许出现在诊断概念集里
    assert "扫描周期" not in floors and "梯形图" not in floors


def test_没有金标的域返回空表绝不跨域借(gold_root: Path) -> None:
    """诚实无先验：宁可不补，也不要拿 AI 概念补制造课。"""
    assert agent.concept_floors_for("从没建过的库") == {}


def test_坏掉的金标文件跳过而不是整域作废(gold_root: Path) -> None:
    make_corpus(gold_root, "mfg", {"mfg-01-好的": ["a", "b"]})
    (gold_root / "mfg" / "mfg-02-坏的.json").write_text("{ 这不是 json", encoding="utf-8")
    assert set(agent.concept_floors_for("mfg")) == {"mfg-01-好的"}


def test_空概念表时不许凑数() -> None:
    """原代码有 `if not weak_concepts: 挑两个最弱的`——表是空的时候
    凑出来的必然是 mastery 里那几个 AI 概念，正是跨域污染的来源。"""
    src = Path(agent.__file__).read_text(encoding="utf-8")
    assert "if not weak_concepts and floors:" in src, "凑数那行必须带 floors 守卫"


# ── corpus 得真的传到诊断（#6 的另一半）────────────────────────

def test_corpus_从api一路传到诊断(gold_root, monkeypatch) -> None:
    """第一版修复只改了 `concept_floors_for(getattr(profile, "corpus", None))`——
    而 LearnerProfile 根本没有 corpus 字段，getattr 永远 None，永远走主域分支。

    链路上三处都要有：API 入参白名单、服务函数签名、schema 字段。
    任何一处漏掉分流都不生效，**而且不报错**——getattr 静默兜底成主域。
    """
    from backend.integration.personalize_service import learner_blueprint_api

    make_corpus(gold_root, "mfg", {"mfg-01-PLC基础": ["扫描周期", "梯形图"]})

    got = learner_blueprint_api(learning_goal="入门", corpus="mfg")
    weak = (got.get("diagnosis") or {}).get("weak_concepts") or got.get("weak_concepts") or []
    assert weak == ["mfg-01-PLC基础"], f"非主域应当只拿自己的主题：{weak}"
    assert "rag" not in weak and "agent_basics" not in weak


def test_不传corpus时仍是主域(gold_root) -> None:
    from backend.integration.personalize_service import learner_blueprint_api

    got = learner_blueprint_api(learning_goal="入门")
    weak = (got.get("diagnosis") or {}).get("weak_concepts") or got.get("weak_concepts") or []
    assert "agent_basics" in weak


def test_两处api白名单都放行corpus() -> None:
    """blueprint 的入参白名单在仓库里有**两份**：

      - `backend/integration/personalize_api.py`（vendored 那套）
      - `app/api/personalize.py`（**生产入口 app.main:app 走的这份**）

    实锤：第一次只改了 backend 那份，本地直调服务函数完全正常，
    线上 curl 仍然返回 AI 概念全家桶——生产走的是另一份。

    判据分散在两处就会长歪，这条钉住它们一致。
    """
    import re
    from pathlib import Path as _P

    roots = _P(__file__).resolve().parents[1]
    for rel in ("backend/integration/personalize_api.py", "app/api/personalize.py"):
        src = (roots / rel).read_text(encoding="utf-8")
        # 只看 blueprint 那个 allowed 集合，别被别处的 corpus 字样蒙混过关
        block = re.search(r"allowed = \{(.+?)\}", src, re.S)
        assert block, f"{rel} 找不到 allowed 白名单"
        assert '"corpus"' in block.group(1), f"{rel} 的 blueprint 白名单漏了 corpus"


def test_主题名取末两段不摊目录结构(gold_root) -> None:
    """投目录树时金标拿目录路径当主题名（「智能制造/d2l-ros2/docs/foxy/chapt1」）。

    原样写进学情报告等于把目录结构摊给学习者看；
    只取末段又会丢上下文——线上实测末段是「advance」「basic」「bt」这种，
    「你在 bt 上比较弱」和没说一样。取末两段。
    """
    make_corpus(
        gold_root,
        "mfg",
        {
            "深层/路径/chapt1": ["a", "b"],
            "另一条/chapt2": ["c", "d"],
        },
    )
    assert set(agent.concept_floors_for("mfg")) == {"路径/chapt1", "另一条/chapt2"}


def test_没有实质成分的父目录不算主题(gold_root) -> None:
    """投目录树时每层目录都会建一条金标，父目录那几条是路径中间节点不是主题。"""
    make_corpus(
        gold_root,
        "mfg",
        {
            "根目录": [],           # 父目录：零成分
            "中间层": ["只有一个"],   # 也不够
            "真主题": ["a", "b", "c"],
        },
    )
    assert set(agent.concept_floors_for("mfg")) == {"真主题"}
