# param_recovery —— 掌握度推断链的 parameter recovery 实验

给个性化有效性出硬数字的内部效度实验：用**已知参数**（掌握 bool 向量 + slip/guess）
的模拟学习者生成作答，喂进引擎真实的掌握度推断链，量化推断结果对已知参数的复原度。
零 LLM 调用、纯本地、秒级、确定种子可重跑。

## 文件

| 文件 | 内容 |
|---|---|
| `profiles.py` | ground-truth 画像参数表（10 个，设计维度：掌握水平 × 特定误解/特长 × 噪声参数） |
| `run_experiment.py` | 模拟作答（规则采样）→ 真实推断链 → 指标 → 报告。实验参数全部在文件头部常量区 |
| `results/runs.jsonl` | 逐 (条件×种子×画像×轮次) 明细，含估计向量 |
| `results/report.md` | 汇总表 + 曲线读法 + 四道防循环闸 + 内部效度限度 + 含糊点清单 |
| `results/run.log` | 运行日志 |

## 跑法

```bash
cd apps/agent-engine
python scripts/param_recovery/run_experiment.py
```

## 被测的是什么

引擎真实代码，直接 import（非镜像重写）：
`quiz_service.score_pretest` → `LearnerDiagnosisAgent.run`（LLM 网关注入禁用桩，
只走确定性数值路径）→ `feedback_adaptation.adapt_feedback`（EWMA 0.7/0.3 逐轮折叠）。

对照基线：全概念 0.5 先验不更新（无个性化）、每轮均匀随机（随机诊断）。
指标：逐概念判定准确率 PCA（主）、掌握度 MAE、随轮数收敛曲线；3 种子。

设计取舍与含糊点（保守解释）见 `results/report.md` 末节。
slip=0.15 / guess=0.25 为文献常用先验，待用 XES3G5M 作答分布校准。
