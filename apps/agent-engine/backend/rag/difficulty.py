"""chunk 难度自动标注：零 LLM 机械特征 + 语料内分位切档。

替掉的劳动：现在每个 `ingest_*.py` 里的 `difficulty` 是**早期会话由模型**按章节写死的常量
（`ingest_llm_deploy.py` 的注释原话：「库内没有自动启发式，difficulty 是各 ingest
脚本按章节人工定的常量」——那个「人工」指的是当时写脚本的 agent）。那批常量既是「科学定标」说不出口的原因，也是领域泛化
必须由人写脚本的原因之一。

## 为什么不让 LLM 直接标档位

ZPD-SCA（arXiv:2508.14377，2026-08-12 逐条核实过）在中文教育文本难度三分类上实测：
零样本设置下 **GLM 0.2659、Qwen-max 0.3061、Qwen-plus 0.3152 低于三分类随机基线（1/3）**。
这三个正是我们的模型栈。

**引用口径必须写全，否则会被反例打穿**：
- 原文写的是「below 33%」，从没打印过「33.33%」这个字符串，别加引号硬引
- 「低于随机」只对这三个模型成立。同一张 Table 4 里 DeepSeek-V3 零样本 0.7775、Qwen32B 0.6314——
  **不能说「LLM 做不了难度分级」**，只能说「部分主流中文商用模型零样本下低于随机基线」
- 那两个数是**混合体裁的聚合行**。Qwen-max 分体裁波动极大（哲学 0.8675，家庭校园 0.2174），
  单一体裁上「低于随机」并不成立

## 为什么是分位切档而不是阈值

我们在阈值上栽过一次：adaptation-lint 一版的阈值在**成品讲义**上校准，
搬到**教材原文**上一个规则的召回从 2/3 掉到 0/18。绝对阈值不跨形态。

分位切档不定绝对值，只定语料内的相对排序，形态变了排序仍然成立。
代价要说清：**它保证相对难度，不保证绝对档位**——整体很浅的语料照样会切出 L4。
缓解办法是把新语料与已有标签的 1704 条放进同一个池子排序（见 `assign_tiers`
的 `anchor` 参数），这样分位点有绝对参照。

## 2026-08-12 实测：两条路都没做出可信的自动标注，结论照报

用 DeepSeek-V3.2、单一提示词、一次跑完全库 1702/1704 条（覆盖 99.9%），
外加 200 条重测子集（seed 20260812）。三项验收全部不依赖真值：

```
重测信度   同档 115/200 = 57.5%，期望一致 40.0%  →  Cohen κ = 0.292
           但「相差不超过一档」99.0%
收敛效度   LLM 标注 vs 机械特征合成分数  Spearman +0.282
判据一致性 各来源符号**不再翻转**（旧标签 em +0.353 / ha −0.120 → 新标注全为正）
```

逐条读：

1. **「口径漂移」假设被证实。** 旧标签跨来源的符号翻转，在同一提示词下消失了。
   所以那批旧标签失败的原因确实是分次分脚本各拍各的，不是机械特征无效。
2. **模型自己不稳。** κ=0.292 落在 Landis & Koch 的「fair」区间下沿——同一个模型、
   同一个提示词、同一段文字、temperature 0.2，重标一遍只有这个一致度。
   连自己都复现不了的标注，不能当别人的金标。
3. **收敛效度弱**（0.282）。两条独立路径没有收敛到同一个量。
4. 分布严重塌向 L2（1065/1702 = 62.6%），模型不敢用极端档。

按实验前写死的三种判读，命中的是第三种：**重测就低 → 这条路自己废掉，不用再争。**

**唯一可救的信号**：一档内 99.0% 说明模型对**相对高低**有共识，对**绝对切点**没有。
真要再试，形态应当是**成对比较**（A 和 B 哪个门槛高）而不是直接给档位——
成对判断不需要绝对边界。竞赛期不做，成本与收益不成比例：难度只是个检索过滤器，
不是对外指标。

**所以本模块的定位降为：来源内相对排序的候选实现，不作为难度标注的自动化方案。**
接入 Agent 里难度那一步退回「来源级一句话给区间」，人工劳动仍然从每章降到每源。

对外口径也随之定死：不说「我们自动化了难度标定」，说
**「我们测过自动标难度，机械特征与 LLM 标注都没通过验收，数据在 `data/eval/chunk_difficulty_labels.json`，
所以保留来源级人工判定并公开分档规则」**。测过说不通，比声称做到了更经得起追问。

## 特征怎么选出来的

不是拍的。`scripts/validate_difficulty.py` 在那 1704 条**旧标签**上逐特征算 Spearman 相关。
⚠️ 旧标签由早期会话的模型按章节拍出，**不是金标**——那份相关性只说明
「能不能复现当时的拍法」。真值缺席，正确的验收是收敛效度，见 `label_chunk_difficulty.py`。**留哪些以那个脚本的实测输出为准**，
这里的 `FEATURES` 顺序不代表权重。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

TIERS = ("L1", "L2", "L3", "L4")

#: 旧标签的边际分布（1704 条：285 / 390 / 972 / 57）。分位点照它切，
#: 这样比对时衡量的是**排序**是否一致，而不是两边档位比例不同造成的系统性错位。
DEFAULT_QUANTILES = (0.167, 0.396, 0.967)

_CJK = re.compile(r"[一-鿿]")
_SENTENCE_END = re.compile(r"[。！？；.!?;]+")
#: 数学记号：行内/行间 LaTeX 与常见转义
_MATH = re.compile(r"\$\$?[^$\n]+\$\$?|\\\(|\\\[|\\frac|\\sum|\\sqrt|\\partial")
#: 英文技术 token：两位以上的字母/数字/下划线串。中文技术文本里它们基本都是术语、
#: API 名、库名——密度越高，读者需要的前置知识越多。
_ASCII_TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_]{1,}")
#: 代码结构记号。本库大多数代码块没有围栏（b1-gradient、b2-attention 都是裸行），
#: 只认围栏会漏一大半——沿用 adaptation-lint 的判据。
_CODE_MARKS = re.compile(r"[=(){}\[\];]|^\s*(?:def|class|import|from|return|if|for|while)\b")


def _is_code_line(line: str) -> bool:
    stripped = re.sub(r"#.*$", "", line).strip()
    if not stripped:
        return False
    if _CJK.search(stripped):
        return False
    return bool(_CODE_MARKS.search(stripped))


@dataclass(frozen=True)
class Features:
    code_ratio: float
    formula_density: float
    term_density: float
    term_variety: float
    mean_sentence_len: float
    heading_depth: float

    def as_dict(self) -> dict[str, float]:
        return {
            "code_ratio": self.code_ratio,
            "formula_density": self.formula_density,
            "term_density": self.term_density,
            "term_variety": self.term_variety,
            "mean_sentence_len": self.mean_sentence_len,
            "heading_depth": self.heading_depth,
        }


FEATURE_NAMES = (
    "code_ratio",
    "formula_density",
    "term_density",
    "term_variety",
    "mean_sentence_len",
    "heading_depth",
)


def extract_features(text: str, *, heading_depth: int = 1) -> Features:
    """零 LLM、零外部依赖。同一段文本永远得到同一组读数，可复算。"""
    lines = text.splitlines()
    chars = max(len(text), 1)
    per_k = 1000.0 / chars

    code_lines = sum(1 for line in lines if _is_code_line(line))
    tokens = _ASCII_TOKEN.findall(text)
    sentences = [s for s in _SENTENCE_END.split(text) if len(s.strip()) > 4]
    cjk_sentences = [s for s in sentences if _CJK.search(s)]

    return Features(
        code_ratio=code_lines / max(len(lines), 1),
        formula_density=len(_MATH.findall(text)) * per_k,
        term_density=len(tokens) * per_k,
        term_variety=len({t.lower() for t in tokens}) * per_k,
        mean_sentence_len=(
            sum(len(s) for s in cjk_sentences) / len(cjk_sentences) if cjk_sentences else 0.0
        ),
        heading_depth=float(heading_depth),
    )


def _ranks(values: list[float]) -> list[float]:
    """平均秩，并列取均值。"""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        shared = (i + j) / 2.0
        for k in range(i, j + 1):
            ranks[order[k]] = shared
        i = j + 1
    return ranks


def score(
    feature_rows: list[Features],
    *,
    use: tuple[str, ...] = FEATURE_NAMES,
) -> list[float]:
    """逐特征转秩后等权求和。

    等权不是偷懒——权重要拟合就需要一批可信的难度标注，而我们手上的旧标签是
    **章级常量**（一整章一个档），拿它拟合 chunk 级权重是把粗标签的噪声学进去，何况它本身没有真值背书。
    等权先跑，`validate_difficulty.py` 报出各特征相关性之后再谈要不要动。
    """
    if not feature_rows:
        return []
    columns = {name: [getattr(f, name) for f in feature_rows] for name in use}
    ranked = {name: _ranks(col) for name, col in columns.items()}
    n = len(feature_rows)
    return [sum(ranked[name][i] for name in use) / (len(use) * max(n - 1, 1)) for i in range(n)]


def assign_tiers(
    scores: list[float],
    *,
    quantiles: tuple[float, ...] = DEFAULT_QUANTILES,
    anchor: list[float] | None = None,
) -> list[str]:
    """分位切档。

    `anchor` 传入已有标签语料的分数时，分位点在**锚点池**上取，新语料按同一把尺子
    切——这是「相对难度 ≠ 绝对档位」那条局限的缓解办法。不传就在自身语料内切，
    此时档位只在这批语料内部可比，报告里必须写明。
    """
    if not scores:
        return []
    pool = sorted(anchor if anchor else scores)
    cuts = [pool[min(int(q * len(pool)), len(pool) - 1)] for q in quantiles]
    out: list[str] = []
    for s in scores:
        tier = TIERS[-1]
        for idx, cut in enumerate(cuts):
            if s <= cut:
                tier = TIERS[idx]
                break
        out.append(tier)
    return out
