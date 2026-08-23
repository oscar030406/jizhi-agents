r"""语料适配性前置闸：在花钱造课之前，先量一遍「这份语料够不够教」。

    python scripts/corpus_fitness.py                    # 全部库，只跑闸 A（零 LLM 零成本）
    python scripts/corpus_fitness.py --score ai iotdb odoo --sample 100   # 加跑闸 B
    python scripts/corpus_fitness.py --index cand=/tmp/cand.jsonl         # 量还没装进来的候选库

## 为什么要有这道闸

已有的四道就绪度闸（`readiness.json` 的 `gate0..gate3`）量的是**建成没建成**，
不是**够不够好**——所以 odoo 那份 `.po` 翻译件四道闸全绿，跑完一轮体检才发现
有据支持率只有 32.7%。那一轮的钱是白花的。

对照过的两家 RAG 产品在代码层都没有这一层（RAGFlow 只有 `is_parsed_done` 这类完成度
检查，Dify 只有配额与检索期 `score_threshold`）。出处：
`docs/05-evidence/kb-architecture-decision-20260816.md` §2.3。

## ⚠ 标定结果：两把尺子都不能落阈值（但两者的理由不一样，别合并成一句）

原本的设想是「长度画像 + 教育价值分能提前标红烂语料」。标定表在下面 `verdict`
上方的注释里。逐闸的结论：

- **闸 A（长度画像）：证伪。** 「超过一半条目短于 50 字符」那个数是在 **`.po` 条目**
  这一层量的，而条目会被拼成 markdown 段落再切块——**切完之后旧语料的块长中位数
  1315 字符，是七个库里最长的**。同一份语料换个粒度就从「一眼不合格」变成
  「一眼很好」。这条不依赖任何接地率数字，是纯语料事实。
- **闸 B（教育价值分）：没被证伪，但也不能落阈值。** 三域排序在全 run 口径下完全正确
  （ρ=+1.00），可 n=3 时置换检验双尾 p 的下限就是 0.333——与「随便排也有 1/3 概率
  排对」在统计上分不开；而加上唯一一份已知不合格的语料后排序就断。

所以本脚本现在的定位是：**长度画像与教育价值分只作画像不作结论**，
判灯只用一条与接地率无关、但确实拦得住的可行性判据（够不够铺一门课）。
两闸的数照跑照落盘——留着才能让上面这几句可复算，也是将来加够坐标后重标定的底子。

## 两条铁律（写死在这里，改之前先读 §2.3 的理由）

1. **只报警不拒绝。** 输出是库级红/黄/绿灯 + 最低分块清单给人看，**任何情况下都不删块、
   不拦生成**。我们自造过一道审核门，消融结果是零增益甚至负增益——教训是加闸容易，
   闸的假阳性代价没人算。只报警时假阳性代价≈0。
2. **没标定住就说没标定住，也别说过头。** 证伪条件是动工前写死的，跑出来不支持就照实
   标掉；但「证据不足」不等于「已被推翻」，两者要分开写，不换个指标凑一个能过的说法。

## 尺子的出处（都不是我们自己发明的）

- 闸 A 的判据取 Gopher 质量过滤器（Rae et al. 2021，实现见 HuggingFace datatrove
  `GopherQualityFilter`，Apache-2.0）九个阈值里**语言无关**的那几个：
  最短长度、符号比 0.1、项目符号行 0.9、省略号行 0.3。
  **明确弃用**它的英文停用词判据（`min_stop_words`，词表是 the/be/to/of…）与
  `max_non_alpha_words_ratio`——两条在中文语料上没有意义，照抄会把整个库判死。
- 闸 B 的五档定义逐字抄自 OpenCSG `chinese-fineweb-edu` 数据集卡（apache-2.0，
  https://huggingface.co/datasets/opencsg/chinese-fineweb-edu ，原生中文）。
  **档位定义一字未改**，改的只有「几分算及格」——那条线由 `LIGHTS` 自标定。

## 一处必须说明的口径改动

Gopher 的分母是**空格分词的词数**。中文不空格分词，直接照搬会让分母塌成个位数、
所有比值爆表。本脚本的分母改成 `汉字数 + 拉丁词数`（`_units()`），
这是**口径适配不是阈值篡改**：阈值 0.1 / 0.9 / 0.3 原样保留。
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

KB = ROOT / "data" / "knowledge_base"
OUT = KB / "fitness.json"

# 抽样种子。固定住才能复算——换种子结论就不可比。
SEED = 20260817

_CJK = re.compile(r"[一-鿿]")
_LATIN_WORD = re.compile(r"[A-Za-z0-9_.\-]+")
# datatrove 的项目符号集合（`GopherQualityFilter.bullet_point_symbols`）+ markdown 常用的 `-` `*`
_BULLET = ("- ", "* ", "+ ", "• ", "‣ ", "⁃ ", "· ", "– ", "— ")
_ELLIPSIS = ("...", "…")


def _units(text: str) -> int:
    """Gopher 分母的中文口径：汉字逐字计 + 拉丁词按空格计。见模块头「口径改动」。"""
    return max(1, len(_CJK.findall(text)) + len(_LATIN_WORD.findall(text)))


def _pct(part: int, whole: int) -> float:
    return round(100.0 * part / whole, 1) if whole else 0.0


def _quantile(values: list[int], q: float) -> int:
    """最近秩分位数。样本量小（玩具库 4 块）时插值没有意义，取最近秩更好解释。"""
    if not values:
        return 0
    s = sorted(values)
    return s[min(len(s) - 1, max(0, round(q * (len(s) - 1))))]


def profile_chunk(content: str, title: str) -> dict:
    """一个块的闸 A 特征。四个 `bad_*` 是 Gopher 阈值的逐块判定，库级取占比。"""
    text = content.strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    units = _units(text)
    cjk = len(_CJK.findall(text))
    # 符号比：Gopher 数 `#` 与 `...`。markdown 的标题井号是结构不是符号，先剥掉再数，
    # 否则六个库会被同一个 markdown 语法一起判死，这一格就没有区分度了。
    body = re.sub(r"^#{1,6}\s", "", text, flags=re.M)
    symbols = body.count("#") + body.count("...") + body.count("…")
    bullets = sum(1 for ln in lines if ln.startswith(_BULLET))
    ellipsis_lines = sum(1 for ln in lines if ln.endswith(_ELLIPSIS))
    return {
        "chars": len(text),
        "cjk_share": cjk / max(1, len(text)),
        # 标题路径：`ingest_domain.write_corpus_index` 的 title 是 " / ".join(heading_path)，
        # 抽不出标题时退回文件相对路径。所以「像个文件路径」= 这一块没有结构信号。
        "titled": bool(title.strip()) and not re.search(r"\.(md|txt|rst)$", title),
        "bad_short": len(text) < 50,
        "bad_symbol": symbols / units > 0.1,
        "bad_bullet": bool(lines) and bullets / len(lines) > 0.9,
        "bad_ellipsis": bool(lines) and ellipsis_lines / len(lines) > 0.3,
    }


def gate_a(rows: list[dict]) -> dict:
    """库级长度与结构画像。零 LLM，全部可复算。"""
    marks = [profile_chunk(r.get("content", ""), r.get("title", "")) for r in rows]
    n = len(marks)
    lengths = [m["chars"] for m in marks]
    return {
        "chunks": n,
        "chars_p10": _quantile(lengths, 0.10),
        "chars_median": _quantile(lengths, 0.50),
        "chars_p90": _quantile(lengths, 0.90),
        "short_pct": _pct(sum(m["bad_short"] for m in marks), n),
        "symbol_pct": _pct(sum(m["bad_symbol"] for m in marks), n),
        "bullet_pct": _pct(sum(m["bad_bullet"] for m in marks), n),
        "ellipsis_pct": _pct(sum(m["bad_ellipsis"] for m in marks), n),
        "titled_pct": _pct(sum(m["titled"] for m in marks), n),
        # 中文占比低 = 这一块基本是英文。中文课的语料里它就是「没译到」的那部分：
        # odoo 从 rst 原件重建时缺译会静默回落英文原文，这一格是那件事的量。
        "latin_heavy_pct": _pct(sum(1 for m in marks if m["cjk_share"] < 0.05), n),
    }


# ---------------------------------------------------------------------------
# 闸 B：教育价值抽样打分
# ---------------------------------------------------------------------------

# 五档定义逐字抄自 OpenCSG chinese-fineweb-edu 数据集卡（apache-2.0）。
# 一字未改是刻意的：改了档位定义，这把尺子就成了我们自己造的，跨语料不可比、对外也不可引。
# 它的语境是中小学网页语料，我们的是岗位培训技术文档——**这层错配用阈值自标定吸收**
# （见 `LIGHTS`），不靠改写档位来掩盖。
EDU_RUBRIC = """0分：如果网页没有提供任何教育价值,完全由无关信息(如广告、宣传材料)组成。
1分：如果网页提供了一些与教育主题相关的基本信息,即使包含一些无关或非学术内容(如广告和宣传材料)。
2分：如果网页涉及某些与教育相关的元素,但与教育标准不太吻合。
3分：如果网页适合教育使用,并介绍了与学校课程相关的关键概念。内容连贯但可能不全面,或包含一些无关信息。
4分：如果网页对不高于中学水平的教育目的高度相关和有益,表现出清晰一致的写作风格。
5分：如果摘录在教育价值上表现出色,完全适合小学或中学教学。它遵循详细的推理过程,写作风格易于理解。"""

EDU_SYSTEM = (
    "你是语料质量评审。下面给出一段中文资料的摘录，请按加分制评估它的教育价值。\n\n"
    + EDU_RUBRIC
    + "\n\n先用不超过 60 字说明理由，再给分。只输出一个 JSON 对象："
    '{"reason": "...", "score": 0-5 的整数}'
)

# 打分用的智能体名。`model_routing.AGENT_TIERS` 里没有它，会落到默认的 fast 档——
# 这是有意的：打一个 0-5 的分不值得上贵档，而且要打几百次。
AGENT = "CorpusFitnessScorer"


def score_blocks(rows: list[dict], sample: int, workers: int = 8) -> dict:
    """抽 `sample` 块打分。返回分布 + 逐块记录（含原文片段，供人工抽查复核）。

    抽样种子固定（`SEED`），同一份语料重跑抽到同一批块——不然两次结果不可比。
    """
    from concurrent.futures import ThreadPoolExecutor

    from backend.services.llm_gateway import LLMGateway

    gw = LLMGateway()
    if not gw.is_enabled(AGENT):
        raise SystemExit("打分档未启用。需要 AGENT_GENERATION_MODE=api 且配好 fast 档的 key。")
    rng = random.Random(SEED)
    picked = rng.sample(rows, min(sample, len(rows)))

    def one(r: dict) -> dict:
        body = (r.get("content") or "").strip()[:2000]
        got = gw.structured_chat(AGENT, EDU_SYSTEM, body, temperature=0.0, max_tokens=400)
        try:
            score = int((got or {}).get("score"))
        except (TypeError, ValueError):
            score = None
        return {
            "source_id": r.get("source_id"),
            "title": r.get("title"),
            "chars": len(body),
            "score": score if score is None or 0 <= score <= 5 else None,
            "reason": str((got or {}).get("reason", ""))[:200],
            "excerpt": body[:180],
        }

    with ThreadPoolExecutor(max_workers=workers) as pool:
        scored = list(pool.map(one, picked))

    ok = [s["score"] for s in scored if s["score"] is not None]
    hist = {str(k): sum(1 for v in ok if v == k) for k in range(6)}
    return {
        "sampled": len(picked),
        "scored": len(ok),
        "failed": len(scored) - len(ok),
        "mean": round(sum(ok) / len(ok), 2) if ok else None,
        "hist": hist,
        "ge2_pct": _pct(sum(1 for v in ok if v >= 2), len(ok)),
        "ge3_pct": _pct(sum(1 for v in ok if v >= 3), len(ok)),
        "lowest": sorted(
            (s for s in scored if s["score"] is not None), key=lambda s: (s["score"], s["chars"])
        )[:20],
        "all": scored,
    }


# ---------------------------------------------------------------------------
# 灯：阈值在这里，全部自标定
# ---------------------------------------------------------------------------

# ## 标定跑完了：两套接地率口径都算过，结论是「不能落阈值」
#
# 预注册的条件（工单裁决口径第 2 条）：拿三域接地率标定阈值，分数曲线若分不开这几个数，
# 这条闸作废。接地率有两套分母，不许混用（见 docs/05-evidence/audit-grounding-caveats-20260817.md）：
#
# A 口径（生产提示词 4-5 屏子集，既有结论用的这套，也是唯一能分开 odoo 新旧两版的）：
#
# | 臂 | 接地率 | 教育价值均分 | ≥3 分占比 | 块长中位 |
# |---|---|---|---|---|
# | ai         | 81.0% | 3.81 | 80% |  886 |
# | iotdb      | 50.0% | 2.47 | 57% |  887 |
# | odoo       | 48.6% | 1.65 | 37% |  658 |
# | odoo 旧语料 | 32.7% | 2.57 | 56% | 1315 |
#
# B 口径（该域全部 run 汇总、剔除未挂语料的屏）：ai 81.0% / iotdb 54.4% / odoo 20.7%。
#
# Spearman ρ（置换检验精确双尾 p）：
#   教育价值均分  A: +0.40 (p=0.75)   B: +1.00 (p=0.333)
#   ≥3 分占比    A: +0.80 (p=0.333)  B: +1.00 (p=0.333)
#   块长中位     A: −0.40 (p=0.75)   B: +0.50 (p=1.0)
#
# - **长度画像证伪**：接地率最低的旧语料块长中位 1315 字符，是全场最长的。
# - **教育价值分不能落阈值**：B 口径下排序全对（ρ=+1.00），但 n=3 时 p 的下限就是
#   0.333，与随机排对分不开；A 口径里加上旧语料后排序断裂——阈值画在 37 与 56 之间
#   的任何位置，都会把修好的语料标红、把坏的语料放行。
#
# 所以**两者都不作判灯依据**，数照跑照落盘，只作画像。要把这条闸推到能落阈值，
# 缺的不是指标是坐标：现在只有 3~4 个带接地率的语料，n=6~8 才可能拿到显著结果。
#
# 另一条不许引用的：两个玩具库（4 块 / 12 块）四屏体检全部未挂语料，**它们在接地率
# 这条轴上没有坐标**，既不能拿来验证这条闸也不能拿来推翻它。它们的红灯只由块数点。
#
# ## 灯只剩一条判据：这个库够不够铺一门课
#
# 这条与接地率无关，是纯粹的可行性，两个数都从盘上量出来：
#   - 一门课的屏数：课程墙 32 门课实测，中位 9.5 屏、最长 13 屏
#   - 每屏取的证据块数：6（`retriever.search` 默认 top_k，与 `evidence-grounding.ts` 一致）
# 零复用下，中位长度的一门课要 10×6=60 块，最长的一门要 13×6=78 块。
COURSE_SCENES_MEDIAN, COURSE_SCENES_MAX, TOP_K = 10, 13, 6
RED_CHUNKS = COURSE_SCENES_MEDIAN * TOP_K   # 60：中位长度的一门课都铺不满
YELLOW_CHUNKS = COURSE_SCENES_MAX * TOP_K   # 78：铺得满中位那门，铺不满最长那门


def verdict(a: dict) -> tuple[str, list[str]]:
    """红/黄/绿 + 每条理由一句人话。**只报警不拒绝**，返回值不参与任何拦截。"""
    n = a["chunks"]
    if n < RED_CHUNKS:
        return "red", [f"只有 {n} 个证据块，铺不满一门课（一门课中位 {COURSE_SCENES_MEDIAN} 屏、"
                       f"每屏取 {TOP_K} 块，零复用要 {RED_CHUNKS} 块）"]
    if n < YELLOW_CHUNKS:
        return "yellow", [f"{n} 个证据块，够一门中等长度的课，铺不满最长的那种"
                          f"（{COURSE_SCENES_MAX} 屏要 {YELLOW_CHUNKS} 块）"]
    return "green", []


def notes(a: dict) -> list[str]:
    """画像里值得人看一眼的地方。**不判灯**——这几条都没通过接地率标定，只是描述。"""
    out = []
    if a["short_pct"] >= 5.0:
        out.append(f"{a['short_pct']}% 的块短于 50 字符")
    if a["latin_heavy_pct"] >= 20.0:
        out.append(f"{a['latin_heavy_pct']}% 的块几乎不含中文")
    if a["titled_pct"] < 95.0:
        out.append(f"{round(100 - a['titled_pct'], 1)}% 的块没有标题路径")
    return out


# ---------------------------------------------------------------------------


def index_path(name: str) -> Path:
    """与引擎 `get_corpus_retriever` 同一条规则：默认语料 ai 在根，其余各自一个子目录。"""
    return KB / "knowledge_index.jsonl" if name == "ai" else KB / "corpora" / name / "knowledge_index.jsonl"


def load(path: Path) -> list[dict]:
    """只给活块。T1 之后索引里躺着归档块，不过滤的话素材量闸 A 会虚高约一倍
    （odoo 那种重建过的库直接翻倍），红黄绿灯当场判错——这个函数的产物是
    「够不够铺一门课」的判据，多数一倍等于把不够的库判成够。"""
    from backend.rag.ingest import read_index_rows

    return read_index_rows(path)


def discover() -> dict[str, Path]:
    found = {"ai": index_path("ai")}
    corpora = KB / "corpora"
    if corpora.is_dir():
        for d in sorted(corpora.iterdir()):
            if (d / "knowledge_index.jsonl").is_file():
                found[d.name] = d / "knowledge_index.jsonl"
    return {k: v for k, v in found.items() if v.is_file()}


def measure(path: Path) -> dict:
    """量一个库的闸 A 并判灯。零 API，0.6 秒跑完七个库（实测）。"""
    a = gate_a(load(path))
    light, why = verdict(a)
    try:  # 引擎目录外的候选库（--index）留绝对路径
        shown = str(path.relative_to(ROOT)).replace("\\", "/")
    except ValueError:
        shown = str(path)
    return {"index": shown, "gate_a": a, "light": light, "why": why, "notes": notes(a)}


def refresh(name: str) -> dict | None:
    """接入链跑完顺手更新这一个库的那一格。**只更新自己这一格**，别的库原样留着
    （它们的索引这次没动，重算等于把别人的 `gate_b` 白扔）。"""
    path = index_path(name)
    if not path.is_file():
        return None
    prior = json.loads(OUT.read_text(encoding="utf-8")) if OUT.is_file() else {}
    entry = {**prior.get("corpora", {}).get(name, {}), **measure(path)}
    report = {**prior, "generated_at": _now(), "seed": SEED, "light_rule": LIGHT_RULE,
              "corpora": {**prior.get("corpora", {}), name: entry}}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    return entry


def _now() -> str:
    from datetime import datetime

    return datetime.now().astimezone().isoformat(timespec="seconds")


LIGHT_RULE = {
    "red_below_chunks": RED_CHUNKS,
    "yellow_below_chunks": YELLOW_CHUNKS,
    "basis": f"一门课中位 {COURSE_SCENES_MEDIAN} 屏 / 最长 {COURSE_SCENES_MAX} 屏，"
             f"每屏取 {TOP_K} 块，零复用",
    "not_calibrated": "长度画像与教育价值分未通过接地率标定，不参与判灯；见脚本注释里的标定表",
}


def main() -> int:
    ap = argparse.ArgumentParser(description="语料适配性前置闸（只报警不拒绝）")
    ap.add_argument("--score", nargs="*", default=[], metavar="库名", help="对这些库加跑闸 B（要调模型）")
    ap.add_argument("--sample", type=int, default=100, help="闸 B 每库抽多少块（默认 100）")
    ap.add_argument("--workers", type=int, default=8, help="闸 B 并发数")
    ap.add_argument("--index", action="append", default=[], metavar="名=路径",
                    help="额外量一个还没装进来的候选库（可重复）")
    ap.add_argument("--out", default=str(OUT), help=f"报告落盘路径（默认 {OUT}）")
    args = ap.parse_args()

    targets = discover()
    for spec in args.index:
        name, _, p = spec.partition("=")
        targets[name] = Path(p)

    out_path = Path(args.out)
    prior = json.loads(out_path.read_text(encoding="utf-8")) if out_path.is_file() else {}
    report = {
        "generated_at": _now(),
        "seed": SEED,
        "light_rule": LIGHT_RULE,
        "corpora": prior.get("corpora", {}),
    }

    for name, path in targets.items():
        entry = {**report["corpora"].get(name, {}), **measure(path)}
        a, light, why = entry["gate_a"], entry["light"], entry["why"]
        if name in args.score:
            rows = load(path)
            print(f"  [{name}] 闸 B 抽样打分 {min(args.sample, len(rows))} 块…", flush=True)
            entry["gate_b"] = score_blocks(rows, args.sample, args.workers)
        report["corpora"][name] = entry
        print(f"{light.upper():6} {name:16} {a['chunks']:5} 块  中位 {a['chars_median']:5} 字符  "
              f"短块 {a['short_pct']:5}%  有标题 {a['titled_pct']:5}%  "
              + "；".join(why + entry["notes"]))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n报告落盘 {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
