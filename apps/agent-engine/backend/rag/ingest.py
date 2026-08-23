from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, List

from backend.schemas.resources import KnowledgeChunk


def parse_front_matter(text: str) -> tuple[Dict[str, str], str]:
    if not text.startswith("---"):
        return {}, text.strip()
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text.strip()
    metadata_text = parts[1]
    body = parts[2].strip()
    metadata: Dict[str, str] = {}
    for line in metadata_text.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        metadata[key.strip()] = value.strip().strip('"')
    return metadata, body


def _split_tags(value: str) -> List[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


TARGET_CHUNK_CHARS = 900
MAX_CHUNK_CHARS = 1400


def split_into_sections(body: str) -> List[str]:
    """Split a markdown body into retrieval-sized chunks.

    First split on H2/H3 headings so a chunk stays on one subtopic, then merge
    short sections and window overly long ones at paragraph boundaries.
    """
    import re

    heading_parts = re.split(r"\n(?=#{2,3}\s)", body)
    sections: List[str] = []
    buffer = ""
    for part in heading_parts:
        part = part.strip()
        if not part:
            continue
        if len(buffer) + len(part) <= TARGET_CHUNK_CHARS:
            buffer = f"{buffer}\n\n{part}".strip()
            continue
        if buffer:
            sections.append(buffer)
        if len(part) <= MAX_CHUNK_CHARS:
            buffer = part
            continue
        # window long sections at paragraph boundaries
        buffer = ""
        window = ""
        for paragraph in part.split("\n\n"):
            paragraph = paragraph.strip()
            if not paragraph:
                continue
            if window and len(window) + len(paragraph) > MAX_CHUNK_CHARS:
                sections.append(window)
                window = paragraph
            else:
                window = f"{window}\n\n{paragraph}".strip()
        if window:
            buffer = window
    if buffer:
        sections.append(buffer)
    return sections or [body]


def load_markdown_chunks(doc_dir: Path) -> List[KnowledgeChunk]:
    chunks: List[KnowledgeChunk] = []
    for path in sorted(doc_dir.glob("*.md")):
        metadata, body = parse_front_matter(path.read_text(encoding="utf-8"))
        if not body:
            continue
        for index, section_text in enumerate(split_into_sections(body), start=1):
            source_id = metadata.get("source_id", path.stem)
            chunks.append(
                KnowledgeChunk(
                    source_id=f"{source_id}#s{index}",
                    title=metadata.get("title", path.stem),
                    topic=metadata.get("topic", "agent_training"),
                    difficulty=metadata.get("difficulty", "L2"),
                    concept_tags=_split_tags(metadata.get("concept_tags", "")),
                    section=f"section-{index}",
                    url=metadata.get("url") or None,
                    content=section_text,
                )
            )
    return chunks


def is_active_row(row: Dict[str, Any]) -> bool:
    """这一行是不是活块。归档块（T1 标了 `superseded`）一律不算。

    **判据只有这一处**。T1 之后索引里同时躺着活块与归档块，任何一个自己
    `json.loads` 逐行读索引的地方，不过这道闸就会把归档块当素材数进去——
    那不是少个功能，是**读数在说谎**：`corpus_fitness` 的素材量闸 A
    因此虚高约一倍，红黄绿灯直接判错。
    """
    return not row.get("superseded")


def read_index_rows(path: Path, *, include_superseded: bool = False) -> List[Dict[str, Any]]:
    """离线脚本读索引的**唯一入口**。默认只给活块。

    与 `backend.rag.retriever.load_index` 的分工：那一个建 `KnowledgeChunk` 对象、
    供检索用；这一个只给原始 dict，供那些只想数一数、抽个字段的离线脚本用。
    两个口的过滤判据同源（都走 {@link is_active_row}），不许各写一份。

    坏行照 `write_index` 的口径处理：整个抛，不悄悄跳过——跳过的可能正是
    某门课的出处，而「少了一块」在计数类脚本里看不出来。

    `include_superseded=True` 只给按 id 溯源用（要查一条已经被顶替的旧块）。
    """
    rows = [
        json.loads(line)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return rows if include_superseded else [r for r in rows if is_active_row(r)]


def write_index(
    chunks: Iterable[KnowledgeChunk], output_path: Path, *, supersede: bool = True
) -> None:
    """落索引。**整库重建不删旧块**：既有的活块原样留下、打上 `superseded` 沉到文件末尾。

    ## 不这么做会怎样

    重建会让 source_id 重新编号（`{stem}#s{节序}`，节序随切块结果走）。已经出过的课
    正文里挂着 `[docs-plc#s31]`，重建后这个号指向的是别的段落——课看着没变，引文全错位。
    T0 的追加路径靠「既有行一个字节不动」躲开了这件事，重建路径躲不开，只能保留旧块。

    ## 撞号是常态，不是异常

    旧块的 source_id **一个字符都不改**——改了旧课的引用当场断链，那正是这里要防的事。
    所以同一个 source_id 在文件里可以同时有一条活块和一条归档块。消歧规则写死在读取侧
    （`backend.rag.retriever`）：检索只看活块；按 id 精确查是「活块优先、归档兜底」。

    ## 归档层按 source_id 去重，新档盖旧档

    不去重的话每重建一次就把整库复制一份——odoo 3046 块跑十轮就是三万行，
    而且接入链每个 run 会重建**两次**（② 建库、④ 出了词表回填 concept_tags），
    等于每接一次翻一倍。去重之后归档层恒定是「上一代活块」，涨幅封在 2×。

    `supersede=False` 用于同一个 run 内的第二次重建（④ 回填）：那一代块是几分钟前
    ② 刚写的，没出过任何一门课，把它归档只会用它盖掉真正被引用的上一代归档
    （同号新档盖旧档）。所以回填只换活层，归档层原样不动。
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # 索引损坏时宁可让重建整个失败、旧文件原样留着，也不要把解析不了的行悄悄丢掉——
    # 丢掉的可能正是某门课的出处。load_index 本来也会在坏行上抛，不是新增的失败形态。
    rows: List[Dict[str, Any]] = []
    if output_path.exists():
        rows = [
            json.loads(line)
            for line in output_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    archived = [row for row in rows if row.get("superseded")]
    if supersede:
        keep = {row.get("source_id"): row for row in archived}
        for row in rows:
            if row.get("superseded"):
                continue
            row["superseded"] = True  # 只加这一格，其余字段原样，key 顺序也不动
            keep[row.get("source_id")] = row
        archived = list(keep.values())

    lines = [chunk.model_dump_json(ensure_ascii=False) for chunk in chunks]
    lines += [json.dumps(row, ensure_ascii=False) for row in archived]
    # 先写临时文件再原子替换：写到一半断电会把索引截断，而归档层没有第二份副本。
    tmp = output_path.parent / (output_path.name + ".writing")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tmp.replace(output_path)

