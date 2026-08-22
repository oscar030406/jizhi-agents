"""从场景引用的教材 chunk 反推它测的是哪个知识点，落成一份静态映射给前端用。

## 起因

学习端图纸 §十 偏差 8 与账本 F3 记的是同一件事：**四种交互的证据各走各的，没挂到同一
知识点**。查代码，`lib/evidence/from-quiz.ts` 与 `from-tutor.ts` 都把
`measured.concept` 写成**场景标题**。后果是置信度涨不起来——同一个知识点上的测验证据与
导学证据落在两个不同的键上，永远不会合流。对外因此有一条红线：
「别说多形态证据归拢到同一知识点」。

## 为什么不用关键词表

第一反应是拿引擎 `goal_concepts.py` 的 `KEYWORD_CONCEPTS` 把标题映射成概念。
**实测在 212 个真实场景标题上只解析出 18.4%（39 条）**——那张表是用来解析
「我想学 RAG」这类学习目标的，不是场景标题分类器。真实标题长这样：
「课程介绍」「知识检查点」「学习率的影响」「实战建议与常见陷阱」，本来就不含概念词。
硬上会得到一个 18% 概念键 + 82% 标题键的混合键空间，比现在统一用标题**更难推理**。

## 这里用的判据

场景审核账单里每条判词带 `sourceIds`（引用了哪些教材 chunk），
而 `knowledge_index.jsonl` 的每个 chunk 自带 `concept_tags`。
所以「这个场景讲的是哪个知识点」可以从**它实际引用了什么**推出来，不靠标题猜。

实测覆盖 **160/212 = 75.5%** 的场景，是关键词路线的 4 倍。

## 一个场景挂多个知识点怎么办：只取主概念

实测每场景标签数：1 个的 83 例、2 个的 54 例、3 个及以上 23 例。

**不给多个知识点各记一条证据。** 图纸 `predictedCorrect` 的注释里已经写明这个坑
（D-20b）：一道挂 3 个 KC 的四选一答对，若每条证据各涨一次，会把 1.28 的 log-odds
算成 3.84。正确做法要判官逐 KC 出结论，而选择题只有对错、拿不到 per-KC 判定。
所以这里只取**被引用次数最多**的那个概念（并列按名字定序，保证可复算），
其余概念一并落盘供追溯，但不参与归拢。

跑法：
    cd apps/agent-engine
    python scripts/experiments/derive_scene_concepts.py \
        --emit ../classroom/lib/evidence/data/scene-concepts.json

## 已知局限（用的人必须知道）

- **只覆盖已落库的课**。新生成的课不在这份映射里，证据会退回按标题归拢。
  根治要在生成时把概念标签写进场景，那是 schema 改动（与账本 B3 同一类问题：
  生成时知道的信息落库时丢了）。
- 覆盖率受限于「场景有没有审核账单、判词有没有 sourceIds」。全库 2231 条判词里
  1466 条带 sourceIds。
- 概念粒度是知识库的 `concept_tags`（十几个），比场景细粒度粗。归拢单位变粗是**有意的**
  ——归拢不起来才是当前的病。场景级溯源没丢：证据的 `source.resourceId` 仍是 sceneId。
"""

from __future__ import annotations

import argparse
import ast
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"
CLASSROOMS = ROOT.parents[0] / "classroom" / "data" / "classrooms"


def load_chunk_tags() -> dict[str, list[str]]:
    """chunk id → concept_tags。索引里这个字段是 Python 字面量字符串，不是 JSON 数组。"""
    out: dict[str, list[str]] = {}
    for line in INDEX.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        tags = row.get("concept_tags")
        if isinstance(tags, str):
            try:
                tags = ast.literal_eval(tags)
            except (ValueError, SyntaxError):
                tags = []
        out[row["source_id"]] = [str(t) for t in (tags or [])]
    return out


def derive() -> dict:
    tags_of = load_chunk_tags()
    scenes: dict[str, dict] = {}
    total = 0
    multi = Counter()

    for path in sorted(CLASSROOMS.glob("*.json")):
        course = json.loads(path.read_text(encoding="utf-8"))
        for scene in course.get("scenes", []):
            total += 1
            scene_id = scene.get("id")
            if not scene_id:
                continue
            # 按 chunk 计票：一个概念被几个不同的 chunk 支撑，就是它的票数。
            # 不按判词计票——同一个 chunk 被三条判词引用不代表它更重要。
            votes: Counter[str] = Counter()
            cited: set[str] = set()
            for claim in (scene.get("audit") or {}).get("claims") or []:
                for sid in claim.get("sourceIds") or []:
                    if sid in cited:
                        continue
                    cited.add(sid)
                    for tag in tags_of.get(sid, []):
                        votes[tag] += 1
            if not votes:
                continue
            # 并列按名字定序：同一份输入永远得到同一个主概念，可复算
            top = sorted(votes.items(), key=lambda kv: (-kv[1], kv[0]))
            multi[len(votes)] += 1
            scenes[scene_id] = {
                "concept": top[0][0],
                "votes": dict(top),
                "citedChunks": len(cited),
            }

    return {
        "_meta": {
            "generator": "scripts/experiments/derive_scene_concepts.py",
            "judgement": "场景引用的 chunk 的 concept_tags 计票，取票数最高者为主概念；并列按名字定序",
            "scenes_total": total,
            "scenes_resolved": len(scenes),
            "note": (
                "只覆盖已落库课程。新生成的课不在表内，证据会退回按场景标题归拢——"
                "根治要在生成时把概念标签写进场景（schema 改动）。"
                "一个场景挂多个概念时只取主概念，不给每个概念各记一条证据（图纸 D-20b）。"
            ),
        },
        "scenes": scenes,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--emit", type=Path, help="落盘路径（通常是 classroom 的 lib/evidence/data/）")
    args = parser.parse_args()

    payload = derive()
    m = payload["_meta"]
    resolved, total = m["scenes_resolved"], m["scenes_total"]
    print(f"场景 {total} 个，能推出概念的 {resolved} 个 = {100 * resolved / max(total, 1):.1f}%")
    dist = Counter(len(v["votes"]) for v in payload["scenes"].values())
    print(f"每场景概念数分布 {sorted(dist.items())}")
    top = Counter(v["concept"] for v in payload["scenes"].values())
    print(f"主概念分布 {top.most_common()}")

    if args.emit:
        args.emit.parent.mkdir(parents=True, exist_ok=True)
        args.emit.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"落盘 {args.emit}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
