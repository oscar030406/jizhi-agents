# -*- coding: utf-8 -*-
"""给已生产课程注入参考与延伸清单（不重跑 LLM），并同步 web-next 副本。

清单纪律：视频只列白名单官方号与官方在线教具；书籍列登记表条目；仓库列开源原仓。
以后新课的 references 走 build_curriculum 大纲；本脚本用于补丁存量资产。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.schemas.curriculum import Course  # noqa: E402

REFERENCES = {
    "llm_basics": [
        {"kind": "book", "title": "Happy-LLM（Datawhale 开源教材）",
         "note": "本课正文语料底座，GitHub 可读全文", "url": "https://github.com/datawhalechina/happy-llm"},
        {"kind": "book", "title": "《从零构建大模型》Sebastian Raschka",
         "note": "深度骨架参照；官方代码仓开源", "url": "https://github.com/rasbt/LLMs-from-scratch"},
        {"kind": "book", "title": "《图解大模型：生成式AI原理与实战》Jay Alammar 等",
         "note": "图解叙事的黄金参照（人民邮电出版社）", "url": ""},
        {"kind": "video", "title": "3Blue1Brown 官方双语：深度学习之神经网络",
         "note": "神经网络可视化直觉（B 站官方号，93 万播放）", "url": "https://www.bilibili.com/video/BV1bx411M7Zx"},
        {"kind": "video", "title": "跟李沐学AI：GPT / GPT-2 / GPT-3 论文精读",
         "note": "第 3-4 章配套深潜（作者官方号）", "url": "https://www.bilibili.com/video/BV1AF411b7xQ"},
        {"kind": "video", "title": "跟李沐学AI：InstructGPT 论文精读",
         "note": "对齐课（SFT/RLHF）配套（作者官方号）", "url": "https://www.bilibili.com/video/BV1hd4y187CR"},
        {"kind": "video", "title": "跟李沐学AI 官方频道：动手学深度学习完整课程实录",
         "note": "喜欢听课的同学：整门课录播都在官方号里", "url": "https://space.bilibili.com/1567748478"},
        {"kind": "tool", "title": "Transformer Explainer（佐治亚理工 Poloclub）",
         "note": "注意力机制交互教具，第 6 课已内嵌", "url": "https://poloclub.github.io/transformer-explainer/"},
        {"kind": "repo", "title": "《动手学深度学习》d2l-zh",
         "note": "深度学习前置知识的开源教材（中文全文）", "url": "https://github.com/d2l-ai/d2l-zh"},
    ],
    "rag": [
        {"kind": "book", "title": "Hello-Agents 第 8 章：记忆与检索（Datawhale 开源教材）",
         "note": "本课正文语料底座，GitHub 可读全文", "url": "https://github.com/datawhalechina/hello-agents"},
        {"kind": "book", "title": "Happy-LLM 第 7 章：大模型应用（RAG 一节）",
         "note": "开源延伸阅读", "url": "https://github.com/datawhalechina/happy-llm"},
        {"kind": "video", "title": "跟李沐学AI 官方频道",
         "note": "LLM 相关论文精读与课程实录（官方号；RAG 主题视频请认准官方来源）",
         "url": "https://space.bilibili.com/1567748478"},
    ],
}


def main() -> None:
    for concept, refs in REFERENCES.items():
        # 原先还写第二份到 legacy-platform/web-next（以及更早的 ai-service vendored 副本）。
        # 两个 app 都已退役、目录已删，只剩引擎自己这一份真源。
        path = ROOT / "data" / "curriculum" / f"{concept}.json"
        if not path.is_file():
            continue
        data = json.loads(path.read_text(encoding="utf-8"))
        data["references"] = refs
        Course.model_validate(data)  # schema 回验
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"✅ {path}")


if __name__ == "__main__":
    main()
