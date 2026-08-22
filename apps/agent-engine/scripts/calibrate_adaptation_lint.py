"""适配 lint 指标的真数据校准（零 API，纯只读）。

用途：`docs/03-design/adaptation-lint-spec-20260811.md` 里每一个阈值/参照带的出处。
本项目铁律「审计尺子必须先对真数据校准再定罪」——这个脚本就是那次校准，
规格里的数字全部由它产出，改规格前先重跑它。

数据源（只读，一个字节都不写回）：
  data/eval/adaptation_probe/resources/*.json          54 份资源快照（纯净测同源）
  data/eval/adaptation_probe/runs/<run>/verdicts.jsonl 判官逐例判定

**口径（2026-08-11 修订，默认 --zone own）**：快照是**注入后**的成品（含 `📖 … —— 摘自`
教材原文），而 lint 实际跑在 `scene-generator.ts` 里注入**之前**的 md 上，看到的是
`{{摘录:id}}` 占位符。第一版阈值在成品上校准、却拿去卡占位符形态的文本，输入形态是错配的
（摘录占全文中位 54%，L2 唯一 A 类规则在真实输入上触发 0 次）。
现在默认先用 `strip_excerpts()` 把摘录块还原成占位符再算指标——这才是 lint 真看得见的文本。
`--zone full` 保留旧口径，只用于对照，两版数字不可比。

校准要回答的唯一问题：**这些机械指标能不能区分判官眼里的三档。**
所以主表按 `judgeA.tier`（判官实际给的档）分组，不是按 `target`（我们想要的档）。
两套都打出来对照——指标与判官的一致度高于与目标的一致度，才说明 lint 量到了
判官在看的东西；反过来则说明 lint 只是在复述我们自己的生成指令。

分离度用相邻档 AUC（Mann-Whitney 的概率形式）：随机各取一份，
高档那份指标值更大的概率。0.5 = 完全分不开，1.0 = 完全分开。
只看总体 Spearman 会被两端拉高，掩盖相邻档重叠——而我们 13 例 miss 全是相邻档漂移。

用法：
  python scripts/calibrate_adaptation_lint.py                 # 全量报告（自撰区口径）
  python scripts/calibrate_adaptation_lint.py --zone full     # 旧口径（注入后成品）对照
  python scripts/calibrate_adaptation_lint.py --bands         # 只打冻结用的参照带 JSON
  python scripts/calibrate_adaptation_lint.py --selftest      # 指标实现的自检
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import re
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROBE = ROOT / "data/eval/adaptation_probe"
RESOURCES = PROBE / "resources"
DEFAULT_RUN = "20260810-172357"

TIER_ORD = {"beginner": 1, "transition": 2, "advanced": 3}
TIERS = ["beginner", "transition", "advanced"]

# ---------------------------------------------------------------- 词表
# 唯一的人工资产，也是最脆的一环：换主题域（LLM → 具身智能）要重列。
# 刻意不收「模型/函数/程序/数据/训练」这类在三档里同样高频的通用词——
# 它们只加噪声不加区分度。收的是判官 because 里真正点过名的那类。
TERMS = [
    # attention / transformer
    "自注意力", "多头注意力", "交叉注意力", "注意力机制", "注意力",
    "Query", "Key", "Value", "查询向量", "键向量", "值向量",
    "点积", "缩放因子", "softmax", "归一化", "概率分布", "logits",
    "token", "词向量", "稠密向量", "稠密嵌入", "嵌入", "embedding",
    "矩阵乘法", "矩阵", "张量", "tensor", "转置", "matmul",
    "Transformer", "编码器", "解码器", "残差", "层归一化", "前馈网络",
    "dropout", "FlashAttention", "稀疏注意力", "掩码",
    # gradient / training
    "梯度消失", "梯度爆炸", "策略梯度", "梯度下降", "梯度",
    "反向传播", "学习率", "损失函数", "收敛", "优化器",
    "超参数", "参数", "权重", "迭代", "过拟合", "混合精度",
    "占用测度", "平稳分布", "方差",
    # kv-cache / inference
    "KV缓存", "KV Cache", "键值缓存", "缓存", "显存占用", "显存",
    "自回归", "序列长度", "上下文窗口", "吞吐", "延迟", "并发",
    "预填充", "prefill", "解码", "量化", "推理",
    # rag
    "检索增强", "向量数据库", "知识库", "召回", "重排", "rerank",
    "余弦相似度", "相似度", "TF-IDF", "BM25", "混合检索",
    "多查询扩展", "假设性文档嵌入", "语义检索", "分块", "索引", "RAG",
    # sampling
    "温度系数", "温度", "采样", "top-p", "top-k", "贪心解码",
    # agent / tooling
    "智能体", "工具调用", "function calling", "提示词", "prompt",
    "思维链", "自我反思", "大模型", "LLM", "客户端", "环境变量", "封装",
]
TERMS = sorted(set(TERMS), key=len, reverse=True)

DEFINE_RE = re.compile(r"是指|就是|叫做|称为|指的是|定义为|所谓|也就是|大白话|即指|换句话说|意思是|表示")
ANALOGY_RE = re.compile(r"就像|好比|类似于|想象一下|想象你|打个比方|相当于|可以理解为|如同|比作|好像|类似")
# 生产域词：L3 的正向特征（rubric「例子贴生产场景（吞吐/显存/线上退化）」）
PROD_RE = re.compile(
    r"吞吐|显存|QPS|线上|生产环境|生产级|集群|并发|部署|退化|SLA|GPU|"
    r"batch|工程实现|性能|开销|扩容|压测|服务化|高并发"
)
# 生活域词：L1 的正向特征（rubric「例子生活化非技术域」）
LIFE_RE = re.compile(
    r"餐厅|点餐|做菜|炒菜|厨房|服务员|排队|找书|图书馆|书架|快递|超市|"
    r"买菜|下山|爬山|雾天|报纸|电话|拨号|顾客|抽屉|钥匙|地图|导航"
)
MIN_RATIO_LINES = 3  # 注释比只在 ≥3 行的代码块上计算，见 code_blocks()
CJK_RE = re.compile(r"[一-鿿]")
# 断句：终止标点 + 空行。**不在单个换行处断**——本库一行是一个逻辑段而非折行，
# 摘录的连续两行常是同一句的两截。也**不把代码/注释行算进句子**：
# chinese_text_difficulty_metrics 台账的口径（整篇按终止标点+空行切）会让
# 代码围栏两侧的散文粘成一句，t2-kv-cache 的「118 字长句」就是这么来的（实测：
# 同一份文件，含代码 118 / 只算散文 64）。差异见本规格 §2 的口径说明。
SENT_SPLIT_RE = re.compile(r"[。！？；]|\n\s*\n")

# 代码行判据：去掉行内注释后没有中文，且带有代码结构记号
CODE_HINT_RE = re.compile(
    r"^\s*(import |from |def |class |return |print\(|if |for |while |with |try:|except|@)"
    r"|[A-Za-z_\]\)]\s*=[^=]|[A-Za-z_]\w*\s*\(|^\s{2,}\S"
)


# ---------------------------------------------------------------- 摘录还原
EXCERPT_PLACEHOLDER_RE = re.compile(r"\{\{\s*摘录\s*[:：]\s*([A-Za-z0-9_#-]+)\s*\}\}")
EXCERPT_TAG_RE = re.compile(r"\[([A-Za-z0-9_#-]+)\]\s*$")


def strip_excerpts(text: str) -> str:
    """注入后的成品 → 生成期的占位符形态（lint 真实看到的输入）。

    `evidence-grounding.ts:279` 的注入是 `{{摘录:sid}}` → `📖 正文\\n—— 摘自《标题》[sid]`。
    这里做它的逆：从 `📖` 那行到 `—— 摘自` 那行（含）整块换回 `{{摘录:sid}}`，
    sid 取 `摘自` 行末尾方括号里的出处 id。未闭合的摘录块（b1/b2-tool-calling 那类
    裁剪产物）按「到文末都是摘录」处理，与 segment() 同口径。
    """
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        if "📖" not in lines[i]:
            out.append(lines[i])
            i += 1
            continue
        j = i
        while j < len(lines) and not lines[j].lstrip().startswith("—— 摘自"):
            j += 1
        sid = ""
        if j < len(lines):
            m = EXCERPT_TAG_RE.search(lines[j].strip())
            sid = m.group(1) if m else ""
        out.append("{{摘录:%s}}" % (sid or "x#0"))
        i = j + 1
    return "\n".join(out)


# ---------------------------------------------------------------- 分区
def segment(text: str) -> list[dict]:
    """逐行打区：excerpt（教材摘录，自查环无权改写）/ formula / code / prose。

    摘录区 = 含 📖 的行到下一行 `—— 摘自` 为止（含）。这是 self_refine 台账
    2.2 用过的同一口径，判词归属就是按它定位的。
    """
    lines = text.split("\n")
    rows = [{"no": i + 1, "raw": l, "zone": "prose", "excerpt": False} for i, l in enumerate(lines)]

    in_ex = False
    for r in rows:
        if "📖" in r["raw"]:
            in_ex = True
        # 生成期是占位符、渲染后才是 📖…摘自，两种都算摘录区（与 TS 侧 segment 同口径）
        if in_ex or EXCERPT_PLACEHOLDER_RE.search(r["raw"]):
            r["excerpt"] = True
        if r["raw"].lstrip().startswith("—— 摘自"):
            in_ex = False

    in_math = False
    in_fence = False
    for r in rows:
        s = r["raw"].strip()
        if s.startswith("```"):
            r["zone"] = "code"
            in_fence = not in_fence
            continue
        if in_fence:
            r["zone"] = "code"
            continue
        if s == "$$":
            r["zone"] = "formula"
            in_math = not in_math
            continue
        if in_math:
            r["zone"] = "formula"
            continue

    # 围栏未闭合（摘录裁剪的产物，b1/b2-tool-calling 实例）：闭合到摘录结束行
    if in_fence:
        for r in reversed(rows):
            if r["zone"] == "code":
                break
    # 裸代码行（本库大多数代码没有围栏，见 b1-gradient / b2-attention）
    for r in rows:
        if r["zone"] != "prose":
            continue
        raw = r["raw"]
        if not raw.strip():
            continue
        code_part, _, comment_part = raw.partition("#")
        if code_part.strip() and not CJK_RE.search(code_part) and CODE_HINT_RE.search(code_part):
            r["zone"] = "code"
        elif not code_part.strip() and comment_part.strip():
            r["zone"] = "comment?"  # 待邻接确认
    for i, r in enumerate(rows):
        if r["zone"] != "comment?":
            continue
        near = [rows[j]["zone"] for j in (i - 1, i + 1) if 0 <= j < len(rows)]
        r["zone"] = "code" if "code" in near else "prose"
    return rows


def code_blocks(rows: list[dict]) -> list[dict]:
    """连续 code 行成块，容忍块内一行空行（a2-attention 的 import 后空行）。"""
    blocks, cur, gap = [], [], 0
    for r in rows:
        if r["zone"] == "code":
            cur.extend([None] * gap)
            gap = 0
            cur.append(r)
        elif cur and not r["raw"].strip() and gap == 0:
            gap = 1
        else:
            if cur:
                blocks.append(cur)
            cur, gap = [], 0
    if cur:
        blocks.append(cur)

    out = []
    for b in blocks:
        b = [r for r in b if r]
        code_n, comment_n = 0, 0
        for r in b:
            s = r["raw"].strip()
            if s.startswith("```"):
                continue
            if s.startswith("#") or s.startswith("//"):
                comment_n += 1
                continue
            if not s:
                continue
            code_n += 1
            if "#" in s and s.partition("#")[2].strip():
                comment_n += 1
        if code_n == 0:
            continue
        out.append(
            {
                "first": b[0]["no"],
                "last": b[-1]["no"],
                "code_n": code_n,
                "comment_n": comment_n,
                "ratio": comment_n / code_n,
                # 注释比只在 ≥3 行的块上有意义：1 行代码配 1 条注释算 1.00，纯噪声。
                # 实测：不设这条，t1/t3-kv-cache（各 1 行自撰代码）会被当成
                # 「逐行注释 = L1 姿态」误告警。
                "ratio_ok": code_n >= MIN_RATIO_LINES,
                "excerpt": any(r["excerpt"] for r in b),
            }
        )
    return out


def para_spans(text: str) -> list[tuple[int, int]]:
    """段落跨度（空行分段）。定义窗口不许跨段——隔着一个空行的「是指」不算给这个术语下定义。"""
    spans, start = [], 0
    for mm in re.finditer(r"\n\s*\n", text):
        spans.append((start, mm.start()))
        start = mm.end()
    spans.append((start, len(text)))
    return spans


def scan_terms(text: str) -> list[dict]:
    """首现术语扫描。长词优先掩码，避免「注意力」在「自注意力」里重复计数。"""
    mask = [False] * len(text)
    hits: dict[str, int] = {}
    low = text.lower()
    for t in TERMS:
        start = 0
        needle = t.lower()
        while True:
            i = low.find(needle, start)
            if i < 0:
                break
            if not any(mask[i : i + len(t)]):
                for k in range(i, i + len(t)):
                    mask[k] = True
                hits.setdefault(t, i)
                break  # 只要首现
            start = i + 1
    spans = para_spans(text)
    out = []
    for t, i in hits.items():
        ps, pe = next(((a, b) for a, b in spans if a <= i < b), (0, len(text)))
        win = text[max(ps, i - 20) : min(pe, i + 60)]
        out.append({"term": t, "pos": i, "defined": bool(DEFINE_RE.search(win) or ANALOGY_RE.search(win))})
    return sorted(out, key=lambda d: d["pos"])


BUILTIN = set(
    """print len range int str float list dict set tuple enumerate zip open sum max min abs
    type format sorted map filter round bool input any all isinstance super repr id next iter
    Step self""".split()
)
KEYWORD = set(
    """if elif else for while with try except finally return def class import from as in is
    not and or None True False lambda pass raise yield global assert del""".split()
)


def bare_symbols(rows: list[dict]) -> dict[str, list[str]]:
    """代码里用了、散文里从没交代过的外部符号（库名 / 未定义的调用名）。

    self_refine 台账 2.3 的「模型侧真实漏项」只剩这一类（torch/math/logits/store），
    自查环自评一轮也发现不了——正是「可机械验的就别让模型验」（IFEval）该管的。
    按区归属：摘录区的漏项改写不了，要走换素材/加缓冲。
    """
    prose = "\n".join(r["raw"] for r in rows if r["zone"] != "code")
    out: dict[str, list[str]] = {"own": [], "excerpt": []}
    for scope in ("own", "excerpt"):
        code = "\n".join(
            r["raw"] for r in rows if r["zone"] == "code" and r["excerpt"] == (scope == "excerpt")
        )
        syms: set[str] = set()
        for m in re.finditer(r"^\s*import\s+([A-Za-z_][\w.]*)", code, re.M):
            syms.add(m.group(1).split(".")[0])
        for m in re.finditer(r"^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+([^\n]+)", code, re.M):
            syms.add(m.group(1).split(".")[0])
            syms.update(x.strip() for x in m.group(2).split(",") if x.strip().isidentifier())
        syms.update(m.group(1) for m in re.finditer(r"\b([A-Za-z_]\w*)\.\w+\s*\(", code))
        syms.update(m.group(1) for m in re.finditer(r"\b([A-Za-z_]\w*)\s*\(", code))
        local = set(re.findall(r"^\s*(?:def|class)\s+([A-Za-z_]\w*)", code, re.M))
        local |= set(re.findall(r"^\s*([A-Za-z_]\w*)\s*=[^=]", code, re.M))
        out[scope] = sorted(
            s
            for s in syms
            if len(s) > 1
            and s not in BUILTIN
            and s not in KEYWORD
            and s not in local
            and not re.search(r"\b" + re.escape(s) + r"\b", prose, re.I)
        )
    return out


# ---------------------------------------------------------------- 指标
def metrics(text: str) -> dict:
    rows = segment(text)
    blocks = code_blocks(rows)
    prose = "\n".join(r["raw"] for r in rows if r["zone"] in ("prose", "formula"))
    cjk = len(CJK_RE.findall(text))
    k = max(cjk, 1) / 1000.0
    h = max(cjk, 1) / 100.0

    terms = scan_terms(text)
    undef = [t for t in terms if not t["defined"]]

    sents = [s for s in SENT_SPLIT_RE.split(prose) if CJK_RE.search(s)]
    slen = [len(CJK_RE.findall(s)) for s in sents]

    non_ex = [b for b in blocks if not b["excerpt"]]
    prod = len(PROD_RE.findall(text)) / k
    life = len(LIFE_RE.findall(text)) / k
    bare = bare_symbols(rows)
    return {
        "bare_symbol_n": len(bare["own"]) + len(bare["excerpt"]),
        "bare_symbol_own": len(bare["own"]),
        "_bare": bare,
        "code_min_comment_ratio": min((b["ratio"] for b in blocks if b["ratio_ok"]), default=None),
        "code_min_comment_ratio_own": min((b["ratio"] for b in non_ex if b["ratio_ok"]), default=None),
        "code_max_block_own": max((b["code_n"] for b in non_ex), default=0),
        "domain_skew": prod - life,
        "uniq_term_per100": len(terms) / h,
        "undef_term_rate": len(undef) / len(terms) if terms else None,
        "code_lines": sum(b["code_n"] for b in blocks),
        "sent_max": max(slen, default=0),
        # —— 以下为候选/对照，最终未进指标集，留着是为了能复现「为什么砍掉它」
        "code_max_block": max((b["code_n"] for b in blocks), default=0),
        "analogy_per1k": len(ANALOGY_RE.findall(text)) / k,
        "longsent_per1k": sum(1 for x in slen if x > 60) / k,
        "prod_per1k": prod,
        "life_per1k": life,
        "undef_term_n": len(undef),
        "define_n": len(DEFINE_RE.findall(text)),
        "cjk": cjk,
        "chars": len(text),
        "_blocks": blocks,
        "_terms": terms,
        "_excerpt_chars": sum(len(r["raw"]) for r in rows if r["excerpt"]),
    }


# 最终指标集（规格 §1 的 M1-M5）。
# sent_max（原 M6）在自撰区口径下出局：相邻档 sep 0.30/0.25（置换 p 0.129/0.200），
# 且 miss-vs-hit AUC 从旧口径的 0.70 掉到 0.42——那个「长句预示判偏」的信号在摘录里，
# 不在模型自撰的那半篇。留在候选池里，砍它的理由要能复现。
KEEP = [
    "code_min_comment_ratio",
    "code_lines",
    "uniq_term_per100",
    "bare_symbol_n",
    "domain_skew",
]
# 候选池：进不了指标集的也要打出来，砍掉的理由要能复现
REPORTED = KEEP + [
    "sent_max",
    "bare_symbol_own",
    "undef_term_rate",
    "code_max_block",
    "analogy_per1k",
    "longsent_per1k",
    "prod_per1k",
    "life_per1k",
    "undef_term_n",
    "define_n",
]


# ---------------------------------------------------------------- 统计
def auc(hi: list[float], lo: list[float]) -> float | None:
    """P(随机取的 hi 档样本 > lo 档样本)，平局记 0.5。"""
    if not hi or not lo:
        return None
    n = 0.0
    for a in hi:
        for b in lo:
            n += 1.0 if a > b else (0.5 if a == b else 0.0)
    return n / (len(hi) * len(lo))


def spearman(xs: list[float], ys: list[float]) -> float | None:
    """ρ 只用来跟 chinese_text_difficulty_metrics 台账的数字对照，不参与定阈值。
    定阈值看的是相邻档 AUC（见模块 docstring）。"""
    if len(xs) < 3:
        return None
    from scipy.stats import spearmanr  # 已在依赖里，平局校正照它的口径

    r = float(spearmanr(xs, ys).statistic)
    return None if r != r else r


def pct(v: list[float], p: float) -> float:
    if not v:
        return float("nan")
    s = sorted(v)
    i = (len(s) - 1) * p
    lo, hi = int(i), min(int(i) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)


# ---------------------------------------------------------------- 主流程
def load(run: str, zone: str = "own") -> list[dict]:
    """zone='own'：指标算在剥掉摘录后的自撰区（lint 真实输入的等价形态，默认）。
    zone='full'：算在注入后的成品上（第一版口径，只留作对照）。"""
    verdicts = {}
    for line in (PROBE / "runs" / run / "verdicts.jsonl").open(encoding="utf-8"):
        v = json.loads(line)
        verdicts[v["caseId"]] = v
    rows = []
    for f in sorted(RESOURCES.glob("*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        v = verdicts.get(d["caseId"], {})
        text = strip_excerpts(d["text"]) if zone == "own" else d["text"]
        rows.append(
            {
                "case": d["caseId"],
                "target": d["tier"],
                "judgeA": (v.get("judgeA") or {}).get("tier"),
                "judgeB": (v.get("judgeB") or {}).get("tier"),
                "borderline": bool((v.get("judgeA") or {}).get("borderline")),
                "text": text,
                "full": d["text"],
                "hit": v.get("hit"),
                "m": metrics(text),
            }
        )
    return rows


def sep(a: float | None) -> float:
    """方向无关的分离度：|AUC-0.5|×2。0 = 完全分不开，1 = 完全分开。"""
    return float("nan") if a is None else abs(a - 0.5) * 2


def sep_perm_p(hi: list[float], lo: list[float], n: int = 2000, seed: int = 20260811) -> float:
    """置换检验：把两档标签打乱 n 次，看有多少次的 sep 不小于实测值。

    n=18/档，sep 看着像 0.5 也可能纯属抽样噪声。砍规则要有噪声地板，
    不能只盯着一个点估计。p 大 = 这条「分离度」跟随机分组没区别。
    """
    obs = sep(auc(hi, lo))
    if obs != obs:
        return float("nan")
    pool = list(hi) + list(lo)
    rng = random.Random(seed)
    k = 0
    for _ in range(n):
        rng.shuffle(pool)
        if sep(auc(pool[: len(hi)], pool[len(hi) :])) >= obs - 1e-12:
            k += 1
    return (k + 1) / (n + 1)


def group_table(rows: list[dict], key: str, name: str) -> None:
    print(f"\n### 按 {name}（{key}）分组：中位数 / 相邻档分离度（p = 置换检验 2000 次）\n")
    print(f"{'指标':<24}{'beginner':>11}{'transition':>11}{'advanced':>11}"
          f"{'sep b|t':>9}{'p':>7}{'sep t|a':>9}{'p':>7}{'ρ':>8}")
    print("-" * 95)
    for k in REPORTED:
        vals = {t: [r["m"][k] for r in rows if r[key] == t and r["m"][k] is not None] for t in TIERS}
        med = {t: (statistics.median(v) if v else float("nan")) for t, v in vals.items()}
        a_bt = auc(vals["transition"], vals["beginner"])
        a_ta = auc(vals["advanced"], vals["transition"])
        p_bt = sep_perm_p(vals["transition"], vals["beginner"])
        p_ta = sep_perm_p(vals["advanced"], vals["transition"])
        pair = [(r["m"][k], TIER_ORD[r[key]]) for r in rows if r[key] in TIER_ORD and r["m"][k] is not None]
        rho = spearman([p[0] for p in pair], [p[1] for p in pair])
        mark = "*" if k in KEEP else " "
        print(f"{mark}{k:<23}{med['beginner']:>11.2f}{med['transition']:>11.2f}{med['advanced']:>11.2f}"
              f"{sep(a_bt):>9.2f}{p_bt:>7.3f}{sep(a_ta):>9.2f}{p_ta:>7.3f}"
              f"{(rho if rho is not None else float('nan')):>8.3f}")


def pooled_missability(rows: list[dict]) -> None:
    """档位无关的「会不会被判官判偏」：miss vs hit 的 AUC。

    有的指标分不开三档，却能分开命中与未命中（sent_max 就是）——
    它的用途不是判档，是标风险。这两件事必须分开报，否则会误以为它没用。
    """
    print("\n### 档位无关：未命中 vs 命中 的 AUC（>0.5 = miss 侧数值更大）\n")
    print(f"{'指标':<24}{'AUC':>7}{'sep':>7}{'hit中位':>10}{'miss中位':>10}")
    print("-" * 58)
    for k in REPORTED:
        hv = [r["m"][k] for r in rows if r["hit"] == 1 and r["m"][k] is not None]
        mv = [r["m"][k] for r in rows if r["hit"] != 1 and r["m"][k] is not None]
        a = auc(mv, hv)
        mark = "*" if k in KEEP else " "
        print(f"{mark}{k:<23}{a:>7.2f}{sep(a):>7.2f}"
              f"{statistics.median(hv):>10.2f}{statistics.median(mv):>10.2f}")


def stability(rows: list[dict]) -> None:
    """留一主题交叉：每次扣掉一个主题的 9 份重算分离度，看数字抖多少。

    n=54、无留出集，词表又是看着这批数据写的——过拟合风险必须量化，
    不能只报一个好看的全样本数字。
    """
    topics = sorted({r["case"].split("-", 1)[1] for r in rows})
    print(f"\n### 留一主题交叉（{len(topics)} 个主题，每次扣 9 份）：分离度的最差/最好\n")
    print(f"{'指标':<24}{'sep b|t 全样本':>15}{'留一区间':>18}{'sep t|a 全样本':>15}{'留一区间':>18}")
    print("-" * 92)
    for k in KEEP:
        def s(sub, hi, lo):
            v = {t: [r["m"][k] for r in sub if r["judgeA"] == t and r["m"][k] is not None] for t in TIERS}
            return sep(auc(v[hi], v[lo]))
        full_bt, full_ta = s(rows, "transition", "beginner"), s(rows, "advanced", "transition")
        loo_bt, loo_ta = [], []
        for tp in topics:
            sub = [r for r in rows if not r["case"].endswith("-" + tp)]
            loo_bt.append(s(sub, "transition", "beginner"))
            loo_ta.append(s(sub, "advanced", "transition"))
        print(f"{k:<24}{full_bt:>15.2f}{f'[{min(loo_bt):.2f}, {max(loo_bt):.2f}]':>18}"
              f"{full_ta:>15.2f}{f'[{min(loo_ta):.2f}, {max(loo_ta):.2f}]':>18}")


def sides_with(rows: list[dict]) -> None:
    """判官与目标档打架时，机械指标站哪边？

    这是「lint 量的是判官在看的东西，不是复述我们自己的生成指令」的关键证据，
    也是反作弊那一节要挡的质疑。做法：用各档**命中样本**的中位剖面当锚，
    把每份资源的 6 项指标做稳健标准化（减全样本中位、除全样本 IQR），
    算它到三个锚的平均曼哈顿距离，看最近的那个锚是 judgeA 判的档还是目标档。
    只统计 judgeA != target 的那些例——一致的例子里两边同答案，没有信息量。
    """
    scale = {}
    for k in KEEP:
        v = sorted(x["m"][k] for x in rows if x["m"][k] is not None)
        iqr = pct(v, 0.75) - pct(v, 0.25)
        scale[k] = (pct(v, 0.5), iqr if iqr > 0 else 1.0)

    anchor = {}
    for t in TIERS:
        hit = [r for r in rows if r["target"] == t and r["hit"] == 1]
        anchor[t] = {
            k: statistics.median(
                [(r["m"][k] - scale[k][0]) / scale[k][1] for r in hit if r["m"][k] is not None]
            )
            for k in KEEP
        }

    def nearest(m: dict) -> str:
        d = {}
        for t in TIERS:
            vals = [
                abs((m[k] - scale[k][0]) / scale[k][1] - anchor[t][k])
                for k in KEEP
                if m[k] is not None
            ]
            d[t] = statistics.fmean(vals)
        return min(d, key=lambda x: d[x])

    dis = [r for r in rows if r["judgeA"] != r["target"]]
    j = sum(1 for r in dis if nearest(r["m"]) == r["judgeA"])
    g = sum(1 for r in dis if nearest(r["m"]) == r["target"])
    print(f"\n### 判官与目标打架的 {len(dis)} 例，指标剖面站哪边\n")
    print(f"  站判官 A 这边 {j} 例 / 站目标档这边 {g} 例 / 都不是 {len(dis) - j - g} 例")
    for r in dis:
        print(f"  {r['case']:18s} target={r['target']:<11s} judgeA={str(r['judgeA']):<11s} "
              f"指标最近档={nearest(r['m'])}")
    same = [r for r in rows if r["judgeA"] == r["target"]]
    acc_same = sum(1 for r in same if nearest(r["m"]) == r["target"]) / len(same)
    acc_all = sum(1 for r in rows if nearest(r["m"]) == r["target"]) / len(rows)
    acc_j = sum(1 for r in rows if nearest(r["m"]) == r["judgeA"]) / len(rows)
    j_acc = sum(1 for r in rows if r["judgeA"] == r["target"]) / len(rows)
    print(f"  对照 1：判官与目标一致的 {len(same)} 例里，指标剖面同答案的占 {acc_same:.0%}")
    print(f"  对照 2：把「最近档」当分类器直接判 {len(rows)} 例——对目标档 {acc_all:.1%}、"
          f"对判官 A {acc_j:.1%}（判官 A 自己对目标档 {j_acc:.1%}）。")
    print("         读法：对目标档高、对判官低，说明剖面量到的是**我们自己下的分档指令**"
          "被执行成什么样，不是判官的答案。这是反作弊那一节要的方向，但也意味着"
          "它预测不了判官——lint 不当分档器，只标形态越界。")


def para_term_check(rows: list[dict]) -> None:
    """rubric 字面口径「单段新术语不超过 2 个」实测——规格 §5 引用这张表。

    结论是字面口径不如全文密度稳：同样的召回，误触发多一倍。
    """
    print("\n### rubric 字面口径「单段新术语 ≤2」实测（按空行分段）\n")
    print(f"{'档':<12}{'命中中位':>10}{'未命中中位':>12}   命中分布")
    print("-" * 78)
    for t in TIERS:
        def mx(r):
            spans = para_spans(r["text"])
            c: dict[tuple[int, int], int] = {}
            for x in r["m"]["_terms"]:
                for a, b in spans:
                    if a <= x["pos"] < b:
                        c[(a, b)] = c.get((a, b), 0) + 1
                        break
            return max(c.values(), default=0)
        hv = sorted(mx(r) for r in rows if r["target"] == t and r["hit"] == 1)
        mv = sorted(mx(r) for r in rows if r["target"] == t and r["hit"] != 1)
        tp = sum(1 for v in mv if v > 2)
        fp = sum(1 for v in hv if v > 2)
        print(f"{t:<12}{statistics.median(hv):>10}{statistics.median(mv):>12}   {hv}")
        print(f"{'':<12}阈值 >2 当门：召回 {tp}/{len(mv)}，误触发 {fp}/{len(hv)}")


def bands(rows: list[dict], keep: list[str]) -> dict:
    """参照带 = 各目标档里**判官判对**的样本的 P10–P90。

    只用命中样本，因为参照带要描述的是「判官认可为本档」的形态；
    用全部样本会把 miss 的越界形态算进带内，带宽被自己的错误撑开。
    """
    out = {}
    for t in TIERS:
        sub = [r for r in rows if r["target"] == t and r["hit"] == 1]
        out[t] = {"n": len(sub)}
        for k in keep:
            v = [r["m"][k] for r in sub if r["m"][k] is not None]
            out[t][k] = {
                "n": len(v),
                # 阈值政策要的是「本档命中样本的最大/最小观测」，所以 min/max 必须在带里，
                # 不能只有分位数——不然阈值是从哪来的复现不出来。
                "min": round(min(v), 3) if v else None,
                "p10": round(pct(v, 0.10), 3),
                "p50": round(pct(v, 0.50), 3),
                "p90": round(pct(v, 0.90), 3),
                "max": round(max(v), 3) if v else None,
            }
    return out


def hitmiss(rows: list[dict], keep: list[str]) -> None:
    print("\n### 每档 命中 vs 未命中 的中位数（lint 想拦的就是这个差）\n")
    print(f"{'档':<12}{'指标':<24}{'hit中位':>10}{'miss中位':>10}{'n hit':>7}{'n miss':>8}")
    print("-" * 71)
    for t in TIERS:
        for k in keep:
            hv = [r["m"][k] for r in rows if r["target"] == t and r["hit"] == 1 and r["m"][k] is not None]
            mv = [r["m"][k] for r in rows if r["target"] == t and r["hit"] != 1 and r["m"][k] is not None]
            if not hv or not mv:
                continue
            print(f"{t:<12}{k:<24}{statistics.median(hv):>10.2f}{statistics.median(mv):>10.2f}"
                  f"{len(hv):>7}{len(mv):>8}")


def excerpt_share(rows: list[dict]) -> None:
    """违规落在摘录区还是模型自撰区——决定 lint 触发的是「改写」还是「换素材」。

    这一节**一律在注入后的成品上算**（`r["full"]`），与主表的自撰区口径无关：
    它要回答的正是「判官读到的那半篇里，lint 够不着的是多少」。
    self_refine 台账 2.1：自查环 prompt 明令「摘录占位符原样保留」，
    所以落在摘录区的违规，让模型改写是白花一次调用。
    """
    print("\n### 违规落点：摘录区 vs 模型自撰区（在注入后成品上算，决定触发什么动作）\n")
    full = {r["case"]: metrics(r["full"]) for r in rows}
    blocks = [b for r in rows for b in full[r["case"]]["_blocks"]]
    ex_b = sum(1 for b in blocks if b["excerpt"])
    print(f"代码块总数 {len(blocks)}：摘录区 {ex_b}，模型自撰区 {len(blocks) - ex_b}")
    sub = [r for r in rows if r["target"] == "beginner"]
    bad = lambda b: (b["ratio_ok"] and b["ratio"] < 0.8) or b["code_n"] > 5  # noqa: E731
    ve = sum(1 for r in sub for b in full[r["case"]]["_blocks"] if b["excerpt"] and bad(b))
    vo = sum(1 for r in sub for b in full[r["case"]]["_blocks"] if not b["excerpt"] and bad(b))
    print(f"beginner 档按 rubric L1 两条硬判据（注释比<0.8 或 单块>5 行）计的违规代码块："
          f"摘录区 {ve}，模型自撰区 {vo}")
    be = sum(len(full[r["case"]]["_bare"]["excerpt"]) for r in sub)
    bo = sum(len(full[r["case"]]["_bare"]["own"]) for r in sub)
    print(f"beginner 档裸符号：摘录区 {be} 个，模型自撰区 {bo} 个")
    ex = [full[r["case"]]["_excerpt_chars"] / max(full[r["case"]]["chars"], 1) for r in rows]
    print(f"摘录区字符占全文比例，中位 {statistics.median(ex):.2f}")
    shrink = [r["m"]["cjk"] / max(full[r["case"]]["cjk"], 1) for r in rows]
    print(f"剥掉摘录后中文字数只剩原文的 {statistics.median(shrink):.2f}（中位）"
          f"——lint 能改的就这么多")


# ---------------------------------------------------------------- 规则
# 规格 §3 的触发条件。**全部在自撰区口径（--zone own）上重校准，与第一版数字不可比。**
# 阈值口径：
#   有外部锚的用外部锚（R = Riehle ICSE'09 OSS 注释比 18.7%±10.9%；rubric v2 明文）；
#   其余一律用「本档命中样本」的观测边界当参照带，不用绝对切点
#   （chinese_text_difficulty_metrics 台账第六节：n=18/档，绝对切点必然过拟合）。
# 动作类：A = 定向改写（+1 次 LLM 调用），B = 只记警告不调模型
#   （素材厚度这类问题不是改写能解决的，动作在检索侧）
# 留用线：相邻档分离度 sep < 0.5 的指标，不许再以「分档信号」的名义支撑 A 类规则。
#   据此砍掉 L2-LONGSENT（M6，sep 0.30/0.25）、L2-BARE 与 L3-THIN-CODE（M2 t|a sep 0.28,
#   p=0.145；旧阈值 <10 在本口径上误触发 10/13）。L1-BARE 留用但改挂 rubric 明文锚，
#   不声称它是分档信号（M4 sep 0.47）。
def _own_ratio_gt(m: dict, x: float) -> bool:
    """自撰区注释比 > x。没有够长的自撰代码块时一律不触发（无证据不定罪）。"""
    v = m["code_min_comment_ratio_own"]
    return v is not None and v > x


def _all_ratio(m: dict) -> float:
    v = m["code_min_comment_ratio"]
    return 1.0 if v is None else v


RULES: dict[str, list[tuple[str, str, object]]] = {
    "beginner": [
        ("A", "L1-TERM     术语密度 >2.3/百字（本档命中样本最大观测 2.203 上取整）",
         lambda m: m["uniq_term_per100"] > 2.3),
        ("A", "L1-BARE     自撰区裸符号 ≥2（rubric 明文阈值是 0，放到 2 是给缩写留余量）",
         lambda m: m["bare_symbol_own"] >= 2),
        ("A", "L1-SOFT-DOMAIN 例子域偏置 >1.0（拿生产场景给零基础举例）〔护栏〕",
         lambda m: m["domain_skew"] > 1.0),
        ("B", "L1-CODE     某代码块注释比 <0.8 或 >5 行（rubric v2 明文 + Riehle 锚）",
         lambda m: _all_ratio(m) < 0.8 or m["code_max_block"] > 5),
    ],
    "transition": [
        ("A", "L2-SOFT-CODE 自撰代码块注释比 >0.8（逐行手把手 = 掉回 L1 姿态）",
         lambda m: _own_ratio_gt(m, 0.8)),
        ("A", "L2-HARD-DOMAIN 例子域偏置 >6.5（本档命中样本最大观测 6.452 上取整）",
         lambda m: m["domain_skew"] > 6.5),
    ],
    "advanced": [
        ("A", "L3-SOFT-COMMENT 自撰代码块注释比 >0.25（本档命中样本最大观测）〔护栏〕",
         lambda m: _own_ratio_gt(m, 0.25)),
        ("A", "L3-SOFT-LIFE 例子域偏置 <0（生活域词压过生产域词）〔护栏〕",
         lambda m: m["domain_skew"] < 0),
        ("B", "L3-THIN-DOMAIN 例子域偏置 <2.8（本档命中样本最小观测 2.833 下取整）",
         lambda m: m["domain_skew"] < 2.8),
    ],
}


def gate_sim(rows: list[dict]) -> None:
    """把阈值当触发器跑一遍：召回多少 miss、在命中样本上误触发多少。

    误触发不是零成本——每一次都是一次多余的 LLM 改写调用，而且改写有 EIR
    （引入新错误的概率）。假阳率必须摆在台面上，不许只报召回。
    """
    for cls, what in (("A", "A 类=定向改写，每次 +1 LLM 调用"), ("B", "B 类=只记警告，0 调用")):
        print(f"\n### 触发模拟 · {what}\n")
        print(f"{'档':<12}{'触发 miss':>12}{'触发 hit':>12}{'误触发率':>10}{'本档触发率':>12}")
        print("-" * 60)
        for t in TIERS:
            sub = [r for r in rows if r["target"] == t]
            rs = [fn for c, _, fn in RULES[t] if c == cls]
            tp = fp = nm = nh = 0
            for r in sub:
                fired = any(fn(r["m"]) for fn in rs)
                if r["hit"] == 1:
                    nh += 1
                    fp += fired
                else:
                    nm += 1
                    tp += fired
            print(f"{t:<12}{f'{tp}/{nm}':>12}{f'{fp}/{nh}':>12}"
                  f"{(fp / nh if nh else 0):>10.0%}{f'{tp + fp}/{len(sub)}':>12}")

    print("\n逐条规则的贡献（触发 miss / 触发 hit）：")
    for t in TIERS:
        sub = [r for r in rows if r["target"] == t]
        nm = sum(1 for r in sub if r["hit"] != 1)
        nh = len(sub) - nm
        for cls, label, fn in RULES[t]:
            tp = sum(1 for r in sub if r["hit"] != 1 and fn(r["m"]))
            fp = sum(1 for r in sub if r["hit"] == 1 and fn(r["m"]))
            print(f"  [{cls}] {label:<62} {tp}/{nm}   {fp}/{nh}")
    print("\n未被任何规则触发的 miss（机械上拦不住的）：")
    for t in TIERS:
        for r in rows:
            if r["target"] == t and r["hit"] != 1 and not any(fn(r["m"]) for _, _, fn in RULES[t]):
                print(f"  {r['case']} (target={t}, judgeA={r['judgeA']}, judgeB={r['judgeB']})")


def selftest() -> None:
    t = "\n".join([
        "标题",
        "",
        "# 这是注释",
        "x = matmul(a, b)  # 行内注释",
        "y = softmax(x)",
        "z = relu(y)",
        "",
        "📖 教材原话，注意力机制是指对信息加权。",
        "```python",
        "class Foo:",
        "    def bar(self):",
        "        return 1",
        "```",
        "—— 摘自《某书》[x#1]",
    ])
    m = metrics(t)
    bs = m["_blocks"]
    assert len(bs) == 2, bs
    own = [b for b in bs if not b["excerpt"]][0]
    assert own["code_n"] == 3 and own["comment_n"] == 2, own      # 上方注释 + 行内注释都算
    ex = [b for b in bs if b["excerpt"]][0]
    assert ex["code_n"] == 3 and ex["comment_n"] == 0, ex
    assert m["code_min_comment_ratio"] == 0.0
    assert abs(m["code_min_comment_ratio_own"] - 2 / 3) < 1e-9
    terms = {x["term"]: x["defined"] for x in m["_terms"]}
    assert terms.get("注意力机制") is True, terms                  # 「是指」在同段 60 字窗内
    assert terms.get("matmul") is False, terms                     # 跨段的「是指」不算
    # $$ 公式不能被当成代码
    m2 = metrics("公式如下：\n$$\nattention(Q,K,V) = softmax(QK^T)V\n$$\n结束。")
    assert m2["code_lines"] == 0, m2["code_lines"]
    # 1-2 行的代码块不参与注释比（避免「1 行代码 1 条注释 = 1.00」的噪声）
    m3 = metrics("看这里：\n\n# 说明\nx = foo(1)\n")
    assert m3["code_min_comment_ratio"] is None and m3["code_lines"] == 1, m3["code_lines"]
    # 裸符号：代码里用了、散文里没交代过
    assert m["_bare"]["own"] == ["matmul", "relu", "softmax"], m["_bare"]
    # 摘录还原：整块换回占位符，摘录里的代码块随之消失，自撰区那块原样留下
    s = strip_excerpts(t)
    assert "{{摘录:x#1}}" in s, s
    assert "📖" not in s and "class Foo" not in s, s
    ms = metrics(s)
    assert len(ms["_blocks"]) == 1 and not ms["_blocks"][0]["excerpt"], ms["_blocks"]
    assert ms["code_min_comment_ratio"] == m["code_min_comment_ratio_own"]
    # 未闭合的摘录块（裁剪产物）：吃到文末，不留半截教材代码
    assert strip_excerpts("正文\n📖 教材\nimport torch") == "正文\n{{摘录:x#0}}"
    print("selftest ok")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default=DEFAULT_RUN)
    ap.add_argument("--zone", choices=("own", "full"), default="own",
                    help="own=剥掉摘录的自撰区（lint 真实输入，默认）；full=注入后成品（旧口径对照）")
    ap.add_argument("--bands", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return

    rows = load(args.run, args.zone)
    if args.bands:
        print(json.dumps(bands(rows, KEEP + ["code_max_block"]), ensure_ascii=False, indent=2))
        return

    print(f"口径 zone={args.zone}"
          f"（own = 剥掉 📖…摘自 摘录块后的自撰区，等价于 lint 在注入前看到的占位符形态）")
    print(f"run={args.run}  n={len(rows)}  "
          f"judgeA 命中 {sum(1 for r in rows if r['judgeA'] == r['target'])}/{len(rows)}  "
          f"final 命中 {sum(1 for r in rows if r['hit'] == 1)}/{len(rows)}   （* = 进入指标集）")
    group_table(rows, "judgeA", "判官 A 实际判定")
    group_table(rows, "target", "用例目标档")
    pooled_missability(rows)
    sides_with(rows)
    stability(rows)
    hitmiss(rows, KEEP)
    para_term_check(rows)
    excerpt_share(rows)
    gate_sim(rows)
    print("\n### 冻结参照带（各目标档命中样本的 P10/P50/P90；--bands 可单独取）")
    print(json.dumps(bands(rows, KEEP + ["code_max_block"]), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    sys.exit(main())
