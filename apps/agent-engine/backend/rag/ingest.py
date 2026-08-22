from __future__ import annotations

from pathlib import Path
from typing import Dict, Iterable, List

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


def write_index(chunks: Iterable[KnowledgeChunk], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [chunk.model_dump_json(ensure_ascii=False) for chunk in chunks]
    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

