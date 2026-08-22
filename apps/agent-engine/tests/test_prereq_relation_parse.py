"""relation 归一化的回归用例。

钉的是一个真事故：提示词没写 relation 的合法取值，模型答
`"llm_basics is a prerequisite of rag"`，上游按 `not in {...}` 整条丢成 None，
调用侧记成「调用失败」。12 条生产在用的边做自检，9 条被这样吃掉，认同率 0/12。
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from build_prereq_graph import normalize_relation  # noqa: E402


def test_enum_passthrough():
    for value in ("a_before_b", "b_before_a", "none", "unclear"):
        assert normalize_relation(value, "x", "y") == value


def test_prose_with_concept_names():
    # 实测抓到的那一条
    assert normalize_relation(
        "llm_basics is a prerequisite of rag", "llm_basics", "rag"
    ) == "a_before_b"
    assert normalize_relation(
        "rag is a prerequisite of llm_basics", "llm_basics", "rag"
    ) == "b_before_a"


def test_prose_chinese():
    assert normalize_relation("批次追踪 是 序列号管理 的前置", "序列号管理", "批次追踪") == "b_before_a"
    assert normalize_relation("A 是 B 的前置", "库存调整", "补货规则") == "a_before_b"


def test_none_and_unclear():
    assert normalize_relation("none", "a", "b") == "none"
    assert normalize_relation("两者无关", "a", "b") == "none"
    assert normalize_relation("no relation between them", "a", "b") == "none"
    assert normalize_relation("unclear", "a", "b") == "unclear"
    assert normalize_relation("证据不足，无法判断", "a", "b") == "unclear"


def test_unparseable_returns_none():
    # 归不了就是归不了，不许猜——猜错的边会影响所有走这条路径的学习者
    assert normalize_relation("", "a", "b") is None
    assert normalize_relation("maybe?", "a", "b") is None
    # 方向说不清（两边都提到同一个概念）也不许猜
    assert normalize_relation("rag prerequisite rag", "rag", "rag") is None
