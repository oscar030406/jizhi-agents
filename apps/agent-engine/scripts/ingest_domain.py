r"""知识库接入 Agent：扔一个目录进去，跑完交回一份就绪度报告。

    python scripts/ingest_domain.py --dir <路径> --name <域名> --scope "要培养什么人"
    python scripts/ingest_domain.py --dir <路径> --name <域名> --dry   # 只分诊不调 API

## 它替掉的是什么

现在换一个知识库要人去写一个 `ingest_*.py`：在里面手写 `CURATED` 常量（收哪些文件、
跳哪些）、手写每章的 `difficulty`、手写 `topic` 归类。那份脚本的存在本身就是
「领域泛化」证据被污染的原因——我们证明的是「能给新域写脚本」，不是「系统能吸收新域」。

**这个脚本不该被改。** 换一个新领域时，命令行参数变，脚本不变。改了它就说明这条路没走通。

## 链条

    分诊 → 切块（带标题路径）→ 许可 → 概念词表 → 前置图 → 难度 → 落盘 → 就绪度报告

前四步的实现分别在 `backend/rag/intake.py`（分诊/结构/许可）与 `backend/rag/concepts.py`
（词表）；前置图直接复用 `build_prereq_graph.py` 的成对分类器，同一套判据、同一道
证据子串闸，不新造第二份口径。

## 三条边界，写在这里免得被误读成缺陷

1. **只吃 md / txt**。其余格式进「未接入文件」清单退回。可控失败优于静默出乱码——
   退回清单是产品特性。格式分诊永远做不完，假装通吃更容易被打穿。
2. **难度只给来源级区间 + 来源内排序**。实测过让模型逐 chunk 标档：重测 κ=0.292、
   与机械特征收敛效度 0.282，两条路都没通过验收（数据见
   `data/eval/chunk_difficulty_labels.json`，结论写在 `backend/rag/difficulty.py` 模块头）。
   所以这一格保留一个人工输入：`--tier-range`。**这不是没做，是测过做不出来。**
3. **前置边一律未复核**。§7.6 只允许人工签字的边当硬前置，本脚本产出的边只作软前置。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from backend.rag.concepts import (  # noqa: E402
    EXTRACT_SYSTEM,
    MERGE_SYSTEM,
    extract_from_sections,
    merge_candidates,
    prune,
    to_vocabulary,
    vocabulary_report,
)
from backend.rag.difficulty import TIERS  # noqa: E402
from backend.rag.intake import (  # noqa: E402
    apply_exclusions,
    detect_license,
    outline_sections,
    parse_exclusions,
    read_body,
    remembered_exclusions,
    triage,
)
from backend.rag import structure_edges as se  # noqa: E402
from backend.services.llm_gateway import LLMGateway  # noqa: E402

AGENT_CONCEPT = "ConceptExtractor"


def _has_cjk(text: str) -> bool:
    """含中文才算有信息量的标题。纯英文文件名当标题是转换语料的常态。"""
    return any("\u4e00" <= ch <= "\u9fff" for ch in text)


def concept_evidence(v: dict) -> str:
    """喂给前置分类器的证据块。

    小节标题只在**含中文**时才留：转换来的语料（`.po` → md）标题常退化成英文
    文件名（adjustments / type），喂进去等于没喂。标题不可用时，正文证据句
    就是唯一的范围信号，**给足别省**。

    ⚠️ 2026-08-12 更正：本函数的注释一度把「Odoo 153 对、IoTDB 66 对全判 none」
    当成证据太薄的实测代价。**那个 0 的真正原因是解析 bug**（见
    `build_prereq_graph.normalize_relation` 的说明），修完同一份语料出 6 条节级边、
    0 次调用失败。加厚证据这件事本身没做错，但它当时并没有解决那个 0。
    """
    titles = [t for t in (s.split(" ", 1)[-1] for s in v["sections"]) if _has_cjk(t)][:12]
    lines = [f"概念：{v['concept']}（语料中 {v['support']} 节提及）"]
    if titles:
        lines.append("覆盖的教材小节：" + "；".join(titles))
    lines += [f"· {e}" for e in dict.fromkeys(v["evidence"])]
    return "\n".join(lines)
KB = ROOT / "data" / "knowledge_base"


#: 概念在书里的位置。`sections` 里的路径带序号（教材形态才有），取里面的数字当排序键。
_POS_NUM = re.compile(r"(\d+)")


def concept_positions(vocab: list[dict]) -> dict[str, tuple]:
    """每个概念在书里排第几。只对**教材形态**语料有意义（见 `detect_form`）。

    取的是**首次出现**那一篇的序号。已知偏置：概述章会把所有概念都提一遍，
    于是什么都显得很早。2026-08-23 在 rag-adv / vecdb 上比过首次/中位/末次
    三种取法，一致率 55%/56%/40% 与 50%/100%/100%——**16 条边选不出口径**，
    所以这里先用最简单的一种，并把判据一起记进边上让它可评估，不拍板。
    """
    pos: dict[str, tuple] = {}
    for v in vocab:
        keys = [
            tuple(int(x) for x in _POS_NUM.findall(s.split("#")[0])) or (999,)
            for s in (v.get("sections") or [])
        ]
        if keys:
            pos[v["concept"]] = min(keys)
    return pos


def build_prereq(
    gateway, names: list[str], evidence: dict[str, str], positions: dict[str, tuple] | None = None
) -> tuple[dict, dict]:
    """复用造图脚本的成对分类器，不复制判据。

    `positions` 给了就在每条边上记一格 `order_agrees`：这条边的方向跟
    作者写下的章节顺序合不合。**只记不判**——与 `link_intent` 的 `intents`
    同一个做法，理由也一样：要不要按它过滤，得等一批人工标注。

    实测先给个底：rag-adv 11 条边里 5 条违反章节序，vecdb 5 条里 2 条违反。
    **违反的占四五成**，所以「章节序当默认、LLM 只复核违反的边」这条杠杆
    在我们的语料上省不下多少调用——一半的边都要复核。这个数记在这里，
    免得下一个人照着文献里的假设直接实现。
    """
    import itertools

    from build_prereq_graph import break_cycles, classify_pair, transitive_reduction

    edges: dict[str, list[tuple[str, float, str]]] = defaultdict(list)
    audit: list[dict] = []
    pairs = list(itertools.combinations(names, 2))
    for i, (a, b) in enumerate(pairs, 1):
        got = classify_pair(gateway, a, b, evidence[a], evidence[b])
        if got is None:
            audit.append({"pair": [a, b], "relation": "error"})
            continue
        audit.append({"pair": [a, b], **got})
        if got["relation"] == "a_before_b":
            edges[a].append((b, got["confidence"], got["because"]))
        elif got["relation"] == "b_before_a":
            edges[b].append((a, got["confidence"], got["because"]))
        if i % 20 == 0:
            print(f"  前置判定 {i}/{len(pairs)}", flush=True)

    cycles = break_cycles(edges)
    prereqs: dict[str, set[str]] = defaultdict(set)
    meta: dict[tuple[str, str], tuple[float, str]] = {}
    for a, lst in edges.items():
        for b, conf, why in lst:
            prereqs[b].add(a)
            meta[(a, b)] = (conf, why)
    reduced, trans = transitive_reduction({k: set(v) for k, v in prereqs.items()})
    pos = positions or {}

    def _agrees(ps: set, q: str) -> str | None:
        """这条子句的方向跟章节序合不合。位置缺一个就返回 None，不猜。"""
        if q not in pos:
            return None
        marks = {
            "yes" if pos[p] < pos[q] else "no" if pos[p] > pos[q] else "tie"
            for p in ps
            if p in pos
        }
        if not marks:
            return None
        return "no" if "no" in marks else ("tie" if marks == {"tie"} else "yes")

    clauses = {
        q: [
            {
                "all": sorted(ps),
                "confidence": round(min(meta.get((p, q), (0.0, ""))[0] for p in ps), 3),
                "because": next((meta[(p, q)][1] for p in sorted(ps) if (p, q) in meta and meta[(p, q)][1]), ""),
                "reviewed": False,
                # 方向与作者写下的章节顺序合不合。只记不判（同 `intents`）。
                "order_agrees": _agrees(ps, q),
            }
        ]
        for q, ps in reduced.items()
        if ps
    }
    return (
        {"items": names, "clauses": clauses},
        {"pairs": len(pairs), "cycles_removed": cycles, "transitive_removed": trans, "audit": audit},
    )


NAME_SYSTEM = """给你一组同属一个章节的小节标题，用一个**中文名词短语**概括这一章讲的是什么。

要求：
- 4-12 个字，是个能当知识点用的名词短语（「批次与序列号追踪」「补货规则配置」），
  不是句子、不是问句、不带标点
- 用这批标题里真实出现的说法，不要自己造词
- 概括的是整章，不是其中某一篇

只输出 JSON：{"name": str}"""


def name_chapters(gateway, plane: dict) -> dict[str, str]:
    """给每个章一个中文名。O(章数) 次调用，Odoo 33 次。

    为什么必须有这一步：转换语料的目录名是英文（`setup_configuration`、
    `product_tracking`），把这种路径直接当概念名喂给前置分类器，模型看到的是
    一串没有语义的标识符。**实测代价**：30 条结构候选边复核通过 0 条，
    17 条判 none、13 条调用直接失败——与「没有结构信号」的表现一模一样，
    但根因完全不同。命名与判边分开，是因为命名对模型是容易任务、判边是难任务。
    """
    from backend.services.llm_gateway import LLMGateway  # noqa: F401  (类型可读性)

    names: dict[str, str] = {}
    for i, (chapter, slot) in enumerate(sorted(plane.items()), 1):
        titles = [t for t in slot.get("titles", []) if t][:12]
        fallback = slot.get("name") or chapter.split("/")[-1]
        if not titles:
            names[chapter] = fallback
            continue
        user = "小节标题：\n" + "\n".join(f"- {t}" for t in titles)
        parsed = gateway.structured_chat(
            AGENT_CONCEPT, NAME_SYSTEM, user, temperature=0.1, max_tokens=120
        )
        got = str((parsed or {}).get("name", "")).strip()
        names[chapter] = got if 2 <= len(got) <= 20 else fallback
        if i % 10 == 0:
            print(f"  章命名 {i}/{len(plane)}", flush=True)
    return names


def write_corpus_index(
    name: str, sections: list, vocab: list[dict], tier_range: str, supersede: bool = True
) -> tuple[Path, int]:
    """把切好的块写成**可检索的**语料库：`data/knowledge_base/corpora/<name>/knowledge_index.jsonl`。

    ## 这一步以前是缺的，而它才是「领域泛化」的真卡点

    2026-08-13 查出来：`ingest_domain.py` 跑完 odoo / iotdb 之后，
    `knowledge_index.jsonl` 里**一条它们的 chunk 都没有**——接入链产出了就绪度报告
    （词表、前置图、许可），却没把语料放进检索得到的地方。于是「换个领域生成课程」
    这件事根本没有素材可取，前面所有关于前置图粒度的讨论都还没走到那一步。

    检索侧的按域机制本来就有（`retriever.get_corpus_retriever`：读
    `corpora/<name>/knowledge_index.jsonl`，建不起来就返回 None、**绝不回退到默认语料**），
    缺的只是没人往里写。

    ## 字段口径

    - `topic` 取**章级**（叶子父目录 / 作者的章），与前置图的概念面同一层——
      两级粒度是同一棵结构树，检索按节、选点按章。
    - `difficulty` 取来源级区间的下界，**不逐 chunk 标**。逐 chunk 自动标难度实测
      没过验收（重测 κ=0.292、收敛效度 0.282），这一格保留人工输入是实测结论。
    - `concept_tags` 用词表做机械子串匹配，不调模型。

    ## 重建不删旧块

    既有的活块由 `write_index` 原样留下并标 `superseded`——重建会让 source_id 重新
    编号，旧课正文里的 `[docs-plc#s31]` 会集体指向别的段落。判据与撞号处理写在
    `backend.rag.ingest.write_index` 的文档串里。

    `supersede=False` 留给同一个 run 内的第二次重建（④ 出词表后回填 concept_tags）：
    那一代块是几分钟前刚写的，没出过课，归档它只会盖掉真正被引用的上一代。
    """
    out, chunks = _build_chunks(name, sections, vocab, tier_range)
    from backend.rag.ingest import write_index

    write_index(chunks, out, supersede=supersede)
    return out, len(chunks)


def _build_chunks(name: str, sections: list, vocab: list[dict], tier_range: str):
    """切块的唯一口径。整库重建与追加共用——两份实现迟早会在 source_id 上分叉，
    而 source_id 分叉就是旧课引文错位。"""
    from backend.schemas.resources import KnowledgeChunk

    concepts = [v["concept"] for v in vocab]
    tier_floor = tier_range.split("-")[0].strip() or "L2"
    chunks: list[KnowledgeChunk] = []

    def strip_media(text: str) -> str:
        """摘掉图片与链接语法，保留可读文字。

        2026-08-16 实测：GitHub 教学仓库的正文带着仓库相对路径的图片
        （`![vector_embeddings](/images/vector_embeddings.png)`、`![retrieval](./images/4_5_1.webp)`）。
        这些路径只在源仓库里成立，进了我们的语料就是死链——而块正文会随摘录流进讲义。
        实拔证据：`/classroom/sVnMPbeeXn` 页面上 2 个 img 标签全部 404，
        另有 4 处 `![...](...)` 原样当文字印在屏幕上。生成提示词早写过
        「编造的图链只会变成死链糊在正文里」，但它管不住**从语料带进来的**图链。
        alt 文字是有信息的（图讲的是什么），留下；链接不是，摘掉。

        2026-08-17 补第二类：**行内链接 `[文字](地址)` 同病**，而且量级大得多。
        odoo 从 rst 原件重建后，3079 处链接落在 1401/3046 = 46.0% 的块里
        （旧的 .po 语料是 0 处——不是它干净，是 .po 里根本没有链接语法）。
        地址全是仓库内相对路径（`../../sign`、`/applications/...`），出了源仓库就是死链；
        而摘录正文在课堂里走 Streamdown 富渲染（见 `ExcerptBlock.tsx`），
        会渲成真 `<a>`。实证：本轮试跑课 `advanced.json` 已有 11 处
        `[Odoo 电子签名](../../sign)` 落在场景正文与 remark 里。
        体检轮的试跑课不进课程墙所以当下不上屏，**但 odoo 一旦真出课就是 K4 刚清过的那种死链**。
        链接文字本身是有信息的（它是个术语或标题），留下；地址摘掉。
        """
        text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", lambda m: f"（图：{m.group(1)}）" if m.group(1) else "", text)
        # 行内链接只留文字。放在图片之后，因为 `![...]()` 的前缀 `!` 已被上一步吃掉。
        text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
        return re.sub(r"[ \t]{2,}", " ", text)
    for key, text, heading_path in sections:
        rel, _, label = key.partition("#")
        order = label.split(" ", 1)[0] or "1"
        stem = re.sub(r"[^0-9A-Za-z]+", "-", rel.rsplit(".", 1)[0]).strip("-").lower() or "doc"
        title = " / ".join(heading_path) or rel
        chapter = "/".join(rel.replace("\\", "/").split("/")[:-1]) or name
        chunks.append(
            KnowledgeChunk(
                source_id=f"{stem}#s{order}",
                title=title,
                topic=chapter,
                difficulty=tier_floor,
                concept_tags=[c for c in concepts if c and c in text],
                section=f"section-{order}",
                url=None,
                content=strip_media(text),
            )
        )
    out = KB / "corpora" / name / "knowledge_index.jsonl"
    return out, chunks


def append_corpus_index(
    name: str, sections: list, vocab: list[dict], tier_range: str
) -> tuple[Path, int, list[str]]:
    """往**已经建好的**语料库后面追加块，既有的行一个字节都不动。

    ## 为什么必须是「不动既有行」

    已经出过的课在正文里挂着 `[docs-plc#s31]` 这样的出处。整库重建会让
    source_id 重新编号，旧课的出处就指向别的段落——课看起来没变，
    引文全错位。所以追加这条路的第一条铁律是既有行原样保留。

    source_id 是 `{文件名派生的 stem}#s{节序}`：追加**新文件**天然不会撞号。
    真撞上了说明投的是同名文件（改过的版本），那不是追加是修改——
    整库重建那条路负责，这里只把撞号的挑出来退回。

    返回 `(索引路径, 新增块数, 撞号的 source_id)`。
    """
    from backend.rag.ingest import write_index
    from backend.schemas.resources import KnowledgeChunk

    out = KB / "corpora" / name / "knowledge_index.jsonl"
    if not out.exists():
        raise FileNotFoundError(f"语料库「{name}」还没建过，追加无从谈起：{out}")

    # 归档块（T1 标了 superseded 的那些）也算进 existing_ids，**这是有意的**：
    # 归档块的 id 正被旧课引用着，让新文档重新占用同一个号，等于把旧课的出处
    # 悄悄换成另一份内容——比拒绝追加糟得多。
    existing_lines = [ln for ln in out.read_text(encoding="utf-8").splitlines() if ln.strip()]
    existing_ids = set()
    for line in existing_lines:
        try:
            existing_ids.add(json.loads(line)["source_id"])
        except (json.JSONDecodeError, KeyError):
            continue

    _, fresh = _build_chunks(name, sections, vocab, tier_range)
    collided = [c.source_id for c in fresh if c.source_id in existing_ids]
    keep = [c for c in fresh if c.source_id not in existing_ids]

    # 先写临时文件再原子替换：追加到一半断电会把既有库截断，
    # 而既有库正被线上课程引用着。
    tmp = out.with_suffix(".jsonl.appending")
    body = existing_lines + [c.model_dump_json(ensure_ascii=False) for c in keep]
    tmp.write_text("\n".join(body) + "\n", encoding="utf-8")
    tmp.replace(out)
    return out, len(keep), collided


def corpus_source_stems(name: str) -> set[str]:
    """既有库里已经收过哪些文件（按 source_id 的 stem 部分）。

    追加时用来认出「这份文件已经在库里了」。**不依赖任何额外清单**——
    存量六个库都是在追加这条路之前建的，没有 sha256 台账，
    只有索引本身一直都在。

    归档块的 stem 一并算进来：那份文件虽然已经不在活层里（被某次重建移出了语料），
    它的 id 还挂在旧课的出处上。再投一遍同名文件会撞上归档号，与其在 append 那边
    报一堆撞号，不如在这里就认出「这份收过」。
    """
    out = KB / "corpora" / name / "knowledge_index.jsonl"
    if not out.exists():
        return set()
    stems: set[str] = set()
    for line in out.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            sid = json.loads(line)["source_id"]
        except (json.JSONDecodeError, KeyError):
            continue
        stems.add(sid.split("#", 1)[0])
    return stems


def report_fitness(name: str) -> None:
    """落库之后顺手量一遍素材量，把结论直接打在终端上。

    这道闸的全部价值在于**花钱之前**看见。等接完再去手动跑一次，跑的人多半已经
    先跑了体检——odoo 那一轮就是这么白花的。所以它挂在这里，零 API、0.6 秒。

    只跑闸 A。闸 B（抽样打分）要调模型，不能挂进默认路径；而且标定跑下来它
    没预测住接地率，更没有理由默认花这个钱（判据与标定表见 corpus_fitness.py）。
    """
    from corpus_fitness import RED_CHUNKS, refresh

    got = refresh(name)
    if not got:
        return
    mark = {"green": "✓", "yellow": "⚠", "red": "✗"}[got["light"]]
    print(f"素材量       {mark}  {got['gate_a']['chunks']} 个证据块"
          + ("".join(f"\n             {w}" for w in got["why"] + got["notes"])))
    if got["light"] == "red":
        print(f"             低于 {RED_CHUNKS} 块只是提醒，不拦生成——这个库照样能选。")


def chapter_evidence(chapter: str, plane: dict, names: dict[str, str]) -> str:
    """章级证据块：章名 + 篇数 + 成员标题。给复核用，不给判定用。

    小节标题原样给：`because` 的子串校验依赖证据逐字可复现（同 build_prereq_graph）。
    """
    slot = plane.get(chapter, {})
    lines = [f"概念：{names.get(chapter, chapter)}（{len(slot.get('files', []))} 篇文档）"]
    titles = [t for t in slot.get("titles", []) if t]
    if titles:
        lines.append("覆盖的小节：" + "；".join(titles[:12]))
    return "\n".join(lines)


def review_structural_edges(
    gateway, edges: list[dict], plane: dict, names: dict[str, str]
) -> tuple[list[dict], dict]:
    """结构提边、模型复核。

    与成对判定的差别是数量级：判定要跑 O(n²) 对（Odoo 153 对，结果 0 条边），
    复核只跑 O(边) 次（Odoo 30 条）。而且模型这次不需要凭空想两个概念谁先谁后，
    它只需要判断「语料里这条引用关系算不算前置」——有据可依的判断比无据的判定稳。

    复核不通过的边**保留在审计里**并标 `passed: false`，不静默丢弃：
    模型判错过（`批次与序列号追踪` vs `批次追踪` 判 none、conf 0.9），
    它在这里同样可能判错，人工签字时要能看见被它拦下的是什么。
    """
    from build_prereq_graph import classify_pair

    kept: list[dict] = []
    audit: list[dict] = []
    for i, e in enumerate(edges, 1):
        p, t = e["prereq"], e["target"]
        got = classify_pair(
            gateway, names.get(p, p), names.get(t, t),
            chapter_evidence(p, plane, names), chapter_evidence(t, plane, names),
        )
        row = {**e, "prereq_name": names.get(p, p), "target_name": names.get(t, t), "review": got}
        if got is None:
            row["passed"] = False
            row["review_note"] = "复核调用失败"
        else:
            row["passed"] = got.get("relation") == "a_before_b"
            row["review_note"] = got.get("because", "")
        audit.append(row)
        if row["passed"]:
            kept.append({**e, "confidence": (got or {}).get("confidence", 0.0)})
        if i % 10 == 0:
            print(f"  结构边复核 {i}/{len(edges)}", flush=True)
    return kept, {"reviewed": len(edges), "passed": len(kept), "audit": audit}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, type=Path, help="扔进来的目录")
    ap.add_argument("--name", required=True, help="域名，也是落盘目录前缀")
    ap.add_argument("--scope", default="", help="疆域：要培养什么人（写进报告，用于就绪度分母）")
    ap.add_argument(
        "--tier-range",
        default="L1-L3",
        help="这批素材整体的难度区间。实测逐 chunk 自动标难度没通过验收，"
        "这一格保留人工输入——每个来源一句话，不是每章一个常量",
    )
    ap.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="疆域的「范围」：明确**不教**的部分，按相对路径前缀排除，可重复。"
        "这不是人工策展——设计稿里疆域盒子本来就有「范围」这一格，"
        "管理者声明「本域不教 X」与「本域教 Y」同等重要：明说不教的不算就绪度缺口，"
        "没提的才算。排除清单原样进报告，不许静默生效。",
    )
    ap.add_argument("--dry", action="store_true", help="只分诊，不调 API")
    ap.add_argument(
        "--no-structure",
        action="store_true",
        help="关掉结构前置边这一层，强制走节级成对判定。只在对照实验里用——"
        "成对判定在三份陌生语料上实测全 0 条边",
    )
    ap.add_argument(
        "--vocab-only",
        action="store_true",
        help="只到词表为止。前置判定是 O(n²) 次调用（28 个概念 = 378 对），"
        "词表不对的话那笔钱是白花的——先看词表，对了再往下跑",
    )
    ap.add_argument(
        "--structure-only",
        action="store_true",
        help="只跑章级结构边 + 复核就退出。词表与节级判定是这条链上最贵的两步，"
        "而结构边这一层可以独立验收——人工抽检方向正确率不需要等词表",
    )
    ap.add_argument(
        "--index-only",
        action="store_true",
        help="只做分诊→切块→落库就退出，词表复用已有 readiness.json。零 API。"
        "给已经接入过、但落库那一步当时还不存在的域补库用",
    )
    ap.add_argument("--max-sections", type=int, default=120, help="抽概念时最多看几节，控成本")
    args = ap.parse_args()

    root = args.dir.resolve()
    if not root.is_dir():
        print(f"目录不存在：{root}")
        return 1

    print(f"=== 接入 {args.name} ← {root}")
    manifest = triage(root)
    # 疆域的「范围」：明说不教的部分在这里剔除，并单列——它与「格式不支持」是两回事，
    # 混在同一份退回清单里会让人读不出「哪些是我们主动不教的」。
    # 没给 --exclude 就沿用上一次接入声明过的那份。
    # 这是「声明只活在 argv 里」那个坑的补丁：iotdb 第一趟带 --exclude 剔了 12 个文件，
    # 第二趟 --index-only 补建索引时没人再敲一遍，12 个文件 132 块原样回到库里
    # （docs/04-research/iotdb-scoped-out-not-enforced-20260823.md）。
    # 现在剔除声明是**库的属性**，不是某一次命令行的属性。
    exclude = parse_exclusions(args.exclude)
    inherited = False
    if not exclude:
        prior_path = KB / f"{args.name}_intake" / "readiness.json"
        prior_report = (
            json.loads(prior_path.read_text(encoding="utf-8")) if prior_path.is_file() else {}
        )
        exclude = remembered_exclusions(prior_report)
        inherited = bool(exclude)
    manifest.accepted, scoped_out = apply_exclusions(manifest.accepted, exclude)
    if inherited:
        print(f"[范围] 沿用上一次声明的剔除前缀 {len(exclude)} 条："
              + "、".join(exclude[:4]) + ("…" if len(exclude) > 4 else ""))
    lic = detect_license(root)
    print(f"[分诊] 收 {len(manifest.accepted)} 个文件（{manifest.accepted_chars:,} 字符），"
          f"退回 {len(manifest.rejected)} 个"
          + (f"，按疆域范围排除 {len(scoped_out)} 个" if scoped_out else ""))
    for rel, why in manifest.rejected[:8]:
        print(f"  退回 {rel}：{why}")
    if len(manifest.rejected) > 8:
        print(f"  …另有 {len(manifest.rejected) - 8} 个，全量见报告")
    print(f"[许可] {lic.spdx}（{lic.evidence}）")

    sections: list[tuple[str, str]] = []
    for f in manifest.accepted:
        body = read_body(f.path)  # rst 在这里被还原成 markdown 标题层级
        for meta in outline_sections(body, path_depth=f.path_depth):
            label = " / ".join(meta.heading_path) or f.relative
            sections.append((f"{f.relative}#{meta.order} {label}", meta.text, meta.heading_path))
    print(f"[切块] {len(sections)} 节")

    # 结构信号探测：零 LLM 调用，所以放在 --dry 之前——分诊阶段就该知道这份语料
    # 有没有可用的显式引用。有就走「结构提边 + 模型复核」，没有就退回成对判定。
    structure = None if args.no_structure else se.probe(root)
    if structure:
        print(f"[结构] 章级概念面 {structure['chapters']} 个，交叉引用 "
              f"{structure['xrefs_total']} 条（章内 {structure['xrefs_within_chapter']} 条不计），"
              f"结构候选边 {len(structure['edges'])} 条")
        if not structure["usable"]:
            print("  这份语料没有可用的显式交叉引用（扫描版教材、单文件语料常见），"
                  "前置图退回节级成对判定")

    if args.index_only:
        prior = KB / f"{args.name}_intake" / "readiness.json"
        report_prior = json.loads(prior.read_text(encoding="utf-8")) if prior.exists() else {}
        vocab_prior = report_prior.get("concepts", [])
        index_path, n = write_corpus_index(args.name, sections, vocab_prior, args.tier_range)
        print(f"[落库] {n} 个 chunk → {index_path.relative_to(ROOT)}"
              f"（词表复用已有 {len(vocab_prior)} 个概念做 concept_tags）")
        # 回填就绪度报告。不回填的话报告会说「未入库」而库其实建好了——
        # 一个说谎的闸位比没有闸位更坏，管理端读的就是这份报告。
        if report_prior:
            report_prior["corpus_index"] = {
                "path": str(index_path.relative_to(ROOT)).replace("\\", "/"),
                "chunks": n,
                "note": "由 --index-only 补建（词表复用已有报告，零 API）。",
            }
            has_npz = (index_path.parent / "knowledge_embeddings.npz").exists()
            report_prior.setdefault("readiness", {})["gate0_retrievable"] = n > 0
            # 这条路径重建了索引，向量索引就跟旧的对不上了（行数变了即失配）。
            # 同上：不报这一格，缺失时检索会静默回落 TF-IDF。
            report_prior["readiness"]["vector_index_built"] = has_npz
            prior.write_text(json.dumps(report_prior, ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"[回填] {prior.relative_to(ROOT)} 的 corpus_index 与闸零已更新")
            if not has_npz:
                print("向量索引 ✗ 缺 knowledge_embeddings.npz——检索会静默回落 TF-IDF。"
                      f"补建：python scripts/build_embedding_index.py --corpus {args.name}")
        report_fitness(args.name)
        print("\n--index-only：到此为止，未调用任何 API")
        return 0

    if args.dry:
        print("\n--dry：到此为止，未调用任何 API")
        return 0

    gateway = LLMGateway()
    if not gateway.route_for(AGENT_CONCEPT).enabled:
        print("路由未启用，检查 SILICONFLOW_API_KEY")
        return 1

    def ask(system: str, user: str) -> dict | None:
        return gateway.structured_chat(AGENT_CONCEPT, system, user, temperature=0.1, max_tokens=800)

    if args.structure_only:
        if not (structure and structure["usable"]):
            print("\n--structure-only：这份语料没有结构候选边，无从复核")
            return 0
        ch_names = name_chapters(gateway, structure["plane"])
        kept, meta = review_structural_edges(
            gateway, structure["edges"], structure["plane"], ch_names
        )
        out_dir = KB / f"{args.name}_intake"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "prereq_chapter_audit.json").write_text(
            json.dumps({"names": ch_names, "edges": meta["audit"]}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"\n结构候选 {meta['reviewed']} 条 → 复核通过 {meta['passed']} 条")
        for e in kept[:20]:
            print(f"  {ch_names[e['prereq']]} → {ch_names[e['target']]}"
                  f"   ({e['links']} vs {e['back_links']})")
        print(f"落盘 {out_dir / 'prereq_chapter_audit.json'}——人工抽检方向正确率看这一份")
        return 0

    # 抽样必须**铺开**，不能取前 N 节。按文件排序取头部等于只看排在最前的那几个文件——
    # 词表会被偏到语料的一角，而报告上却写着「扫了 120 节」，读起来像覆盖了全库。
    # 等距抽样：跨全部文件均匀取，成本不变、代表性天差地别。
    picked = sections
    if len(sections) > args.max_sections:
        step = len(sections) / args.max_sections
        picked = [sections[int(i * step)] for i in range(args.max_sections)]
        covered = len({sec[0].split("#")[0] for sec in picked})
        print(f"[词表] 等距抽样 {len(picked)}/{len(sections)} 节，覆盖 "
              f"{covered}/{len(manifest.accepted)} 个文件（--max-sections 上限）")
    found = extract_from_sections(picked, ask)
    kept = prune(found)
    merged, merge_log = merge_candidates(kept, ask)
    vocab = to_vocabulary(merged)
    print(f"[词表] 候选 {len(found)} → 支撑够 {len(kept)} → 归并后 {len(merged)}")

    if len(merged) < 2:
        print("\n词表不足 2 个概念，前置图无从谈起。就绪度：闸一红。")
        return 0

    names = [v["concept"] for v in vocab]
    # 证据必须带**小节标题**。`build_prereq_graph.py` 上一版栽过同一个坑：
    # 只给正文片段，模型看到的是碎片、判不出概念的范围，55 对答了 52 个 none。
    # 加上标题后同一批语料出 9 条边。这里一度只传 evidence 句子，等于把那个 bug 引回来
    # （实测 IoTDB：66 对 0 条边，且两条 evidence 常常是同一句重复）。
    evidence = {v["concept"]: concept_evidence(v) for v in vocab}

    # 两级前置图，同一棵结构树：
    #   章级——边来自语料里显式写着的交叉引用，模型只复核；
    #   节级——没有结构信号时才退回 O(n²) 成对判定。
    # 粒度是上一版全判 none 的根因：前置关系存在于章之间，同一章里的节多半是兄弟
    # （先进先出 vs 后进先出是并列选项），不是先后。
    chapter_graph: dict | None = None
    chapter_meta: dict | None = None
    if structure and structure["usable"]:
        ch_names = name_chapters(gateway, structure["plane"])
        kept, chapter_meta = review_structural_edges(
            gateway, structure["edges"], structure["plane"], ch_names
        )
        chapter_graph = {
            "level": "chapter",
            "items": sorted(structure["plane"]),
            "names": ch_names,
            "clauses": {
                e["target"]: [{
                    "all": [e["prereq"]],
                    "confidence": round(e.get("confidence", 0.0), 3),
                    "because": e["because"],
                    "reviewed": False,
                }]
                for e in kept
            },
        }
        print(f"[前置图·章级] 结构候选 {chapter_meta['reviewed']} 条 → 复核通过 "
              f"{chapter_meta['passed']} 条（调用数 = 边数，不是 O(n²) 对）")

    if chapter_graph and chapter_graph["clauses"]:
        # 章级出得来边就不再烧 O(n²) 的节级判定。想做对照跑 --no-structure。
        graph = {"items": names, "clauses": {}}
        graph_meta = {"pairs": 0, "cycles_removed": [], "transitive_removed": [], "audit": [],
                      "skipped": "章级结构边可用，跳过节级 O(n²) 成对判定（--no-structure 可强制）"}
        print(f"[前置图·节级] 跳过（省 {len(names) * (len(names) - 1) // 2} 次调用）")
    else:
        graph, graph_meta = build_prereq(gateway, names, evidence, concept_positions(vocab))
        print(f"[前置图·节级] {len(graph['clauses'])} 个概念有前置，"
              f"去环 {len(graph_meta['cycles_removed'])}，传递约简 {len(graph_meta['transitive_removed'])}")

    # 落库：语料进 corpora/<name>/，这一步之前是缺的（见 write_corpus_index 的说明）
    index_path, chunk_count = write_corpus_index(args.name, sections, vocab, args.tier_range)
    print(f"[落库] {chunk_count} 个 chunk → {index_path.relative_to(ROOT)}")

    out_dir = KB / f"{args.name}_intake"
    out_dir.mkdir(parents=True, exist_ok=True)
    report = {
        "domain": args.name,
        "scope": args.scope,
        "source_dir": str(root),
        "license": {"spdx": lic.spdx, "evidence": lic.evidence, "unknown": lic.unknown},
        "intake": {
            "accepted_files": len(manifest.accepted),
            "accepted_chars": manifest.accepted_chars,
            "rejected": [{"file": r, "reason": w} for r, w in manifest.rejected],
            "scoped_out": {"prefixes": list(exclude), "files": scoped_out},
            "sections": len(sections),
            "sections_scanned_for_concepts": len(picked),
        },
        "vocabulary": vocabulary_report(found, kept, merge_log),
        "concepts": vocab,
        "prereq_graph": graph,
        "prereq_meta": {k: v for k, v in graph_meta.items() if k != "audit"},
        "prereq_graph_chapter": chapter_graph,
        "structure_signals": None if not structure else {
            "chapters": structure["chapters"],
            "xrefs_total": structure["xrefs_total"],
            "xrefs_within_chapter": structure["xrefs_within_chapter"],
            "chapter_pairs": structure["chapter_pairs"],
            "candidate_edges": len(structure["edges"]),
            "reviewed": (chapter_meta or {}).get("reviewed", 0),
            "passed": (chapter_meta or {}).get("passed", 0),
            "note": "边来自语料显式交叉引用的不对称性（RefD 式），模型只复核不判定。"
                    "没有交叉引用的语料这一层为空，退回节级成对判定。",
        },
        "difficulty": {
            "tier_range": args.tier_range,
            "method": "来源级区间（人工一句话）+ 来源内机械特征排序",
            "note": "逐 chunk 自动标难度实测未通过验收（重测 κ=0.292、收敛效度 0.282），"
                    "见 backend/rag/difficulty.py 模块头。这一格保留人工输入是实测结论不是偷懒。",
            "tiers": list(TIERS),
        },
        "corpus_index": {
            "path": str(index_path.relative_to(ROOT)).replace("\\", "/"),
            "chunks": chunk_count,
            "note": "检索侧按域取库（retriever.get_corpus_retriever），建不起来返回 None、"
                    "绝不回退到默认语料。没有这一格，换领域生成课程无素材可取。",
        },
        "readiness": {
            "gate0_retrievable": chunk_count > 0,
            # 闸零只保证「有块可捞」，不保证「向量检索能用」——本脚本不建向量索引，
            # 那一步要另跑 build_embedding_index.py。缺了 npz 时 embedding_retriever
            # 返回 None、调用方**静默回落 TF-IDF**：库看着是好的，检索质量已经换了一条路。
            # 2026-08-16 实测代价：odoo 扩容重建后漏跑这一步，一整轮体检跑在 TF-IDF 上，
            # 差点把「证据池减半」误判成检索稀释。所以这一格必须报，且不许合进闸零。
            "vector_index_built": (index_path.parent / "knowledge_embeddings.npz").exists(),
            "vector_index_note": "缺失时检索静默回落 TF-IDF；补建命令 "
                                 f"python scripts/build_embedding_index.py --corpus {args.name}",
            "gate1_vocabulary": len(merged) >= 2,
            "gate2_graph_connected": len(graph["clauses"]) > 0
            or bool(chapter_graph and chapter_graph["clauses"]),
            "gate3_item_mapping": False,
            "gate3_note": "测项映射未实现——该概念的掌握度置信封顶且禁止跳过（学习者侧已有的降级）",
            "reviewed_edges": 0,
            "note": "全部前置边未经人工确认，只作软前置（§7.6）。"
                    "本报告不构成对前置图质量的效果承诺——外部对照实验未跑。",
        },
    }
    (out_dir / "readiness.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    (out_dir / "prereq_audit.json").write_text(
        json.dumps(graph_meta["audit"], ensure_ascii=False, indent=1), encoding="utf-8"
    )
    if chapter_meta:
        # 人工抽检方向正确率就看这一份：每条边带引用次数、反向次数、复核判词。
        # 被复核拦下的边也在里面（passed: false），不静默丢弃。
        (out_dir / "prereq_chapter_audit.json").write_text(
            json.dumps(chapter_meta["audit"], ensure_ascii=False, indent=1), encoding="utf-8"
        )

    print(f"\n=== 就绪度报告 ===")
    print(f"疆域：{args.scope or '（未声明）'}")
    print(f"闸零 可检索   {'✓' if chunk_count else '✗'}  {chunk_count} 个 chunk 入库")
    if report["readiness"]["vector_index_built"]:
        print("向量索引     ✓  knowledge_embeddings.npz 已在位")
    else:
        print("向量索引     ✗  没有 knowledge_embeddings.npz——检索会静默回落 TF-IDF。"
              f"补建：python scripts/build_embedding_index.py --corpus {args.name}")
    print(f"闸一 词表     {'✓' if report['readiness']['gate1_vocabulary'] else '✗'}  {len(merged)} 个概念")
    if chapter_graph:
        print(f"闸二 前置闭包 {'✓' if report['readiness']['gate2_graph_connected'] else '✗'}  "
              f"章级 {len(chapter_graph['clauses'])}/{len(chapter_graph['items'])} 个章有前置"
              f"（结构候选 {chapter_meta['reviewed']} → 复核过 {chapter_meta['passed']}）")
    else:
        print(f"闸二 前置闭包 {'✓' if report['readiness']['gate2_graph_connected'] else '✗'}  "
              f"节级 {len(graph['clauses'])}/{len(names)} 个概念有前置")
    print(f"闸三 教得动   ✗  测项映射未实现（相关概念置信封顶、禁跳过）")
    report_fitness(args.name)
    print(f"许可         {lic.spdx}{'  ⚠ 待人工确认' if lic.unknown else ''}")
    print(f"退回文件      {len(manifest.rejected)} 个")
    print(f"落盘 {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
