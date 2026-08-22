"""接入产物落盘：front-matter 形状、兜底 topic 的可辨识、难度只在文件内排序。

最关键的一条是**兜底不许伪装成抽取**：抽样是等距的，绝大多数节没被扫到，
topic 只能拿目录名顶上。这个占比就是词表对语料的真实覆盖，报告里必须分得开——
把兜底值混进「抽出来的概念」，就等于把 5% 的覆盖报成 100%。
"""

from backend.rag.emit import (
    FALLBACK_SUFFIX,
    EmitSection,
    emit_report,
    front_matter,
    plan_sections,
    slugify,
    tier_bounds,
)
from backend.rag.ingest import parse_front_matter

FORMULA = "$x = \\frac{a}{b}$ 推导如下。" * 40
PROSE = "时序数据建模的基本概念。" * 40


def _file(rel="Table/Basic-Concept/intro.md"):
    return (
        rel,
        3,
        [
            (1, "s1", ["入门", "建模"], PROSE),
            (2, "s2", ["入门", "推导"], FORMULA),
        ],
    )


def test_tier_bounds_parses_and_degrades():
    assert tier_bounds("L1-L3") == (1, 3)
    assert tier_bounds("L2") == (2, 2)
    # 参数写坏了退回全域，不抛——接入不该因为一个格式挂掉
    assert tier_bounds("随便写的") == (1, 4)


def test_fallback_topic_is_distinguishable():
    planned = plan_sections([_file()], {"s1": "时序数据模型"}, "L1-L3")
    assert planned[0].topic == "时序数据模型" and planned[0].topic_from_concept
    assert planned[1].topic.endswith(FALLBACK_SUFFIX) and not planned[1].topic_from_concept


def test_report_separates_concept_from_fallback():
    planned = plan_sections([_file()], {"s1": "时序数据模型"}, "L1-L3")
    rep = emit_report(planned)
    assert rep["topic_from_concept"] == 1
    assert rep["topic_from_directory"] == 1
    assert rep["concept_coverage"] == 0.5


def test_difficulty_stays_inside_the_declared_range():
    planned = plan_sections([_file()], {}, "L2-L3")
    assert {p.difficulty for p in planned} <= {"L2", "L3"}


def test_difficulty_is_ranked_within_the_file():
    """公式密的那节要排在散文那节之上——只用相对排序，不用绝对阈值。"""
    planned = plan_sections([_file()], {}, "L1-L4")
    prose, formula = planned[0], planned[1]
    assert formula.difficulty >= prose.difficulty


def test_front_matter_round_trips_through_the_existing_parser():
    """产物必须能被现有的 `parse_front_matter` 吃下——不发明新格式的验收点。"""
    sec = EmitSection(
        source_id="intro#1",
        title="建模",
        topic="时序数据模型",
        concept_tags=["时序数据模型"],
        content=PROSE,
        heading_depth=2,
        topic_from_concept=True,
        difficulty="L2",
    )
    doc = front_matter(sec) + "\n\n" + sec.content
    meta, body = parse_front_matter(doc)
    assert meta["source_id"] == "intro#1"
    assert meta["topic"] == "时序数据模型"
    assert meta["difficulty"] == "L2"
    assert meta["title"] == "建模"
    assert body.startswith("时序数据建模")


def test_slugify_keeps_chinese_and_kills_punctuation():
    assert slugify("Basic-Concept") == "basic_concept"
    assert slugify("时序数据 / 模型") == "时序数据_模型"
    assert slugify("!!!") == "misc"


def test_empty_input_does_not_explode():
    assert plan_sections([], {}, "L1-L3") == []
    assert emit_report([])["sections"] == 0
