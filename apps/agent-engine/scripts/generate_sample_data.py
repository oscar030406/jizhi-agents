"""Regenerate tracked sample fixtures.

This is a destructive maintenance command: it rewrites learner profiles, quiz data,
sample documents, v1/v2 evaluation cases, and resets the v1 result CSV. Normal
startup, testing, and CI must use the committed fixtures instead.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


DOCS = [
    ("kb001", "Agent 基础概念", "agent_basics", "L1", ["agent_basics"], "Agent 是围绕目标、上下文、工具和反馈循环组织起来的 LLM 应用单元。高质量 Agent 不是自由聊天，而是把输入、状态、工具调用和输出约束成可审计流程。"),
    ("kb002", "LLM 应用开发流程", "llm_app_flow", "L1", ["agent_basics", "deployment"], "一个可交付 LLM 应用通常包含需求定义、数据准备、提示词或 schema 设计、检索或工具接入、评测、日志和部署。先做端到端闭环，再扩展模型能力。"),
    ("kb003", "Prompt 与结构化输出", "structured_output", "L2", ["structured_output", "evaluation"], "结构化输出通过 JSON schema、Pydantic 或函数参数约束模型结果，能降低后处理复杂度。教育场景中应要求资源、题目、证据和审核结果分别输出。"),
    ("kb004", "Tool Calling 基础", "tool_calling", "L2", ["tool_calling"], "Tool Calling 让模型选择并调用外部函数，例如检索、计算、查询数据库或执行代码。工具必须有清晰输入输出、错误处理和权限边界。"),
    ("kb005", "Function Calling 与参数设计", "tool_calling", "L2", ["tool_calling", "structured_output"], "函数参数应尽量窄而明确，避免把整段自然语言传给万能函数。好的参数包括 query、top_k、filters、source_ids、difficulty 等可验证字段。"),
    ("kb006", "RAG 基础", "rag", "L1", ["rag"], "RAG 通过检索外部知识片段来约束生成内容。它的价值不是让模型更会背答案，而是让回答可以追溯到证据来源。"),
    ("kb007", "文档切分策略", "rag_chunking", "L2", ["rag"], "文档切分要平衡语义完整性和检索粒度。教育知识库可按概念、步骤、误区和练习任务切分，并保留 title、section、difficulty、concept_tags。"),
    ("kb008", "向量检索与关键词检索", "retrieval", "L2", ["rag"], "向量检索适合语义相近的问题，关键词检索适合专有名词和 API 字段。原型阶段可以用 TF-IDF，生产阶段可替换为 Chroma、FAISS 或 pgvector。"),
    ("kb009", "证据门控", "evidence_gate", "L3", ["rag", "guardrails"], "证据门控要求生成前先检索，生成后再检查关键事实是否能被 source_id 支持。低置信检索应触发补检索、降级回答或人工审核。"),
    ("kb010", "LangGraph 工作流思想", "langgraph", "L3", ["langgraph"], "LangGraph 的核心是把 Agent 应用建模为状态图。节点处理状态，边控制转移，适合诊断、检索、生成、审核、反馈这类长流程。"),
    ("kb011", "多 Agent 协作模式", "multi_agent", "L3", ["agent_basics", "evaluation"], "多 Agent 协作不是堆角色名，而是让不同节点承担诊断、检索、生成、审核和决策职责，并暴露各自中间产物。"),
    ("kb012", "审核 Agent 规则", "audit_agent", "L3", ["guardrails", "evaluation"], "审核 Agent 应检查引用覆盖率、难度匹配、概念覆盖和无证据断言。审核失败时应返回修订建议，而不是直接发布。"),
    ("kb013", "Agent 评测指标", "agent_evaluation", "L3", ["evaluation"], "Agent 评测应包含流程成功率、引用覆盖率、知识点覆盖率、难度适配和幻觉风险标记。指标必须可复算，不能只由模型自评。"),
    ("kb014", "Trace 与日志", "trace_logging", "L2", ["evaluation"], "Trace 记录每个节点的输入、输出、状态和耗时。演示时展示 trace 能证明系统不是黑盒，并方便定位失败节点。"),
    ("kb015", "Guardrails 与人工审核", "guardrails", "L3", ["guardrails"], "Guardrails 包括输入校验、工具权限、输出 schema、事实审核和人工审批。高风险教育内容应保留人工抽查入口。"),
    ("kb016", "FastAPI 服务化", "deployment", "L2", ["deployment"], "FastAPI 适合把 Agent 工作流暴露为 API。核心接口应包括画像、先测、运行工作流、检索、反馈和评测摘要。"),
    ("kb017", "Docker 部署", "deployment", "L2", ["deployment"], "Dockerfile 和 docker-compose 可以固定运行方式。比赛原型至少应支持一条命令启动 API 和前端，并通过 README 说明环境变量。"),
    ("kb018", "文档问答系统实操", "project_doc_qa", "L2", ["rag", "tool_calling"], "文档问答项目的最小闭环是导入文档、检索片段、基于证据回答、输出引用和记录失败案例。它适合作为 RAG 入门实操。"),
    ("kb019", "工具调用 Agent 实操", "project_tool_agent", "L3", ["tool_calling", "agent_basics"], "工具调用 Agent 的最小任务是接收目标、选择工具、执行工具、解释结果并记录工具参数。必须处理工具失败和无权限场景。"),
    ("kb020", "多 Agent 学习助手实操", "project_learning_assistant", "L4", ["agent_basics", "rag", "evaluation", "guardrails"], "多 Agent 学习助手要把学情诊断、资源生成、内容审核和反馈决策串成闭环。高分演示应展示角色分工和每步证据。"),
    ("kb021", "难度 L1-L4 定标", "difficulty_calibration", "L2", ["evaluation"], "L1 是概念识别，L2 是按步骤实现，L3 是组合模块并排错，L4 是开放任务、评测和工程化交付。资源难度应随画像动态调整。"),
    ("kb022", "学习反馈决策", "feedback_loop", "L3", ["evaluation", "guardrails"], "反馈决策可根据测验得分和信心判断降维解释、保持路线、增加练习或进阶挑战。决策应留下理由，便于学习者理解。"),
]


PROFILES = [
    {
        "id": "zero_beginner",
        "name": "零基础型",
        "background": "非计算机专业，想用 AI 做简单工具。",
        "programming_level": 0,
        "python_level": 0,
        "agent_level": 0,
        "rag_level": 0,
        "engineering_level": 0,
        "learning_goal": "理解 Agent 应用开发的最小闭环，并完成一个文档问答助手。",
        "time_budget_hours": 24,
        "learning_preference": "生活类比和分步练习",
        "constraints": ["avoid_jargon", "needs_visual_trace"],
    },
    {
        "id": "python_no_agent",
        "name": "有 Python 基础但不了解 Agent",
        "background": "会写脚本和简单 Web API，但没做过 Agent/RAG。",
        "programming_level": 2,
        "python_level": 3,
        "agent_level": 0,
        "rag_level": 1,
        "engineering_level": 2,
        "learning_goal": "用 FastAPI 做一个带检索和工具调用的 Agent 服务。",
        "time_budget_hours": 36,
        "learning_preference": "代码模板和可运行示例",
        "constraints": ["wants_code_first"],
    },
    {
        "id": "ai_weak_engineering",
        "name": "AI 专业但工程能力弱",
        "background": "理解模型和论文，缺少 API、部署、测试经验。",
        "programming_level": 2,
        "python_level": 2,
        "agent_level": 2,
        "rag_level": 2,
        "engineering_level": 1,
        "learning_goal": "把 RAG 和评测做成可部署的 Agent 工作流。",
        "time_budget_hours": 40,
        "learning_preference": "架构图、接口说明和测试驱动",
        "constraints": ["needs_deployment_practice"],
    },
    {
        "id": "backend_to_agent",
        "name": "后端开发转 Agent 应用",
        "background": "熟悉后端服务和数据库，想掌握 Agent 编排与审核。",
        "programming_level": 4,
        "python_level": 3,
        "agent_level": 1,
        "rag_level": 2,
        "engineering_level": 4,
        "learning_goal": "构建可观测、多 Agent 协作、带审核和评测的学习助手。",
        "time_budget_hours": 48,
        "learning_preference": "系统设计、接口契约和扩展 TODO",
        "constraints": ["prefers_api_first"],
    },
    {
        "id": "competition_sprint",
        "name": "竞赛冲刺型",
        "background": "团队成员，需要快速做出比赛演示和指标报告。",
        "programming_level": 3,
        "python_level": 3,
        "agent_level": 2,
        "rag_level": 2,
        "engineering_level": 3,
        "learning_goal": "在一周内完成可演示的多 Agent 个性化学习系统原型。",
        "time_budget_hours": 20,
        "learning_preference": "闭环优先、评测优先、演示脚本优先",
        "constraints": ["deadline_pressure", "needs_demo_assets"],
    },
]


CONCEPTS = ["agent_basics", "rag", "tool_calling", "langgraph", "evaluation", "guardrails", "deployment"]


def ensure_dirs() -> None:
    for path in [
        ROOT / "data" / "knowledge_base" / "sample_docs",
        ROOT / "data" / "learner_profiles",
        ROOT / "data" / "quiz",
        ROOT / "data" / "eval",
    ]:
        path.mkdir(parents=True, exist_ok=True)


def write_docs() -> None:
    doc_dir = ROOT / "data" / "knowledge_base" / "sample_docs"
    for source_id, title, topic, difficulty, tags, body in DOCS:
        front = "\n".join(
            [
                "---",
                f"source_id: {source_id}",
                f"title: {title}",
                f"topic: {topic}",
                f"difficulty: {difficulty}",
                f"concept_tags: {', '.join(tags)}",
                "url: local://sample_knowledge_base",
                "---",
                "",
            ]
        )
        content = (
            f"{front}# {title}\n\n"
            f"{body}\n\n"
            f"## 实训提示\n\n"
            f"学习者需要把 `{', '.join(tags)}` 转换成可运行任务，并在输出中保留证据、难度和审核字段。\n"
        )
        (doc_dir / f"{source_id}_{topic}.md").write_text(content, encoding="utf-8")

    manifest = ROOT / "data" / "knowledge_base" / "sources_manifest.csv"
    with manifest.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=["source_id", "title", "url", "license", "note"])
        writer.writeheader()
        for source_id, title, *_ in DOCS:
            writer.writerow(
                {
                    "source_id": source_id,
                    "title": title,
                    "url": "local://sample_knowledge_base",
                    "license": "sample generated for competition prototype",
                    "note": "Local replaceable sample; not an external citation.",
                }
            )


def write_profiles() -> None:
    path = ROOT / "data" / "learner_profiles" / "learner_profiles.json"
    path.write_text(json.dumps(PROFILES, ensure_ascii=False, indent=2), encoding="utf-8")


def write_questions() -> None:
    questions = []
    for idx in range(30):
        concept = CONCEPTS[idx % len(CONCEPTS)]
        difficulty = ["L1", "L2", "L3", "L4"][idx % 4]
        questions.append(
            {
                "id": f"q{idx + 1:02d}",
                "question": f"关于 {concept} 的 Agent 实训，下列哪项最符合可验证系统要求？",
                "options": {
                    "A": "只让模型自由回答，不保存中间过程。",
                    "B": "把输入、证据、输出和审核结果结构化记录。",
                    "C": "为了演示效果隐藏失败案例。",
                    "D": "不设置难度等级，所有学习者使用同一资源。",
                },
                "answer": "B",
                "explanation": "赛题强调流程闭环、证据追踪、结构化输出和可复算评测。",
                "concept_tags": [concept],
                "difficulty": difficulty,
            }
        )
    path = ROOT / "data" / "quiz" / "pretest_questions.jsonl"
    path.write_text("\n".join(json.dumps(q, ensure_ascii=False) for q in questions) + "\n", encoding="utf-8")


# 12 个学习目标 × 5 组画像 = 60 组端到端用例（赛题要求 ≥50）。
# 两套金标（见 docs/gold_standard_protocol.md）：
# - v1（本文件主输出 e2e_cases.jsonl）：expected_difficulty 由诊断算法生成 = 自证基线，
#   仅作对照，difficulty_match 天然≈100%，无对外参考价值。
# - v2（gold_v2/，由 write_e2e_gold_v2 生成）：expected_difficulty 由独立准则 gold_labeler 生成，
#   破循环论证，是可对外声称的真实适配率。团队须按协议人工复核 v2。
GOALS = [
    ("完成 RAG 文档问答 Agent", ["rag", "agent_basics"]),
    ("实现工具调用 Agent 并记录 trace", ["tool_calling", "agent_basics"]),
    ("用 LangGraph 思想组织多 Agent 工作流", ["langgraph", "agent_basics"]),
    ("建立 Agent 评测和审核指标", ["evaluation", "guardrails"]),
    ("把学习助手部署为 API 服务", ["deployment", "agent_basics"]),
    ("设计证据门控的检索增强生成流程", ["rag"]),
    ("为工具调用 Agent 增加权限与审核边界", ["tool_calling", "guardrails"]),
    ("搭建多 Agent 协作的内容审核工作流", ["langgraph", "guardrails"]),
    ("构建带评测看板的学习 Agent", ["evaluation", "agent_basics"]),
    ("用 Docker 部署带检索的问答服务", ["rag", "deployment"]),
    ("实现检索结果重排与引用面板", ["rag"]),
    ("从零构建一个带审核和部署的文档问答助手", ["rag", "guardrails", "deployment"]),
]


def write_e2e_cases() -> None:
    from backend.agents.learner_diagnosis_agent import LearnerDiagnosisAgent
    from backend.schemas.learner import LearnerProfile
    from backend.services.quiz_service import estimate_pretest_from_profile

    diagnosis_agent = LearnerDiagnosisAgent()
    profiles_by_id = {p["id"]: LearnerProfile(**p) for p in PROFILES}
    pretest_by_id = {pid: estimate_pretest_from_profile(p, []) for pid, p in profiles_by_id.items()}

    cases = []
    index = 0
    for goal, concepts in GOALS:
        for raw_profile in PROFILES:
            index += 1
            pid = raw_profile["id"]
            # v1 自证金标：难度由被测诊断算法(目标感知)生成，与运行时一致 → 循环论证的对照
            diagnosis = diagnosis_agent.run(profiles_by_id[pid], pretest_by_id[pid], learning_goal=goal)
            cases.append(
                {
                    "id": f"case{index:02d}",
                    "learner_profile_id": pid,
                    "learning_goal": goal,
                    "expected_concepts": concepts,
                    "expected_difficulty": diagnosis.recommended_difficulty,
                    "must_include": [concepts[0], "证据"],
                    "must_not_include": ["保证满分", "未经验证的外部来源"],
                }
            )
    path = ROOT / "data" / "eval" / "e2e_cases.jsonl"
    path.write_text("\n".join(json.dumps(case, ensure_ascii=False) for case in cases) + "\n", encoding="utf-8")
    (ROOT / "data" / "eval" / "eval_results.csv").write_text(
        "case_id,concept_coverage,citation_coverage,difficulty_match,hallucination_rate,hallucination_risk_flag_rate,workflow_success\n",
        encoding="utf-8",
    )
    write_e2e_gold_v2(cases)


def write_e2e_gold_v2(cases: list[dict]) -> None:
    """独立金标（Phase A-1，破循环）：expected_difficulty 由独立评分准则（gold_labeler）
    而非诊断算法生成；expected_concepts 沿用人工标注。标注方法写入字段，供人工复核。"""
    from backend.services.gold_labeler import independent_expected_difficulty
    from backend.schemas.learner import LearnerProfile

    profiles_by_id = {p["id"]: LearnerProfile(**p) for p in PROFILES}
    gold_dir = ROOT / "data" / "eval" / "gold_v2"
    gold_dir.mkdir(parents=True, exist_ok=True)
    v2_cases = []
    for case in cases:
        profile = profiles_by_id[case["learner_profile_id"]]
        v2_cases.append(
            {
                **case,
                "expected_difficulty": independent_expected_difficulty(profile, case["learning_goal"]),
                "difficulty_source": "independent_heuristic_v2_pending_human_review",
                "concept_source": "hand_authored_per_goal",
            }
        )
    (gold_dir / "e2e_cases.jsonl").write_text(
        "\n".join(json.dumps(c, ensure_ascii=False) for c in v2_cases) + "\n", encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="重建仓库内已跟踪的样例与评测夹具（破坏性维护命令）")
    parser.add_argument(
        "--force",
        action="store_true",
        help="确认覆盖 learner_profiles、quiz、sample_docs、v1/v2 cases 和 v1 结果 CSV",
    )
    args = parser.parse_args()
    if not args.force:
        parser.error("该命令会覆盖已跟踪数据；仅在明确重建夹具时使用 --force")

    ensure_dirs()
    write_docs()
    write_profiles()
    write_questions()
    write_e2e_cases()
    print("sample data regenerated")


if __name__ == "__main__":
    main()
