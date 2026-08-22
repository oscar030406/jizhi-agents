"""大模型应用开发岗位调研分析（模块一）。

数据源：人工智能招聘大数据 2014-2025（分年 parquet，已含 AI 关键词预筛）。
筛选口径（三层，报告必须原样披露）：
  L0 全集   = AI 招聘专集全部行（对照基线）
  L1 大模型相关 = 岗位名或 JD 命中大模型技术词（见 CORE_PAT）
  L2 应用开发岗 = L1 且命中应用开发词（开发/应用/工程师）且非纯算法研究岗
产出：data/ 下 CSV 统计表（图表脚本另行消费）。
"""
from __future__ import annotations

import os
import re

import pandas as pd

BASE = os.path.dirname(__file__)
PQ = os.path.join(BASE, "parquet")
OUT = os.path.join(BASE, "stats")
os.makedirs(OUT, exist_ok=True)

# 大模型技术词（核心层）——按 2023+ 招聘语言习惯取词，含英文变体
CORE_PAT = re.compile(
    r"大模型|大语言模型|LLM|AIGC|生成式\s*AI|生成式人工智能|GPT|ChatGPT|"
    r"文心一言|通义|智谱|讯飞星火|Llama|DeepSeek|"
    r"提示词|Prompt\s*Engineer|RAG|检索增强|"
    r"智能体|Agent开发|AI\s*Agent|多智能体|LangChain|LangGraph|向量数据库|微调|Lora|SFT",
    re.IGNORECASE,
)
# 应用开发词（区分应用岗 vs 纯算法研究岗）
APP_PAT = re.compile(r"应用|开发|工程师|后端|全栈|平台|系统|落地|解决方案", re.IGNORECASE)
RESEARCH_ONLY_PAT = re.compile(r"研究员|科学家|博士后|实习", re.IGNORECASE)

# 技能词典：JD 词频 × 我们概念图的对照（概念图 id → 关键词组）
SKILL_LEXICON: dict[str, list[str]] = {
    "rag": ["RAG", "检索增强", "向量数据库", "向量检索", "知识库问答", "Embedding", "召回"],
    "agent_basics": ["Agent", "智能体", "多智能体", "工具调用", "function call", "MCP"],
    "tool_calling": ["工具调用", "function call", "插件", "API 调用", "MCP"],
    "langgraph": ["LangChain", "LangGraph", "编排", "工作流", "Dify", "AutoGen"],
    "evaluation": ["评测", "评估", "测试集", "benchmark", "指标", "A/B"],
    "guardrails": ["安全", "护栏", "合规", "风控", "幻觉", "审核"],
    "deployment": ["部署", "上线", "Docker", "K8s", "vLLM", "推理服务", "高并发", "FastAPI", "Flask"],
    "prompt_engineering": ["提示词", "Prompt", "指令工程"],
    "finetune(不在课程)": ["微调", "LoRA", "SFT", "RLHF", "预训练"],
    "python": ["Python", "PyTorch"],
}

EDU_ORDER = ["不限", "大专", "本科", "硕士", "博士"]


def norm_edu(v: str) -> str:
    v = str(v)
    for k in ("博士", "硕士", "本科", "大专", "中专", "高中"):
        if k in v:
            return "大专" if k in ("中专", "高中", "大专") else k
    return "不限"


def norm_exp(v: str) -> str:
    v = str(v)
    if re.search(r"不限|无", v):
        return "经验不限"
    m = re.search(r"(\d+)", v)
    if not m:
        return "经验不限"
    n = int(m.group(1))
    if n < 1:
        return "1年以内"
    if n <= 3:
        return "1-3年"
    if n <= 5:
        return "3-5年"
    return "5年以上"


def main() -> None:
    files = sorted(f for f in os.listdir(PQ) if f.endswith(".parquet"))
    trend_rows = []
    l2_frames = []
    for f in files:
        year = int(re.search(r"(\d{4})", f).group(1))
        df = pd.read_parquet(os.path.join(PQ, f))
        text = (df["招聘岗位"].fillna("") + "\n" + df["职位描述"].fillna("")).astype(str)
        l1 = text.str.contains(CORE_PAT)
        title = df["招聘岗位"].fillna("").astype(str)
        l2 = l1 & (title.str.contains(APP_PAT) | df["职位描述"].fillna("").astype(str).str.contains(APP_PAT)) \
             & ~title.str.contains(RESEARCH_ONLY_PAT)
        trend_rows.append({
            "year": year, "ai_total": len(df),
            "llm_related": int(l1.sum()), "llm_app_dev": int(l2.sum()),
        })
        sub = df[l2].copy()
        sub["year"] = year
        l2_frames.append(sub)
        print(f"{year}: 全集 {len(df):>7} | L1 大模型相关 {int(l1.sum()):>6} | L2 应用开发 {int(l2.sum()):>6}", flush=True)

    trend = pd.DataFrame(trend_rows).sort_values("year")
    trend.to_csv(os.path.join(OUT, "trend.csv"), index=False)

    allsub = pd.concat(l2_frames, ignore_index=True)
    # 混年 dtype 冲突（旧 parquet float / 新 parquet str）：统一 str 落盘，数值由消费侧解析
    allsub = allsub.astype(str)
    allsub["year"] = allsub["year"].astype(int)
    allsub.to_parquet(os.path.join(OUT, "llm_app_dev_subset.parquet"), index=False)
    recent = allsub[allsub["year"] >= 2023].copy()
    print(f"\nL2 子集总量 {len(allsub)}，其中 2023+ {len(recent)}")

    # 学历 / 经验 / 城市 / 薪资（近三年口径：岗位要求随时代漂移，用 2023+）
    recent["edu"] = recent["学历要求"].map(norm_edu)
    recent["exp"] = recent["要求经验"].map(norm_exp)
    recent["edu"].value_counts().reindex(EDU_ORDER).fillna(0).astype(int) \
        .to_csv(os.path.join(OUT, "edu_dist.csv"))
    recent["exp"].value_counts().to_csv(os.path.join(OUT, "exp_dist.csv"))
    recent["工作城市"].astype(str).value_counts().head(15).to_csv(os.path.join(OUT, "city_top.csv"))

    sal = recent[["最低月薪", "最高月薪"]].apply(pd.to_numeric, errors="coerce").dropna()
    sal = sal[(sal["最低月薪"] >= 1000) & (sal["最高月薪"] <= 200000)]  # 去脏（日薪/年薪混入）
    sal["mid"] = (sal["最低月薪"] + sal["最高月薪"]) / 2
    sal.describe().to_csv(os.path.join(OUT, "salary_desc.csv"))
    sal["mid"].to_frame().to_csv(os.path.join(OUT, "salary_mid.csv"), index=False)

    # 技能词频（2023+ JD 全文）
    jd = recent["职位描述"].fillna("").astype(str)
    n = len(jd)
    rows = []
    for concept, words in SKILL_LEXICON.items():
        pat = re.compile("|".join(re.escape(w) for w in words), re.IGNORECASE)
        hit = int(jd.str.contains(pat).sum())
        rows.append({"concept": concept, "jd_hits": hit, "jd_share": round(hit / n, 4)})
    pd.DataFrame(rows).sort_values("jd_hits", ascending=False) \
        .to_csv(os.path.join(OUT, "skill_freq.csv"), index=False)

    # 岗位名 TOP（看真实叫法分布，回答"名字对不对"）
    recent["招聘岗位"].astype(str).str.strip().value_counts().head(30) \
        .to_csv(os.path.join(OUT, "title_top.csv"))
    print("stats 全部落盘 →", OUT)


if __name__ == "__main__":
    main()
