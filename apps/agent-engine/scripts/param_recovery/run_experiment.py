# -*- coding: utf-8 -*-
"""Parameter recovery 实验：已知参数的模拟学习者 → 真实掌握度推断链 → 能否复原参数。

被测系统 = 引擎侧真实代码（直接 import，非镜像）：
  1. backend/services/quiz_service.py::score_pretest —— 作答折叠成逐概念得分
  2. backend/agents/learner_diagnosis_agent.py::LearnerDiagnosisAgent.run
     —— 初始掌握向量（LLM 网关注入禁用桩，只走确定性路径）
  3. backend/services/feedback_adaptation.py::adapt_feedback
     —— 逐轮 EWMA 折叠（new = old*0.7 + score*0.3）

模拟作答 = 规则采样（认识论保真：行为由参数生成，不用 LLM 扮演学生）：
  会的概念以 1-slip 概率答对，不会的以 guess 概率蒙对。

运行：cd apps/agent-engine && python scripts/param_recovery/run_experiment.py
输出：scripts/param_recovery/results/{runs.jsonl, report.md, run.log}
零 LLM 调用、纯本地、秒级。
"""
from __future__ import annotations

import json
import logging
import random
import statistics
import sys
from pathlib import Path
from types import SimpleNamespace

ENGINE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ENGINE_ROOT))

from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent  # noqa: E402
from backend.schemas.learner import (  # noqa: E402
    FeedbackInput,
    LearnerProfile,
    PretestAnswer,
    PretestQuestion,
)
from backend.schemas.resources import FeedbackDecision  # noqa: E402
from backend.services.feedback_adaptation import adapt_feedback  # noqa: E402
from backend.services.quiz_service import score_pretest  # noqa: E402

from profiles import CONCEPTS, PROFILES  # noqa: E402

# ---------------- 实验参数（全部在此，不散落命令行） ----------------
SEEDS = [1, 2, 3]
ROUNDS = 4                    # 每画像模拟测验轮数
PRETEST_Q_PER_CONCEPT = 2     # 前测每概念题数（8 概念 × 2 = 16 题）
QUIZ_Q_PER_CONCEPT = 2        # 每轮测验每聚焦概念题数（3 概念 × 2 = 6 题/轮，落在 5-8 规格内）
MASTERY_THRESHOLD = 0.5       # PCA 主判定阈（bool 真值的中点）
SYSTEM_WEAK_THRESHOLD = 0.65  # 系统自身弱概念阈（feedback_adaptation.WEAK_MASTERY_THRESHOLD），报告里作次要阈
LEARNING_GOAL = "掌握 Agent 开发基础"

RESULTS_DIR = Path(__file__).resolve().parent / "results"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler()],
)
log = logging.getLogger("param_recovery")


class _NoLLM:
    """禁用网关桩：诊断 Agent 只走确定性路径，保证零 LLM 调用。"""

    def is_enabled(self, agent: str) -> bool:
        return False


# ---------------- 模拟作答（规则采样，非 LLM 扮演） ----------------

def answer_correct(rng: random.Random, mastered: bool, slip: float, guess: float) -> bool:
    return rng.random() < ((1.0 - slip) if mastered else guess)


def make_learner_profile(pid: str) -> LearnerProfile:
    # 各能力级统一取 2（中位）：诊断 Agent 的 setdefault 先验只对未提供的概念生效；
    # 我们对全部 8 个概念都提供前测得分，故先验仅影响概念集外的 deployment 键（见报告含糊点②）。
    return LearnerProfile(
        id=f"sim_{pid}", name=pid, background="parameter-recovery 模拟学习者",
        programming_level=2, python_level=2, agent_level=2, rag_level=2,
        engineering_level=2, learning_goal=LEARNING_GOAL,
        time_budget_hours=40, learning_preference="text", corpus="",
    )


def simulate_pretest(rng: random.Random, truth: dict) -> tuple[list[PretestQuestion], list[PretestAnswer]]:
    questions, answers = [], []
    for concept in CONCEPTS:
        for i in range(PRETEST_Q_PER_CONCEPT):
            qid = f"pre_{concept}_{i}"
            questions.append(PretestQuestion(
                id=qid, question=f"[synthetic] {concept} #{i}",
                options={"A": "对", "B": "错"}, answer="A",
                explanation="synthetic", concept_tags=[concept], difficulty="L2",
            ))
            ok = answer_correct(rng, truth["mastery"][concept], truth["slip"], truth["guess"])
            answers.append(PretestAnswer(question_id=qid, selected="A" if ok else "B"))
    return questions, answers


def pick_quiz_concepts(diagnosis) -> list[str]:
    """本轮测验聚焦哪几个概念：跟随系统自己的弱概念判定（限制在实验概念集内），
    与 feedback_adaptation._focus_concepts 的取法一致（弱概念优先，否则取掌握度最低的 2 个）。"""
    weak = [c for c in diagnosis.weak_concepts if c in CONCEPTS][:3]
    if weak:
        return weak
    mastery = {c: diagnosis.mastery_vector.get(c, 0.0) for c in CONCEPTS}
    return [c for c, _ in sorted(mastery.items(), key=lambda kv: (kv[1], kv[0]))[:2]]


def simulate_quiz(rng: random.Random, truth: dict, concepts: list[str]) -> tuple[dict[str, float], float]:
    """逐概念答题 → 逐概念得分（正确率）与总分。评分=算距离，零判官。"""
    concept_scores, total_ok, total_n = {}, 0, 0
    for concept in concepts:
        ok = sum(
            answer_correct(rng, truth["mastery"][concept], truth["slip"], truth["guess"])
            for _ in range(QUIZ_Q_PER_CONCEPT)
        )
        concept_scores[concept] = round(ok / QUIZ_Q_PER_CONCEPT, 3)
        total_ok += ok
        total_n += QUIZ_Q_PER_CONCEPT
    return concept_scores, round(total_ok / total_n, 3) if total_n else 0.0


# ---------------- 被测系统与基线 ----------------

def run_system(rng: random.Random, pid: str, truth: dict) -> list[dict[str, float]]:
    """真实推断链：前测诊断 + ROUNDS 轮反馈折叠。返回每轮末的掌握向量（限实验概念集）。"""
    profile = make_learner_profile(pid)
    questions, answers = simulate_pretest(rng, truth)
    pretest = score_pretest(profile.id, questions, answers)
    diagnosis = LearnerDiagnosisAgent(gateway=_NoLLM()).run(profile, pretest, LEARNING_GOAL)

    trajectory = []
    for r in range(ROUNDS):
        quiz_concepts = pick_quiz_concepts(diagnosis)
        concept_scores, quiz_score = simulate_quiz(rng, truth, quiz_concepts)
        feedback = FeedbackInput(
            learner_profile_id=profile.id, quiz_score=quiz_score,
            confidence=None, concept_scores=concept_scores,
        )
        decision = FeedbackDecision(
            feedback_type="quiz", decision="keep_route",
            updated_difficulty=diagnosis.recommended_difficulty,
            next_action="keep_route", explanation="param-recovery synthetic",
        )
        # adapt_feedback 只读 parent_run 的 run_id / learning_goal / diagnosis 三个字段，
        # 用 SimpleNamespace 鸭子类型替代完整 WorkflowRun（若该函数未来访问更多字段需同步此处）。
        parent_run = SimpleNamespace(
            run_id=f"{pid}_r{r}", learning_goal=LEARNING_GOAL, diagnosis=diagnosis,
        )
        adaptation = adapt_feedback(profile, parent_run, feedback, decision)
        diagnosis = adaptation.diagnosis
        trajectory.append({c: diagnosis.mastery_vector.get(c, 0.0) for c in CONCEPTS})
    return trajectory


def run_baseline_static() -> list[dict[str, float]]:
    """无个性化基线：全概念 0.5 先验，永不更新。"""
    return [{c: 0.5 for c in CONCEPTS} for _ in range(ROUNDS)]


def run_baseline_random(rng: random.Random) -> list[dict[str, float]]:
    """随机诊断基线：每轮每概念均匀随机掌握度。"""
    return [{c: rng.random() for c in CONCEPTS} for _ in range(ROUNDS)]


# ---------------- 指标：算距离，零判官 ----------------

def score_round(est: dict[str, float], truth_mastery: dict[str, bool], threshold: float) -> tuple[float, float]:
    hits = [int((est[c] >= threshold) == truth_mastery[c]) for c in CONCEPTS]
    mae = [abs(est[c] - (1.0 if truth_mastery[c] else 0.0)) for c in CONCEPTS]
    return sum(hits) / len(hits), sum(mae) / len(mae)


def main() -> None:
    # 概念集来自真实概念图谱：启动即断言，防语料漂移
    graph = json.loads(
        (ENGINE_ROOT / "data" / "knowledge_base" / "concept_graph.json").read_text(encoding="utf-8")
    )
    missing = [c for c in CONCEPTS if c not in graph]
    assert not missing, f"概念不在 concept_graph.json 中: {missing}"

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    log.addHandler(logging.FileHandler(RESULTS_DIR / "run.log", mode="w", encoding="utf-8"))
    log.info("start: %d profiles x %d seeds x %d rounds", len(PROFILES), len(SEEDS), ROUNDS)

    rows = []
    for seed in SEEDS:
        for pid, truth in PROFILES.items():
            rng = random.Random(f"{seed}:{pid}")
            trajectories = {
                "system": run_system(rng, pid, truth),
                "baseline_static": run_baseline_static(),
                "baseline_random": run_baseline_random(random.Random(f"{seed}:{pid}:rand")),
            }
            for name, traj in trajectories.items():
                for r, est in enumerate(traj, start=1):
                    pca, mae = score_round(est, truth["mastery"], MASTERY_THRESHOLD)
                    pca65, _ = score_round(est, truth["mastery"], SYSTEM_WEAK_THRESHOLD)
                    rows.append({
                        "condition": name, "seed": seed, "profile": pid, "round": r,
                        "pca": round(pca, 4), "pca_t065": round(pca65, 4),
                        "mae": round(mae, 4), "estimate": {c: round(est[c], 3) for c in CONCEPTS},
                    })
            log.info("seed=%s profile=%s done", seed, pid)

    with (RESULTS_DIR / "runs.jsonl").open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    write_report(rows)
    log.info("done: %d rows -> %s", len(rows), RESULTS_DIR)


# ---------------- 报告 ----------------

def _agg(rows, condition, r, key):
    vals = [x[key] for x in rows if x["condition"] == condition and x["round"] == r]
    return statistics.mean(vals), (statistics.stdev(vals) if len(vals) > 1 else 0.0)


def write_report(rows) -> None:
    conds = ["system", "baseline_static", "baseline_random"]
    cond_zh = {"system": "被测系统（真实推断链）", "baseline_static": "基线A：无个性化（0.5 先验不更新）",
               "baseline_random": "基线B：随机诊断"}

    lines = [
        "# Parameter Recovery 实验报告：掌握度推断链能否复原已知参数",
        "",
        f"- 画像数 {len(PROFILES)}（设计覆盖见 profiles.py）× 种子 {SEEDS} × 每画像 {ROUNDS} 轮测验"
        f"（前测 {len(CONCEPTS)}×{PRETEST_Q_PER_CONCEPT} 题，每轮聚焦概念 ×{QUIZ_Q_PER_CONCEPT} 题）",
        f"- 概念集：{', '.join(CONCEPTS)}（取自 data/knowledge_base/concept_graph.json AI 主域，启动断言存在）",
        "- 被测代码：quiz_service.score_pretest → LearnerDiagnosisAgent.run（确定性路径）→ "
        "feedback_adaptation.adapt_feedback（EWMA 0.7/0.3）。直接 import 引擎真实代码，非镜像重写。",
        "",
        "## 主结果：PCA（逐概念判定准确率，阈 0.5）随轮数收敛",
        "",
        "| 轮次 | " + " | ".join(cond_zh[c] for c in conds) + " |",
        "|---|" + "---|" * len(conds),
    ]
    for r in range(1, ROUNDS + 1):
        cells = []
        for c in conds:
            m, s = _agg(rows, c, r, "pca")
            cells.append(f"{m:.3f} ± {s:.3f}")
        lines.append(f"| {r} | " + " | ".join(cells) + " |")

    lines += ["", "## 掌握度估计 MAE（对 bool 真值 {0,1}）", "",
              "| 轮次 | " + " | ".join(cond_zh[c] for c in conds) + " |",
              "|---|" + "---|" * len(conds)]
    for r in range(1, ROUNDS + 1):
        cells = []
        for c in conds:
            m, s = _agg(rows, c, r, "mae")
            cells.append(f"{m:.3f} ± {s:.3f}")
        lines.append(f"| {r} | " + " | ".join(cells) + " |")

    sys_first, _ = _agg(rows, "system", 1, "pca")
    sys_last, _ = _agg(rows, "system", ROUNDS, "pca")
    stat_last, _ = _agg(rows, "baseline_static", ROUNDS, "pca")
    rand_last, _ = _agg(rows, "baseline_random", ROUNDS, "pca")
    sys65, _ = _agg(rows, "system", ROUNDS, "pca_t065")
    lines += [
        "",
        "## 曲线读法",
        "",
        f"被测系统第 1 轮 PCA {sys_first:.3f}，第 {ROUNDS} 轮 {sys_last:.3f}"
        f"（变化 {sys_last - sys_first:+.3f}）；同轮无个性化基线 {stat_last:.3f}、随机基线 {rand_last:.3f}。"
        f"用系统自身弱概念阈 0.65 复判，末轮 PCA 为 {sys65:.3f}。"
        "收敛主要来自前测（16 题直接观测全部概念）；逐轮增益受 MAX_FOCUS_CONCEPTS=3 限制"
        "——每轮最多折叠 3 个概念的新证据，其余概念维持前测估计。",
        "",
        "## 四道防循环闸",
        "",
        "1. **真值=参数表，非扮演**：学习者行为由写死的 mastery/slip/guess 参数生成"
        "（profiles.py），不用 LLM 扮演学生——不存在生成方和被测方共享模型先验的循环。",
        "2. **评分=算距离，零判官**：PCA/MAE 是估计向量对参数表的算术距离，无任何 LLM 判官参与。",
        "3. **噪声参数出处**：slip=0.15 / guess=0.25 为文献常用先验，**待用 XES3G5M 作答分布校准**；"
        "画像内含 slip=0.25 / guess=0.35 变体覆盖参数扰动。",
        "4. **范式=parameter recovery**：已知参数生成数据→推断→比对复原度，是认知建模的标准"
        "内部效度检验（cf. parameter recovery 方法学，Frontiers, 2021；引文条目入正式材料前需核对具体文献）。",
        "",
        "## 内部效度限度声明",
        "",
        "本实验证明的是：**若学习者行为符合 slip/guess 作答模型，推断链能以上表精度复原其掌握参数**。"
        "它不证明真实学习者行为符合该模型，也不证明个性化内容的教学效果——那是外部效度问题，"
        "需真人数据（如 XES3G5M 校准、线上 A/B）另行回答。",
        "",
        "## 实现口径与含糊点（均取保守解释）",
        "",
        "1. `adapt_feedback` 的 `MAX_FOCUS_CONCEPTS=3`：每轮只折叠 concept_scores 的前 3 个概念。"
        "实验按系统真实行为办——每轮测验只出系统当前弱概念（≤3 个）的题，不绕过该限制。",
        "2. 诊断 Agent 会 setdefault 出概念集外的 `deployment` 键（画像能力级先验）。"
        "指标只算实验 8 概念；选题时把弱概念过滤到概念集内，避免测概念集外键。",
        "3. PCA 主阈取 0.5（bool 真值中点）；系统自身弱概念阈 0.65 作次要阈并列报告。",
        "4. 决策分支固定 `keep_route`：本实验只测掌握度折叠，不测决策 Agent（后者含 LLM 成分，"
        "属另一实验）。`updated_difficulty` 原样回传上一轮推荐值。",
        "5. `WorkflowRun` 用 SimpleNamespace 鸭子类型替代（adapt_feedback 只读 run_id / "
        "learning_goal / diagnosis 三字段）；若引擎侧函数改动访问字段，此处需同步。",
        "6. 基线判定并列时（0.5 ≥ 阈 0.5）计为「已掌握」——对无个性化基线是偏乐观的让步。",
        "",
    ]
    (RESULTS_DIR / "report.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
