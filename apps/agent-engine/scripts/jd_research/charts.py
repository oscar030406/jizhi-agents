"""岗位调研答辩图表（dataviz 规范：单轴、细 mark、直接标注、验证过的配色）。

配色（validate_palette.js 三色 PASS）：
  series-1 蓝 #2a78d6（主/我们覆盖）  series-2 橙 #eb6834（对照/强调）
  中性灰 #9a9891（未覆盖/辅助）。#1baf7a 对表面对比不足只作填充不作文字。
输出 → D:/UserData/Desktop/挑战杯/docs/assets/jd/
"""
from __future__ import annotations

import json
import os

import matplotlib
import matplotlib.pyplot as plt
import pandas as pd

matplotlib.rcParams["font.family"] = ["Microsoft YaHei"]
matplotlib.rcParams["axes.unicode_minus"] = False

BASE = os.path.dirname(__file__)
STATS = os.path.join(BASE, "stats")
# 锚定脚本位置到仓库根（scripts/jd_research -> engine -> apps -> 仓库根），不写机器路径（L9）
OUT = os.path.join(BASE, "..", "..", "..", "..", "docs", "assets", "jd")
os.makedirs(OUT, exist_ok=True)

BLUE, ORANGE, AQUA, GRAY = "#2a78d6", "#eb6834", "#1baf7a", "#9a9891"
INK, INK2 = "#0b0b0b", "#52514e"


def style_ax(ax):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color("#d8d6d0")
    ax.tick_params(colors=INK2, labelsize=9)
    ax.yaxis.grid(True, color="#eceae5", linewidth=0.8)
    ax.set_axisbelow(True)


def fig_trend():
    # 绝对量受数据集逐年采集规模影响（2022 全集缩至 4.5 万），且 2025 仅 1-7 月——
    # 用「占 AI 招聘集比例」做主口径，消除两类采集偏差；绝对量仅在报告表格给出。
    t = pd.read_csv(os.path.join(STATS, "trend.csv"))
    t = t[t["year"] >= 2016]
    t["share"] = t["llm_related"] / t["ai_total"] * 100
    fig, ax = plt.subplots(figsize=(7.6, 4.0), dpi=160)
    ax.plot(t["year"], t["share"], color=BLUE, linewidth=2, marker="o", markersize=4.5)
    for _, r in t[t["year"] >= 2022].iterrows():
        ax.annotate(f"{r['share']:.1f}%", (r["year"], r["share"]),
                    textcoords="offset points", xytext=(0, 8), fontsize=9.5, color=INK, ha="center")
    ax.set_title("大模型相关岗位占 AI 招聘的比例（AI 招聘专集；2025 为 1-7 月）",
                 fontsize=12, color=INK, loc="left")
    ax.set_ylabel("%", color=INK2, fontsize=9)
    ax.set_xticks(t["year"])
    style_ax(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "trend_llm_jobs.png"))
    plt.close(fig)


def fig_share():
    rows = json.load(open(os.path.join(STATS, "zhaopin_baseline.json"), encoding="utf-8"))
    d = pd.DataFrame(rows)
    d = d[(d["total"] > 100_000)]  # 2019/2020/2025 残缺年份剔除，口径注明
    d["share"] = d["llm_hits"] / d["total"] * 100
    fig, ax = plt.subplots(figsize=(7.6, 3.6), dpi=160)
    ax.plot(d["year"], d["share"], color=BLUE, linewidth=2, marker="o", markersize=4.5)
    peak = d.loc[d["share"].idxmax()]
    ax.annotate(f"{peak['share']:.2f}%（{int(peak['year'])}）", (peak["year"], peak["share"]),
                textcoords="offset points", xytext=(-10, 8), fontsize=10, color=INK)
    ax.set_title("大模型岗位占全行业招聘比例（智联大盘 1,300万+ 条，残缺年份已剔除）",
                 fontsize=12, color=INK, loc="left")
    ax.set_ylabel("%", color=INK2, fontsize=9)
    ax.set_xticks(d["year"])
    style_ax(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "share_of_market.png"))
    plt.close(fig)


def _barh(series: pd.Series, title: str, fname: str, color=BLUE, highlight: dict | None = None):
    fig, ax = plt.subplots(figsize=(7.2, 0.42 * len(series) + 1.4), dpi=160)
    colors = [highlight.get(i, color) if highlight else color for i in series.index]
    bars = ax.barh(range(len(series)), series.values, color=colors, height=0.62)
    ax.set_yticks(range(len(series)))
    ax.set_yticklabels(series.index, fontsize=9.5, color=INK)
    ax.invert_yaxis()
    for i, v in enumerate(series.values):
        ax.text(v, i, f" {v:,.0f}" if v >= 1 else f" {v:.1%}", va="center", fontsize=9, color=INK2)
    ax.set_title(title, fontsize=12, color=INK, loc="left")
    ax.xaxis.set_visible(False)
    for s in ax.spines.values():
        s.set_visible(False)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, fname))
    plt.close(fig)


def fig_edu_exp_city():
    edu = pd.read_csv(os.path.join(STATS, "edu_dist.csv"), index_col=0).iloc[:, 0]
    _barh(edu, "学历要求分布（大模型应用开发岗，2023-2025）", "edu_dist.png")
    exp = pd.read_csv(os.path.join(STATS, "exp_dist.csv"), index_col=0).iloc[:, 0]
    _barh(exp, "经验要求分布（同口径）", "exp_dist.png")
    city = pd.read_csv(os.path.join(STATS, "city_top.csv"), index_col=0).iloc[:, 0].head(10)
    _barh(city, "岗位城市 TOP10（同口径）", "city_top.png")


def fig_salary():
    mid = pd.read_csv(os.path.join(STATS, "salary_mid.csv"))["mid"]
    fig, ax = plt.subplots(figsize=(7.2, 3.6), dpi=160)
    ax.hist(mid.clip(upper=80000), bins=40, color=BLUE, edgecolor="white", linewidth=0.6)
    med = mid.median()
    ax.axvline(med, color=ORANGE, linewidth=1.6)
    ax.annotate(f"中位数 {med / 1000:.1f}k", (med, ax.get_ylim()[1] * 0.9),
                textcoords="offset points", xytext=(8, 0), fontsize=10, color=INK)
    ax.set_title("月薪分布（区间中值，元/月；>8万截尾展示）", fontsize=12, color=INK, loc="left")
    style_ax(ax)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "salary_hist.png"))
    plt.close(fig)


def fig_skill_vs_curriculum():
    sk = pd.read_csv(os.path.join(STATS, "skill_freq.csv"))
    sk = sk.set_index("concept")["jd_share"].sort_values(ascending=True)
    covered = {"rag", "agent_basics", "tool_calling", "langgraph", "evaluation",
               "guardrails", "deployment", "python"}
    labels, colors = [], []
    for c in sk.index:
        base = c.split("(")[0]
        is_cov = base in covered
        labels.append(c)
        colors.append(BLUE if is_cov else GRAY)
    sk.index = labels
    fig, ax = plt.subplots(figsize=(7.6, 0.44 * len(sk) + 1.6), dpi=160)
    ax.barh(range(len(sk)), sk.values, color=colors, height=0.62)
    ax.set_yticks(range(len(sk)))
    ax.set_yticklabels(sk.index, fontsize=9.5, color=INK)
    for i, v in enumerate(sk.values):
        ax.text(v, i, f" {v:.0%}", va="center", fontsize=9, color=INK2)
    ax.set_title("JD 技能提及率 × 课程概念图覆盖", fontsize=12, color=INK, loc="left")
    from matplotlib.patches import Patch
    ax.legend(handles=[Patch(color=BLUE, label="课程已覆盖"), Patch(color=GRAY, label="未覆盖")],
              loc="lower right", frameon=False, fontsize=9)
    ax.xaxis.set_visible(False)
    for s in ax.spines.values():
        s.set_visible(False)
    fig.tight_layout()
    fig.savefig(os.path.join(OUT, "skill_vs_curriculum.png"))
    plt.close(fig)


if __name__ == "__main__":
    fig_trend()
    fig_share()
    fig_edu_exp_city()
    fig_salary()
    fig_skill_vs_curriculum()
    print("charts →", OUT)
