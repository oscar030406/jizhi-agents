"""接入产物落盘：把切好的节写成知识库现有的 md + front-matter 格式。

## 为什么不发明新格式

`load_markdown_chunks()` 已经在吃 `data/knowledge_base/<name>_docs/*.md`，
front-matter 里读 `source_id / title / topic / difficulty / concept_tags / url`，
然后 `build_knowledge_base.py` 出 `knowledge_index.jsonl`、`build_embedding_index.py` 出索引。
接入 Agent 的产物直接落成这个形状，**下游一行不改**——这是「换知识库即用」能成立的关节。

## 三格怎么填，以及填不满时怎么如实标

- **topic**：抽概念时扫到的节直接用它的概念；没扫到的用**文件所在目录名**兜底。
  抽样是等距的（成本闸），所以必然有大量节没被扫到——兜底值一律带 `_dir` 后缀，
  在报告里单列占比。**不许把兜底值伪装成抽出来的概念。**
- **difficulty**：来源级区间 + 文件内机械特征排序。逐 chunk 让模型标难度实测没通过验收
  （重测 κ=0.292），所以这里不问模型。
- **url**：投进来的目录是本地路径，没有可公开引用的 URL 时留空，不编。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from backend.rag.difficulty import TIERS, extract_features, score

#: 兜底 topic 的后缀。带上它，报告里才分得清「抽出来的概念」和「拿目录名顶上的」。
FALLBACK_SUFFIX = "_dir"

_SLUG = re.compile(r"[^0-9a-zA-Z一-鿿]+")


def slugify(text: str) -> str:
    s = _SLUG.sub("_", text.strip()).strip("_").lower()
    return s or "misc"


@dataclass
class EmitSection:
    """一节待落盘的内容。"""

    source_id: str
    title: str
    topic: str
    concept_tags: list[str]
    content: str
    heading_depth: int
    #: 这个 topic 是抽出来的概念还是目录名兜底的
    topic_from_concept: bool
    difficulty: str = "L2"


def tier_bounds(tier_range: str) -> tuple[int, int]:
    """`"L1-L3"` → (1, 3)。写坏了就退回全域，不抛——接入不该因为一个参数格式挂掉。"""
    m = re.findall(r"L([1-4])", tier_range.upper())
    if not m:
        return 1, len(TIERS)
    lo, hi = min(int(x) for x in m), max(int(x) for x in m)
    return lo, hi


def plan_sections(
    files: list[tuple[str, int, list[tuple[int, str, list[str], str]]]],
    concept_of_section: dict[str, str],
    tier_range: str,
) -> list[EmitSection]:
    """把切好的节配上 topic 与难度。

    `files` 每项是 (相对路径, 路径深度, [(节序, 节标识, 标题路径, 正文)])。
    `concept_of_section` 是抽概念阶段扫到的 节标识 → 概念，没扫到的不在里面。
    """
    lo, hi = tier_bounds(tier_range)
    band = TIERS[lo - 1 : hi]

    planned: list[EmitSection] = []
    for rel, _depth, sections in files:
        # 目录名兜底：`Table/Basic-Concept/xxx.md` → `basic_concept`
        parts = Path(rel).parts
        fallback = slugify(parts[-2] if len(parts) >= 2 else Path(rel).stem) + FALLBACK_SUFFIX

        feats = [extract_features(body, heading_depth=len(path)) for _, _, path, body in sections]
        # 难度在**文件内**排序后切到来源区间里。跨文件比没有意义——
        # 不同文件的绝对难度不可比，这正是分位切档只保证相对难度那条局限。
        tiers = (
            [band[i] for i in _band_index(score(feats), len(band))] if feats else []
        )
        for i, (order, sid, path, body) in enumerate(sections):
            concept = concept_of_section.get(sid)
            topic = slugify(concept) if concept else fallback
            planned.append(
                EmitSection(
                    source_id=f"{slugify(Path(rel).stem)}#{order}",
                    title=(path[-1] if path else Path(rel).stem),
                    topic=topic,
                    concept_tags=[topic],
                    content=body,
                    heading_depth=len(path),
                    topic_from_concept=concept is not None,
                    difficulty=tiers[i] if i < len(tiers) else band[0],
                )
            )
    return planned


def _band_index(scores: list[float], bands: int) -> list[int]:
    """把分数映射到 0..bands-1。只用相对排序，不用绝对阈值。"""
    if not scores or bands <= 1:
        return [0] * len(scores)
    order = sorted(range(len(scores)), key=lambda i: scores[i])
    out = [0] * len(scores)
    for rank, idx in enumerate(order):
        out[idx] = min(bands - 1, rank * bands // max(len(scores), 1))
    return out


def front_matter(sec: EmitSection, url: str = "") -> str:
    """现有 `parse_front_matter()` 认得的形状：`---` 包裹的 `key: value`。"""
    lines = [
        "---",
        f"source_id: {sec.source_id}",
        f'title: "{sec.title}"',
        f"topic: {sec.topic}",
        f"difficulty: {sec.difficulty}",
        f"concept_tags: {', '.join(sec.concept_tags)}",
    ]
    if url:
        lines.append(f"url: {url}")
    lines.append("---")
    return "\n".join(lines)


def emit_report(planned: list[EmitSection]) -> dict:
    """落盘这一步的账。兜底占比必须报——它是「词表覆盖了多少语料」的直接读数。"""
    total = len(planned)
    from_concept = sum(1 for p in planned if p.topic_from_concept)
    return {
        "sections": total,
        "topic_from_concept": from_concept,
        "topic_from_directory": total - from_concept,
        "concept_coverage": round(from_concept / total, 4) if total else 0.0,
        "note": f"带 `{FALLBACK_SUFFIX}` 后缀的 topic 是目录名兜底，不是抽出来的概念。"
        "抽样是等距的（成本闸），所以未被扫到的节必然占多数——"
        "这个占比就是词表对语料的实际覆盖，不是缺陷，但不能当成全覆盖报。",
    }
