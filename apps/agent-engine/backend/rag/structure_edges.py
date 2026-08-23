r"""章级概念面与结构前置边：不问模型，只读语料里已经写着的东西。

## 为什么有这一层

代码图谱（call / import / inherit）抽得出来，是因为那些边**在源码里是显式的**——
AST 里就写着，不需要判断。而我们前三轮一直在让 LLM **判断**「A 是不是 B 的前置」，
三份陌生语料全判 none，且是高置信度判错（`批次与序列号追踪` vs `批次追踪` 判 none、
conf 0.9）。Odoo 153 对全判过，0 条边。

⚠️ **2026-08-12 深夜更正：那个 0 的首要原因是一个解析 bug，不是下面两条。**
`build_prereq_graph.py` 的提示词没写 `relation` 的合法取值，模型答
`"llm_basics is a prerequisite of rag"`，`if rel not in {...}: return None` 把
判对了的应答整条丢掉。修完之后同一份 Odoo 语料节级出 6 条边（0 次调用失败）、
章级出 13 条。尺子自检见 `scripts/experiments/prereq_reviewer_sanity.py`：修复前
12 条生产在用的边认同率 0/12，修复后 12/12。

下面两条**仍然成立**，只是不再是那个 0 的解释——章级 13 条 > 节级 6 条，
粒度这个方向的判断没变：

1. **粒度错了**。前置关系存在于**章级**概念之间。同一章里的节级概念多半是兄弟
   （先进先出 vs 后进先出是并列选项，库存调整 vs 补货规则是并行操作），不是先后。
   `build_prereq_graph.py` 用语料 `topic` 字段（章级）能出 9 / 3 条边，
   `ingest_domain.py` 从标题抽（节级）出 0 条，同一套分类器同一份判据。
2. **该用的信号没用**。Odoo 语料里有 168 条 `<../../path/to/page>` 显式交叉引用——
   等价于 import——脚本数过它，一条都没用上。

本模块补这两处：概念面提到章级，边由交叉引用的不对称性给出，LLM 从**判定**降级为
**复核**。附带的成本变化是数量级的：成对判定是 O(n²) 次调用（Odoo 153 对），
复核是 O(边) 次（Odoo 30 条）。

## 方法出处

RefD（Liang et al. 2015）用 Wikipedia 链接结构的不对称性推前置；
Pal et al.（[arXiv:2011.10337](https://arxiv.org/abs/2011.10337)）用教材结构的统计法
跑赢 RefD。本模块是这两者在「文档目录 + 页面互链」形态上的最简实现。

## 边界

- **语料得有交叉引用，而且写法不止一种**。Odoo（reST 转来的）写 `<../../a/b>`，
  IoTDB（VuePress）写 `[文字](../a/b.md)`。2026-08-12 实测：只认尖括号那一种时，
  IoTDB 报 0 条引用、0 条边，读起来像「这份语料没有结构」——其实只是换了写法，
  补上 markdown 链接后同一份语料出 329 条引用、35 条候选边。
  **「产出为 0」在这一层永远要先当成探测器没覆盖，再当成语料没结构。**
  真的没有交叉引用（扫描版 PDF 教材）就返回空，调用侧退回原路径并在报告里标明。
- **链接不等于前置**。`finance/accounting/reporting → manufacturing/basic_setup`
  这种是「参见」。不对称阈值滤掉一部分，剩下的靠 LLM 复核与人工签字。
- 产出的边一律 `reviewed: false`，只作软前置（设计稿 §7.6）。
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from pathlib import Path

#: 交叉引用有两种写法，两种都要收——**这一格是按语料形态吃亏最快的地方**。
#: Odoo（reST 转来的）写 `<../../a/b/c>`；IoTDB（VuePress）写 `[文字](../a/b.md)`。
#: 只认前者时 IoTDB 实测 0 条引用、0 条边，看起来像「这份语料没有结构」——
#: 其实只是换了个写法。
_XREF_ANGLE = re.compile(r"<((?:\.\./)+[^>\s]+)>")
_XREF_MD = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
#: 站点根路径（/img/…）、外链、纯锚点都不是页面间引用。
_NOT_A_PAGE = re.compile(r"^(https?:|mailto:|#|/)")
#: 有扩展名且不是 .md 的一律当资源文件（图片 / csv / 附件），不进引用图。
_ASSET = re.compile(r"\.(?!md$)[A-Za-z0-9]{1,5}$")


def page_refs(text: str) -> list[str]:
    """一篇文档里指向**同语料其它页面**的相对引用。"""
    return [target for target, _pos in page_refs_at(text)]


def page_refs_at(text: str) -> list[tuple[str, int]]:
    """同上，但带每次出现的**字符位置**。

    位置这一格是为了让每次引用拿到**自己那句话**。原来 `_context` 用
    `text.find(needle)` 找第一次出现，同一页多次引用同一目标时，
    每次拿回来的都是同一句——审表上两条不同的边贴着一模一样的引文，
    就是这么来的（iotdb 那份表的第 1、2 条）。判「详见」还是「请先」
    靠的正是那句话，取错了句子等于判据本身是错的。
    """
    out: list[tuple[str, int]] = []
    for m in _XREF_ANGLE.finditer(text):
        out.append((m.group(1), m.start()))
    for m in _XREF_MD.finditer(text):
        target = m.group(1).split("#", 1)[0].strip()
        if not target or _NOT_A_PAGE.match(target) or _ASSET.search(target):
            continue
        out.append((target, m.start()))
    out.sort(key=lambda x: x[1])
    return out


#: markdown 标题，用来给章取中文名。
HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*$", re.MULTILINE)

#: 一条边至少要有几次引用。1 次太容易是顺手一提。
MIN_LINKS = 2
#: 正反向引用次数比。低于它说明两章互相引用，是并列不是先后。
MIN_RATIO = 2.0


def _has_cjk(text: str) -> bool:
    return any("一" <= ch <= "鿿" for ch in text)


def normalize(rel: str) -> str:
    return rel.replace("\\", "/").lstrip("./")


def chapter_of(rel: str) -> str | None:
    """章 = 叶子文件的父目录全路径。目录深度各语料不同（Odoo 4 层、IoTDB 5 层），
    取父目录而不是固定层数，跨语料才一致。"""
    parts = normalize(rel).split("/")[:-1]
    return "/".join(parts) if parts else None


def resolve(src_rel: str, target: str) -> str:
    """把 <../../a/b/c> 解析成仓库内路径。手工消化 `..`，不碰文件系统——
    引用的目标可能压根不在收进来的文件里，走 Path.resolve 会去探真实路径。"""
    parts = list(Path(normalize(src_rel)).parent.parts)
    for seg in target.split("/"):
        if seg == "..":
            if parts:
                parts.pop()
        elif seg not in ("", "."):
            parts.append(seg)
    return "/".join(parts)


def member_titles(chapter: str, files: dict[str, str]) -> list[str]:
    """该章下每个文档的**首个**标题。只取首个：Odoo 页面正文里满是
    「如何取消发给货代的发货请求？」这类小标题，扫全篇会把页面的一个小节
    当成整章的名字（实测踩过）。"""
    out: list[str] = []
    for rel, text in files.items():
        if chapter_of(rel) != chapter:
            continue
        hs = HEADING.findall(text)
        if hs:
            out.append(hs[0].strip())
    return out


def chapter_name(chapter: str, files: dict[str, str]) -> str:
    """章名一律取**目录名**，不从成员标题里挑。

    成员标题描述的是章里的某一篇，不是这一章；挑一个当章名是在编造。
    转换语料的目录名常是英文（`product_tracking`），需要中文名时由调用侧
    拿 `titles` 做一次命名调用——那是 O(章数) 次，Odoo 33 次，很便宜。
    结构定边、模型只命名，比让模型判边可靠。
    """
    return chapter.split("/")[-1]


def chapter_plane(files: dict[str, str]) -> dict[str, dict]:
    """-> {章路径: {name, files, chars}}"""
    plane: dict[str, dict] = {}
    for rel, text in files.items():
        ch = chapter_of(rel)
        if ch is None:
            continue
        slot = plane.setdefault(ch, {"path": ch, "files": [], "chars": 0})
        slot["files"].append(normalize(rel))
        slot["chars"] += len(text)
    for ch, slot in plane.items():
        slot["name"] = chapter_name(ch, files)
        slot["titles"] = member_titles(ch, files)[:12]
    return plane


#: 引用上下文取多长。一句话的量级——够看出是「需要先…」还是「参见…」，又不至于把整段搬进审表。
CONTEXT_CHARS = 60

#: 「参见」措辞：链接只是指路，读者不看也能继续。**这一族是方向抽检的主要失分来源**——
#: 2026-08-12 人工初审 21 条边，10 条对、11 条错，错的几乎全是这一族被当成了前置。
SEEALSO_MARK = re.compile(
    r"详见|参见|可参考|请查看|请参阅|参考|更多|完整指南|了解如何|详细信息|详情|"
    r"以.{0,8}为例|文档。|指南。|见下|如下所示|另见"
)
#: 「前置」措辞：不先做/不先懂就走不下去。
PREREQ_MARK = re.compile(
    r"请先|需要先|必须先|必须|首先|事先|前提|确保.{0,6}(已|配置|启用)|"
    r"请启用|需启用|仅应针对启用了|启用.{0,10}(后|才)|准备|完成.{0,6}准备|要.{0,12}首先"
)


def _context(text: str, needle: str, at: int | None = None) -> str:
    """引用出现处前后各一小段，压成一行。**这一格是人工抽检最省时间的东西**：
    章名只能告诉你两章叫什么，引用当时那句话才告诉你链接为什么存在——
    「需要先启用 X」是前置，「更多细节参见 X」不是。

    `at` 是这次出现的位置。不给就退回找第一次出现——那会让同一页的多次引用
    共用同一句话，判据取错句子等于判据是错的（见 `page_refs_at`）。
    """
    i = at if at is not None else text.find(needle)
    if i < 0:
        return ""
    lo = max(0, i - CONTEXT_CHARS)
    hi = min(len(text), i + len(needle) + CONTEXT_CHARS)
    return " ".join(text[lo:hi].split())


#: 句子边界。判措辞只看引用**所在那一句**，不看窗口里凑巧挨着的邻句。
_SENT_BOUND = re.compile(r"[。！？；\n]")


def _sentence(text: str, at: int, needle_len: int) -> str:
    """引用所在的那一句（左右各最多 2×CONTEXT_CHARS 兜底，防超长无标点段落）。

    与 `_context` 分工明确：`_context` 是给**人**看的引文，窗口宽一点更好读；
    这一个是给 `link_intent` 判措辞用的，窗口必须收到句内。

    实测差别很大：Odoo 上宽窗口判出 234 次「请先」族，收到句内只剩 87 次——
    **六成是邻句串味**。而「请先」是唯一能把一条边留下来的信号，
    串味等于凭邻居的句子留下这条边。
    """
    lo, floor = at, max(0, at - CONTEXT_CHARS * 2)
    while lo > floor and not _SENT_BOUND.match(text[lo - 1]):
        lo -= 1
    hi, ceil = at + needle_len, min(len(text), at + needle_len + CONTEXT_CHARS * 2)
    while hi < ceil and not _SENT_BOUND.match(text[hi]):
        hi += 1
    return " ".join(text[lo:hi].split())


def link_intent(context: str) -> str:
    """从引用周围那句话判这条链接是「前置」还是「参见」。零 LLM。

    ⚠️ **本函数目前只作诊断，不参与边的产出。** 2026-08-12 试过把它接进计数
    （命中「参见」就不计入证据强度），效果两极：IoTDB 候选边 35 → 17、
    在标注子集上方向正确率 83%；Odoo 30 → 29、正确率 56%，几乎没动。
    更要命的是评估口径不干净——那 15 条标签是我自己标的、规则也是照着这些例子写的，
    等于拿同一批样本调参又验收。按项目纪律（对抗式审查、先证伪），
    这不构成把它接进产出的证据。要接，得先有一批**不是写规则的人标的**边。

    优先级设计（留档）：先看「参见」族。两族措辞常同句出现，而误把参见当前置的代价更大——
    一条假前置会拦住本来能往下学的人。宁可漏，不可误。
    """
    if SEEALSO_MARK.search(context):
        return "seealso"
    if PREREQ_MARK.search(context):
        return "prereq"
    return "unknown"


def xref_counts(files: dict[str, str]) -> tuple[Counter, int, int, dict, dict]:
    """章间引用计数。-> (计数, 引用总数, 未跨章数, 上下文样例, 措辞分布)

    计的是**全部**跨章引用，不按措辞过滤——过滤器（`link_intent`）证据不足，见其文档。
    已知代价：纯按链接数计会把「详见 X」这种指路网络也算成前置网络，
    实测方向正确率只有 48%（21 条人工初审 10 条对）。这是当前这一层的真实精度，
    所以产出的边一律 `reviewed: false`、只作软前置、不拦人。

    **措辞分布（第五个返回值）只记不判**：每条边的引用里有几次是「详见」族、
    几次是「请先」族、几次认不出。记它是为了让「这条规则值多少」能被算出来——
    在此之前，想知道过滤后的正确率只能把整条链重跑一遍，而重跑要花钱。
    要不要按它过滤，等一批**不是写规则的人标的**边（见 `link_intent` 文档）。
    """
    pair: Counter = Counter()
    contexts: dict[tuple[str, str], list[str]] = defaultdict(list)
    intents: dict[tuple[str, str], Counter] = defaultdict(Counter)
    total = same = 0
    for rel, text in files.items():
        src = chapter_of(rel)
        for target, at in page_refs_at(text):
            total += 1
            resolved = resolve(rel, target)
            # `.md` 结尾的引用已经带文件名，不能再补一层，否则父目录算错一级
            dst = chapter_of(resolved if resolved.endswith(".md") else resolved + ".md")
            # src 也要挡 None：上传路径会把文件名拍平（a/b.md → b.md），
            # chapter_of() 对没有目录层的名字返 None。只挡 dst 的话，
            # 后面 sorted((src, dst)) 会抛 TypeError，把 ④ 知识整理整站打崩，
            # 而 ④ 不是旁路站——它失败会让整次 run 判失败、_cleanup_partial 把刚建好的库删掉。
            # 实测：odoo 语料有 168 处 `<../../a/b>` 这类跨目录引用，三次 run 全崩。
            if src is None or dst is None or dst == src:
                same += 1
                continue
            pair[(src, dst)] += 1
            snippet = _context(text, target, at)
            # 判措辞只看引用所在那一句；给人看的引文仍用宽窗口（见 `_sentence`）
            intents[(src, dst)][link_intent(_sentence(text, at, len(target)))] += 1
            if len(contexts[(src, dst)]) < 3 and snippet:
                contexts[(src, dst)].append(snippet)
    return pair, total, same, dict(contexts), {k: dict(v) for k, v in intents.items()}


def structural_edges(
    files: dict[str, str], min_links: int = MIN_LINKS, ratio: float = MIN_RATIO
) -> list[dict]:
    """RefD 式不对称：章 Y 的页面大量引用章 X 而反向很少 -> X 是 Y 的前置。

    返回 [{prereq, target, links, back_links, because}]，按引用次数降序。
    """
    pair, _total, _same, contexts, intents = xref_counts(files)
    seen: set[tuple[str, str]] = set()
    edges: list[dict] = []
    for (src, dst), n_fwd in pair.items():
        if n_fwd < min_links:
            continue
        key = tuple(sorted((src, dst)))
        if key in seen:
            continue
        n_back = pair.get((dst, src), 0)
        if n_back and n_fwd / n_back < ratio:
            continue  # 互相引用，是并列不是先后
        seen.add(key)
        edges.append({
            "prereq": dst,          # 被引的一方更基础
            "target": src,          # 引用别人的一方依赖对方
            "links": n_fwd,
            "back_links": n_back,
            "because": f"「{src}」的页面 {n_fwd} 次引用「{dst}」，反向 {n_back} 次",
            "contexts": contexts.get((src, dst), []),
            # 这条边的引用里，措辞各占几次。**只记不判**——按它过滤要等
            # 一批不是写规则的人标的边（见 `link_intent`）。记下来是为了
            # 「过滤能带来多少」这件事能算，而不是每问一次就重跑一遍链。
            "intents": intents.get((src, dst), {}),
        })
    edges.sort(key=lambda e: -e["links"])
    return edges


def load_markdown(root: Path) -> dict[str, str]:
    return {
        normalize(str(p.relative_to(root))): p.read_text(encoding="utf-8", errors="replace")
        for p in sorted(root.rglob("*.md"))
    }


#: 文档**身份**里的序号：`pv-ops-01.md`、`chapter1-02-preparation.md`、`第3章-定时器.md`。
#: 认三种写法——分隔符后的数字、`chapter1` 这类连写、中文「第N章」。
_DOC_ORDER = re.compile(
    r"(?:[/_\-\s]\d{1,3}(?:[._\-]\d{1,2})*(?=[._\-\s/]|$))"
    r"|(?:(?:chapter|chap|ch|part|lesson|unit|sec|step)\s*\d{1,3})"
    r"|(?:第\s*[一二三四五六七八九十百\d]+\s*[章节讲篇课])",
    re.I,
)
#: 站点导航文件。有它说明顺序写在别处，而我们收进来的 md 里没有。
_NAV_FILES = {
    "summary.md", "toc.md", "_sidebar.md", "mkdocs.yml",
    "sidebar.json", "_toc.yml", "toctree.rst",
}
#: 判成 textbook 需要多少比例的文档在**身份**上带序号。
#: 六份真语料实测分得极开——pv-ops 100%、cold-chain 100%、rag-adv 90%、vecdb 100%
#: 对 iotdb 0%、odoo 0%——中间是空的，所以阈值取哪个都一样，取 0.5 留余量。
_TEXTBOOK_MIN_RATIO = 0.5


def detect_form(files: dict[str, str], root: Path | None = None) -> dict:
    """这份语料是**教材形态**还是**文档站形态**。零 API。

    ## 为什么要分

    2026-08-23 两轮实测（`docs/05-evidence/prereq-intent-coverage-20260823.md`）：
    结构信号能不能用**由语料形态决定**，不是三条独立的局限，是一条规律。

    - 教材形态（单书成册、标题带章节号）：章节序、指路措辞、篇内位置三样都在。
    - 文档站形态（VuePress / rst 转 md）：**章节序全灭**——iotdb 带序号的目录
      0/29、文件 0/242，odoo 0/161 与 0/962，且 odoo 的 rst `toctree`
      在转换成 md 时一条都没活下来。措辞信号也只够得着一成（Odoo 90% 的引用
      两个词表都不认）。

    所以下游那些吃顺序的东西（前置边用章节序当默认、难度冷启动的位置先验）
    只能在 textbook 形态上激活。docsite 形态**诚实降级**并说明原因，
    不假装算得出来——「系统知道自己不知道」比硬凑一个数值钱。

    ## 判据看文档身份，不看正文

    第一版扫正文里的 `## 1. 步骤` 这类标题号，把 iotdb 判成了 textbook 99%——
    **页内小标题文档站也有，跟文档之间的顺序毫无关系**。要的是「这些文档
    本身排没排过序」，所以判据只看路径/文件名。改口径之后同一批语料：
    pv-ops 100%、cold-chain 100%、rag-adv 90%、vecdb 100% 对 iotdb 0%、odoo 0%，
    中间是空的。

    导航文件的存在是**反**证据：顺序写在导航里，而导航不在我们收进来的正文里。
    """
    total = len(files)
    if not total:
        return {"form": "unknown", "numbered_ratio": 0.0, "nav_files": [], "why": "一个文档都没有"}

    numbered = sum(1 for rel in files if _DOC_ORDER.search(rel))
    ratio = numbered / total
    navs = sorted(
        {p.name for p in root.rglob("*") if p.is_file() and p.name.lower() in _NAV_FILES}
    ) if root else []

    if ratio >= _TEXTBOOK_MIN_RATIO:
        form = "textbook"
        why = f"{numbered}/{total}（{ratio:.0%}）的文档在文件名里带序号，作者写下了顺序"
    else:
        form = "docsite"
        why = (
            f"只有 {numbered}/{total}（{ratio:.0%}）的文档在文件名里带序号"
            + (f"，顺序写在导航文件里（{'、'.join(navs)}）而导航不在正文中" if navs else "，也没有导航文件")
            + "——这份语料里没有可用的章节序"
        )
    return {"form": form, "numbered_ratio": round(ratio, 3), "nav_files": navs, "why": why}


def probe(root: Path) -> dict:
    """一次性给出这份语料的结构信号清单。调用侧据此决定走哪条路径。"""
    files = load_markdown(root)
    plane = chapter_plane(files)
    pair, total, same, _ctx, _intents = xref_counts(files)
    edges = structural_edges(files)
    form = detect_form(files, root)
    return {
        "files": len(files),
        "chapters": len(plane),
        "xrefs_total": total,
        "xrefs_within_chapter": same,
        "chapter_pairs": len(pair),
        "edges": edges,
        "plane": plane,
        "usable": len(edges) > 0,
        "structure_form": form,
    }


def _selftest() -> None:
    assert chapter_of("a/b/c.md") == "a/b"
    assert chapter_of("c.md") is None
    assert resolve("a/b/c.md", "../../x/y") == "x/y"
    assert resolve("a/b/c.md", "../d") == "a/d"
    # 尖括号写法（Odoo / reST 转换语料）
    assert page_refs("见 <../a/b> 与 <../../c/d>") == ["../a/b", "../../c/d"]
    # markdown 写法（IoTDB / VuePress）
    assert page_refs("[文字](../a/b.md) [图](/img/x.png) [外](https://x) [锚](#y)") == ["../a/b.md"]
    assert page_refs("[带锚](../a/b.md#section)") == ["../a/b.md"]

    files = {
        "root/basics/intro.md": "# 基础\n正文",
        "root/adv/one.md": "# 进阶\n见 <../basics/intro> 与 <../basics/intro>",
        "root/adv/two.md": "# 进阶二\n见 [基础](../basics/intro.md)",
    }
    edges = structural_edges(files)
    assert len(edges) == 1, edges
    assert edges[0]["prereq"] == "root/basics" and edges[0]["target"] == "root/adv"
    plane = chapter_plane(files)
    assert plane["root/basics"]["name"] == "basics"      # 章名取目录名，不挑成员标题
    assert plane["root/basics"]["titles"] == ["基础"]     # 成员标题另存，供命名用
    # 互相引用不出边
    mutual = {
        "x/a.md": "见 <../y/b> <../y/b>",
        "y/b.md": "见 <../x/a> <../x/a>",
    }
    assert structural_edges(mutual) == []


if __name__ == "__main__":
    import argparse
    import json

    _selftest()
    ap = argparse.ArgumentParser(description="结构前置信号探针（零 LLM 调用）")
    ap.add_argument("--corpus", required=True, type=Path)
    ap.add_argument("--json", type=Path)
    args = ap.parse_args()

    result = probe(args.corpus)
    print(f"文档 {result['files']} 篇，章级概念面 {result['chapters']} 个")
    print(f"交叉引用 {result['xrefs_total']} 条（章内 {result['xrefs_within_chapter']} 条不计），"
          f"覆盖 {result['chapter_pairs']} 个有序章对")
    print(f"\n[结构前置边] {len(result['edges'])} 条")
    for e in result["edges"][:20]:
        pn = result["plane"].get(e["prereq"], {}).get("name", e["prereq"])
        tn = result["plane"].get(e["target"], {}).get("name", e["target"])
        print(f"  {pn}  →  {tn}      ({e['links']} vs {e['back_links']})")
        print(f"      {e['prereq']}  →  {e['target']}")
    if len(result["edges"]) > 20:
        print(f"  …另有 {len(result['edges']) - 20} 条")
    if args.json:
        args.json.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n落盘 {args.json}")
