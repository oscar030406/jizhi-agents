"""域级实操项目侦察：GitHub 公开 API 搜真实仓库 → 模型分级起草 → 管理员确认。

为什么是这个形态（2026-08-28 定案）：
- 「推荐外部真实项目」需要互联网上的真实数据。让模型凭先验报项目名会编出
  不存在/已停更的仓库，比空着危险；所以**事实来自 GitHub REST API**（星数、
  更新时间、README、许可证全部实拉），模型只做它擅长的事——筛选、分级、写
  推荐语，且只能从候选清单里选仓库，编不出清单外的条目。
- 大陆服务器到 api.github.com 实测可达（2026-08-28：搜索 2.6s / README 1.9s），
  但连通性有历史抖动记录（clone 曾卡死），所以：短超时 + 重试 + 失败显式报错
  给管理端，绝不静默降级成编造。
- 初稿永不自动上线：落 data/practice_drafts/<corpus>.json，approved=false，
  管理员逐条勾选发布后学习端才展示。与岗位图谱「模型起草、管理员确认」同一理念。
- 岗位数据合规红线不受影响：搜的是开源代码仓库，不是招聘数据。
"""

from __future__ import annotations

import hashlib
import json
import re
import tempfile
import time
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

import requests
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from backend.integration.personalize_service import skill_map_api
from backend.services.llm_gateway import LLMGateway

ROOT = Path(__file__).resolve().parents[2]
DRAFT_DIR = ROOT / "data" / "practice_drafts"
DRAFT_SCHEMA_VERSION = 3
RELEASE_SCHEMA_VERSION = 1

AGENT = "ResourceGenerationAgent"  # strong 档，职责表里本来就写着「生成实操任务」
GITHUB_API = "https://api.github.com"
LEVELS = ("starter", "advanced", "portfolio")

import os as _os

# 候选门槛可按域调（PRACTICE_SCOUT_* 环境变量）。星数下限默认放得很低：
# 细分工业领域的教学仓库星数生态与 AI 圈差一个数量级（PLC 教程 20★ 已是头部），
# 绝对高门槛会把整个领域筛成空集（08-28 实测：30★ 门槛下智能制造域零候选）。
# 质量分层交给下游——模型见得到星数，管理员终审最后把关。
MIN_STARS = int(_os.environ.get("PRACTICE_SCOUT_MIN_STARS", "10"))
MAX_AGE_YEARS = int(_os.environ.get("PRACTICE_SCOUT_MAX_AGE_YEARS", "3"))
SEARCH_PER_KEYWORD = int(_os.environ.get("PRACTICE_SCOUT_PER_KEYWORD", "8"))
MAX_CANDIDATES = int(_os.environ.get("PRACTICE_SCOUT_MAX_CANDIDATES", "14"))
README_CHARS = 1200

KEYWORD_SYSTEM = """你是技能培训的实训设计师。根据领域描述与语料主题，给出用于在 GitHub 上搜索\
「适合学习者上手练习的开源项目/教程」的英文搜索词。
要求：4-6 个搜索词；每个 2-4 个单词；面向教学与实践（tutorial / example / demo / starter 这类词优先）；\
只输出 JSON：{"keywords": ["...", "..."]}"""

DRAFT_SYSTEM = """你是企业技能培训的实训设计师。下面给出一批从 GitHub 实时搜索得到的真实仓库\
（含星数、简介、README 摘录）。请从中挑选适合该领域学习者的实操项目并分级起草推荐卡。

硬性要求：
1. 只能从候选清单中选仓库（repo 字段填候选的 full_name，一字不差）；清单外的仓库一概不许出现。
2. 推荐语必须依据该仓库的简介与 README 摘录，不得引入摘录之外的具体断言（如具体章节数、具体数据集）。
3. 分级：starter（第一个上手项目，难度1-2星）、advanced（进阶，3-4星）、portfolio（作品级，4-5星）。\
整组覆盖至少 starter 与 advanced 两档；总数不超过要求数。
4. 不合适的候选（纯框架源码、无教学价值、与领域无关）直接不选，宁缺毋滥。
5. 每张卡必须给出 steps：3-6 条具体、可执行、按顺序排列的操作步骤，不能只写目标或口号。
6. courseIds / jobIds 只能选用户消息给出的允许 ID。只要存在课程候选，每张卡至少关联一门课程；只要存在岗位候选，
每张卡至少关联一个岗位。某类候选为空时，对应字段必须是空数组。
7. 只输出 JSON：
{"projects": [{
  "repo": "owner/name",
  "name": "推荐卡标题（中文，一眼看出做什么）",
  "level": "starter|advanced|portfolio",
  "difficulty": 1-5 整数,
  "hours": "预估工时，如 10-20 小时",
  "prereq": "前置要求一句话",
  "steps": ["具体步骤 1", "具体步骤 2", "具体步骤 3"],
  "courseIds": ["允许的课程 ID"],
  "jobIds": ["允许的岗位 ID"],
  "cost": "成本口径（如：本地即可运行 / 需要一块 PLC 仿真环境）",
  "networkNote": "网络门槛（能访问 GitHub 即可 / ⚠需要...）",
  "why": "为什么值得做：练的是什么真实工作能力，2-3 句",
  "acceptance": "验收标准：做到什么程度算完成（可检查）",
  "deliverable": "做完手里有什么",
  "resumeAdvice": "简历用法：怎么写才不虚"
}]}"""


class ScoutError(RuntimeError):
    """对管理端可见的失败（网络不通 / 模型未启用 / 无候选），不静默。"""


class _DraftCard(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    repo: str = Field(min_length=1)
    name: str = Field(min_length=1)
    level: Literal["starter", "advanced", "portfolio"]
    difficulty: int = Field(ge=1, le=5)
    hours: str
    prereq: str
    steps: list[str] = Field(min_length=3, max_length=6)
    courseIds: list[str]
    jobIds: list[str]
    cost: str
    networkNote: str
    why: str
    acceptance: str
    deliverable: str
    resumeAdvice: str


def _validation_reasons(exc: ValidationError) -> list[str]:
    return [
        f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
        for error in exc.errors()
    ]


def _normalize_candidates(items: list[dict[str, Any]], id_key: str, label: str) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise ScoutError(f"{label}候选格式错误")
        candidate_id = str(item.get(id_key) or "").strip()
        title = str(item.get("title") or "").strip()
        if not candidate_id or not title or candidate_id in seen:
            raise ScoutError(f"{label}候选必须有唯一的非空 id 与 title")
        seen.add(candidate_id)
        normalized.append({"id": candidate_id, "title": title})
    return normalized


def _publish_errors(project: dict[str, Any]) -> list[str]:
    steps = project.get("steps")
    clean_steps = (
        [step.strip() for step in steps if isinstance(step, str) and step.strip()]
        if isinstance(steps, list)
        else []
    )
    project["steps"] = clean_steps
    errors = []
    if not all(str(project.get(key) or "").strip() for key in ("id", "name", "why", "acceptance", "deliverable")):
        errors.append("关键字段为空")
    if not 3 <= len(clean_steps) <= 6:
        errors.append("可执行步骤必须为 3–6 条")
    return errors


def _project_errors(
    project: dict[str, Any], course_ids: set[str], job_ids: set[str]
) -> list[str]:
    errors = _publish_errors(project)
    for field, allowed, label in (
        ("courseIds", course_ids, "课程"),
        ("jobIds", job_ids, "岗位"),
    ):
        values = project.get(field)
        if not isinstance(values, list) or any(
            not isinstance(value, str) or not value.strip() for value in values
        ):
            errors.append(f"{field} 必须是非空字符串 ID 组成的数组")
            continue
        clean = [value.strip() for value in values]
        project[field] = clean
        unknown = sorted(set(clean) - allowed)
        if unknown:
            errors.append(f"包含未知或越域{label} ID：{', '.join(unknown)}")
        elif allowed and not clean:
            errors.append(f"存在{label}候选时至少关联一个 {label} ID")
    return errors


def _stored_candidate_ids(doc: dict[str, Any]) -> tuple[set[str], set[str]]:
    if not isinstance(doc.get("course_candidates"), list) or not isinstance(
        doc.get("job_candidates"), list
    ):
        raise ScoutError("旧实操草稿缺少课程/岗位候选边界，请重新生成并审核")
    courses = _normalize_candidates(doc["course_candidates"], "id", "课程")
    jobs = _normalize_candidates(doc["job_candidates"], "id", "岗位")
    return {item["id"] for item in courses}, {item["id"] for item in jobs}


def _current_job_candidates(corpus: str) -> list[dict[str, str]]:
    skill_map = skill_map_api(corpus)
    jobs = skill_map.get("jobs", [])
    if not isinstance(jobs, list):
        raise ScoutError("岗位技能地图返回格式错误")
    return _normalize_candidates(jobs, "job_id", "岗位")


def _validate_candidate_snapshot(
    doc: dict[str, Any],
    current_courses: list[dict[str, str]],
    current_jobs: list[dict[str, str]],
) -> tuple[set[str], set[str]]:
    stored_courses, stored_jobs = _stored_candidate_ids(doc)
    current_course_ids = {item["id"] for item in current_courses}
    current_job_ids = {item["id"] for item in current_jobs}
    stale_courses = sorted(stored_courses - current_course_ids)
    stale_jobs = sorted(stored_jobs - current_job_ids)
    if stale_courses:
        raise ScoutError(f"草稿记录的课程候选已失效：{', '.join(stale_courses)}")
    if stale_jobs:
        raise ScoutError(f"草稿记录的岗位候选已失效：{', '.join(stale_jobs)}")
    return current_course_ids, current_job_ids


def _session() -> requests.Session:
    # trust_env 保持默认 True：本机开发走系统代理可达 GitHub，服务器无代理直连可达。
    # （与 LLM 网关相反——国内模型 API 必须剥代理，那边自己管自己的。）
    s = requests.Session()
    s.headers["Accept"] = "application/vnd.github+json"
    s.headers["User-Agent"] = "jizhi-practice-scout"
    import os
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        s.headers["Authorization"] = f"Bearer {token}"
    return s


def _get(session: requests.Session, url: str, **kw) -> requests.Response:
    last: Exception | None = None
    limit_waited = False
    for attempt in range(3):
        try:
            resp = session.get(url, timeout=(5, 12), **kw)
            if resp.status_code in (403, 429) and "rate limit" in resp.text.lower():
                # 未认证配额按 IP 计，走共享代理出口时随时可能是打光状态。
                # 官方 reset 头在 60s 内就等它一次；等不起才报给管理端。
                reset = resp.headers.get("x-ratelimit-reset")
                wait = int(reset) - int(time.time()) + 2 if reset and reset.isdigit() else 65
                if not limit_waited and 0 < wait <= 90:
                    limit_waited = True
                    time.sleep(wait)
                    continue
                raise ScoutError("GitHub API 触发限流，稍后再试（或配置 GITHUB_TOKEN 提高配额）")
            resp.raise_for_status()
            return resp
        except ScoutError:
            raise
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise ScoutError(f"GitHub API 不可达（重试 3 次）：{last}")


def _fmt_stars(n: int) -> str:
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def suggest_keywords(gateway: LLMGateway, corpus: str, scope: str, topics: list[str]) -> list[str]:
    user = (
        f"领域库：{corpus}\n领域范围描述：{scope or '（未填写）'}\n"
        f"语料主题样本：{', '.join(topics[:20])}\n请给出 GitHub 搜索词。"
    )
    parsed = gateway.structured_chat(AGENT, KEYWORD_SYSTEM, user, temperature=0.3, max_tokens=400)
    words = [str(w).strip() for w in (parsed or {}).get("keywords", []) if str(w).strip()]
    if not words:
        raise ScoutError("模型未产出搜索关键词（检查模型路由与密钥）")
    return words[:6]


def search_candidates(session: requests.Session, keywords: list[str]) -> list[dict[str, Any]]:
    # GitHub 搜索是全词 AND：小众技术词（IoTDB）配上任何修饰词（tutorial example）
    # 直接清零（08-28 实测五个词组全部 total=0）。所以逐级降词扩召回：
    # 全词 → 前两词 → 单核心词，凑够 3 个候选就停，不白打配额。
    seen: dict[str, dict[str, Any]] = {}
    tried: set[str] = set()
    for width in (None, 2, 1):
        round_kws = []
        for kw in keywords:
            cut = kw if width is None else " ".join(kw.split()[:width])
            if cut and cut.lower() not in tried:
                tried.add(cut.lower())
                round_kws.append(cut)
        _search_into(session, round_kws, seen)
        if len(seen) >= 3:
            break
    ranked = sorted(seen.values(), key=lambda c: -c["stars"])[:MAX_CANDIDATES]
    if not ranked:
        raise ScoutError(
            f"按关键词搜不到符合门槛的仓库（星数≥{MIN_STARS}、{MAX_AGE_YEARS} 年内有维护、非归档）"
        )
    return ranked


def _search_into(session: requests.Session, keywords: list[str], seen: dict[str, dict[str, Any]]) -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(days=365 * MAX_AGE_YEARS)
    for kw in keywords:
        resp = _get(
            session,
            f"{GITHUB_API}/search/repositories",
            params={"q": kw, "sort": "stars", "order": "desc", "per_page": SEARCH_PER_KEYWORD},
        )
        for item in resp.json().get("items", []):
            full = item.get("full_name", "")
            if not full or full in seen or item.get("archived"):
                continue
            if int(item.get("stargazers_count") or 0) < MIN_STARS:
                continue
            pushed = item.get("pushed_at") or ""
            try:
                if datetime.fromisoformat(pushed.replace("Z", "+00:00")) < cutoff:
                    continue
            except ValueError:
                continue
            if not (item.get("description") or "").strip():
                continue
            seen[full] = {
                "full_name": full,
                "html_url": item.get("html_url"),
                "stars": int(item.get("stargazers_count") or 0),
                "description": (item.get("description") or "").strip(),
                "license": (item.get("license") or {}).get("spdx_id") or "无许可证信息",
                "pushed_at": pushed[:10],
                "matched_keyword": kw,
            }
        # 未认证搜索配额 10 次/分钟（按 IP）。6.5s 一拍 = 稳在 9 次/分内；
        # 配了 GITHUB_TOKEN（30 次/分）就快步走。
        time.sleep(2.2 if session.headers.get("Authorization") else 6.5)


def attach_readmes(session: requests.Session, candidates: list[dict[str, Any]]) -> None:
    for c in candidates:
        try:
            resp = _get(
                session,
                f"{GITHUB_API}/repos/{c['full_name']}/readme",
                headers={"Accept": "application/vnd.github.raw+json"},
            )
            text = re.sub(r"\s+", " ", resp.text)[:README_CHARS]
        except ScoutError as exc:
            text = f"（README 拉取失败：{exc}；仅凭简介判断）"
        except Exception as exc:  # noqa: BLE001 单个 README 拉不到不致命，标注即可
            text = f"（README 处理失败：{type(exc).__name__}: {exc}；仅凭简介判断）"
        c["readme_excerpt"] = text


def draft_cards(
    gateway: LLMGateway,
    corpus: str,
    scope: str,
    candidates: list[dict[str, Any]],
    course_candidates: list[dict[str, str]],
    job_candidates: list[dict[str, str]],
    count: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_name = {c["full_name"]: c for c in candidates}
    course_ids = {item["id"] for item in course_candidates}
    job_ids = {item["id"] for item in job_candidates}
    lines = [
        f"领域库：{corpus}；领域范围：{scope or '（未填写）'}；最多推荐 {count} 个。",
        "允许的课程 ID（只能从这里选；为空则 courseIds=[]）："
        + (json.dumps(course_candidates, ensure_ascii=False) if course_candidates else "[]"),
        "允许的岗位 ID（只能从这里选；为空则 jobIds=[]）："
        + (json.dumps(job_candidates, ensure_ascii=False) if job_candidates else "[]"),
        "",
        "候选仓库：",
    ]
    for c in candidates:
        lines.append(
            f"- {c['full_name']}（{c['stars']}★，{c['license']}，最近提交 {c['pushed_at']}）：{c['description']}\n"
            f"  README 摘录：{c.get('readme_excerpt', '')}"
        )
    parsed = gateway.structured_chat(AGENT, DRAFT_SYSTEM, "\n".join(lines), temperature=0.4, max_tokens=5000)
    if not parsed or not isinstance(parsed.get("projects"), list):
        raise ScoutError("模型未返回可解析的推荐卡 JSON")

    kept, dropped = [], []
    seen_repo: set[str] = set()
    seen_project_ids: set[str] = set()
    for raw in parsed["projects"]:
        try:
            p = _DraftCard.model_validate(raw).model_dump()
        except ValidationError as exc:
            dropped.append({
                "repo": raw.get("repo") if isinstance(raw, dict) else "",
                "name": raw.get("name") if isinstance(raw, dict) else "",
                "reasons": _validation_reasons(exc),
            })
            continue
        repo = p["repo"].strip()
        reasons = []
        if repo not in by_name:
            reasons.append(f"仓库不在候选清单内：{repo!r}")
        if repo in seen_repo:
            reasons.append("仓库重复推荐")
        candidate_project = {
            **p,
            "id": re.sub(r"[^a-z0-9-]", "-", repo.lower().replace("/", "-")),
        }
        if candidate_project["id"] in seen_project_ids:
            reasons.append(f"规范化项目 ID 冲突：{candidate_project['id']}")
        reasons.extend(_project_errors(candidate_project, course_ids, job_ids))
        if reasons:
            dropped.append({"repo": repo, "name": p.get("name"), "reasons": reasons})
            continue
        seen_repo.add(repo)
        seen_project_ids.add(candidate_project["id"])
        src = by_name[repo]
        owner = repo.split("/")[0]
        kept.append({
            # org / links / 星数由代码从 GitHub 实拉数据填——模型无权编这些事实字段
            "id": candidate_project["id"],
            "name": str(p["name"]).strip(),
            "org": f"{owner}（{_fmt_stars(src['stars'])}★）",
            "level": p["level"],
            "difficulty": p["difficulty"],
            "hours": p["hours"].strip(),
            "jobIds": candidate_project["jobIds"],
            "courseIds": candidate_project["courseIds"],
            "prereq": p["prereq"].strip(),
            "steps": candidate_project["steps"],
            "cost": p["cost"].strip(),
            "networkNote": p["networkNote"].strip(),
            "why": str(p["why"]).strip(),
            "acceptance": str(p["acceptance"]).strip(),
            "deliverable": str(p["deliverable"]).strip(),
            "resumeAdvice": p["resumeAdvice"].strip(),
            "links": [{"label": "仓库", "url": src["html_url"]}],
            "alternatives": [],
            "firsthand": False,
            "approved": False,
            "provenance": {
                "source": "github-api",
                "matched_keyword": src["matched_keyword"],
                "stars": src["stars"],
                "license": src["license"],
                "pushed_at": src["pushed_at"],
            },
        })
    if not kept:
        detail = "；".join(
            f"{item.get('repo') or '未知卡片'}: {', '.join(item['reasons'])}"
            for item in dropped[:6]
        )
        raise ScoutError(f"模型起草的推荐卡全部未过校验：{detail}")
    if len(kept) > count:
        raise ScoutError(f"模型返回 {len(kept)} 张有效推荐卡，超过要求数量 {count}")
    levels = {item["level"] for item in kept}
    missing_levels = [level for level in ("starter", "advanced") if level not in levels]
    if missing_levels:
        raise ScoutError(f"有效推荐卡缺少必需分级：{', '.join(missing_levels)}")
    return kept, dropped


def draft_path(corpus: str) -> Path:
    return DRAFT_DIR / f"{corpus}.json"


def release_path(corpus: str) -> Path:
    return DRAFT_DIR / "releases" / f"{corpus}.json"


def _corpus_operation_lock(corpus: str) -> FileLock:
    path = draft_path(corpus)
    path.parent.mkdir(parents=True, exist_ok=True)
    return FileLock(f"{path}.lock", timeout=15)


def _write_json(path: Path, doc: dict[str, Any]) -> None:
    """同目录临时文件换名；草稿与发布版本库共用这一套文件存储原语。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    pending: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            pending = Path(handle.name)
            handle.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            _os.fsync(handle.fileno())
        pending.replace(path)
    finally:
        if pending is not None:
            pending.unlink(missing_ok=True)


def _load_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ScoutError(f"存储文件格式错误：{path.name}")
    return data


def load_draft(corpus: str) -> dict[str, Any] | None:
    return _load_json(draft_path(corpus))


def _require_draft(corpus: str) -> dict[str, Any]:
    doc = load_draft(corpus)
    if not doc:
        raise ScoutError("该域还没有实操初稿")
    if doc.get("version") != DRAFT_SCHEMA_VERSION:
        raise ScoutError(
            f"实操草稿版本不是 {DRAFT_SCHEMA_VERSION}，请重新生成后再审核"
        )
    if doc.get("corpus") != corpus:
        raise ScoutError("实操草稿记录的领域与当前请求不一致")
    if not isinstance(doc.get("projects"), list):
        raise ScoutError("实操草稿 projects 格式错误")
    payload = _snapshot_payload(
        doc.get("course_candidates"),
        doc.get("job_candidates"),
        doc.get("projects"),
    )
    if not all(isinstance(payload[key], list) for key in payload):
        raise ScoutError("实操草稿缺少课程、岗位或项目列表")
    if doc.get("snapshot_id") != _snapshot_id(payload):
        raise ScoutError("实操草稿快照校验失败，请重新起草")
    return doc


def _load_release_store(corpus: str) -> dict[str, Any] | None:
    store = _load_json(release_path(corpus))
    if store is None:
        return None
    if store.get("schema_version") != RELEASE_SCHEMA_VERSION:
        raise ScoutError("实操发布版本库格式错误，请重新执行发布验收")
    if store.get("corpus") != corpus or not isinstance(store.get("versions"), list):
        raise ScoutError("实操发布版本库的领域或版本列表格式错误")
    versions = store["versions"]
    if not versions:
        raise ScoutError("实操发布版本库缺少版本")
    for expected, release in enumerate(versions, start=1):
        if not isinstance(release, dict) or release.get("version") != expected:
            raise ScoutError("实操发布版本必须从 1 严格递增且不可重复")
        _validate_release(release)
    if store.get("current_version") != versions[-1]["version"]:
        raise ScoutError("实操发布版本库的当前指针不是最新版本")
    return store


def _snapshot_payload(
    course_candidates: list[dict[str, Any]],
    job_candidates: list[dict[str, Any]],
    projects: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "course_candidates": deepcopy(course_candidates),
        "job_candidates": deepcopy(job_candidates),
        "projects": deepcopy(projects),
    }


def _snapshot_id(payload: dict[str, Any]) -> str:
    raw = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


def _validate_release(release: dict[str, Any]) -> dict[str, Any]:
    payload = _snapshot_payload(
        release.get("course_candidates"),
        release.get("job_candidates"),
        release.get("projects"),
    )
    if not all(isinstance(payload[key], list) for key in payload):
        raise ScoutError("实操发布快照缺少课程、岗位或项目列表")
    if release.get("snapshot_id") != _snapshot_id(payload):
        raise ScoutError("实操发布快照校验失败，拒绝读取被改写的版本")
    course_ids, job_ids = _stored_candidate_ids(payload)
    invalid = [
        (project.get("id", "未知项目"), _project_errors(project, course_ids, job_ids))
        for project in deepcopy(payload["projects"])
    ]
    invalid = [(project_id, errors) for project_id, errors in invalid if errors]
    if invalid:
        detail = "；".join(
            f"{project_id}: {', '.join(errors)}" for project_id, errors in invalid
        )
        raise ScoutError(f"实操发布快照未过门禁：{detail}")
    expected_status = "published" if payload["projects"] else "unpublished"
    if release.get("status") != expected_status:
        raise ScoutError("实操发布快照的状态与项目清单不一致")
    return payload


def _append_release_locked(
    corpus: str,
    payload: dict[str, Any],
    *,
    source_draft_generated_at: str | None,
    restored_from_version: int | None = None,
) -> dict[str, Any]:
    path = release_path(corpus)
    path.parent.mkdir(parents=True, exist_ok=True)
    store = _load_release_store(corpus) or {
        "schema_version": RELEASE_SCHEMA_VERSION,
        "corpus": corpus,
        "current_version": 0,
        "versions": [],
    }
    version = len(store["versions"]) + 1
    release = {
        "version": version,
        "status": "published" if payload["projects"] else "unpublished",
        "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_draft_generated_at": source_draft_generated_at,
        "restored_from_version": restored_from_version,
        "snapshot_id": _snapshot_id(payload),
        **deepcopy(payload),
    }
    _validate_release(release)
    store["versions"].append(release)
    store["current_version"] = version
    _write_json(path, store)
    return {
        "corpus": corpus,
        "current_version": version,
        "release": deepcopy(release),
    }


def release_history(corpus: str) -> dict[str, Any]:
    store = _load_release_store(corpus)
    if store is None:
        return {"corpus": corpus, "current_version": None, "versions": []}
    versions = []
    for release in store["versions"]:
        payload = _validate_release(release)
        versions.append(
            {
                "version": release["version"],
                "status": release["status"],
                "published_at": release["published_at"],
                "snapshot_id": release["snapshot_id"],
                "restored_from_version": release.get("restored_from_version"),
                "project_ids": [project["id"] for project in payload["projects"]],
            }
        )
    return {
        "corpus": corpus,
        "current_version": store["current_version"],
        "versions": versions,
    }


def run_draft(
    corpus: str,
    scope: str,
    topics: list[str],
    courses: list[dict[str, Any]],
    count: int = 6,
) -> dict[str, Any]:
    course_candidates = _normalize_candidates(courses, "id", "课程")
    job_candidates = _current_job_candidates(corpus)
    gateway = LLMGateway()
    if not gateway.is_enabled(AGENT):
        raise ScoutError("生成模型路由未启用（检查对应密钥是否配置）")
    session = _session()
    keywords = suggest_keywords(gateway, corpus, scope, topics)
    candidates = search_candidates(session, keywords)
    attach_readmes(session, candidates)
    projects, dropped = draft_cards(
        gateway,
        corpus,
        scope,
        candidates,
        course_candidates,
        job_candidates,
        count,
    )
    doc = {
        "version": DRAFT_SCHEMA_VERSION,
        "corpus": corpus,
        "status": "draft",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": gateway.route_for(AGENT).model,
        "keywords": keywords,
        "candidates_considered": [
            {k: c[k] for k in ("full_name", "stars", "license", "pushed_at", "matched_keyword")}
            for c in candidates
        ],
        "course_candidates": course_candidates,
        "job_candidates": job_candidates,
        "note": "GitHub 实时搜索 + 模型分级起草的初稿。管理员逐条审核勾选后才对学习者展示。",
        "dropped": dropped,
        "projects": projects,
    }
    doc["snapshot_id"] = _snapshot_id(
        _snapshot_payload(course_candidates, job_candidates, projects)
    )
    try:
        with _corpus_operation_lock(corpus):
            _write_json(draft_path(corpus), doc)
    except Timeout as exc:
        raise ScoutError("实操初稿正由另一请求审核或替换，请稍后重试") from exc
    return doc


def approve(
    corpus: str,
    project_ids: list[str],
    courses: list[dict[str, Any]],
    draft_snapshot_id: str,
) -> dict[str, Any]:
    try:
        with _corpus_operation_lock(corpus):
            doc = _require_draft(corpus)
            if doc["snapshot_id"] != draft_snapshot_id:
                raise ScoutError("实操初稿已变化，请刷新页面后重新审核")
            current_courses = _normalize_candidates(courses, "id", "课程")
            current_jobs = _current_job_candidates(corpus)
            course_ids, job_ids = _validate_candidate_snapshot(doc, current_courses, current_jobs)
            wanted = set(project_ids)
            by_id = {
                str(project.get("id") or ""): project
                for project in doc.get("projects", [])
            }
            missing = wanted - by_id.keys()
            if missing:
                raise ScoutError(f"找不到待发布项目：{', '.join(sorted(missing))}")
            invalid = {}
            validated: dict[str, dict[str, Any]] = {}
            for project_id in wanted:
                candidate = deepcopy(by_id[project_id])
                errors = _project_errors(candidate, course_ids, job_ids)
                if errors:
                    invalid[project_id] = errors
                else:
                    validated[project_id] = candidate
            if invalid:
                detail = "；".join(
                    f"{project_id}: {', '.join(errors)}"
                    for project_id, errors in invalid.items()
                )
                raise ScoutError(f"实操项目未过发布门禁：{detail}。请重新生成并审核")
            selected = []
            for project in doc["projects"]:
                project_id = str(project.get("id") or "")
                if project_id not in wanted:
                    continue
                released = deepcopy(validated[project_id])
                released["approved"] = True
                selected.append(released)
            payload = _snapshot_payload(
                doc["course_candidates"],
                doc["job_candidates"],
                selected,
            )
            return _append_release_locked(
                corpus,
                payload,
                source_draft_generated_at=str(doc.get("generated_at") or "") or None,
            )
    except Timeout as exc:
        raise ScoutError("实操初稿正由另一请求审核或替换，请稍后重试") from exc


def restore_release(
    corpus: str,
    version: int,
    courses: list[dict[str, Any]],
) -> dict[str, Any]:
    try:
        with _corpus_operation_lock(corpus):
            store = _load_release_store(corpus)
            if store is None:
                raise ScoutError("该域还没有可恢复的实操发布版本")
            source = next(
                (item for item in store["versions"] if item.get("version") == version),
                None,
            )
            if source is None:
                raise ScoutError(f"找不到实操发布版本：{version}")
            payload = _validate_release(source)
            current_courses = _normalize_candidates(courses, "id", "课程")
            current_jobs = _current_job_candidates(corpus)
            _validate_candidate_snapshot(payload, current_courses, current_jobs)
            return _append_release_locked(
                corpus,
                payload,
                source_draft_generated_at=source.get("source_draft_generated_at"),
                restored_from_version=version,
            )
    except Timeout as exc:
        raise ScoutError("实操发布版本正由另一请求更新，请稍后重试") from exc


def published_projects(corpus: str) -> list[dict[str, Any]]:
    store = _load_release_store(corpus)
    if store is None:
        return []
    current = next(
        (
            item
            for item in store["versions"]
            if item.get("version") == store.get("current_version")
        ),
        None,
    )
    if current is None:
        raise ScoutError("实操发布版本库缺少当前版本")
    payload = _validate_release(current)
    return deepcopy(payload["projects"])
