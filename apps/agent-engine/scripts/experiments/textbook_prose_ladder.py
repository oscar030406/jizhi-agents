r"""行文形态的外部尺子：拿真实中文教材量「教材是怎么写字的」，不自己拍。

    python scripts/experiments/textbook_prose_ladder.py --json ../data/eval/textbook_prose_ladder.json

## 为什么要这一份

`textbook_code_ladder.py` 量的是**代码形态**，管住了「零基础不该见 import」。
行文没人管。2026-08-13 实测生成的课里出现：

    「盯住…这个核心直觉」「你就抓住了向量数据库的**命门**」
    「那是语义关系被数学捕捉的**魔法时刻**」「这正是向量数据库**最打动人**的地方」

现有 lint（`apps/classroom/lib/generation/adaptation-lint.ts`）只查术语密度、代码形态、
域偏置，查不出这类修辞。补这一层的难点不是写正则，是**判据从哪来**——
上一批我加过一条「导学一句不超过 40 字」，那个数字是拍的、无出处，已撤。

这一份的做法：**候选词由我们提，进不进 lint 由教材语料判。**
候选词在 3xx 份真实中文教材里出现 0 次 → 进 lint；教材自己也在用 → 剔除并留证据。
「关键在于」「至关重要」这类看着像 AI 味的词，正是靠这一关免于误伤。

## 语料

教材侧（仓库内，只读）：d2l-zh / Happy-LLM / tiny-universe / 笨办法学 Python v2。
我们侧：`data/eval/adaptation_probe/resources/*.json` 的 108 份探针资源——
就是判官打 85.2% 适配率的那一批，同批语料，口径对得上。

两侧都**剥掉教材摘录**（📖 到「—— 摘自」之间）：摘录是教材原文，不是我们写的字，
留着会把教材的行文算成我们的。与 lint 的 `--zone own` 口径一致。
"""

from __future__ import annotations

import argparse
import json
import re
import statistics as st
from collections import Counter
from pathlib import Path

#: scripts/experiments/ → scripts/ → apps/agent-engine/ → apps/ → 仓库根（四层）
_REPO = Path(__file__).resolve().parents[4]
_ENGINE = Path(__file__).resolve().parents[2]

TEXTBOOKS: list[tuple[str, Path]] = [
    ("动手学深度学习 d2l-zh", _REPO / "references" / "d2l-zh-main"),
    ("Happy-LLM", _REPO / "references" / "happy-llm-main"),
    ("tiny-universe 白盒实现", _REPO / "references" / "tiny-universe"),
    ("笨办法学 Python v2", _REPO / "references" / "learn-python-the-smart-way-v2"),
]
#: 我们侧两批，分开量——它们是两条不同的生成路径，混在一起会互相稀释。
#:  · 探针资源：判官打 85.2% 适配率的那 108 份，单场景、纯 markdown
#:  · 成品课程：classroom 落库的整门课，画布 HTML，是学员真正看到的东西。
#:    08-13 那几句「命门/魔法时刻/最打动人」出自这一批，探针那批里没有。
OURS_PROBE = _ENGINE / "data" / "eval" / "adaptation_probe" / "resources"
OURS_COURSES = _REPO / "apps" / "classroom" / "data" / "classrooms"

SKIP_DIRS = (".git", "__pycache__", "node_modules", ".ipynb_checkpoints")

# ─────────────────────────────────────────────────────── 候选词（只是候选，判定权在语料）
#
# 三个来源，都不是我临时想的：
#   A. `~/.claude/CLAUDE.md`「对外文档去 AI 味」明令禁的那几类（夸张修辞、空洞 -ing 分析句、
#      收尾套话）——那份纪律管我们写的文档，这里把同一套判据搬到生成物上
#   B. humanizer skill 的 "Words to watch" 分类（inflated symbolism / promotional language /
#      superficial -ing analyses / vague attributions）的中文对应，按类别搬不按词直译
#   C. 2026-08-13 实测生成物里抓到的原句
#
# 故意混进了「至关重要」「值得一提的是」「本质上」这类**疑似误伤词**：
# 它们该被剔除还是该进表，由教材语料说了算，不由我说了算。

CANDIDATES: dict[str, list[str]] = {
    "夸张修辞": [
        "命门", "魔法", "魔力", "精髓", "真谛", "奥秘", "奥义", "灵魂", "法宝", "杀手锏",
        "点睛", "画龙点睛", "一针见血", "醍醐灌顶", "豁然开朗", "恍然大悟", "拨云见日",
        "震撼", "惊艳", "优雅地", "完美地", "彻底改变", "革命性", "颠覆性", "里程碑",
        "划时代", "无缝", "赋能", "强大的", "全面的", "显著提升", "极致", "终极",
        "最打动人", "最迷人", "迷人的", "美妙", "神奇", "不可思议", "淋漓尽致",
    ],
    "时刻话术": ["魔法时刻", "高光时刻", "那一刻", "关键时刻", "见证奇迹"],
    "呼告煽动": [
        "盯住", "记住这一点", "划重点", "敲黑板", "别急", "别怕", "放心",
        "你就抓住了", "恭喜你", "太棒了", "想象一下", "试想", "不妨想想",
        "让我们一起", "我们一起来", "你会发现", "你有没有想过",
    ],
    "空洞分析": [
        "体现了", "彰显", "凸显了", "折射出", "映射出", "诠释了", "揭示了",
        "蕴含着", "标志着", "奠定了基础", "扮演着重要角色", "发挥着重要作用",
        "提供了新思路", "打开了新的大门", "开辟了新的",
    ],
    "收尾套话": [
        "总而言之", "综上所述", "总的来说", "展望未来", "由此可见", "不难看出",
        "值得一提的是", "需要注意的是", "毫无疑问",
    ],
    "疑似误伤对照": ["关键在于", "至关重要", "本质上", "换句话说", "也就是说", "简单来说"],
}

# ─────────────────────────────────────────────────────── 文本清洗

CJK_G = re.compile(r"[一-鿿]")
FENCE = re.compile(r"^ {0,3}(```|~~~).*?^ {0,3}\1", re.S | re.M)
EXCERPT = re.compile(r"📖.*?—— ?摘自[^\n]*", re.S)
MATH_BLOCK = re.compile(r"\$\$.*?\$\$", re.S)
MATH_INLINE = re.compile(r"\$[^$\n]{1,200}\$")
INLINE_CODE = re.compile(r"`[^`\n]*`")
HTML = re.compile(r"<[^>\n]{1,200}>")
IMG = re.compile(r"!\[[^\]]*\]\([^)]*\)")
LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
SRC_TAG = re.compile(r"\[[A-Za-z0-9_-]+#[A-Za-z0-9_-]+\]")
TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$", re.M)
HEADING = re.compile(r"^\s{0,3}#{1,6}\s*", re.M)
LIST_MARK = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+", re.M)
QUOTE_MARK = re.compile(r"^\s*>+\s*", re.M)
FRONT_MATTER = re.compile(r"\A---\n.*?\n---\n", re.S)
D2L_DIRECTIVE = re.compile(r"^\s*:.*$", re.M)  # d2l 的 :label: :eqlabel: :numref: 等


def strip_to_prose(md: str) -> str:
    """markdown → 纯散文。代码/公式/表格/摘录全部剥掉，只留下作者写的字。"""
    t = FRONT_MATTER.sub("", md)
    t = EXCERPT.sub("", t)
    t = FENCE.sub("", t)
    t = MATH_BLOCK.sub("", t)
    t = MATH_INLINE.sub("", t)
    t = INLINE_CODE.sub("", t)
    t = IMG.sub("", t)
    t = LINK.sub(r"\1", t)
    t = SRC_TAG.sub("", t)
    t = HTML.sub("", t)
    t = TABLE_ROW.sub("", t)
    t = D2L_DIRECTIVE.sub("", t)
    t = HEADING.sub("", t)
    t = LIST_MARK.sub("", t)
    t = QUOTE_MARK.sub("", t)
    return t


#: 加粗与破折号要在剥 markdown 记号**之前**数——剥完就没了。
BOLD = re.compile(r"\*\*[^*\n]+\*\*")
EMDASH = re.compile(r"——")
BANG = re.compile(r"[!！]")
#: 顿号连三项及以上：「A、B、C」。中文排比最机械的一种形态。
TRIPLE = re.compile(r"[^\s、，。；：！？]{1,12}、[^\s、，。；：！？]{1,12}、[^\s、，。；：！？]{1,12}")
SECOND_PERSON = re.compile(r"你们|你|咱们")
SENT_END = re.compile(r"[。！？!?；;]+|\n{2,}")


def sentences(prose: str) -> list[str]:
    out = []
    for chunk in SENT_END.split(prose):
        s = chunk.strip()
        if len(CJK_G.findall(s)) >= 4:  # 少于 4 个汉字的碎片不是句子（标题残渣、编号）
            out.append(s)
    return out


def measure(prose_raw: str) -> dict | None:
    """prose_raw 是已剥代码/摘录、但仍带 markdown 强调记号的文本。"""
    cjk = len(CJK_G.findall(prose_raw))
    if cjk < 200:
        return None
    per_k = cjk / 1000
    plain = re.sub(r"[*_`]", "", prose_raw)
    sents = sentences(plain)
    lens = [len(CJK_G.findall(s)) for s in sents] or [0]
    return {
        "cjk": cjk,
        "sentences": len(sents),
        "sent_median": st.median(lens),
        "sent_p90": _pct(lens, 0.90),
        "sent_p99": _pct(lens, 0.99),
        "sent_max": max(lens),
        "bold_per_k": len(BOLD.findall(prose_raw)) / per_k,
        "emdash_per_k": len(EMDASH.findall(prose_raw)) / per_k,
        "bang_per_k": len(BANG.findall(plain)) / per_k,
        "triple_per_k": len(TRIPLE.findall(plain)) / per_k,
        "you_per_k": len(SECOND_PERSON.findall(plain)) / per_k,
    }


def _pct(values: list[int], q: float) -> float:
    s = sorted(values)
    if not s:
        return 0.0
    i = min(len(s) - 1, int(round(q * (len(s) - 1))))
    return float(s[i])


def merge(parts: list[dict]) -> dict:
    """按字数加权合并同一语料的多个文件（句长分位用汇总后的句表重算，见 collect_corpus）。"""
    total = sum(p["cjk"] for p in parts)
    out = {"files": len(parts), "cjk": total, "sentences": sum(p["sentences"] for p in parts)}
    for k in ("bold_per_k", "emdash_per_k", "bang_per_k", "triple_per_k", "you_per_k"):
        out[k] = sum(p[k] * p["cjk"] for p in parts) / total
    return out


# ─────────────────────────────────────────────────────── 语料装载


def md_files(root: Path) -> list[Path]:
    return [
        p
        for p in root.rglob("*.md")
        if not any(d in p.parts for d in SKIP_DIRS)
    ]


def ipynb_markdown(path: Path) -> str:
    try:
        nb = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return ""
    return "\n\n".join(
        "".join(c.get("source", []))
        for c in nb.get("cells", [])
        if c.get("cell_type") == "markdown"
    )


def load_textbook(root: Path) -> list[str]:
    docs = []
    for p in md_files(root):
        try:
            docs.append(p.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            continue
    for p in root.rglob("*.ipynb"):
        if any(d in p.parts for d in SKIP_DIRS):
            continue
        src = ipynb_markdown(p)
        if src:
            docs.append(src)
    return docs


def load_probe() -> list[str]:
    docs = []
    for p in sorted(OURS_PROBE.glob("*.json")):
        try:
            docs.append(json.loads(p.read_text(encoding="utf-8"))["text"])
        except Exception:
            continue
    return docs


#: 画布里的等宽段落是代码，不是行文。katex 的 span 汤不用单独剥：
#: 所有指标都以汉字为分母、句长也只数汉字，拉丁符号进不了统计。
MONO_P = re.compile(r"<p[^>]*monospace[^>]*>.*?</p>", re.S)


def load_courses(channel: str) -> list[str]:
    """channel='canvas' 画布正文（讲义）｜'speech' 口播与讨论提示。

    分开量是有原因的：口播是另一条生成路径，**lint 从来没看过它**
    （lint 跑在 scene-generator 的 markdown 上，口播是后一步单独生成的）。
    合在一起量会把口播的口癖稀释掉——实测「盯住」59 次全在口播里。
    """
    docs = []
    for p in sorted(OURS_COURSES.glob("*.json")):
        try:
            course = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        chunks: list[str] = []
        for scene in course.get("scenes", []):
            if channel == "canvas":
                for el in (scene.get("content") or {}).get("canvas", {}).get("elements", []):
                    html = el.get("content")
                    if isinstance(html, str) and html:
                        chunks.append(MONO_P.sub("", html))
            else:
                for act in scene.get("actions", []):
                    for key in ("text", "topic", "prompt"):
                        val = act.get(key)
                        if isinstance(val, str) and val:
                            chunks.append(val)
        if chunks:
            docs.append("\n\n".join(chunks))
    return docs


def collect_corpus(label: str, docs: list[str]) -> tuple[dict, str] | None:
    """→ (统计, 全文)。全文留着给词频查证与出处定位用。"""
    proses = [strip_to_prose(d) for d in docs]
    parts = [m for m in (measure(x) for x in proses) if m]
    if not parts:
        return None
    joined = "\n\n".join(proses)
    whole = measure(joined)
    assert whole
    stats = merge(parts)
    for k in ("sent_median", "sent_p90", "sent_p99", "sent_max"):
        stats[k] = whole[k]
    stats["label"] = label
    return stats, joined


# ─────────────────────────────────────────────────────── 词频对表


def word_table(
    textbook_text: str, channels: dict[str, tuple[str, list[str]]]
) -> list[dict]:
    """channels: 通道名 → (全文, 逐篇文本)。逐通道计数，因为它们是不同的生成路径。"""
    tb_per_m = len(CJK_G.findall(textbook_text)) / 1_000_000 or 1e-9
    rows = []
    for group, words in CANDIDATES.items():
        for w in words:
            tb_n = textbook_text.count(w)
            per_channel = {
                name: {"hits": text.count(w), "docs": sum(1 for d in docs if w in d)}
                for name, (text, docs) in channels.items()
            }
            rows.append(
                {
                    "word": w,
                    "group": group,
                    "textbook_hits": tb_n,
                    "textbook_per_m": round(tb_n / tb_per_m, 2),
                    "ours": per_channel,
                    "ours_hits": sum(c["hits"] for c in per_channel.values()),
                    "ours_docs": sum(c["docs"] for c in per_channel.values()),
                    # 判据：教材里一次都没出现过的，才进 lint。
                    # 教材自己在用的词，我们没有立场禁它——不管它看起来多像 AI 味。
                    "verdict": "进 lint" if tb_n == 0 else "剔除·教材在用",
                }
            )
    return rows


def context_of(word: str, text: str, width: int = 28) -> str:
    i = text.find(word)
    if i < 0:
        return ""
    return text[max(0, i - width) : i + len(word) + width].replace("\n", " ")


# ─────────────────────────────────────────────────────── 输出


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path)
    ap.add_argument(
        "--emit-lint",
        type=Path,
        help="把教材零命中的词表写成 lint 的数据文件（classroom 侧 import 它）",
    )
    args = ap.parse_args()

    corpora: list[dict] = []
    tb_texts: list[str] = []
    for label, root in TEXTBOOKS:
        if not root.is_dir():
            print(f"跳过 {label}：路径不存在 {root}")
            continue
        got = collect_corpus(label, load_textbook(root))
        if got:
            corpora.append(got[0])
            tb_texts.append(got[1])

    if not corpora:
        print("教材语料一份都没读到，停")
        return 1

    raw = {
        "探针资源": load_probe(),
        "成品课程·讲义": load_courses("canvas"),
        "成品课程·口播": load_courses("speech"),
    }
    ours: dict[str, tuple[str, list[str]]] = {}
    ours_rows = []
    for name, docs in raw.items():
        got = collect_corpus(f"【我们】{name} n={len(docs)}", docs)
        if not got:
            print(f"我们侧 {name} 读不到，跳过")
            continue
        ours_rows.append(got[0])
        ours[name] = (got[1], [strip_to_prose(d) for d in docs])
    if not ours:
        print("我们侧语料一份都没读到，停")
        return 1

    all_rows = corpora + ours_rows
    print(f"{'语料':<26}{'篇':>5}{'汉字':>9}{'句中位':>7}{'句P90':>7}{'句P99':>7}"
          f"{'加粗/千':>8}{'破折/千':>8}{'感叹/千':>8}{'排比/千':>8}{'你/千':>7}")
    print("-" * 108)
    for s in all_rows:
        print(f"{s['label']:<26}{s['files']:>5}{s['cjk']:>9}{s['sent_median']:>7.0f}"
              f"{s['sent_p90']:>7.0f}{s['sent_p99']:>7.0f}{s['bold_per_k']:>8.2f}"
              f"{s['emdash_per_k']:>8.2f}{s['bang_per_k']:>8.2f}{s['triple_per_k']:>8.2f}"
              f"{s['you_per_k']:>7.2f}")

    tb_all = "\n\n".join(tb_texts)
    ours_all = "\n\n".join(t for t, _ in ours.values())
    rows = word_table(tb_all, ours)

    enforce = [r for r in rows if r["verdict"] == "进 lint"]
    spared = [r for r in rows if r["verdict"] != "进 lint"]
    fired = sorted(
        (r for r in enforce if r["ours_hits"] > 0), key=lambda r: -r["ours_hits"]
    )

    print(f"\n候选 {len(rows)} 词：教材零命中 {len(enforce)} 个可进 lint，"
          f"{len(spared)} 个被教材自己的用法救下来。")

    print(f"\n【教材零命中 且 我们在用】——lint 该抓的就是这些（{len(fired)} 个）")
    print(f"{'词':<12}{'组':<10}{'合计':>5}{'篇':>4}  {'逐通道':<30}原文片段")
    for r in fired[:40]:
        per = "/".join(f"{k.split('·')[-1]}{v['hits']}" for k, v in r["ours"].items() if v["hits"])
        print(f"{r['word']:<12}{r['group']:<10}{r['ours_hits']:>5}{r['ours_docs']:>4}  "
              f"{per:<30}{context_of(r['word'], ours_all)[:40]}")
    if not fired:
        print("（无——这批语料里没抓到，但词表照样有效：它管的是以后生成的课）")

    print("\n【被教材救下来的候选】——看着像 AI 味，真教材自己在用，不许禁")
    for r in sorted(spared, key=lambda r: -r["textbook_hits"])[:20]:
        print(f"{r['word']:<14}{r['group']:<10}教材 {r['textbook_hits']:>4} 次  "
              f"{context_of(r['word'], tb_all)[:48]}")

    if args.emit_lint:
        # 只收「夸张修辞 / 时刻话术 / 呼告煽动 / 空洞分析 / 收尾套话」五组里教材零命中的词。
        # 「疑似误伤对照」那一组是拿来验方法的，本来就不该进 lint——即便某个词碰巧
        # 教材零命中，它也是被当作反例放进候选的，进表就是自证循环。
        groups = [g for g in CANDIDATES if g != "疑似误伤对照"]
        words = sorted(
            (r["word"] for r in enforce if r["group"] in groups), key=lambda w: (-len(w), w)
        )
        args.emit_lint.write_text(
            json.dumps(
                {
                    "_provenance": {
                        "script": "apps/agent-engine/scripts/experiments/textbook_prose_ladder.py",
                        "rule": "候选词在真实中文教材语料里出现 0 次 → 进表；教材自己在用 → 剔除",
                        "textbook_corpora": [s["label"] for s in corpora],
                        "textbook_cjk": sum(s["cjk"] for s in corpora),
                        "candidates": len(rows),
                        "spared_by_corpus": sorted(
                            r["word"] for r in spared
                        ),
                    },
                    "aiTells": words,
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"\n落盘 lint 词表 {args.emit_lint}（{len(words)} 词）")

    if args.json:
        args.json.write_text(
            json.dumps(
                {
                    "corpora": all_rows,
                    "candidates": rows,
                    "enforce": [r["word"] for r in enforce],
                    "spared": [r["word"] for r in spared],
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"\n落盘 {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
