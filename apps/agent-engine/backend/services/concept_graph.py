"""概念前置图加载与拓扑排序。

## 两个数据源，各管各的（2026-08-12 起）

设计稿 §10 第 1 条点的偏差是「编排层直接读表示层：路径规划直接读硬编码的
`concept_graph.json`」，后果是**换域即坏**——那份文件只有 10 个概念、全是 AI 域，
具身域一个都没有，路径退化成章节顺序。

现在分成两份：

- **边**（前置关系）来自 `prereq_graph.json`：由 `build_prereq_graph.py` 从语料造，
  按域分、带 clause 分组与置信度、AI 与具身域都有。换域就是换这份表。
- **元数据**（难度档、常见误区、标题）仍来自 `concept_graph.json`：新图不产出这些，
  而且难度那一列的自动化实测没通过验收（重测 κ=0.292，见
  `backend/rag/difficulty.py` 模块头），保留人工值是实测结论不是偷懒。

四个调用点（learning_path_planner / personalization_service / personalize_service）
**一行不改**：接口形状没变，换的是 `prerequisites()` 底下取哪份表。

## 边还有第二个来源：接入流水线建的库（2026-08-30 补）

`prereq_graph.json` 只有 `ai` 与 `embodied` 两个域——`build_prereq_graph.py` 的
`--domain` 选项就硬编码这两个。而管理端用接入流水线建的每一个新库，也各自造了一张
前置图，落在 `data/knowledge_base/<corpus>_intake/readiness.json` 的 `prereq_graph`
里（`domain_intake._extract_concepts` → `ingest_domain.build_prereq`），从没进过全局那份。
只读全局那份的后果就是模块头第一段写的老毛病换个位置复发：新建库的域一条边都取不到，
路径退化成章节顺序。所以 {@link load_prereq_edges} 现在读两处的并集。

## 域过滤：不加就串味

两个来源合起来有七八个域，拍平成一张平表意味着智能制造的概念闭包里会长出 AI 域的前置。
`load_prereq_edges(domain=...)` 只取一个域的边；不传保持全域并集（既有四个调用点靠它，
它们本来就只跑 AI/具身域）。{@link available_prereq_domains} 供上层如实展示取的是哪几份。

**域参数当前谁在用**：一个生产调用点都没有——`prerequisites` / `known_concepts` /
`graph_source` 全是不传域的全域并集，`domain_path.build_domain_path` 则是自己读
`readiness.json` 建了一份同域视图，没走这里。眼下守着这条路的只有
`tests/test_domain_path.py::test_prereq_edges_are_domain_scoped`。
留着不删是因为「串味」这个坑已经踩过一次（模块头第一段那件事换个位置复发），
按域取边是修它的唯一入口，删掉等于把已知的坑重新埋回去。
按域的路径规划一接过来，第一个调用点就落在这。

## 缓存不失效，重跑接入要重启

`readiness.json` 会被接入流水线重写（每跑一次 run 就是一份新的）。这里的 `lru_cache`
是**进程内永久缓存，不做失效**：引擎进程里没有文件变更的通知源，加 mtime 轮询要给
每次调用摊一次 stat，而前置图在一次进程生命周期里改动是罕例。代价说清楚即可——
接入流水线重跑完，新边要等引擎重启才生效。

## 未复核的边只作软前置

`prereq_graph.json` 里的边一律 `reviewed: false`（§7.6：只有人工签字的边才能当硬前置）。
这里的用途是**扩展目标闭包与排序**，属于推荐不属于拦截，用软前置是恰当的；
真要拿它拦人，得先过人工确认那一关。{@link graph_source} 供报告层如实展示用的是哪份。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
KB_DIR = PROJECT_ROOT / "data" / "knowledge_base"
GRAPH_PATH = KB_DIR / "concept_graph.json"
#: 由语料造出来的前置图（`scripts/build_prereq_graph.py` 的产物）。
PREREQ_GRAPH_PATH = KB_DIR / "prereq_graph.json"
#: 接入流水线为每个新库落的就绪度报告，`prereq_graph` 字段里带该域自己的边。
INTAKE_READINESS_GLOB = "*_intake/readiness.json"


@lru_cache(maxsize=1)
def load_graph() -> dict[str, dict]:
    """元数据表：难度、误区、标题、以及旧的 prerequisites（作兜底）。"""
    if not GRAPH_PATH.exists():
        return {}
    data = json.loads(GRAPH_PATH.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


def read_json_dict(path: Path) -> dict:
    """读一份 JSON，读不动就当没有。

    `readiness.json` 可能正被接入流水线重写（写到一半、或那次 run 崩在半路），
    一份坏文件不该让所有域的前置边一起消失。
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


@lru_cache(maxsize=1)
def _prereq_by_domain() -> dict[str, dict[str, list[str]]]:
    """域 → {概念: 前置列表}。两个来源都收进来，键统一是域名。

    - 全局 `prereq_graph.json`：顶层键就是域名（ai / embodied）
    - 各库的 `<corpus>_intake/readiness.json`：域名取目录前缀（即语料库名）

    clause 之间是 OR（满足其中一组即可，§4.2），但这里的用途是**扩展闭包与排序**，
    取并集是安全的方向：多带上几个前置只会让顺序更保守，不会漏掉该先学的。
    真正要做「选哪条 clause」的决策在选点那一层（`selection.ts`），不在这儿。
    """
    sources: list[tuple[str, dict]] = []
    for domain, payload in read_json_dict(PREREQ_GRAPH_PATH).items():
        if domain.startswith("_") or not isinstance(payload, dict):
            continue
        sources.append((domain, payload))
    for path in sorted(KB_DIR.glob(INTAKE_READINESS_GLOB)):
        payload = read_json_dict(path).get("prereq_graph")
        if isinstance(payload, dict):
            sources.append((path.parent.name[: -len("_intake")], payload))

    out: dict[str, dict[str, list[str]]] = {}
    for domain, payload in sources:
        slot = out.setdefault(domain, {})
        for concept, clauses in (payload.get("clauses") or {}).items():
            for clause in clauses or []:
                for p in clause.get("all", []):
                    bucket = slot.setdefault(concept, [])
                    if p not in bucket:
                        bucket.append(p)
    return out


# 缓存键是域名，取值范围是盘上的库目录（现在七个）加一个 None，16 够用还有余量。
# 不写 maxsize=None：域名从 HTTP 参数一路传下来是迟早的事，无界缓存等于把外部可控的
# 字符串当键往进程里堆。
@lru_cache(maxsize=16)
def load_prereq_edges(domain: str | None = None) -> dict[str, list[str]]:
    """概念 → 前置概念列表。

    `domain` 给了就只取该域的边；不给保持全域并集（既有调用点的行为一字不变）。
    跨域拍平会让一个域的概念闭包里长出另一个域的前置——学习者体感是「我学智能制造，
    它让我先去学 RAG」——所以新写的调用点应当把域传进来。
    """
    by_domain = _prereq_by_domain()
    if domain is not None:
        return {k: list(v) for k, v in (by_domain.get(domain) or {}).items()}
    out: dict[str, list[str]] = {}
    for slot in by_domain.values():
        for concept, prereqs in slot.items():
            bucket = out.setdefault(concept, [])
            for p in prereqs:
                if p not in bucket:
                    bucket.append(p)
    return out


def available_prereq_domains() -> list[str]:
    """有边可取的域名单。报告层拿它写「这次用的是哪几份表」，别猜。"""
    return sorted(d for d, slot in _prereq_by_domain().items() if slot)


def graph_source() -> str:
    """当前边取自哪份表。降级要可见（§7.7）——报告层拿它写字，别猜。"""
    return "prereq_graph" if load_prereq_edges() else "concept_graph(legacy)"


def isolated_corpus(corpus: str | None) -> str | None:
    """这个库有没有自己的接入前置图；有就返回域名，没有返回 None。

    为什么要这层判断，而不是「传了 corpus 就按它过滤」：主库（ai）的索引里并进了
    具身语料（`embodied` 是主库内子域，域名表里就是这么标的），AI 课引用具身概念是
    正常现象。对主库硬过滤成 `domain="ai"`，会把具身那三条边从闭包里摘掉——
    那不是隔离，那是把本来就该在一起的两半劈开。

    接入流水线单独建出来的库不一样：它有自己的 `<corpus>_intake/readiness.json`，
    索引也是独立的一份，跨域概念对它就是噪声。所以只对这类库开域过滤。
    """
    name = (corpus or "").strip()
    if not name:
        return None
    return name if (KB_DIR / f"{name}_intake" / "readiness.json").exists() else None


def prerequisites(concept: str, domain: str | None = None) -> list[str]:
    """前置概念：**两份表取并集**，人工策展的在前。

    一版写的是「有新图就不看旧图」，被用例判死：`langgraph` 在人工图里有
    `tool_calling` 这条边，模型图里没有，于是闭包把它整个丢了。
    那个取舍方向是反的——§7.6 的排序是**人工确认过的边才是可信的那一档**，
    模型抽的边只能当软前置。让模型的表顶掉人工的表，等于把可信度高的那份废了。

    并集的代价是多带几个前置，方向安全：闭包多算只会让顺序更保守，不会漏掉该先学的。
    两份都没有就是真没有——空列表，不编。
    """
    # 人工策展表只有 AI 域；独立建出来的库不该去它那儿捞前置（捞到的是别的域的边）。
    curated = [] if domain else list(load_graph().get(concept, {}).get("prerequisites", []))
    built = load_prereq_edges(domain).get(concept) or []
    out = list(curated)
    for p in built:
        if p not in out:
            out.append(p)
    return out


def concept_meta(concept: str) -> dict:
    return load_graph().get(concept, {})


def known_concepts(domain: str | None = None) -> set[str]:
    """两份表里出现过的全部概念。新图的 items 覆盖具身域，旧图只有 AI 域。

    `domain` 给了就只认那个域的概念——独立库的闭包不该把别域概念算成「已知」，
    否则拓扑排序会把它们排进来。
    """
    out: set[str] = set() if domain else set(load_graph())
    edges = load_prereq_edges(domain)
    out |= set(edges)
    for prereqs in edges.values():
        out |= set(prereqs)
    return out


def prerequisite_closure(concepts: list[str], domain: str | None = None) -> list[str]:
    """把目标概念扩展为包含所有（递归）前置概念的集合。

    走 {@link prerequisites}，所以新图一上线这里自动跟着变——
    这正是「编排层不直读表示层」要的效果：换域换表，编排层不动。
    """
    known = known_concepts(domain)
    seen: set[str] = set()
    stack = list(concepts)
    while stack:
        c = stack.pop()
        if c in seen or c not in known:
            continue
        seen.add(c)
        stack.extend(prerequisites(c, domain))
    return list(seen)


def topological_order(concepts: list[str], domain: str | None = None) -> list[str]:
    """按前置关系拓扑排序（前置在前）。图外概念放最后，保持稳定。"""
    graph = load_graph()
    universe = known_concepts(domain)
    target = [c for c in dict.fromkeys(concepts)]
    known = [c for c in target if c in universe]
    unknown = [c for c in target if c not in universe]

    ordered: list[str] = []
    visiting: set[str] = set()

    def visit(c: str) -> None:
        if c in ordered or c not in universe:
            return
        if c in visiting:  # 环保护（造图时已去环，这里防御）
            return
        visiting.add(c)
        for pre in prerequisites(c, domain):
            if pre in known:
                visit(pre)
        visiting.discard(c)
        if c not in ordered:
            ordered.append(c)

    # 难度只在元数据表里有；新图独有的概念（具身域那批）取默认 L2，不编一个假难度
    for c in sorted(known, key=lambda x: _difficulty_rank(graph.get(x, {}).get("difficulty", "L2"))):
        visit(c)
    return ordered + unknown


def _difficulty_rank(level: str) -> int:
    return {"L1": 1, "L2": 2, "L3": 3, "L4": 4}.get(level, 2)
