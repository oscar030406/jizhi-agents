r"""把《动手学深度学习》（d2l-zh，Apache-2.0）卷积神经网络一章策展入库——
第二领域迁移实验（v4 §2.6）的知识库切片。

为什么是它：迁移证据需要许可干净、可进提交包的第二领域语料；d2l-zh 是 Apache-2.0
开源中文教材（PLAYBOOK 早已标注"DL 课的底座，未入库"），CNN 一章自成体系。
CV-main（无许可，仅本地）不用于对外交付。

方法：CNN 章六节 md → 清洗 d2l 指令标记/图片行 → 带 front-matter 的 md
（source_id 前缀 dl），与 hello-agents 同款切块管线。
用法：python scripts\ingest_d2l.py  然后  python scripts\build_knowledge_base.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

REPO = ROOT.parent.parent / "references" / "d2l-zh-main"
CHAPTER = REPO / "chapter_convolutional-neural-networks"
OUTPUT_DIR = ROOT / "data" / "knowledge_base" / "d2l_docs"
REPO_URL = "https://github.com/d2l-ai/d2l-zh/blob/master/chapter_convolutional-neural-networks"
LICENSE_NOTE = "Apache-2.0；作者 d2l-ai《动手学深度学习》；使用需保留署名"

# 人工策展：(节号, 文件名, 标题)。概念统一 deep_learning，难度随节递进。
CURATED = [
    (1, "index.md", "卷积神经网络·导言", "L2"),
    (2, "conv-layer.md", "图像卷积", "L2"),
    (3, "padding-and-strides.md", "填充和步幅", "L2"),
    (4, "channels.md", "多输入多输出通道", "L3"),
    (5, "pooling.md", "汇聚层（池化）", "L2"),
    (6, "lenet.md", "LeNet 卷积网络", "L3"),
]

# d2l 专用标记与图片行：正文中剔除（:label:/:numref:/:begin_tab: 等）
DIRECTIVE_LINE = re.compile(r"^:(label|eqlabel|begin_tab|end_tab|width|height):.*$", re.MULTILINE)
INLINE_REF = re.compile(r":(numref|ref|eqref|cite|citet):`[^`]*`")
IMAGE_LINE = re.compile(r"^!\[[^\]]*\]\([^)]*\)\s*$", re.MULTILINE)


def clean(text: str) -> str:
    text = DIRECTIVE_LINE.sub("", text)
    text = IMAGE_LINE.sub("", text)
    text = INLINE_REF.sub("前文", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def main() -> None:
    if not CHAPTER.is_dir():
        raise SystemExit(f"语料不存在：{CHAPTER}")
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    written = 0
    for sec, filename, title, difficulty in CURATED:
        src = CHAPTER / filename
        body = clean(src.read_text(encoding="utf-8"))
        source_id = f"dl01s{sec:02d}"
        front = "\n".join([
            "---",
            f"source_id: {source_id}",
            f"title: 动手学深度学习 第6章 6.{sec} {title}",
            "topic: deep_learning",
            f"difficulty: {difficulty}",
            "concept_tags: deep_learning",
            f"url: {REPO_URL}/{filename}",
            f"license: {LICENSE_NOTE}",
            "grade: B",
            "---",
            "",
        ])
        (OUTPUT_DIR / f"{source_id}.md").write_text(front + body + "\n", encoding="utf-8")
        written += 1
        print(f"  + {source_id} {title}（{len(body)} 字）")
    print(f"✅ {written} 节 → {OUTPUT_DIR}，下一步：python scripts\\build_knowledge_base.py")


if __name__ == "__main__":
    main()
