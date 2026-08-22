"""从切好的教材里抽概念词表。接入 Agent 的第 3、4 步。

## 这一步为什么绕不开

`build_prereq_graph.py` 能直接跑，是因为库内 9 个来源的 chunk 上**已经有 `topic` 字段**——
那是当初写 `ingest_*.py` 时人工归的类。新领域没有这个字段，前置图就无从谈起：
词表是命名空间，其余四张表全 key 在它上面。

## 判据：闭集候选，不开集发明

模型开集自由生成知识点只有 35–56% 匹配，闭集验证能到 86–88% F1（arXiv:2409.08406）；
GPT-4o-mini 在 646 道题上生成了 569 个知识成分而专家只有 101 个，**5.6 倍冗余**，
且用它拟合的模型 RMSE 比专家模型差（arXiv:2511.09935）。

所以这里的候选池是**教材的标题结构**——节标题是作者做过的知识划分，粒度锚定教材
（设计稿 §4.3）。模型只做三件受限的事：从标题+正文里认出概念、给规范名、判同一性。
不许它凭空造一个标题里没有的概念面。

## 两道机械闸，都不靠模型自觉

1. **证据子串校验**：概念的 `evidence` 必须是所给正文的精确子串，对不上就丢掉该概念。
2. **出现次数下限**：只在一节里出现过的概念不进词表。教材里真正的知识面会被反复提及，
   只出现一次的多半是模型从某个例子里摘的名词。

## 归并为什么必须是三分类

「self-attention 和 attention 是不是同一个」——二分类会把前者吞进后者，直接毁掉图的粒度。
必须给出「同一 / A 比 B 窄 / 无关」三档：窄的那个保留为独立概念，只是记下它的上位。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Callable, Iterable

#: 一节里最多抽几个概念。上限防止模型把每个名词都当概念（5.6 倍冗余那个坑）。
MAX_PER_SECTION = 8

#: 进词表的最低出现节数。只露过一面的不算知识面。
MIN_SECTIONS = 2

EXTRACT_SYSTEM = f"""你在从中文技术教材里认出**知识面**（概念），供个性化学习系统当词表用。

**候选池是给你的标题路径，不是正文。** 正文只用来判断这一节到底在讲什么、以及摘证据。
从标题里认出这一节讲的知识面，必要时归一成更规范的说法；
**标题里没有、只在正文里出现过的名词，一律不要输出**。

知识面 = 一个需要单独学、可以单独考的技术主题。判据：
- **是**：能当一节课的标题，学完它能回答「这是什么、怎么用、什么时候用」
- **不是**：函数名、类名、配置参数名、SQL 关键字、HTTP 头、命令行选项、
  某个例子里的变量、公司或产品名、章节编号

几个反例，照着排除：`SessionPool`（API 类名）、`DataReplicationFactor`（配置参数）、
`GROUP BY 子句`（SQL 语法元素）、`Authorization Header`（协议细节）。
它们对应的**知识面**分别是「会话与连接管理」「副本与一致性配置」「查询语言」「接口鉴权」——
输出后者，不要输出前者。

每节最多 {MAX_PER_SECTION} 个，**宁可一个都不给也不要凑数**。
一节讲的往往就是一两个知识面。

name 用规范的中文技术名（有公认英文缩写的保留缩写，如 RAG、PLC、OPC UA），
名字要完整、不许截断、不许带半个括号。
evidence 必须是**从给你的正文里原样摘出的一句话**，能支撑「这一节在讲这个概念」。
摘不出就不要输出这个概念。

只输出 JSON：{{"concepts": [{{"name": str, "evidence": str}}]}}"""

#: 一眼就不是知识面的名字，机械挡掉，不指望提示词自觉。
#: 这些形态在 API 文档类语料里成片出现（实测 IoTDB：28 个概念里 17 个是这类）。
_IDENTIFIER_SHAPED = (
    re.compile(r"^[A-Za-z][A-Za-z0-9]*$"),          # SessionPool / DataNode / TTL
    re.compile(r"^[A-Z][A-Z0-9_]{2,}$"),             # FIELD / TAG / GROUP_BY
    re.compile(r"^[a-z_]+$"),                        # snake_case 参数名
    re.compile(r"[()（）\[\]{}]"),                    # 括号残缺或带参数签名
    # 不加 ：Python 的 \w 在 Unicode 下含中文，"GROUP BY子句" 的 Y 与 子 之间
    # 不构成词边界，加了反而漏掉最常见的那种写法（实测漏过）。
    re.compile(r"^(GROUP BY|ORDER BY|SELECT|INSERT|DELETE|WHERE|CREATE)", re.I),
)

#: 名字长度的容忍范围。一个字的多半是截断，太长的多半是把一句话当成了概念。
_MIN_NAME, _MAX_NAME = 2, 24


def looks_like_identifier(name: str) -> bool:
    """判这个名字是不是「标识符」而不是「知识面」。

    纯机械，不调模型——提示词里已经写了排除条款，实测照样漏（IoTDB 那批里
    `DataReplicationFactor`、`SessionPool`、`基础鉴权(Basic Auth` 全过了）。
    判据写在代码里才拦得住。
    """
    s = name.strip()
    if not (_MIN_NAME <= len(s) <= _MAX_NAME):
        return True
    return any(p.search(s) for p in _IDENTIFIER_SHAPED)


MERGE_SYSTEM = """给你两个候选概念名和各自的证据，判断它们的关系。三选一：

- "same"：同一个知识面的不同叫法（「大模型」与「大语言模型」）
- "a_narrower"：A 是 B 的一个子面，需要单独学（「自注意力」之于「注意力机制」）
- "unrelated"：两个不同的知识面

**注意不要把子面并进上位面**——那会毁掉词表的粒度，学习者本该单独学的东西就消失了。
拿不准是 same 还是 a_narrower 时，选 a_narrower（保留粒度比合并安全）。

只输出 JSON：{"relation": str}"""


@dataclass
class ConceptCandidate:
    name: str
    #: 出现在哪些节（标题路径的字符串形式），去重。
    sections: set[str] = field(default_factory=set)
    #: 支撑证据，每节一条。
    evidence: list[str] = field(default_factory=list)

    @property
    def support(self) -> int:
        return len(self.sections)


def normalize(name: str) -> str:
    """确定性规范化。先做完这一步再谈调模型——大部分重复是格式差异不是语义差异。"""
    s = name.strip()
    # 全角转半角的常见几个 + 去掉包裹的括号与引号
    s = s.translate(str.maketrans("（）［］【】「」《》", "()[][]\"\"<>"))
    s = re.sub(r"^[\s\"'<\[(]+|[\s\"'>\])]+$", "", s)
    # 中英文之间的空格、连续空白
    s = re.sub(r"\s+", " ", s)
    return s


def _fold(name: str) -> str:
    """归并用的折叠键：忽略大小写、空格、连字符与下划线。"""
    return re.sub(r"[\s\-_]+", "", name).lower()


def extract_from_sections(
    sections: Iterable[tuple[str, str]] | Iterable[tuple[str, str, list[str]]],
    ask: Callable[[str, str], dict | None],
) -> dict[str, ConceptCandidate]:
    """逐节抽概念。`sections` 是 (节标识, 正文) 或 (节标识, 正文, 标题路径)。

    **给了标题路径就把它当候选池**——模块头说的「候选池是教材的标题结构」要落到这里，
    只发正文等于把闭集做成了开集（实测代价：IoTDB 那批抽出来 28 个概念，
    17 个是配置参数名和 API 类名，378 对判出 0 条边——分类器没错，词表是废的）。

    两道机械闸：证据必须是正文子串（压幻觉概念）、名字不能是标识符形态
    （提示词里写了排除条款，实测照样漏）。丢掉的都不进候选。
    """
    found: dict[str, ConceptCandidate] = {}
    for section in sections:
        section_id, body = section[0], section[1]
        heading_path = list(section[2]) if len(section) > 2 else []
        user = (
            (f"【标题路径（候选池）】\n{' / '.join(heading_path)}\n\n" if heading_path else "")
            + f"【本节正文（只用来判断与摘证据）】\n{body}"
        )
        parsed = ask(EXTRACT_SYSTEM, user)
        items = (parsed or {}).get("concepts")
        if not isinstance(items, list):
            continue
        haystack = " ".join(body.split())
        for item in items[:MAX_PER_SECTION]:
            if not isinstance(item, dict):
                continue
            name = normalize(str(item.get("name", "")))
            evidence = str(item.get("evidence", "")).strip()
            if not name or not evidence:
                continue
            if looks_like_identifier(name):
                continue  # 标识符不是知识面：丢
            if " ".join(evidence.split()) not in haystack:
                continue  # 证据不是正文子串：丢
            key = _fold(name)
            slot = found.setdefault(key, ConceptCandidate(name=name))
            slot.sections.add(section_id)
            slot.evidence.append(evidence)
    return found


def prune(found: dict[str, ConceptCandidate], min_sections: int = MIN_SECTIONS) -> dict[str, ConceptCandidate]:
    """砍掉支撑不足的候选。返回保留的，被砍的由调用方从差集算出来记进报告。"""
    return {k: v for k, v in found.items() if v.support >= min_sections}


def merge_candidates(
    found: dict[str, ConceptCandidate],
    ask: Callable[[str, str], dict | None],
) -> tuple[dict[str, ConceptCandidate], list[str]]:
    """把同义候选并成一个，保留子面。返回（词表, 归并记录）。

    只对**折叠键有包含关系**的候选对调模型——全量两两问是 O(n²) 次调用，
    而真正的同义词几乎总是字面相关（「注意力」vs「注意力机制」）。
    字面无关却同义的（「大模型」vs「LLM」）漏掉了，代价是词表里多一个概念，
    不是错误，报告里如实记。
    """
    names = sorted(found, key=lambda k: -found[k].support)
    merged: dict[str, ConceptCandidate] = {}
    log: list[str] = []
    for key in names:
        cand = found[key]
        target = None
        for kept in merged:
            if key in kept or kept in key:
                parsed = ask(
                    MERGE_SYSTEM,
                    f"A = {cand.name}\nA 的证据：{cand.evidence[0] if cand.evidence else ''}\n\n"
                    f"B = {merged[kept].name}\nB 的证据：{merged[kept].evidence[0] if merged[kept].evidence else ''}",
                )
                if str((parsed or {}).get("relation", "")) == "same":
                    target = kept
                    break
        if target:
            merged[target].sections |= cand.sections
            merged[target].evidence.extend(cand.evidence)
            log.append(f"{cand.name} → {merged[target].name}")
        else:
            merged[key] = cand
    return merged, log


def to_vocabulary(merged: dict[str, ConceptCandidate]) -> list[dict]:
    """词表的落盘形态。按支撑节数降序——支撑多的更可能是真知识面。"""
    return [
        {
            "concept": c.name,
            "sections": sorted(c.sections),
            "support": c.support,
            "evidence": c.evidence[:3],
        }
        for c in sorted(merged.values(), key=lambda x: (-x.support, x.name))
    ]


def vocabulary_report(
    found: dict[str, ConceptCandidate],
    kept: dict[str, ConceptCandidate],
    merge_log: list[str],
) -> dict:
    """就绪度报告里「词表」那一格的内容。砍掉了什么必须写出来，不能只报留下的。"""
    dropped = [found[k].name for k in found if k not in kept]
    return {
        "candidates": len(found),
        "kept": len(kept),
        "dropped_low_support": sorted(dropped),
        "merged": merge_log,
        "min_sections": MIN_SECTIONS,
        "note": "只在一节里出现过的候选不进词表；证据对不上正文的候选在抽取阶段已丢弃。"
                "字面无关但同义的概念（如「大模型」与「LLM」）本步骤查不出，会各占一格。",
    }


def json_only(raw: str) -> dict | None:
    """从模型输出里剥出第一个 JSON 对象。围栏与前后缀都容忍。"""
    m = re.search(r"\{.*\}", raw, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group())
    except json.JSONDecodeError:
        return None
