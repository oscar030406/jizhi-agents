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

import json
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

from backend.services.llm_gateway import LLMGateway

ROOT = Path(__file__).resolve().parents[2]
DRAFT_DIR = ROOT / "data" / "practice_drafts"

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
6. 只输出 JSON：
{"projects": [{
  "repo": "owner/name",
  "name": "推荐卡标题（中文，一眼看出做什么）",
  "level": "starter|advanced|portfolio",
  "difficulty": 1-5 整数,
  "hours": "预估工时，如 10-20 小时",
  "prereq": "前置要求一句话",
  "steps": ["具体步骤 1", "具体步骤 2", "具体步骤 3"],
  "cost": "成本口径（如：本地即可运行 / 需要一块 PLC 仿真环境）",
  "networkNote": "网络门槛（能访问 GitHub 即可 / ⚠需要...）",
  "why": "为什么值得做：练的是什么真实工作能力，2-3 句",
  "acceptance": "验收标准：做到什么程度算完成（可检查）",
  "deliverable": "做完手里有什么",
  "resumeAdvice": "简历用法：怎么写才不虚"
}]}"""


class ScoutError(RuntimeError):
    """对管理端可见的失败（网络不通 / 模型未启用 / 无候选），不静默。"""


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
        except ScoutError:
            raise
        except Exception:  # noqa: BLE001 单个 README 拉不到不致命，标注即可
            text = "（README 拉取失败，仅凭简介判断）"
        c["readme_excerpt"] = text


def draft_cards(
    gateway: LLMGateway, corpus: str, scope: str, candidates: list[dict[str, Any]], count: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_name = {c["full_name"]: c for c in candidates}
    lines = [f"领域库：{corpus}；领域范围：{scope or '（未填写）'}；最多推荐 {count} 个。", "", "候选仓库："]
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
    for p in parsed["projects"]:
        repo = str(p.get("repo") or "").strip()
        raw_steps = p.get("steps")
        steps = (
            [step.strip() for step in raw_steps if isinstance(step, str) and step.strip()]
            if isinstance(raw_steps, list)
            else []
        )
        reasons = []
        if repo not in by_name:
            reasons.append(f"仓库不在候选清单内：{repo!r}")
        if repo in seen_repo:
            reasons.append("仓库重复推荐")
        if p.get("level") not in LEVELS:
            reasons.append(f"level 非法：{p.get('level')!r}")
        if not all(str(p.get(k) or "").strip() for k in ("name", "why", "acceptance", "deliverable")):
            reasons.append("关键字段为空")
        if len(steps) < 2:
            reasons.append("可执行步骤少于 2 条")
        if reasons:
            dropped.append({"repo": repo, "name": p.get("name"), "reasons": reasons})
            continue
        seen_repo.add(repo)
        src = by_name[repo]
        owner = repo.split("/")[0]
        kept.append({
            # org / links / 星数由代码从 GitHub 实拉数据填——模型无权编这些事实字段
            "id": re.sub(r"[^a-z0-9-]", "-", repo.lower().replace("/", "-")),
            "name": str(p["name"]).strip(),
            "org": f"{owner}（{_fmt_stars(src['stars'])}★）",
            "level": p["level"],
            "difficulty": max(1, min(5, int(p.get("difficulty") or 3))),
            "hours": str(p.get("hours") or "").strip(),
            "jobIds": [],
            "courseIds": [],
            "prereq": str(p.get("prereq") or "").strip(),
            "steps": steps,
            "cost": str(p.get("cost") or "").strip(),
            "networkNote": str(p.get("networkNote") or "GitHub 可访问即可").strip(),
            "why": str(p["why"]).strip(),
            "acceptance": str(p["acceptance"]).strip(),
            "deliverable": str(p["deliverable"]).strip(),
            "resumeAdvice": str(p.get("resumeAdvice") or "").strip(),
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
        raise ScoutError("模型起草的推荐卡全部未过校验（详见 dropped）")
    return kept, dropped


def draft_path(corpus: str) -> Path:
    return DRAFT_DIR / f"{corpus}.json"


def load_draft(corpus: str) -> dict[str, Any] | None:
    p = draft_path(corpus)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def run_draft(corpus: str, scope: str, topics: list[str], count: int = 6) -> dict[str, Any]:
    gateway = LLMGateway()
    if not gateway.is_enabled(AGENT):
        raise ScoutError("生成模型路由未启用（检查对应密钥是否配置）")
    session = _session()
    keywords = suggest_keywords(gateway, corpus, scope, topics)
    candidates = search_candidates(session, keywords)
    attach_readmes(session, candidates)
    projects, dropped = draft_cards(gateway, corpus, scope, candidates, count)
    doc = {
        "version": 1,
        "corpus": corpus,
        "status": "draft",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": gateway.route_for(AGENT).model,
        "keywords": keywords,
        "candidates_considered": [
            {k: c[k] for k in ("full_name", "stars", "license", "pushed_at", "matched_keyword")}
            for c in candidates
        ],
        "note": "GitHub 实时搜索 + 模型分级起草的初稿。管理员逐条审核勾选后才对学习者展示。",
        "dropped": dropped,
        "projects": projects,
    }
    DRAFT_DIR.mkdir(parents=True, exist_ok=True)
    draft_path(corpus).write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return doc


def approve(corpus: str, project_ids: list[str]) -> dict[str, Any]:
    doc = load_draft(corpus)
    if not doc:
        raise ScoutError("该域还没有实操初稿")
    wanted = set(project_ids)
    hit = 0
    for p in doc["projects"]:
        p["approved"] = p["id"] in wanted
        hit += int(p["approved"])
    doc["status"] = "published" if hit else "draft"
    doc["approved_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds") if hit else None
    draft_path(corpus).write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return doc


def published_projects(corpus: str) -> list[dict[str, Any]]:
    doc = load_draft(corpus)
    if not doc or doc.get("status") != "published":
        return []
    return [p for p in doc["projects"] if p.get("approved")]
