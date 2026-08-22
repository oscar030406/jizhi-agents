"""一句话自述 → 画像种子（五维档位初值 + 类比域线索）。

确定性关键词规则，零 LLM 依赖：抽取结果逐条附命中证据（哪个词 → 哪一维哪一档），
可审计可复算——与门禁叙事同构。规则表与 docs/scenario_definition.md 档位语义 0-4 表对齐。
用户没提到的维度返回 None（由 onboarding 身份预设兜底），只上调不虚构。
"""
from __future__ import annotations

from pydantic import BaseModel, Field

# 易被更长的词内嵌的关键词 → 内嵌它的上下文。命中时若周围是这些词，不算数。
#
# **2026-08-13 实测事故**：输入「我完全不懂技术，也没写过代码，想搞明白**向量数据库**」，
# 「数据库」在「向量数据库」里命中 `programming=3`（后端），再被「同维度取最高档」
# 压过「没写过代码」的 0——一个零基础学习者被判成后端工程师，比不跑抽取还糟。
_EMBEDDED_IN: dict[str, tuple[str, ...]] = {
    "数据库": ("向量数据库", "图数据库", "关系数据库", "时序数据库"),
    "go": ("algo", "going", "google", "django", "mongo", "logo"),
    "prompt": ("prompt-",),
}

#: 明确的自我否定陈述（「没写过代码」这类）。命中后**锁定该维度**，
#: 后面的规则不许再往上抬——偶然提到一个名词，不能压过一句「我不会」。
_ASSERTIVE_LEVEL = 0

# (关键词组, 维度, 档位, 证据说明)。顺序=优先级，同维度取最高档（0 档锁定除外）。
_RULES: list[tuple[tuple[str, ...], str, int, str]] = [
    # programming / python
    (("没写过代码", "零基础", "不会编程", "不懂技术", "文科"), "programming", 0, "自述零编程接触"),
    (("学过语法", "学过一点", "刚入门"), "programming", 1, "自述学过语法"),
    (("写过脚本", "爬虫", "自动化脚本"), "python", 2, "写过脚本/爬虫 → Python 档 2"),
    (("web api", "flask", "django", "fastapi", "写过接口"), "python", 2, "写过 Web API"),
    (("后端", "服务端", "java", "go", "数据库"), "programming", 3, "后端/多语言经验"),
    (("架构", "技术负责人", "重构过"), "programming", 4, "架构级经验"),
    # agent
    (("用过 chatgpt", "用过豆包", "用过 ai", "问过 ai"), "agent", 1, "用过对话产品"),
    (("调过 api", "openai api", "调用大模型", "prompt"), "agent", 2, "调过 LLM API"),
    (("写过 agent", "工具调用", "function call"), "agent", 3, "写过完整 Agent"),
    (("多智能体", "multi-agent"), "agent", 4, "设计过多 Agent 系统"),
    # rag
    (("听说过 rag", "知道检索增强"), "rag", 1, "知道 RAG 概念"),
    (("langchain", "llamaindex", "搭过 rag", "向量库", "embedding"), "rag", 2, "用库搭过 RAG demo"),
    (("检索链路", "自己搭过检索", "重排"), "rag", 3, "自建过检索+生成链路"),
    # engineering
    (("跑通过 demo", "本地跑过"), "engineering", 1, "本地跑通过 demo"),
    (("部署过", "docker", "上线过", "服务器"), "engineering", 2, "部署过服务"),
    (("生产环境", "线上事故", "运维"), "engineering", 3, "有生产环境经验"),
    (("高并发", "可观测", "k8s", "kubernetes"), "engineering", 4, "高并发/可观测性实践"),
]

_DOMAIN_HINTS: list[tuple[tuple[str, ...], str]] = [
    (("后端", "数据库", "服务端", "java", "go"), "后端工程"),
    (("算法", "科研", "论文", "数学", "研究生"), "算法科研"),
    (("前端", "页面", "vue", "react"), "前端工程"),
    (("产品", "运营", "文科", "转行", "非计算机"), "非工程背景"),
]


class IntakeEvidence(BaseModel):
    dimension: str
    level: int = Field(ge=0, le=4)
    keyword: str
    reason: str


class ProfileSeed(BaseModel):
    """抽取结果：命中的维度给档位，未命中的不给（None 语义=由身份预设兜底）。"""

    levels: dict[str, int] = Field(default_factory=dict)
    background_hint: str = ""
    evidence: list[IntakeEvidence] = Field(default_factory=list)
    unmatched: bool = False  # 一条规则都没命中：如实标注，前端提示改用选项


def _really_hit(keyword: str, lowered: str) -> bool:
    """关键词命中，且不是被更长的词内嵌进来的。

    中文没有词边界，`in` 判定会把「向量数据库」里的「数据库」当成后端经验。
    这里只对已知易误伤的词做上下文排除，不做分词——分词引入依赖，
    而误伤是可枚举的少数几个词。
    """
    if keyword not in lowered:
        return False
    for host in _EMBEDDED_IN.get(keyword, ()):
        # 去掉所有内嵌形态后还剩这个词，才算真命中
        if keyword not in lowered.replace(host, ""):
            return False
    return True


def extract_profile_seed(text: str) -> ProfileSeed:
    lowered = text.lower()
    levels: dict[str, int] = {}
    locked: set[str] = set()
    evidence: list[IntakeEvidence] = []
    for keywords, dimension, level, reason in _RULES:
        hit = next((k for k in keywords if _really_hit(k, lowered)), None)
        if hit is None:
            continue
        evidence.append(IntakeEvidence(dimension=dimension, level=level, keyword=hit, reason=reason))
        if dimension in locked:
            # 该维度已被一句明确的「我不会」锁死，后面的名词命中不许往上抬。
            # 证据仍然记下来——被压掉的命中也要能查，别让人以为规则没跑。
            continue
        if level == _ASSERTIVE_LEVEL:
            levels[dimension] = level
            locked.add(dimension)
        elif levels.get(dimension, -1) < level:
            levels[dimension] = level
    background_hint = next(
        (label for keys, label in _DOMAIN_HINTS if any(_really_hit(k, lowered) for k in keys)), ""
    )
    return ProfileSeed(
        levels=levels,
        background_hint=background_hint,
        evidence=evidence,
        unmatched=not levels and not background_hint,
    )
