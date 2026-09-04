"""项目带练：把一张已发布的实操推荐卡，按学习者画像拆成一串可检查的里程碑。

为什么要有这一层（2026-09-04 定案）：
- 推荐卡只回答「做什么项目、做到什么算完成」，是一份说明书。学习者真正卡住的地方是
  「第一步先写哪个函数」「做到哪算这一段完了」「工程上该养成什么习惯」。这一层把卡
  拆成 3~6 个里程碑，每个里程碑写清要搭的模块、怎么做、怎么验收、这一段要练的一个
  工程习惯、常见坑、以及一道检查题——检查题交给讲义驱动导学（tutor_service）去问和判，
  这一层不自己造第二套对话。
- 个性化在输入端：里程碑的粒度、工程习惯的档位、里程碑数量都由画像决定（姿态档、
  工程自评、时间预算），并且写在 fit 字段里让学习者看到依据。
- 事实来源仍然是卡片（GitHub 实拉的）与 README，讲解性的「读什么」只能引用受控
  知识库检索出来的块（带 source_id）；引不到的 source_id 一律丢弃，不留假出处。
- 同一张卡、同一档画像只生成一次，落盘缓存（data/practice_drafts/guides/）；评委
  三分钟里等不起 30 秒生成，第二次打开必须秒开。
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from backend.integration.personalize_service import evidence_retrieve_api
from backend.services import practice_scout
from backend.services.llm_gateway import LLMGateway

GUIDE_DIR = practice_scout.DRAFT_DIR / "guides"
GUIDE_SCHEMA_VERSION = 1
AGENT = practice_scout.AGENT  # 同一支起草模型：卡是它写的，拆里程碑也归它
README_CHARS = 3000
EVIDENCE_TOP_K = 6


class GuideError(RuntimeError):
    """生成失败要对调用方可见：模型未启用、卡不存在、输出不合法都不许静默成空。"""


# 工程习惯阶梯：按学习者的工程自评（0-4）给这一轮该练的习惯。写死在这里而不是交给
# 模型现编，是因为它是教学决策不是内容——同一档学习者拿到的要求要一致、可复算。
HABIT_LADDER: dict[int, list[dict[str, str]]] = {
    0: [
        {"title": "先在本地把示例跑通", "how": "照 README 装好环境，跑一次自带示例，把报错和解决办法记在一个 notes.md 里。"},
        {"title": "第一次 git 提交", "how": "git init、写 .gitignore、把跑通的状态提交一次，提交信息写清「做了什么」。"},
        {"title": "每改一处就跑一次", "how": "改完一个函数立刻运行，不攒着改；出错先看最后三行报错。"},
    ],
    1: [
        {"title": "每个里程碑一次提交", "how": "里程碑做完就提交，提交信息写「实现了 X，验证方法是 Y」。"},
        {"title": "README 记录用法", "how": "把怎么安装、怎么运行、参数是什么写进 README，写给一周后的自己。"},
        {"title": "给关键函数写一个测试", "how": "挑一个最容易错的函数，写一个最小的断言测试，以后每次改都跑它。"},
    ],
    2: [
        {"title": "先拆任务再动手", "how": "把这个里程碑拆成 3-5 条 issue 或待办，每条写清完成标准，做完打勾。"},
        {"title": "测试跟着功能走", "how": "新功能配一个测试；修 bug 先写能复现的测试，再改代码。"},
        {"title": "分支开发", "how": "每个里程碑开一个分支，做完合回主分支，合并前自己过一遍 diff。"},
    ],
    3: [
        {"title": "PR 描述与自审清单", "how": "合并前写 PR 描述：改了什么、怎么验证、有什么风险；对照清单自审一遍。"},
        {"title": "接口先定再实现", "how": "先写函数签名和输入输出的约定（docstring 或类型），再填实现。"},
        {"title": "把估时写下来并对账", "how": "每个里程碑先估时再做，做完记录实际用时，看偏差在哪。"},
    ],
    4: [
        {"title": "CI 跑测试", "how": "配一条最简单的 CI（GitHub Actions 跑 pytest 或 npm test），红了就不合并。"},
        {"title": "版本与回滚", "how": "打 tag 记版本，写清每版改了什么；准备一条回滚到上一版的命令。"},
        {"title": "可观测性", "how": "关键路径加日志或指标，出问题能靠日志定位而不是加 print。"},
    ],
}

_TIER_NOTE = {
    "L1": "零基础姿态：每个里程碑的 how 要写到「先建哪个文件、先写哪个函数」的粒度；术语第一次出现给一句解释；代码片段不超过 8 行。",
    "L2": "有基础姿态：how 写到函数和模块级别，不逐行手把手；可以要求学习者自己查 API 文档。",
    "L3": "熟练姿态：how 只给设计要点与接口约定，把实现细节留给学习者；多给一个可选的扩展方向。",
}

GUIDE_SYSTEM = """你是技能培训的实训导师，负责把一个开源实操项目拆成学习者可以逐段完成、逐段验收的里程碑。
输入给你：项目推荐卡（事实字段来自 GitHub，不可改写）、README 摘录、知识库里与该项目相关的证据块（带 source_id）、学习者画像与本次的教学决策。
要求：
1. 里程碑数量按给定的 milestone_count；顺序是做的顺序，前一个做完后一个才做得起来。第一个里程碑一定是「把环境和示例跑通」。
2. 每个里程碑：title（不超过 18 字）、goal（一句话，做完能看见什么）、build（2-4 条，要搭的模块/函数/文件，写具体名字）、how（3-6 条，按顺序的具体做法，按姿态档控制粒度）、acceptance（可检查的完成标准，能用「运行什么、看到什么」表述）、pitfalls（1-3 条常见坑与怎么查）、reading（0-3 条，只能从给定证据块里选 source_id，并写一句为什么这一块对这一步有用）、check_question（一道开放题，问学习者这一段做了什么、为什么这么做，能暴露没做或没懂）、expected_points（2-4 条判分要点）、minutes（预计分钟数，整数）。
3. 工程习惯已由系统按档位给出（engineering_habit 字段照抄给定的那一条，不要改写、不要另编）。
4. overview：一句话说这个项目做完学习者手里有什么。fit：两到三句，说明按这份画像为什么这样拆（引用给定的姿态档、工程档、时间预算）。management：cadence（建议的做题节奏）与 tracking（怎么记录进度与问题），各一句。
5. 不得引入卡片与 README 之外的项目事实（如具体章节数、数据集名）；不确定就不写。
6. 只输出一个 JSON 对象，不要任何多余文字。字段名：overview, fit, milestones[], management{cadence, tracking}。"""


class _Reading(BaseModel):
    source_id: str
    why: str = ""


class _Habit(BaseModel):
    title: str
    how: str


class _Milestone(BaseModel):
    # index 与 engineering_habit 都由系统事后覆盖：模型漏写或写成字符串都不算错
    index: int | None = None
    title: str = Field(min_length=2, max_length=40)
    goal: str = Field(min_length=4)
    build: list[str] = Field(min_length=1, max_length=6)
    how: list[str] = Field(min_length=2, max_length=12)  # 超 8 条在 _validate 里截，不整份作废
    acceptance: str = Field(min_length=4)
    engineering_habit: Any = None
    pitfalls: list[str] = Field(default_factory=list, max_length=4)
    # 模型常把 reading 写成裸的 source_id 字符串；在 _validate 里统一成 {source_id, why}
    reading: list[Any] = Field(default_factory=list, max_length=6)
    check_question: str = Field(min_length=6)
    expected_points: list[str] = Field(min_length=1, max_length=5)
    minutes: int = Field(ge=10, le=600)


class _Management(BaseModel):
    cadence: str
    tracking: str


class _Guide(BaseModel):
    overview: str = Field(min_length=4)
    fit: str = Field(min_length=4)
    milestones: list[_Milestone] = Field(min_length=3, max_length=8)
    management: _Management


def _tier_of(profile: dict[str, Any]) -> str:
    """姿态档。与课堂端 presentationTier 同一套阈值（lib/generation/learner-profile.ts）。"""
    explicit = str(profile.get("tier") or "").strip().upper()
    if explicit in ("L1", "L2", "L3"):
        return explicit
    prog = profile.get("programming_level")
    if not isinstance(prog, (int, float)):
        return "L2"
    if prog <= 1:
        return "L1"
    agent = float(profile.get("agent_level") or 0)
    eng = float(profile.get("engineering_level") or 0)
    if agent >= 3 or (prog >= 4 and eng >= 3):
        return "L3"
    return "L2"


def _eng_level(profile: dict[str, Any]) -> int:
    raw = profile.get("engineering_level")
    try:
        return max(0, min(4, int(raw)))
    except (TypeError, ValueError):
        return 1


def _milestone_count(profile: dict[str, Any], difficulty: int) -> int:
    budget = profile.get("time_budget_hours")
    try:
        hours = float(budget)
    except (TypeError, ValueError):
        hours = 0.0
    if hours and hours <= 5:
        return 3
    if hours and hours <= 12:
        return 4
    return 5 if difficulty <= 3 else 6


def profile_key(profile: dict[str, Any], difficulty: int) -> str:
    """缓存键只看影响拆法的三个量：姿态档、工程档、里程碑数。别的画像字段不进键——
    换个昵称不该重新生成一份。"""
    return f"{_tier_of(profile)}-e{_eng_level(profile)}-m{_milestone_count(profile, difficulty)}"


def _guide_path(corpus: str, project_id: str, key: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", project_id)[:80]
    digest = hashlib.sha1(project_id.encode("utf-8")).hexdigest()[:8]
    return GUIDE_DIR / corpus / f"{safe}-{digest}-{key}.json"


def _repo_full_name(project: dict[str, Any]) -> str | None:
    for link in project.get("links") or []:
        url = str(link.get("url") or "")
        m = re.match(r"https?://github\.com/([^/\s]+)/([^/\s#?]+)", url)
        if m:
            return f"{m.group(1)}/{m.group(2).removesuffix('.git')}"
    return None


def _fetch_readme(full_name: str | None) -> str:
    if not full_name:
        return ""
    session = practice_scout._session()  # noqa: SLF001 同一套限流与重试
    try:
        resp = practice_scout._get(  # noqa: SLF001
            session,
            f"{practice_scout.GITHUB_API}/repos/{full_name}/readme",
            headers={"Accept": "application/vnd.github.raw+json"},
        )
        return re.sub(r"\s+", " ", resp.text)[:README_CHARS]
    except Exception as exc:  # noqa: BLE001 README 拉不到不致命：卡上的事实字段还在
        return f"（README 拉取失败：{type(exc).__name__}；以下只凭推荐卡拆解）"


def _evidence(corpus: str, project: dict[str, Any], tier: str) -> list[dict[str, str]]:
    query = " ".join([str(project.get("name") or ""), *[str(s) for s in (project.get("steps") or [])[:2]]])
    cap = {"L1": "L2", "L2": "L3", "L3": ""}[tier]
    try:
        result = evidence_retrieve_api(query, EVIDENCE_TOP_K, corpus, "", cap, 0)
    except Exception:  # noqa: BLE001 检索挂了就没有「读什么」，不影响拆里程碑
        return []
    out: list[dict[str, str]] = []
    for chunk in result.get("chunks") or []:
        sid = str(chunk.get("source_id") or "").strip()
        if not sid:
            continue
        out.append(
            {
                "source_id": sid,
                "title": str(chunk.get("title") or "").strip(),
                "excerpt": re.sub(r"\s+", " ", str(chunk.get("text") or chunk.get("content") or ""))[:320],
            }
        )
    return out


def _find_project(corpus: str, project_id: str) -> dict[str, Any]:
    for project in practice_scout.published_projects(corpus):
        if project.get("id") == project_id:
            return project
    raise GuideError(f"实操项目未发布或不存在：{project_id}")


def _habits(eng: int, count: int) -> list[dict[str, str]]:
    ladder = HABIT_LADDER[eng]
    # 按里程碑顺序发：第一段永远是阶梯的第一条（最基础的那条），里程碑比习惯多时
    # 后面的段沿用最后一条（练巩固），不回绕到第一条——第 4 段再让人「跑通示例」是倒退。
    return [ladder[min(i, len(ladder) - 1)] for i in range(count)]


def _build_user_message(
    project: dict[str, Any],
    readme: str,
    evidence: list[dict[str, str]],
    profile: dict[str, Any],
    tier: str,
    eng: int,
    count: int,
    habits: list[dict[str, str]],
) -> str:
    card = {
        k: project.get(k)
        for k in ("name", "org", "level", "difficulty", "hours", "prereq", "steps", "why", "acceptance", "deliverable", "cost", "networkNote")
    }
    ev_lines = [f"- {e['source_id']}｜{e['title']}｜{e['excerpt']}" for e in evidence] or ["（无：知识库里没有检索到与此项目直接相关的块，reading 一律留空）"]
    habit_lines = [f"里程碑 {i + 1}：{h['title']}——{h['how']}" for i, h in enumerate(habits)]
    budget = profile.get("time_budget_hours")
    return (
        f"项目推荐卡（事实，不可改写）：\n{json.dumps(card, ensure_ascii=False)}\n\n"
        f"README 摘录：\n{readme or '（无）'}\n\n"
        f"知识库证据块（reading 只能从这里选 source_id）：\n" + "\n".join(ev_lines) + "\n\n"
        f"学习者画像：姿态档 {tier}；工程自评 {eng}/4；时间预算 {budget if budget else '未填'} 小时；身份 {profile.get('role') or '未填'}。\n"
        f"教学决策：milestone_count={count}。{_TIER_NOTE[tier]}\n"
        f"每个里程碑的 engineering_habit 照抄下面这一条（title 与 how 原样）：\n" + "\n".join(habit_lines)
    )


def _validate(parsed: dict[str, Any] | None, evidence: list[dict[str, str]], habits: list[dict[str, str]], count: int) -> dict[str, Any]:
    if not parsed:
        raise GuideError("模型未返回可解析的里程碑，本次不编造")
    try:
        guide = _Guide.model_validate(parsed)
    except ValidationError as exc:
        reasons = "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()[:4])
        raise GuideError(f"里程碑输出不合法：{reasons}") from exc
    known = {e["source_id"] for e in evidence}
    doc = guide.model_dump()
    for i, m in enumerate(doc["milestones"]):
        m["index"] = i + 1
        # 出处硬约束：不在证据集里的 source_id 直接丢，不留假引用；裸字符串按 source_id 收
        readings: list[dict[str, str]] = []
        for r in m["reading"]:
            if isinstance(r, str):
                r = {"source_id": r.strip(), "why": ""}
            if not isinstance(r, dict):
                continue
            sid = str(r.get("source_id") or "").strip()
            if sid in known:
                readings.append({"source_id": sid, "why": str(r.get("why") or "").strip()})
        m["reading"] = readings[:3]
        m["how"] = m["how"][:8]
        # 工程习惯是教学决策，模型改写了也按系统给的算
        m["engineering_habit"] = dict(habits[min(i, len(habits) - 1)])
    if len(doc["milestones"]) < min(3, count):
        raise GuideError("里程碑少于 3 个，不够成一条带练路线")
    return doc


def build_guide(corpus: str, project_id: str, profile: dict[str, Any], refresh: bool = False) -> dict[str, Any]:
    """主入口：读缓存 → 没有就生成 → 落盘。返回给课堂端的完整载荷。"""
    project = _find_project(corpus, project_id)
    difficulty = int(project.get("difficulty") or 3)
    key = profile_key(profile, difficulty)
    path = _guide_path(corpus, project_id, key)
    if not refresh and path.exists():
        cached = json.loads(path.read_text(encoding="utf-8"))
        if cached.get("schema_version") == GUIDE_SCHEMA_VERSION:
            cached["cached"] = True
            return cached

    gateway = LLMGateway()
    if not gateway.is_enabled(AGENT):
        raise GuideError("起草模型路由未启用（缺 key），不能生成带练路线")
    tier = _tier_of(profile)
    eng = _eng_level(profile)
    count = _milestone_count(profile, difficulty)
    habits = _habits(eng, count)
    readme = _fetch_readme(_repo_full_name(project))
    evidence = _evidence(corpus, project, tier)
    user = _build_user_message(project, readme, evidence, profile, tier, eng, count, habits)
    parsed = gateway.structured_chat(AGENT, GUIDE_SYSTEM, user, temperature=0.3, max_tokens=4500)
    guide = _validate(parsed, evidence, habits, count)

    doc = {
        "schema_version": GUIDE_SCHEMA_VERSION,
        "corpus": corpus,
        "project_id": project_id,
        "project_name": project.get("name"),
        "profile_key": key,
        "decisions": {
            "tier": tier,
            "engineering_level": eng,
            "milestone_count": count,
            "readme_used": not readme.startswith("（README 拉取失败"),
            "evidence_ids": [e["source_id"] for e in evidence],
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "guide": guide,
        "cached": False,
    }
    practice_scout._write_json(path, doc)  # noqa: SLF001 同一套原子写
    return doc
