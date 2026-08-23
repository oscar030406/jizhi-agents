r"""DINA 对账：classroom 侧自研掌握度逻辑 vs EduCDM（中科大，Apache-2.0）标准 EMDINA。

背景：apps/classroom/lib/generation/selection.ts 的观测通道是 DINA 思想——
  P(对) = p·(1−slip) + (1−p)·guess，slip 先验钉 0.1，guess 钉 1/选项数。
本脚本用同一份作答数据分别跑 EduCDM 的 EM 估计和一个按 selection.ts 逻辑重写的
mini 实现，对比 slip/guess 估计与掌握判定的一致率，产出校验证据。

数据：仓库无真实「学生×题目」作答矩阵（learner_profiles.json 是画像无作答，
quiz/ 是题库无作答），故用**合成作答集**：20 学生 × 15 题 × 5 概念 Q 矩阵，
概念取自 learner_profiles.json 的五个能力维度，生成过程即 DINA 观测通道本身
（true slip=0.1、true guess=1/选项数），固定种子可重跑。

用法：python scripts\audit_dina_educdm.py
产物：../../docs/05-evidence/dina-educdm-audit-20260823.md（docs 已 gitignore）
日志：data/eval/dina_educdm_audit.log
依赖：pip install EduCDM -i https://pypi.tuna.tsinghua.edu.cn/simple
"""
from __future__ import annotations

import json
import logging
import sys
from datetime import date
from pathlib import Path

import numpy as np
from EduCDM import EMDINA

ROOT = Path(__file__).resolve().parents[1]
REPORT_PATH = ROOT.parents[1] / "docs" / "05-evidence" / "dina-educdm-audit-20260823.md"
LOG_PATH = ROOT / "data" / "eval" / "dina_educdm_audit.log"
PROFILES_PATH = ROOT / "data" / "learner_profiles" / "learner_profiles.json"

SEED = 42
STU_NUM, PROB_NUM, KNOW_NUM = 20, 15, 5
TRUE_SLIP = 0.1          # selection.ts 的 SLIP 先验
EM_EPOCH, EM_EPSILON = 200, 1e-3

# selection.ts 的常量（对齐 apps/classroom/lib/generation/selection.ts）
IN_STATE_MIN = 0.8       # bandOf：>0.8 判 in
OUT_OF_STATE_MAX = 0.2   # <0.2 判 out，中间 uncertain
PRIOR = 0.5              # 无证据时的掌握先验

def guess_by_options(options: int) -> float:
    return 1.0 / options if options > 0 else 0.0

# Q 矩阵：15 题 × 5 概念。每个概念至少一道单点题（selection.ts 注释里的
# Q 完备性/可识别性要求），其余为多概念题（DINA 合取）。
Q_MATRIX = np.array([
    [1, 0, 0, 0, 0],  # q0  单点：programming
    [0, 1, 0, 0, 0],  # q1  单点：python
    [0, 0, 1, 0, 0],  # q2  单点：agent
    [0, 0, 0, 1, 0],  # q3  单点：rag
    [0, 0, 0, 0, 1],  # q4  单点：engineering
    [1, 1, 0, 0, 0],  # q5
    [0, 1, 1, 0, 0],  # q6
    [0, 0, 1, 1, 0],  # q7
    [0, 0, 0, 1, 1],  # q8
    [1, 0, 0, 0, 1],  # q9
    [0, 1, 0, 1, 0],  # q10
    [1, 0, 1, 0, 0],  # q11
    [0, 1, 1, 1, 0],  # q12
    [1, 1, 0, 0, 1],  # q13
    [0, 0, 1, 1, 1],  # q14
])
# 选项数：前 12 道四选一，后 3 道判断题（2 选项）——贴近真实题库形态
OPTIONS = np.array([4] * 12 + [2] * 3)


def synthesize(rng: np.random.Generator, concepts: list[str], profiles: list[dict]):
    """从 5 类画像各派生 4 名学生：能力维度 level>=2 视为倾向掌握（概率 0.9），
    否则 0.15，再逐概念抽真值——保持画像间的能力梯度，形状贴近真实分布。"""
    level_keys = [f"{c}_level" for c in concepts]
    true_attr = np.zeros((STU_NUM, KNOW_NUM), dtype=int)
    for i in range(STU_NUM):
        p = profiles[i % len(profiles)]
        for k, key in enumerate(level_keys):
            prob = 0.9 if p.get(key, 0) >= 2 else 0.15
            true_attr[i, k] = int(rng.random() < prob)

    true_guess = np.array([guess_by_options(o) for o in OPTIONS])
    eta = (true_attr @ Q_MATRIX.T == Q_MATRIX.sum(axis=1)).astype(int)  # 合取
    p_correct = eta * (1 - TRUE_SLIP) + (1 - eta) * true_guess
    R = (rng.random((STU_NUM, PROB_NUM)) < p_correct).astype(int)
    return true_attr, R


def mini_estimate(R: np.ndarray) -> np.ndarray:
    """按 selection.ts 逻辑的 mini 掌握度估计：slip 钉 0.1、guess 钉 1/选项数，
    对每个（学生, 概念）用该概念相关题目做逐题贝叶斯更新，
    似然即 predictedCorrect 的观测通道 P(对|会)=1−s、P(对|不会)=g。
    多概念题的证据记到每个所需概念上（对应 D-20b 讨论的简化，非完整 EM）。"""
    est = np.full((STU_NUM, KNOW_NUM), PRIOR)
    for i in range(STU_NUM):
        for k in range(KNOW_NUM):
            p = PRIOR
            for j in range(PROB_NUM):
                if Q_MATRIX[j, k] == 0:
                    continue
                g = guess_by_options(int(OPTIONS[j]))
                like1, like0 = (1 - TRUE_SLIP, g) if R[i, j] == 1 else (TRUE_SLIP, 1 - g)
                p = p * like1 / (p * like1 + (1 - p) * like0)
            est[i, k] = p
    return est


def band_of(estimate: float) -> str:
    if estimate > IN_STATE_MIN:
        return "in"
    if estimate < OUT_OF_STATE_MAX:
        return "out"
    return "uncertain"


def main() -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(LOG_PATH, mode="w", encoding="utf-8"),
                  logging.StreamHandler(sys.stdout)],
    )
    log = logging.getLogger("dina_audit")
    rng = np.random.default_rng(SEED)

    concepts = ["programming", "python", "agent", "rag", "engineering"]
    profiles = json.loads(PROFILES_PATH.read_text(encoding="utf-8"))
    log.info("画像 %d 类（%s），派生 %d 名合成学生", len(profiles), PROFILES_PATH.name, STU_NUM)

    true_attr, R = synthesize(rng, concepts, profiles)
    log.info("合成作答矩阵 %s，总体正确率 %.3f", R.shape, R.mean())

    # --- EduCDM 标准 EMDINA ---
    cdm = EMDINA(R, Q_MATRIX, STU_NUM, PROB_NUM, KNOW_NUM, skip_value=-1)
    cdm.train(epoch=EM_EPOCH, epsilon=EM_EPSILON)
    edu_attr = cdm.all_states[cdm.theta].astype(int)          # (stu, know) 0/1
    edu_slip, edu_guess = cdm.slip, cdm.guess                 # 每题
    log.info("EduCDM EMDINA 训练完成（epoch<=%d, eps=%g）", EM_EPOCH, EM_EPSILON)

    # --- selection.ts 逻辑的 mini 实现 ---
    mini_est = mini_estimate(R)
    mini_band = np.vectorize(band_of)(mini_est)
    mini_in = (mini_band == "in").astype(int)

    # --- 对账 ---
    fixed_guess = np.array([guess_by_options(int(o)) for o in OPTIONS])
    slip_diff = np.abs(edu_slip - TRUE_SLIP)
    guess_diff = np.abs(edu_guess - fixed_guess)

    cells = STU_NUM * KNOW_NUM
    decided = mini_band != "uncertain"
    agree_all = (mini_in == edu_attr).mean()
    agree_decided = (mini_in[decided] == edu_attr[decided]).mean() if decided.any() else float("nan")
    n_uncertain = int((~decided).sum())

    acc_edu = (edu_attr == true_attr).mean()
    acc_mini = (mini_in == true_attr)[decided].mean() if decided.any() else float("nan")

    log.info("slip：EduCDM 估计均值 %.3f vs 先验 0.1，平均|差| %.3f，最大 %.3f",
             edu_slip.mean(), slip_diff.mean(), slip_diff.max())
    log.info("guess：EduCDM 估计均值 %.3f vs 1/选项数均值 %.3f，平均|差| %.3f，最大 %.3f",
             edu_guess.mean(), fixed_guess.mean(), guess_diff.mean(), guess_diff.max())
    log.info("掌握判定一致率：全 %d 格 %.1f%%；剔除 uncertain（%d 格）后 %.1f%%",
             cells, agree_all * 100, n_uncertain, agree_decided * 100)
    log.info("对合成真值的还原率：EduCDM %.1f%%，mini（已定带）%.1f%%",
             acc_edu * 100, acc_mini * 100)

    # --- 报告 ---
    item_rows = "\n".join(
        f"| q{j} | {int(OPTIONS[j])} | {fixed_guess[j]:.3f} | {edu_guess[j]:.3f} | "
        f"{TRUE_SLIP:.3f} | {edu_slip[j]:.3f} |"
        for j in range(PROB_NUM)
    )
    report = f"""# DINA 对账：selection.ts 自研逻辑 vs EduCDM EMDINA（{date.today().isoformat()}）

## 目的
`apps/classroom/lib/generation/selection.ts` 的掌握度观测通道采用 DINA 思想
（`predictedCorrect = p·(1−slip) + (1−p)·guess`，slip 先验 0.1，guess = 1/选项数）。
本报告用同一份作答数据对比标准实现 EduCDM（中科大，Apache-2.0）的 EMDINA
与按 selection.ts 逻辑重写的 mini 实现，作为「与标准实现一致」的校验证据。

## 数据（合成，非真实作答）
仓库内没有真实「学生×题目」作答矩阵（learner_profiles.json 是画像、quiz/ 是题库），
故构造合成集：**20 学生 × 15 题 × 5 概念 Q 矩阵**。概念取画像的五个能力维度，
学生从 5 类画像各派生 4 名（level≥2 → 掌握概率 0.9，否则 0.15）；每概念含单点题
（Q 完备性）；生成过程即 DINA 通道（true slip=0.1，true guess=1/选项数，
前 12 题四选一、后 3 题判断）。种子 {SEED}，可复算：`python scripts\\audit_dina_educdm.py`。

## 结果

### slip / guess 估计
| 量 | 我们的先验 | EduCDM EM 估计（均值） | 平均\\|差\\| | 最大\\|差\\| |
|---|---|---|---|---|
| slip | 0.100（钉死） | {edu_slip.mean():.3f} | {slip_diff.mean():.3f} | {slip_diff.max():.3f} |
| guess | {fixed_guess.mean():.3f}（1/选项数） | {edu_guess.mean():.3f} | {guess_diff.mean():.3f} | {guess_diff.max():.3f} |

逐题：

| 题 | 选项数 | guess 先验 | guess EM | slip 先验 | slip EM |
|---|---|---|---|---|---|
{item_rows}

### 掌握判定一致率
mini 按 selection.ts 三分带（>0.8 in / <0.2 out / 其余 uncertain）判 in，
EduCDM 输出二元掌握态：

- 全部 {cells} 个（学生×概念）格：一致率 **{agree_all * 100:.1f}%**（uncertain 计不一致）
- 剔除 uncertain（{n_uncertain} 格）后：一致率 **{agree_decided * 100:.1f}%**
- 对合成真值的还原率：EduCDM {acc_edu * 100:.1f}%，mini（已定带）{acc_mini * 100:.1f}%

## 结论（如实）
- 数据由 DINA 通道生成，属于「模型设定正确」情形下的对账，不是对真实学生数据的验证。
- mini 实现与 EduCDM 的差异来源明确：mini 钉死 slip/guess 做逐题贝叶斯更新，
  多概念题证据记到每个所需概念（selection.ts D-20b 的简化）；EduCDM 做完整 EM
  联合估计。两者在上表口径下的一致程度以数字为准，不外推。
- guess 的 EM 估计在小样本（20 人）下方差大是已知现象——这正是 selection.ts
  把 guess 钉为 1/选项数的理由（小样本下 3PL 的 c 不可识别）。slip 估计与 0.1
  先验的偏差见上表。

日志：`apps/agent-engine/data/eval/dina_educdm_audit.log`
脚本：`apps/agent-engine/scripts/audit_dina_educdm.py`
"""
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(report, encoding="utf-8")
    log.info("报告写入 %s", REPORT_PATH)


if __name__ == "__main__":
    main()
