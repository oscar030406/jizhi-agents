r"""从语料造概念前置图，产出 `selection.ts` 直接吃的 `PrereqGraph`。

## 这张图卡着谁

`apps/classroom/lib/generation/selection.ts` 的消费侧全建好了、44 测绿，但它自己的注释写着
「**本轮不实现图的构造**：图由管理者那条路一次性造出来」。没有这张图，选点退化成按教材
章节顺序排——书序当前置判据的精确率约 43%（Vuong, Nixon & Towle, EDM 2011，已逐条核实）。
所以这不是锦上添花，是学习者侧唯一的硬依赖。

## 词表从哪来：语料自己有

不让模型开集发明概念——开集生成只有 35–56% 匹配，闭集验证 86–88% F1（arXiv:2409.08406），
差一倍以上。这里的词表直接取**语料 chunk 上已有的 topic**：AI 域 11 个、具身域 7 个。
它们是入库时按教材章节归的类，粒度锚定教材（设计稿 §4.3），不是现编的。

顺带记两个由此暴露的缺口：`prompt_engineering` 在语料里有 32 个 chunk 却不在
`concept_graph.json` 里；具身域 7 个概念一个都没进过 concept_graph。

## 判法：成对分类，不是生成式召回

设计稿 §7.2 明写的坑：不能用生成式召回 + 嵌入相似度（arXiv:2507.18479 报 BERTScore 0.83
好看，但测的是语义相近，不是前置关系对不对，不可对质）。这里逐对问
「A 是不是 B 的前置」，三选一 + 置信度 + **依据必须是所给证据的精确子串**（压幻觉边的机械闸）。
摘不出引文时保留关系、清空 because 并留痕——「引文没摘对」和「关系判错」是两件事，
一版把它们混成一件、整条降级，等于因为前者丢掉后者。无依据边占比单独可算，
那就是这张表的幻觉率，与资源侧同一把尺子。

规模小到不需要候选剪枝：域内 C(11,2)+C(7,2) = 76 对，全量判得起。

**一版的教训写在这里**：提示词里那句「拿不准就答 none」加上三条排除，把模型压得
55 对里答了 52 个 none，只留 3 条边——比人工策展的 13 条少一个数量级。
判据改成一句可操作的话（「没接触过 A 的人直接学 B 会不会卡住」），证据改成给全标题，
才是这一版。**造完必须与人工策展的 concept_graph 对照**，不对照就不知道自己在哪一侧翻车。

## clause 分组（AND/OR）

设计稿 §4.2 要求区分「必须全满足」与「满足其中一组即可」——按 AND 处理会凭空多算一整段
前置链，学习者体感是「我明明会 Python，它非要我先学 TS」。成对判定只能给出边，
所以有第二遍：对前置 ≥2 个的概念，单独问一次哪些是互为替代的。

## 置信度怎么用（不在本脚本，在消费侧）

§7.6：只有**人工确认过**的边才能升为硬前置。本脚本产出的边一律标 `reviewed: false`，
消费侧据此只当软前置——排序靠后、规格的理由里写「建议先学 A」，但不拦人。
`θ_hard` 没有可搬的文献值，标未验证。

## 跑法

    python scripts/build_prereq_graph.py --dry          # 只打印词表与候选对，不调 API
    python scripts/build_prereq_graph.py                # 全量
    python scripts/build_prereq_graph.py --domain ai    # 只跑一个域
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.llm_gateway import LLMGateway  # noqa: E402

AGENT = "PrereqEdgeClassifier"
INDEX = ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"
OUTPUT = ROOT / "data" / "knowledge_base" / "prereq_graph.json"

#: 域的划分依据是 source_id 前缀，与库内既有口径一致（em* 是具身域，其余是 AI 域）。
EMBODIED_PREFIX = "em"

#: 每个概念给模型看几段证据。多了贵，少了判不准；取标题 + 正文开头。
EVIDENCE_PER_CONCEPT = 2
#: 标题全给，但设个上限防止 deployment 这种 178 chunk 的概念把提示词撑爆。
TITLE_CAP = 25
EVIDENCE_CHARS = 300

EDGE_SYSTEM = """你在判断两个技术概念之间的**前置关系**，用于个性化学习系统的选点。

判据只有一句话，照它执行：
**一个完全没接触过 A 的人，直接去学 B 的材料，会不会卡在看不懂 A 的术语或前提上？**
会卡 → A 是 B 的前置。不会卡 → 不是。

三类容易误判的，逐条对照：
- **算前置**：A 的术语/结论在 B 的材料里被当作已知直接使用（讲 RAG 时直接用「向量检索」「嵌入」不再解释）
- **不算**：两者共用一批术语、经常一起出现，但各自能独立读懂
- **不算**：B 用到了 A 的产物，但用的时候只需要会调不需要懂原理（用 API 不必先会实现）

注意方向：**更基础、更早被当作已知的那一个是前置**。两个概念都可能互相提及，
但只有一个方向上「不懂就卡住」。两个方向都卡不住就是 none。

relation 只能是下面四个字符串之一，**原样照抄，不许换成别的说法**：
- "a_before_b"：A 是 B 的前置
- "b_before_a"：B 是 A 的前置
- "none"：两个方向都不构成前置
- "unclear"：证据不足以判断

confidence 是 0-1 的小数，表示你对这个判断的把握。
because 必须是**从给你的证据里原样摘出的一句话**——不许改写、不许自己组织语言。
摘得出支撑证据就给，摘不出但判断成立仍然要给出关系，because 留空即可。

只输出 JSON：{"relation": "a_before_b|b_before_a|none|unclear", "confidence": number, "because": str}"""

CLAUSE_SYSTEM = """给你一个概念 B 和它的一组前置概念，判断这些前置里**哪些是互为替代的**
（掌握其中任意一个就够，不必全会），哪些是缺一不可的。

例：学 RAG 之前要会 Python **或** TypeScript——这两个互为替代。
但学 Transformer 要同时会线性代数**和**反向传播——这两个缺一不可。

把前置分成若干组：**组内是「都要会」，组之间是「会其中一组就行」**。
绝大多数情况只有一组（全都要会）——**不确定就返回一组**，多分组会让学习者绕过真正必需的前置。

只输出 JSON：{"groups": [["概念1","概念2"], ["概念3"]]}"""


def load_concepts() -> dict[str, dict[str, dict]]:
    """按域收拢词表：{domain: {concept: {"chunks": [...], "titles": [...]}}}"""
    by_domain: dict[str, dict[str, dict]] = {"ai": defaultdict(lambda: {"chunks": [], "titles": []}),
                                             "embodied": defaultdict(lambda: {"chunks": [], "titles": []})}
    # 只取活块：归档块与活块同号，前置图会把同一节的证据数两遍，
    # 直接抬高「支撑数」这个进图门槛的判据。
    from backend.rag.ingest import read_index_rows

    for row in read_index_rows(INDEX):
        domain = "embodied" if row["source_id"].startswith(EMBODIED_PREFIX) else "ai"
        topic = row.get("topic")
        if not topic:
            continue
        slot = by_domain[domain][topic]
        slot["chunks"].append(row)
        slot["titles"].append(row.get("title", ""))
    return {d: dict(v) for d, v in by_domain.items()}


def evidence_block(concept: str, slot: dict) -> str:
    """给模型看的证据。摘证据的规则要稳定——because 的子串校验依赖它逐字可复现。"""
    # 标题比正文片段更能表达一个概念的**范围**。一版只给 4 段正文，模型看到的是碎片，
    # 判不出「这个概念覆盖到哪」，结果 55 对里 52 对答无关、只留 3 条边。标题短，可以多给。
    titles = [t for t in dict.fromkeys(slot["titles"]) if t][:TITLE_CAP]
    parts = [
        f"概念：{concept}（语料中 {len(slot['chunks'])} 个切片）",
        "覆盖的教材小节：" + "；".join(titles),
    ]
    for c in slot["chunks"][:EVIDENCE_PER_CONCEPT]:
        body = " ".join(c["content"].split())[:EVIDENCE_CHARS]
        parts.append(f"· {c.get('title', '')}：{body}")
    return "\n".join(parts)


RELATIONS = {"a_before_b", "b_before_a", "none", "unclear"}
#: 只收「前置在前」这一族说法：`X is a prerequisite of Y`、`X 是 Y 的前置`——
#: 两种语序里**先出现的那个概念都是前置**。刻意不收 `requires` / `依赖`：
#: 「X 依赖 Y」的前置是 Y，方向相反，混进同一族会归错方向。归不了就返回 None，
#: 一条错边会影响所有走这条路径的学习者，宁可丢也不猜。
_PREREQ_MARK = re.compile(r"prerequisite|prereq|前置|先修|先于|before")
_NONE_MARK = re.compile(r"\bnone\b|no relation|not a prereq|无关|不构成|没有前置|均不")
_UNCLEAR_MARK = re.compile(r"unclear|uncertain|不确定|无法判断|证据不足")


def normalize_relation(raw: str, a: str, b: str) -> str | None:
    """把散文形态的 relation 归一成四个枚举值之一，归不了返回 None。

    **这是一个真事故的补丁，别当防御性编程删掉。** 提示词原本只写
    `{"relation": str, ...}`，从头到尾没告诉模型合法取值是哪四个，
    模型于是照自己的话写：`"relation": "llm_basics is a prerequisite of rag"`。
    上游那句 `if rel not in {...}: return None` 把这种**判对了的**应答
    整条丢成 None，调用侧再把 None 记成「调用失败」。

    实测代价：拿 12 条生产在用的前置边做尺子自检，9 条记成调用失败、
    认同率 0/12。差点据此得出「这份语料没有前置结构」——那是尺子在说谎，
    不是语料没结构。提示词已同步补上枚举（治本），这里是拿不到的那一侧的护栏。
    """
    s = (raw or "").strip()
    if s in RELATIONS:
        return s
    low = s.lower()
    if _UNCLEAR_MARK.search(low):
        return "unclear"
    if _NONE_MARK.search(low):
        return "none"
    if not _PREREQ_MARK.search(low):
        return None
    # 方向：这一族说法里**先出现的概念就是前置**（`X is a prerequisite of Y`、
    # `X 是 Y 的前置`，两种语序一致）。先按概念原名找，找不到再退回字面的 A / B。
    if a.lower() != b.lower():
        pos_a, pos_b = low.find(a.lower()), low.find(b.lower())
        if pos_a >= 0 and pos_b >= 0:
            return "a_before_b" if pos_a < pos_b else "b_before_a"
    letter_a = re.search(r"(?<![0-9a-z_])a(?![0-9a-z_])", low)
    letter_b = re.search(r"(?<![0-9a-z_])b(?![0-9a-z_])", low)
    if letter_a and letter_b:
        return "a_before_b" if letter_a.start() < letter_b.start() else "b_before_a"
    return None


def classify_pair(gateway: LLMGateway, a: str, b: str, ea: str, eb: str) -> dict | None:
    user = f"概念 A = {a}\n概念 B = {b}\n\n【A 的证据】\n{ea}\n\n【B 的证据】\n{eb}"
    parsed = gateway.structured_chat(AGENT, EDGE_SYSTEM, user, temperature=0.1, max_tokens=500)
    if not parsed:
        return None
    rel = normalize_relation(str(parsed.get("relation", "")), a, b)
    if rel is None:
        return None
    because = str(parsed.get("because", "")).strip()
    try:
        conf = float(parsed.get("confidence", 0))
    except (TypeError, ValueError):
        conf = 0.0
    # 依据必须是所给证据的精确子串——这是压幻觉边的机械闸，对不上整条丢。
    if rel in {"a_before_b", "b_before_a"}:
        haystack = " ".join((ea + " " + eb).split())
        if not because or " ".join(because.split()) not in haystack:
            # 一版在这里把整条降级成 unclear，等于因为「引文没摘对」丢掉「关系判断」——
            # 两件事不是一回事。改为保留关系、清空 because 并留痕，让无依据边可被单独统计
            # （无依据边占比 = 表的幻觉率，与资源侧同一把尺子）。
            return {"relation": rel, "confidence": conf, "because": "",
                    "no_evidence": True}
    return {"relation": rel, "confidence": max(0.0, min(1.0, conf)), "because": because}


def break_cycles(edges: dict[str, list[tuple[str, float, str]]]) -> list[str]:
    """删掉环里置信度最低的那条边。返回删除记录。

    环意味着「A 要先于 B 且 B 要先于 A」，逻辑上不可能同时成立，必然有一条判错了。
    删最低置信的那条是可复算的确定性规则，不是拍脑袋。
    """
    removed: list[str] = []
    def find_cycle() -> list[str] | None:
        color: dict[str, int] = {}
        stack: list[str] = []
        def dfs(u: str) -> list[str] | None:
            color[u] = 1
            stack.append(u)
            for v, _, _ in edges.get(u, []):
                if color.get(v, 0) == 1:
                    return stack[stack.index(v):] + [v]
                if color.get(v, 0) == 0:
                    got = dfs(v)
                    if got:
                        return got
            stack.pop()
            color[u] = 2
            return None
        for n in list(edges):
            if color.get(n, 0) == 0:
                got = dfs(n)
                if got:
                    return got
        return None

    while True:
        cycle = find_cycle()
        if not cycle:
            return removed
        worst = None
        for i in range(len(cycle) - 1):
            u, v = cycle[i], cycle[i + 1]
            for j, (dst, conf, _) in enumerate(edges.get(u, [])):
                if dst == v and (worst is None or conf < worst[2]):
                    worst = (u, j, conf, v)
        if worst is None:
            return removed
        u, j, conf, v = worst
        edges[u].pop(j)
        removed.append(f"{u}→{v}（置信 {conf:.2f}，环 {'→'.join(cycle)}）")


def transitive_reduction(prereqs: dict[str, set[str]]) -> tuple[dict[str, set[str]], list[str]]:
    """删掉可由传递推出的直接边。存直接边、闭包算出来（设计稿 §4.2 第一条约束）。"""
    removed: list[str] = []
    reachable: dict[str, set[str]] = {}

    def reach(q: str, seen: set[str]) -> set[str]:
        if q in reachable:
            return reachable[q]
        if q in seen:
            return set()
        out: set[str] = set()
        for p in prereqs.get(q, set()):
            out.add(p)
            out |= reach(p, seen | {q})
        reachable[q] = out
        return out

    reduced: dict[str, set[str]] = {}
    for q, ps in prereqs.items():
        keep = set()
        for p in ps:
            # p 若能从 q 的其他前置里传递到达，它就是冗余的直接边
            indirect = set()
            for other in ps - {p}:
                indirect |= {other} | reach(other, {q})
            if p in indirect:
                removed.append(f"{p}→{q}（可由传递推出）")
            else:
                keep.add(p)
        reduced[q] = keep
    return reduced, removed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry", action="store_true", help="只打印词表与候选对，不调 API")
    parser.add_argument("--domain", choices=["ai", "embodied"], help="只跑一个域")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument(
        "--force",
        action="store_true",
        help="即使本次产出明显差于现有文件也覆盖。默认拒绝——"
        "一次 API 报错的重跑曾把 9 条边的图覆盖成 0 条",
    )
    args = parser.parse_args()

    concepts = load_concepts()
    domains = [args.domain] if args.domain else ["ai", "embodied"]

    for d in domains:
        names = sorted(concepts[d], key=lambda c: -len(concepts[d][c]["chunks"]))
        pairs = list(itertools.combinations(names, 2))
        print(f"[{d}] 词表 {len(names)} 个：{'、'.join(names)}")
        print(f"[{d}] 候选对 {len(pairs)} 个（域内全量，规模小不做剪枝）")
    if args.dry:
        return 0

    os.environ["AGENT_GENERATION_MODE"] = "api"
    gateway = LLMGateway()
    route = gateway.route_for(AGENT)
    if not route.enabled:
        print(f"路由未启用：{route.provider}/{route.model}，检查 {route.api_key_env}")
        return 1
    print(f"模型 {route.provider}/{route.model}")

    existing = json.loads(args.output.read_text(encoding="utf-8")) if args.output.exists() else {}
    out: dict[str, dict] = dict(existing)

    for d in domains:
        names = sorted(concepts[d], key=lambda c: -len(concepts[d][c]["chunks"]))
        ev = {c: evidence_block(c, concepts[d][c]) for c in names}
        edges: dict[str, list[tuple[str, float, str]]] = defaultdict(list)
        audit: list[dict] = []
        pairs = list(itertools.combinations(names, 2))
        for i, (a, b) in enumerate(pairs, 1):
            got = classify_pair(gateway, a, b, ev[a], ev[b])
            if got is None:
                audit.append({"pair": [a, b], "relation": "error"})
                continue
            audit.append({"pair": [a, b], **got})
            if got["relation"] == "a_before_b":
                edges[a].append((b, got["confidence"], got["because"]))
            elif got["relation"] == "b_before_a":
                edges[b].append((a, got["confidence"], got["because"]))
            if i % 10 == 0:
                print(f"[{d}] {i}/{len(pairs)} 对", flush=True)

        cycles_removed = break_cycles(edges)
        # 转成 前置 → 概念 的方向：edges[a] = [(b,...)] 表示 a 是 b 的前置
        prereqs: dict[str, set[str]] = defaultdict(set)
        meta: dict[tuple[str, str], tuple[float, str]] = {}
        for a, lst in edges.items():
            for b, conf, why in lst:
                prereqs[b].add(a)
                meta[(a, b)] = (conf, why)
        reduced, trans_removed = transitive_reduction({k: set(v) for k, v in prereqs.items()})

        # clause 分组：前置 ≥2 个的概念单独问一次哪些互为替代
        clauses: dict[str, list[dict]] = {}
        for q, ps in reduced.items():
            if not ps:
                continue
            groups = [sorted(ps)]
            if len(ps) >= 2:
                user = f"概念 B = {q}\nB 的前置概念：{'、'.join(sorted(ps))}"
                parsed = gateway.structured_chat(AGENT, CLAUSE_SYSTEM, user, temperature=0.1, max_tokens=300)
                got = (parsed or {}).get("groups")
                if isinstance(got, list) and got:
                    cleaned = [sorted({c for c in g if c in ps}) for g in got if isinstance(g, list)]
                    cleaned = [g for g in cleaned if g]
                    # 分组必须覆盖全部前置，否则丢了前置——宁可回落单组
                    if cleaned and {c for g in cleaned for c in g} == ps:
                        groups = cleaned
            clauses[q] = [
                {
                    "all": g,
                    # 一组里取最低置信度：这条 clause 的成立取决于最弱的那条边
                    "confidence": round(min(meta.get((p, q), (0.0, ""))[0] for p in g), 3),
                    "because": next((meta[(p, q)][1] for p in g if (p, q) in meta and meta[(p, q)][1]), ""),
                    # §7.6：只有人工确认过的边才能升硬前置。产出一律未复核。
                    "reviewed": False,
                }
                for g in groups
            ]

        out[d] = {
            "items": names,
            "clauses": clauses,
            "_meta": {
                "source": "语料 topic 当词表（闭集，不让模型开集发明概念）+ 成对分类",
                "model": f"{route.provider}/{route.model}",
                "pairs_judged": len(pairs),
                "edges_kept": sum(len(v) for v in reduced.values()),
                "cycles_removed": cycles_removed,
                "transitive_removed": trans_removed,
                "reviewed": False,
                "note": "全部边未经人工确认，消费侧只可当软前置（§7.6）。"
                        "前置图质量未做外部对照实验，对外材料不得出现依赖它的效果承诺。",
            },
            "_audit": audit,
        }
        print(f"[{d}] 保留边 {out[d]['_meta']['edges_kept']}，去环 {len(cycles_removed)}，"
              f"传递约简 {len(trans_removed)}")

    # 退化保护：**一次跑砸的重跑不许覆盖好产物。**
    # 实测踩过：一次遇 16 次 API 错误、判出 0 条边的重跑，把 9 条边的图整个覆盖掉了，
    # 而且没有任何提示——好在 classroom 那份同步副本还在才捞回来。
    # 判据：任一域的边数掉到原来的一半以下，或原来有边现在归零，就拒绝写。
    degraded: list[str] = []
    for d in domains:
        before = len((existing.get(d) or {}).get("clauses") or {})
        after = len(out[d]["clauses"])
        errors = sum(1 for x in out[d]["_audit"] if x.get("relation") == "error")
        if before and (after == 0 or after * 2 < before):
            degraded.append(f"{d}：{before} 条 → {after} 条（本次 {errors} 次调用失败）")
    if degraded and not args.force:
        print("\n拒绝写盘——本次产出比现有的差：")
        for line in degraded:
            print(f"  {line}")
        print(f"现有文件保持不动：{args.output}")
        print("确认要覆盖就加 --force；多半应该先查 API 是不是在报错。")
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"落盘 {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
