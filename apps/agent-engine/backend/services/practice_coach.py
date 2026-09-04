"""项目带练的第二层：把里程碑拆成代码任务，配一个能问的伴学教练。

上一层（practice_guide）把项目拆成里程碑，回答「先做哪段、做到哪算完」。学习者真正
卡住的是「这一段的代码怎么写」。这一层做三件事，都以里程碑为上下文：

1. 代码任务（code_tasks）：一个里程碑拆成 2~4 个循序渐进的小任务，每个任务给骨架代码，
   骨架里留 TODO 让学习者填——零基础档骨架几乎写全、只留一两行；有基础档给函数签名和
   注释；熟练档只给接口约定。任务之间写清「上一步的产物怎么接到这一步」，最后一个任务
   把这一段的模块连起来。每个任务带可检查的判分要点和三级提示（方向 / 伪代码 / 参考实现），
   看过参考实现的那次判分最高只记「部分正确」。同档缓存，和里程碑一样。
2. 判代码（grade_code）：对照任务的判分要点判 correct / partial / incorrect，逐条说依据，
   指出问题和下一步改什么。不跑代码——判官是读，不是执行；判据写成能靠读判出的形态。
3. 伴学对话（coach_chat）：学习者随时问「这行怎么写、报错什么意思」，教练带着里程碑、
   当前任务骨架、README 摘录和知识库证据回答。默认给思路和最小片段，不整段抄答案；学习者
   连问两次同一处再给完整实现。引用知识库的话带 source_id。

事实边界与上一层一致：项目事实只来自卡片和 README；库外知识不硬引 source_id。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from backend.services import practice_guide as pg
from backend.services import practice_scout
from backend.services.llm_gateway import LLMGateway

TASKS_SCHEMA_VERSION = 1
TASK_AGENT = pg.AGENT  # 起草任务归资源生成那一档
COACH_AGENT = "ConversationTutor"  # 对话与判分走导学那一档（fast），和课堂导学同一支


class CoachError(RuntimeError):
    pass


TASKS_SYSTEM = """你是实训导师，负责把一个项目里程碑拆成 2~4 个循序渐进的代码任务，让学习者自己把代码写出来。
输入：项目推荐卡（事实字段不可改写）、README 摘录、这个里程碑的目标 / 要搭什么 / 怎么做 / 验收标准、学习者姿态档与本次的拆法要求。
要求：
1. 任务按做的顺序排；前一个任务的产物是后一个的输入；最后一个任务把这一段涉及的模块接起来，能跑出验收标准里说的结果。
2. 每个任务：id（t1、t2…）、title（不超过 16 字）、brief（两句话：要写什么、写完能看到什么）、language（如 python）、skeleton（骨架代码，含 TODO 注释标出要填的地方；按姿态档决定留多少：零基础只留 1~3 行、每个 TODO 旁写一句提示；有基础留函数体、给签名和 docstring；熟练只给接口和输入输出约定）、criteria（3~5 条，判官靠读代码就能判的要点，如「用了 for 循环遍历列表」「函数有返回值且返回列表」）、expected_output（运行后应看到什么，一句话）、hints（恰好 3 条，依次是：方向提示、伪代码或分步、参考实现代码）、bridge（一句话：这一步的产物怎么接到下一步；最后一个任务写「怎么验证整段完成」）。
3. 不得引入卡片与 README 之外的项目事实（文件名、函数名可以自拟，但要与骨架一致）。
4. 只输出一个 JSON 对象：{"tasks": [...]}，不要多余文字。"""

GRADE_SYSTEM = """你是实训判官，对照任务的判分要点判学习者提交的代码。你只读代码不运行。
输出 JSON：{"verdict": "correct" | "partial" | "incorrect", "because": ["逐条对照要点，写命中或缺失，引用学习者代码里的具体片段"], "problems": ["1-3 条表达、逻辑或工程习惯问题；没有就空数组"], "next": "一句话，学习者下一步改什么或可以进入下一任务"}。
判据：全部要点命中且没有明显逻辑错误 = correct；命中一半以上 = partial；否则 incorrect。代码明显是把参考实现原样贴回来（与提供的参考实现逐行相同）也只记 partial，并在 problems 里说明。"""

COACH_SYSTEM = """你是陪学习者做项目的编程教练。你手里有：项目卡与 README 摘录、当前里程碑的目标与做法、当前代码任务的骨架与判分要点、知识库里相关的教材段（带 source_id）、对话历史。
规则：
1. 先回答问题本身，用学习者能看懂的话；有代码就给最小片段，默认不给整段任务的完整实现。
2. 学习者对同一处第二次说不会，或明确要求完整代码，就给完整实现，并逐行解释关键行。
3. 报错类问题：先解释报错在说什么，再给排查步骤，最后给修法。
4. 用到教材段的内容时，句末标 source_id，例如「（hl04s02#s3）」；教材里没有的不要编 source_id。
5. 不评价学习者，不说客套话，不用感叹号。每次回答不超过 250 字（代码不计）。
只输出回答正文，不要 JSON。"""


class _Task(BaseModel):
    id: str = Field(min_length=1, max_length=12)
    title: str = Field(min_length=2, max_length=40)
    brief: str = Field(min_length=4)
    language: str = "python"
    skeleton: str = Field(min_length=4)
    criteria: list[str] = Field(min_length=2, max_length=6)
    expected_output: str = ""
    hints: list[str] = Field(min_length=3, max_length=3)
    bridge: str = ""


class _Tasks(BaseModel):
    tasks: list[_Task] = Field(min_length=2, max_length=5)


def _tasks_path(corpus: str, project_id: str, key: str, milestone: int):
    base = pg._guide_path(corpus, project_id, key)  # noqa: SLF001 同一套命名，放同目录
    return base.with_name(base.stem + f"-m{milestone}-tasks.json")


def _find_milestone(guide_doc: dict[str, Any], index: int) -> dict[str, Any]:
    for m in guide_doc["guide"]["milestones"]:
        if int(m.get("index") or 0) == index:
            return m
    raise CoachError(f"带练路线里没有第 {index} 段")


def _skeleton_rule(tier: str) -> str:
    return {
        "L1": "零基础档：骨架几乎写全，每个任务只留 1~3 行 TODO，TODO 旁一句提示写清要做什么；不出现学习者没见过的语法。",
        "L2": "有基础档：给函数签名、docstring 和调用示例，函数体留 TODO；可以要求查文档。",
        "L3": "熟练档：只给模块接口与输入输出约定，实现全部留给学习者；多给一个可选的扩展要求。",
    }[tier]


def build_code_tasks(corpus: str, project_id: str, profile: dict[str, Any], milestone: int, refresh: bool = False) -> dict[str, Any]:
    """一个里程碑的代码任务。先要有带练路线（同档缓存里读），再按段拆。"""
    guide_doc = pg.build_guide(corpus, project_id, profile)
    key = guide_doc["profile_key"]
    path = _tasks_path(corpus, project_id, key, milestone)
    if not refresh and path.exists():
        cached = json.loads(path.read_text(encoding="utf-8"))
        if cached.get("schema_version") == TASKS_SCHEMA_VERSION:
            cached["cached"] = True
            return cached

    ms = _find_milestone(guide_doc, milestone)
    project = pg._find_project(corpus, project_id)  # noqa: SLF001
    gateway = LLMGateway()
    if not gateway.is_enabled(TASK_AGENT):
        raise CoachError("起草模型路由未启用（缺 key），不能拆代码任务")
    tier = guide_doc["decisions"]["tier"]
    readme = pg._fetch_readme(pg._repo_full_name(project))  # noqa: SLF001
    card = {k: project.get(k) for k in ("name", "prereq", "steps", "acceptance", "deliverable")}
    user = (
        f"项目推荐卡：\n{json.dumps(card, ensure_ascii=False)}\n\nREADME 摘录：\n{readme or '（无）'}\n\n"
        f"当前里程碑（第 {milestone} 段）：\n{json.dumps({k: ms.get(k) for k in ('title', 'goal', 'build', 'how', 'acceptance', 'engineering_habit')}, ensure_ascii=False)}\n\n"
        f"姿态档 {tier}。拆法要求：{_skeleton_rule(tier)}\n任务数：{3 if tier != 'L3' else 2}~4。"
    )
    parsed = gateway.structured_chat(TASK_AGENT, TASKS_SYSTEM, user, temperature=0.3, max_tokens=5000)
    if not parsed:
        raise CoachError("模型未返回可解析的任务清单，本次不编造")
    try:
        tasks = _Tasks.model_validate(parsed)
    except ValidationError as exc:
        reasons = "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()[:4])
        raise CoachError(f"任务清单不合法：{reasons}") from exc
    doc = {
        "schema_version": TASKS_SCHEMA_VERSION,
        "corpus": corpus,
        "project_id": project_id,
        "profile_key": key,
        "milestone": milestone,
        "tier": tier,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tasks": [t.model_dump() for t in tasks.tasks],
        "cached": False,
    }
    # 任务 id 规整成 t1..tn，防模型乱编
    for i, t in enumerate(doc["tasks"], start=1):
        t["id"] = f"t{i}"
    practice_scout._write_json(path, doc)  # noqa: SLF001
    return doc


_VERDICTS = ("correct", "partial", "incorrect")


def grade_code(task: dict[str, Any], code: str, hints_used: int = 0) -> dict[str, Any]:
    gateway = LLMGateway()
    if not gateway.is_enabled(COACH_AGENT):
        raise CoachError("判分模型路由未启用（缺 key）")
    code = (code or "").strip()
    if len(code) < 8:
        raise CoachError("代码太短，先把骨架里的 TODO 填上再交")
    user = (
        f"任务：{task.get('title')}\n说明：{task.get('brief')}\n判分要点：\n"
        + "\n".join(f"- {c}" for c in task.get("criteria") or [])
        + f"\n\n参考实现（第三级提示，用于识别原样抄回）：\n{(task.get('hints') or ['', '', ''])[2]}\n\n"
        f"学习者提交的代码：\n{code[:6000]}"
    )
    parsed = gateway.structured_chat(COACH_AGENT, GRADE_SYSTEM, user, temperature=0.1, max_tokens=900)
    verdict = str((parsed or {}).get("verdict") or "").strip().lower()
    if verdict not in _VERDICTS:
        raise CoachError("判分模型未返回合法裁决，本轮如实中止，不猜对错")
    capped = False
    # 看过参考实现（第 3 级提示）再交，最高记 partial：和课堂导学的提示压档口径一致
    if hints_used >= 3 and verdict == "correct":
        verdict, capped = "partial", True
    because = [str(b).strip() for b in (parsed.get("because") or []) if str(b).strip()]
    if capped:
        because.append("用过第三级提示（参考实现），本题最高记「部分正确」")
    return {
        "verdict": verdict,
        "because": because,
        "problems": [str(p).strip() for p in (parsed.get("problems") or []) if str(p).strip()],
        "next": str(parsed.get("next") or "").strip(),
        "hints_used": max(0, int(hints_used)),
    }


def coach_chat(
    corpus: str,
    project_id: str,
    profile: dict[str, Any],
    milestone: int,
    task_id: str,
    history: list[dict[str, str]],
    message: str,
) -> dict[str, Any]:
    message = (message or "").strip()
    if not message:
        raise CoachError("问题为空")
    gateway = LLMGateway()
    if not gateway.is_enabled(COACH_AGENT):
        raise CoachError("教练模型路由未启用（缺 key）")
    guide_doc = pg.build_guide(corpus, project_id, profile)
    ms = _find_milestone(guide_doc, milestone)
    tasks_doc = None
    try:
        tasks_doc = build_code_tasks(corpus, project_id, profile, milestone)
    except CoachError:
        tasks_doc = None
    task = next((t for t in (tasks_doc or {}).get("tasks", []) if t["id"] == task_id), None) if task_id else None
    project = pg._find_project(corpus, project_id)  # noqa: SLF001
    tier = guide_doc["decisions"]["tier"]
    evidence = pg._evidence(corpus, {"name": f"{project.get('name')} {ms.get('title')} {message}", "steps": []}, tier)  # noqa: SLF001
    context = (
        f"项目：{project.get('name')}；验收：{project.get('acceptance')}\n"
        f"里程碑第 {milestone} 段：{json.dumps({k: ms.get(k) for k in ('title', 'goal', 'build', 'how', 'acceptance')}, ensure_ascii=False)}\n"
        + (f"当前任务：{json.dumps({k: task.get(k) for k in ('title', 'brief', 'skeleton', 'criteria')}, ensure_ascii=False)}\n" if task else "当前没有选中任务。\n")
        + f"学习者姿态档：{tier}\n"
        + "知识库相关段：\n"
        + ("\n".join(f"- {e['source_id']}｜{e['title']}｜{e['excerpt']}" for e in evidence) or "（无）")
    )
    messages = [{"role": "system", "content": COACH_SYSTEM + "\n\n" + context}]
    for h in history[-12:]:
        role = "assistant" if h.get("role") == "assistant" else "user"
        text = str(h.get("content") or "").strip()
        if text:
            messages.append({"role": role, "content": text[:2000]})
    messages.append({"role": "user", "content": message[:2000]})
    try:
        raw = gateway.chat(COACH_AGENT, messages, temperature=0.3, max_tokens=900)
    except Exception as exc:  # noqa: BLE001 网关异常对外说人话，不吞
        raise CoachError(f"教练模型调用失败：{type(exc).__name__}") from exc
    reply = ""
    try:
        reply = str(raw["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError):
        reply = ""
    if not reply:
        raise CoachError("教练没有给出回答，本轮如实中止")
    known = {e["source_id"] for e in evidence}
    cited = [sid for sid in dict.fromkeys(re.findall(r"[a-z]{2}\d{2,3}(?:s\d{2})?#s\d+|[a-z]{2}\d{2,3}s\d{2}", reply)) if sid in known]
    return {"reply": reply, "cited": cited, "evidence_ids": sorted(known)}
