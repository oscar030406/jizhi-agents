r"""从语料自身的结构机械导出覆盖率金标。规则先于语料，零 LLM 调用。

    python scripts/derive_kc_gold.py --corpus data/knowledge_base/hello_agents_docs --out data/eval/kc_gold_derived
    python scripts/derive_kc_gold.py --corpus <任意 md 目录> --out <目录> --compare data/eval/kc_gold

## 为什么金标可以来自语料

赛题把权威安放在知识库那一侧：目标介绍写「由『领域专家 Agent』**依托专业知识库**确保
内容生成的绝对专业与零幻觉」；实用价值满分档把三个指标挂在「生成的领域知识精准贴合
**行业实际规范与岗位需求**」之后；提交形式把「专业知识库切片」写进**测试方案**。
全篇没有一处要求金标必须来自知识库以外。

我们自己加的「金标与生成管线不共享提示词、生成前冻结」纪律保留，但实现方式改成
**机械规则先于数据 = 冻结**：本脚本先于任何新语料存在、不含任何领域词，
所以不论扔什么语料进来，金标都由规则机械导出，人从头到尾不必读语料。
口径全文见 `docs/05-evidence/prereg-v5-blind-transfer-20260812.md` 第 4 节。

## 两级粒度，同一棵结构树

- **主题（课程单位）= 章级**：文件树语料取目录，扁平语料取 front-matter 的 topic
- **金标 KC = 节级**：文件树语料取每个文件，扁平语料取文件内最深层编号标题

同一份结构，前置图用章级、覆盖率用节级——这正是接手单里提的「两级词表」。

## 一个必须处理的坑

markdown 里 ``` 围栏内的 `# 注释` 是代码注释，不是标题。hello-agents 8.3 节里
`# 创建具有RAG能力的Agent` 这类共 6 行全在 python 代码块内，按标题解析会污染金标。
本脚本逐行跟踪围栏状态。
"""

from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

#: 编号标题：`### 8.3.1 RAG的基础知识` / `## 2.1 xxx`。带编号说明是作者刻意排的层级，
#: 不带编号的多是行文小标题，粒度不稳，不收。
NUMBERED = re.compile(r"^(#{1,6})\s+(\d+(?:\.\d+)+)\s+(.+?)\s*$")
ANY_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")
FRONT_MATTER = re.compile(r"^([a-z_]+):\s*(.*)$")


def read_front_matter(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    meta = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        m = FRONT_MATTER.match(line)
        if m:
            meta[m.group(1)] = m.group(2).strip()
    return meta


def headings(text: str, numbered_only: bool = True) -> list[tuple[int, str, str]]:
    """返回 [(层级, 编号, 标题)]，跳过围栏内的行。"""
    out: list[tuple[int, str, str]] = []
    in_fence = False
    for line in text.splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = NUMBERED.match(line)
        if m:
            out.append((len(m.group(1)), m.group(2), m.group(3)))
        elif not numbered_only:
            m2 = ANY_HEADING.match(line)
            if m2:
                out.append((len(m2.group(1)), "", m2.group(2)))
    return out


def slug(text: str, used: set[str]) -> str:
    base = re.sub(r"[^0-9a-zA-Z一-鿿]+", "-", text).strip("-")[:40] or "kc"
    cand, i = base, 2
    while cand in used:
        cand, i = f"{base}-{i}", i + 1
    used.add(cand)
    return cand


#: 教学活动不是知识成分。人工金标里已经用同样的理由删过条目（rag.json 的删除记录：
#: 「rag-practice：端到端实践是教学活动而非独立知识成分」）。这里把那条判断固化成
#: 一张**不含任何领域词**的通用停用模式表，所以它对陌生语料一样成立。
ACTIVITY = re.compile(
    r"快速体验|上手|运行效果|效果展示|案例背景|学习目标|本章|小结|总结|回顾|练习|习题"
    r"|参考文献|延伸阅读|附录|环境准备|安装|配置流程|演示|实战演练|动手"
)


#: 教材 front-matter 的 title 形如「第8章 8.3 RAG系统：知识检索增强」，章号是作者排的。
CHAPTER_IN_TITLE = re.compile(r"第\s*([0-9一二三四五六七八九十]+)\s*章")
#: source_id 形如 ha08s03：语料前缀 + 章 + 节。去掉 sNN 即章。
CHAPTER_IN_ID = re.compile(r"^(.*?)s\d+$")


def chapter_of(meta: dict[str, str], path: Path) -> str:
    """作者侧的章。优先 title 里的「第N章」，退回 source_id 去掉节号，再退回文件名。"""
    m = CHAPTER_IN_TITLE.search(meta.get("title", ""))
    sid = meta.get("source_id") or path.stem
    if m:
        prefix = CHAPTER_IN_ID.match(sid)
        stem = prefix.group(1) if prefix else sid
        return f"{stem}-第{m.group(1)}章"
    m2 = CHAPTER_IN_ID.match(sid)
    return m2.group(1) if m2 else sid


def _has_cjk(text: str) -> bool:
    return any("一" <= ch <= "鿿" for ch in text)


def title_of(path: Path, text: str) -> str:
    """页面标题。**优先取含中文的那一个标题**，不是第一个。

    转换语料（reST → md）的首个标题常常是英文页面锚点：Odoo 实测拿到
    `bpost` / `dhl credentials` / `barcode nomenclature` 这类 slug，
    拿它当知识成分名，后面机械匹配和判官复核都对不上中文课文。
    这条判据与 `ingest_domain.concept_evidence` 的「标题只在含中文时才留」同源。
    """
    meta = read_front_matter(text)
    if meta.get("title"):
        return meta["title"]
    hs = [h[2] for h in headings(text, numbered_only=False)]
    cjk = next((h for h in hs if _has_cjk(h)), None)
    return cjk or (hs[0] if hs else path.stem)


#: 一句话的量级：够判官认出这个知识成分讲什么，又不至于把整页塞进金标。
FIRST_SENTENCE = re.compile(r"[^。！？\n]{8,120}[。！？]")


def lead_sentence(text: str) -> str:
    """正文里第一句中文。

    转换语料的页面标题可能整页都是英文锚点（Odoo 的 `# bpost`、`# dhl credentials`），
    中文全在正文里。这种页面只给名字的话，第二级判官拿到的是一个没有语义的 slug。
    所以额外抽一句正文当描述——机械、不含领域词、对任何语料一视同仁。
    """
    # 逐行跟踪围栏状态。只丢「以 ``` 开头的那一行」是不够的——代码块**里面**的
    # 中文注释会被当成正文，金标描述就成了一句代码注释。
    kept: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence or not line.strip() or line.startswith("#"):
            continue
        kept.append(line)
    body = "\n".join(kept)
    for m in FIRST_SENTENCE.finditer(body):
        s = m.group().strip()
        if _has_cjk(s):
            return s
    return ""


def derive(corpus: Path) -> dict[str, list[dict]]:
    """-> {topic: [ {id, name, synonyms, source} ]}"""
    files = sorted(corpus.rglob("*.md"))
    if not files:
        raise SystemExit(f"{corpus} 下没有 .md")

    nested = any(len(p.relative_to(corpus).parts) > 1 for p in files)
    topics: dict[str, list[dict]] = defaultdict(list)
    used: set[str] = set()

    if nested:
        # 文件树语料：主题=叶子父目录，KC=每个文件
        for p in files:
            rel = p.relative_to(corpus)
            topic = "/".join(rel.parts[:-1])
            text = p.read_text(encoding="utf-8", errors="replace")
            name = title_of(p, text)
            entry = {
                "id": slug(name, used), "name": name, "synonyms": [],
                "source": str(rel).replace("\\", "/"),
            }
            if not _has_cjk(name):
                # 名字是英文锚点时，补一句正文——否则判官拿到的是没有语义的 slug
                lead = lead_sentence(text)
                if lead:
                    entry["description"] = lead
            topics[topic].append(entry)
        return dict(topics)

    # 扁平语料（我们 knowledge_base 的形态）：主题取**作者的章**，KC 取最深编号标题。
    #
    # 不用 front-matter 的 `topic:` ——那是我们入库时打的标签，是我方产物；
    # 用它当金标分母就把金标的一部分权威挪回了我们这边。`title:` 里的「第N章」
    # 是教材作者排的目录条目，才是赛题所说的那一侧权威。
    for p in files:
        text = p.read_text(encoding="utf-8", errors="replace")
        meta = read_front_matter(text)
        topic = chapter_of(meta, p)
        hs = headings(text, numbered_only=True)
        if hs:
            deepest = max(h[0] for h in hs)
            picked = [h for h in hs if h[0] == deepest]
        else:
            picked = [(1, "", title_of(p, text))]
        for _lvl, num, name in picked:
            if ACTIVITY.search(name):
                continue
            topics[topic].append({
                "id": slug(name, used), "name": name, "synonyms": [],
                "source": f"{p.name}{(' §' + num) if num else ''}",
            })
    return dict(topics)


def write_gold(kept: dict[str, list[dict]], out: Path, corpus: Path) -> int:
    """每个主题一份 json 落到 `out`。返回落盘份数。

    从 main() 的 `--out` 分支抽出来的，落盘格式一字未改——领域接入流水线要 import 它，
    金标格式必须只有一个真源（CLI 与流水线产出的金标要能互相对照）。
    """
    out.mkdir(parents=True, exist_ok=True)
    for topic, kcs in kept.items():
        fname = re.sub(r"[^0-9a-zA-Z一-鿿]+", "-", topic).strip("-") or "topic"
        (out / f"{fname}.json").write_text(json.dumps({
            "topic": topic,
            "status": "derived-mechanical",
            "note": "由 scripts/derive_kc_gold.py 从语料结构机械导出。"
                    "规则先于语料、不含领域词，等价于生成前冻结。"
                    "synonyms 留空：机械匹配是第一级加速器，判定以第二级判官+引文核验为准。",
            "source": str(corpus).replace("\\", "/"),
            "knowledge_components": kcs,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(kept)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", required=True, type=Path)
    ap.add_argument("--out", type=Path, help="落盘目录，每个主题一份 json")
    ap.add_argument("--compare", type=Path, help="与现有人工金标目录对照")
    ap.add_argument("--min-kc", type=int, default=2, help="KC 少于这个数的主题不出金标")
    args = ap.parse_args()

    topics = derive(args.corpus)
    kept = {t: kcs for t, kcs in topics.items() if len(kcs) >= args.min_kc}
    total = sum(len(v) for v in kept.values())
    print(f"语料 {args.corpus}")
    print(f"主题 {len(kept)} 个（过滤掉 KC<{args.min_kc} 的 {len(topics) - len(kept)} 个），KC 合计 {total}")
    for t, kcs in sorted(kept.items(), key=lambda kv: -len(kv[1]))[:12]:
        print(f"  {len(kcs):>3} KC  {t}")
        for kc in kcs[:3]:
            print(f"           · {kc['name'][:48]}")
    if len(kept) > 12:
        print(f"  …另有 {len(kept) - 12} 个主题")

    if args.out:
        print(f"\n已落盘 {write_gold(kept, args.out, args.corpus)} 份到 {args.out}")

    if args.compare:
        print(f"\n=== 与人工金标对照（{args.compare}） ===")
        for gp in sorted(args.compare.glob("*.json")):
            g = json.loads(gp.read_text(encoding="utf-8"))
            t = g.get("topic")
            manual = len(g.get("knowledge_components", []))
            auto = len(kept.get(t, []))
            flag = "" if auto else "   ← 机械导出没有这个主题"
            print(f"  {t:<24} 人工 {manual:>3} KC ｜ 机械 {auto:>3} KC{flag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
