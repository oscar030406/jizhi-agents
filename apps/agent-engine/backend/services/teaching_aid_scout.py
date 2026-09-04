"""外部可视化教具侦察：按概念在 GitHub 上找真实的交互式讲解/可视化项目。

为什么要有这个（2026-09-04）：
- 我们自己生成的互动教具做不过 transformer-explainer、CNN Explainer、TensorFlow
  Playground 这类被无数课堂用过的成品。与其硬做，不如把它们**指给学习者**，
  课上照着操作单点几下就看见了。
- 与实操项目侦察（practice_scout）同一套纪律：**事实全部来自 GitHub REST API**
  （星数、许可证、更新时间、homepage 都是实拉），模型只负责从候选清单里挑、
  分档、写中文操作单，编不出清单外的仓库。
- 初稿永不自动上线：落 data/teaching_aids/<corpus>.json，approved=false，
  管理员逐条勾选后才发布到不可变的 releases/<corpus>.json。

与 practice_scout 的关系：底层文件原语、HTTP 会话、README 抓取、快照校验全部复用
它的函数，不复制。只有 `search_candidates` 自己写了一份——practice_scout 那份不带
`homepage` 字段，而演示站地址正是这个功能的核心（教具的价值在能点开的那个网页，
不在源码）。多拉一次 /repos 拿 homepage 要按仓库计费，未认证 core 配额只有 60 次/小时，
一轮就打光；搜索结果里本来就带 homepage，所以在搜索这一层取。
"""

from __future__ import annotations

import json
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

import requests
from filelock import FileLock, Timeout
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from backend.services.llm_gateway import LLMGateway
from backend.services.practice_scout import (
    GITHUB_API,
    ScoutError,
    _get,
    _load_json,
    _session,
    _snapshot_id,
    _snapshot_payload,
    _write_json,
    attach_readmes,
)

ROOT = Path(__file__).resolve().parents[2]
AID_DIR = ROOT / "data" / "teaching_aids"
DRAFT_SCHEMA_VERSION = 1
RELEASE_SCHEMA_VERSION = 1

AGENT = "ResourceGenerationAgent"
LEVELS = ("starter", "advanced")

# 教具的门槛比实操项目高：课堂上要当着人点开，星数太低、多年不维护的站点随时打不开。
MIN_STARS = 100
MAX_AGE_YEARS = 3
SEARCH_PER_KEYWORD = 10
POOL_PER_CONCEPT = 4  # 每概念只给这么多候选拉 README：未认证 core 配额 60 次/小时
README_CHARS = 600  # 十一个概念的候选一次性喂给模型，摘录再长提示词就过万了

# 概念 → GitHub 搜索词。手写不让模型编：GitHub 搜索是全词 AND，词一多直接零命中，
# 而「哪些教具是这个概念的」是教研判断，不是模型该猜的事。
CONCEPT_KEYWORDS: dict[str, list[str]] = {
    # 第一轮实测：泛词（"agent visualization"、"llm evaluation dashboard"）按星数排序
    # 拉回来的是 excelize、CellChat、plow 这类跟概念无关的高星仓库。词要指向
    # 「这个东西画出来给人看」，不能只指向领域。
    "llm_basics": [
        "transformer explainer",
        "attention visualization",
        "bertviz",
        "tokenizer playground",
        "embedding projector",
        "attention viewer",
        "llm sampling visualizer",
    ],
    "deep_learning": [
        "cnn explainer",
        "neural network playground",
        "backpropagation visualization",
        "tensorflow playground",
        "deep learning visualization",
    ],
    "agent_basics": [
        "generative agents simulation",
        "agent simulation demo",
        "agent playground web",
    ],
    "tool_calling": [
        "mcp inspector",
        "function calling playground",
        "tool calling demo",
    ],
    "rag": [
        "rag visualizer",
        "retrieval visualization",
        "vector database visualization",
        "chunk visualizer",
    ],
    "context_engineering": [
        "tokenizer visualizer",
        "kv cache calculator",
        "context length calculator",
        "attention map viewer",
    ],
    "langgraph": [
        "langgraph studio",
        "agent workflow builder",
        "node graph editor",
    ],
    "evaluation": [
        "chatbot arena",
        "model arena",
        "llm benchmark explorer",
    ],
    "guardrails": [
        "prompt injection game",
        "prompt injection challenge",
        "llm security playground",
    ],
    "deployment": [
        "llm inference calculator",
        "gpu memory calculator",
        "quantization demo",
    ],
    "prompt_engineering": [
        "llm playground ui",
        "prompt playground open source",
        "sampling temperature demo",
    ],
}

OSI_LICENSES = {
    "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear",
    "MPL-2.0", "GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-2.1", "LGPL-3.0",
    "ISC", "Unlicense", "0BSD", "EPL-2.0", "Zlib",
}

# 论文/资源清单类仓库：它们星数高、更新勤，但点开没有能操作的东西。
LIST_REPO_PATTERN = re.compile(
    r"\b(awesome|paper[- ]?list|reading[- ]?list|curated list|collection of (papers|resources)|"
    r"survey|roadmap|cheat[- ]?sheet|interview questions)\b",
    re.IGNORECASE,
)

DRAFT_SYSTEM = """你是技能培训的教研。下面给出一批从 GitHub 实时搜索得到的真实仓库\
（含星数、简介、演示站地址、README 摘录）。请从中挑出**能在课堂上当场点开、让学习者动手看见\
概念怎么运转**的可视化教具，为每个写一张中文教具卡。

硬性要求：
1. 只能从候选清单里选仓库（repo 字段填候选的 full_name，一字不差）；清单外的一概不许出现。
2. 只选真的能交互或能看动画的东西：网页演示、可视化工具、可运行的动画笔记本。\
纯代码库、纯论文清单、纯资源合集、只有静态图片的仓库一律不选，宁缺毋滥。
3. what_it_shows 写这个教具让人看见什么（2 句，中文，平实叙述，不要推销词、不要感叹号）。
4. use_in_class 写 3-5 步课堂操作单：每步说清**点哪里、改什么、看什么变化**，\
不能只写「打开网站看看」这种空话。依据必须来自简介与 README 摘录，摘录里没有的\
按钮名、菜单名、文件名一律不要写。
5. level：starter=零基础也能跟着点；advanced=要先懂这个概念才看得懂。
6. duration_minutes：课堂上用这个教具的分钟数，5-30 的整数。
7. 只输出 JSON，键名一字不差照抄：
{"aids": [{
  "repo": "owner/name",
  "concept": "候选清单里给的概念 ID",
  "name": "教具中文名（一眼看出是讲什么的）",
  "what_it_shows": "让人看见什么，2 句",
  "use_in_class": ["操作步骤 1", "操作步骤 2", "操作步骤 3"],
  "duration_minutes": 10,
  "level": "starter|advanced"
}]}"""


class _AidCard(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    repo: str = Field(min_length=1)
    concept: str = Field(min_length=1)
    name: str = Field(min_length=1)
    what_it_shows: str = Field(min_length=1)
    use_in_class: list[str] = Field(min_length=3, max_length=5)
    duration_minutes: int = Field(ge=5, le=30)
    level: Literal["starter", "advanced"]


def draft_path(corpus: str) -> Path:
    return AID_DIR / f"{corpus}.json"


def release_path(corpus: str) -> Path:
    return AID_DIR / "releases" / f"{corpus}.json"


def _corpus_lock(corpus: str) -> FileLock:
    path = draft_path(corpus)
    path.parent.mkdir(parents=True, exist_ok=True)
    return FileLock(f"{path}.lock", timeout=15)


def _validation_reasons(exc: ValidationError) -> list[str]:
    return [
        f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors()
    ]


def is_list_repo(text: str) -> bool:
    """资源清单类仓库：课堂上点开没有能操作的东西。"""
    return bool(LIST_REPO_PATTERN.search(text or ""))


def candidate_rejection(item: dict[str, Any], cutoff: str) -> str | None:
    """候选进不进池的唯一判定处。返回原因字符串＝不要，None＝可以。"""
    if item["stars"] < MIN_STARS:
        return f"星数不足 {MIN_STARS}：{item['stars']}"
    if item["pushed_at"] < cutoff:
        return f"超过 {MAX_AGE_YEARS} 年未提交：{item['pushed_at']}"
    if is_list_repo(f"{item['full_name']} {item['description']}"):
        return "论文/资源清单类仓库，没有可操作的教具"
    # 许可证：有公开演示站的可以放行——课堂上是打开人家的网站，不是分发人家的代码。
    if item["license"] not in OSI_LICENSES and not item["demo_url"]:
        return f"许可证不合格且没有公开演示站：{item['license']}"
    return None


def search_candidates(
    session: requests.Session, concept: str, keywords: list[str]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """按概念搜候选，返回（进池的, 被筛掉的）。homepage 直接从搜索结果里取。"""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=365 * MAX_AGE_YEARS)).strftime("%Y-%m-%d")
    seen: dict[str, dict[str, Any]] = {}
    for keyword in keywords:
        resp = _get(
            session,
            f"{GITHUB_API}/search/repositories",
            params={"q": keyword, "sort": "stars", "order": "desc", "per_page": SEARCH_PER_KEYWORD},
        )
        for item in resp.json().get("items", []):
            full = item.get("full_name") or ""
            if not full or full in seen or item.get("archived"):
                continue
            description = (item.get("description") or "").strip()
            if not description:
                continue
            homepage = (item.get("homepage") or "").strip()
            seen[full] = {
                "full_name": full,
                "html_url": item.get("html_url"),
                "stars": int(item.get("stargazers_count") or 0),
                "description": description,
                "license": (item.get("license") or {}).get("spdx_id") or "无许可证信息",
                "pushed_at": (item.get("pushed_at") or "")[:10],
                "demo_url": homepage if homepage.startswith("https://") else None,
                "matched_keyword": keyword,
                "concept": concept,
            }
        # 未认证搜索配额 10 次/分钟（按 IP），6.5 秒一拍稳在 9 次/分内。
        time.sleep(2.2 if session.headers.get("Authorization") else 6.5)

    kept, rejected = [], []
    for item in sorted(seen.values(), key=lambda c: -c["stars"]):
        reason = candidate_rejection(item, cutoff)
        if reason:
            rejected.append({**item, "reason": reason})
        else:
            kept.append(item)
    return kept[:POOL_PER_CONCEPT], rejected


def probe_embeddable(url: str, timeout: float = 12.0) -> dict[str, Any]:
    """演示站能不能被我们 iframe 进来。只看响应头，不解析页面。

    只有明确允许（没有 X-Frame-Options，且 CSP 没有限制 frame-ancestors）才算能嵌。
    拿不准一律 False：嵌不进去时页面是一片空白，比直接给个链接更糟。
    """
    result: dict[str, Any] = {"status": None, "embeddable": False, "reason": ""}
    try:
        resp = requests.get(url, timeout=timeout, allow_redirects=True, stream=True)
        resp.close()
    except Exception as exc:  # noqa: BLE001 探测失败不致命，记原因
        result["reason"] = f"打不开：{type(exc).__name__}"
        return result
    result["status"] = resp.status_code
    if resp.status_code != 200:
        result["reason"] = f"HTTP {resp.status_code}"
        return result
    xfo = (resp.headers.get("X-Frame-Options") or "").strip().upper()
    if xfo:
        result["reason"] = f"X-Frame-Options: {xfo}"
        return result
    csp = resp.headers.get("Content-Security-Policy") or ""
    match = re.search(r"frame-ancestors([^;]*)", csp, re.IGNORECASE)
    if match:
        directive = match.group(1).strip().lower()
        if directive not in ("*", "https:"):
            result["reason"] = "CSP frame-ancestors: " + (directive or "'none'")
            return result
    result["embeddable"] = True
    return result


def _aid_errors(aid: dict[str, Any], concepts: set[str]) -> list[str]:
    """发布门禁。审核与发布两处共用，草稿与发布快照走同一把尺。"""
    errors = []
    steps = aid.get("use_in_class")
    clean = (
        [s.strip() for s in steps if isinstance(s, str) and s.strip()]
        if isinstance(steps, list)
        else []
    )
    aid["use_in_class"] = clean
    if not all(str(aid.get(k) or "").strip() for k in ("id", "name", "what_it_shows", "url")):
        errors.append("关键字段为空")
    if not 3 <= len(clean) <= 5:
        errors.append("课堂操作单必须为 3–5 步")
    if aid.get("concept") not in concepts:
        errors.append(f"概念不在本领域概念表内：{aid.get('concept')}")
    if aid.get("level") not in LEVELS:
        errors.append(f"档位只能是 {'/'.join(LEVELS)}")
    if not isinstance(aid.get("duration_minutes"), int) or not 5 <= aid["duration_minutes"] <= 30:
        errors.append("课堂时长必须是 5–30 的整数")
    if not isinstance(aid.get("embeddable"), bool):
        errors.append("embeddable 必须是布尔值（由演示站响应头实测得出）")
    if aid.get("embeddable") and not aid.get("demo_url"):
        errors.append("没有演示站却标了可嵌入")
    return errors


def concepts_for(corpus: str) -> list[str]:
    """本领域有哪些概念。以概念图为准，没有概念图就报错，不猜。"""
    path = ROOT / "data" / "knowledge_base" / "concept_graph.json"
    if corpus != "ai":
        path = ROOT / "data" / "knowledge_base" / "corpora" / corpus / "concept_graph.json"
    data = _load_json(path)
    if not data:
        raise ScoutError(f"找不到 {corpus} 的概念图，无法按概念找教具")
    return [k for k in data if not k.startswith("_")]


def draft_cards(
    gateway: LLMGateway,
    corpus: str,
    candidates: list[dict[str, Any]],
    concepts: set[str],
    count: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_name = {c["full_name"]: c for c in candidates}
    lines = [
        f"领域库：{corpus}；最多挑 {count} 个教具。",
        "允许的概念 ID（concept 只能填这些）：" + "、".join(sorted(concepts)),
        "",
        "候选仓库：",
    ]
    for c in candidates:
        lines.append(
            f"- {c['full_name']}（概念 {c['concept']}，{c['stars']}★，{c['license']}，"
            f"最近提交 {c['pushed_at']}，演示站 {c['demo_url'] or '无'}）：{c['description']}\n"
            f"  README 摘录：{c.get('readme_excerpt', '')}"
        )
    parsed = gateway.structured_chat(
        AGENT, DRAFT_SYSTEM, "\n".join(lines), temperature=0.3, max_tokens=6000
    )
    if not parsed or not isinstance(parsed.get("aids"), list):
        raise ScoutError("模型未返回可解析的教具卡 JSON")

    kept, dropped = [], []
    seen_ids: set[str] = set()
    for raw in parsed["aids"]:
        try:
            card = _AidCard.model_validate(raw).model_dump()
        except ValidationError as exc:
            dropped.append({
                "repo": raw.get("repo") if isinstance(raw, dict) else "",
                "reasons": _validation_reasons(exc),
            })
            continue
        repo = card["repo"].strip()
        reasons = []
        if repo not in by_name:
            reasons.append(f"仓库不在候选清单内：{repo!r}")
        aid_id = re.sub(r"[^a-z0-9-]", "-", repo.lower().replace("/", "-"))
        if aid_id in seen_ids:
            reasons.append(f"教具 ID 冲突：{aid_id}")
        if reasons:
            dropped.append({"repo": repo, "reasons": reasons})
            continue
        src = by_name[repo]
        # url / demo_url / provenance / embeddable 一律由代码从实拉数据填，模型无权编事实
        aid = {
            "id": aid_id,
            "concept": card["concept"],
            "name": card["name"].strip(),
            "what_it_shows": card["what_it_shows"].strip(),
            "use_in_class": [s.strip() for s in card["use_in_class"]],
            "duration_minutes": card["duration_minutes"],
            "level": card["level"],
            "url": src["html_url"],
            "demo_url": src["demo_url"],
            "embeddable": bool(src.get("embeddable")),
            "embed_note": src.get("embed_note", ""),
            "approved": False,
            "provenance": {
                "source": "github-api",
                "stars": src["stars"],
                "license": src["license"],
                "pushed_at": src["pushed_at"],
            },
        }
        errors = _aid_errors(aid, concepts)
        if errors:
            dropped.append({"repo": repo, "reasons": errors})
            continue
        seen_ids.add(aid_id)
        kept.append(aid)
    if not kept:
        detail = "；".join(
            f"{d.get('repo') or '未知卡片'}: {', '.join(d['reasons'])}" for d in dropped[:6]
        )
        raise ScoutError(f"模型起草的教具卡全部未过校验：{detail}")
    return kept, dropped


def run_draft(corpus: str, concepts: list[str] | None = None, count: int = 16) -> dict[str, Any]:
    all_concepts = set(concepts_for(corpus))
    wanted = [c for c in (concepts or sorted(all_concepts)) if c in CONCEPT_KEYWORDS]
    if not wanted:
        raise ScoutError("没有配了搜索词的概念，无法起草")
    gateway = LLMGateway()
    if not gateway.is_enabled(AGENT):
        raise ScoutError("生成模型路由未启用（检查对应密钥是否配置）")

    session = _session()
    pool: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    seen_repos: set[str] = set()
    for concept in wanted:
        kept, dropped = search_candidates(session, concept, CONCEPT_KEYWORDS[concept])
        rejected.extend(dropped)
        for item in kept:
            if item["full_name"] in seen_repos:
                continue
            seen_repos.add(item["full_name"])
            pool.append(item)
    if not pool:
        raise ScoutError("按概念搜不到符合门槛的教具仓库")

    attach_readmes(session, pool)
    for item in pool:
        item["readme_excerpt"] = (item.get("readme_excerpt") or "")[:README_CHARS]
        if item["demo_url"]:
            probe = probe_embeddable(item["demo_url"])
            item["embeddable"] = probe["embeddable"]
            item["embed_note"] = probe["reason"]
            if probe["status"] != 200:
                # 演示站打不开就当没有演示站：课上点开是 404 比没有链接更难堪
                item["demo_url"] = None
                item["embeddable"] = False
        else:
            item["embeddable"] = False
            item["embed_note"] = "仓库没有填 homepage"

    aids, dropped = draft_cards(gateway, corpus, pool, all_concepts, count)
    doc = {
        "version": DRAFT_SCHEMA_VERSION,
        "corpus": corpus,
        "status": "draft",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": gateway.route_for(AGENT).model,
        "concepts": sorted(all_concepts),
        "candidates_considered": [
            {k: c[k] for k in ("full_name", "concept", "stars", "license", "pushed_at", "demo_url")}
            for c in pool
        ],
        "rejected_candidates": rejected,
        "dropped": dropped,
        "note": "GitHub 实时搜索 + 模型起草的初稿。管理员逐条审核勾选后才对学习者展示。",
        "aids": aids,
    }
    doc["snapshot_id"] = _snapshot_id(_snapshot_payload([], [], aids))
    try:
        with _corpus_lock(corpus):
            _write_json(draft_path(corpus), doc)
    except Timeout as exc:
        raise ScoutError("教具初稿正由另一请求审核或替换，请稍后重试") from exc
    return doc


def load_draft(corpus: str) -> dict[str, Any] | None:
    return _load_json(draft_path(corpus))


def _require_draft(corpus: str) -> dict[str, Any]:
    doc = load_draft(corpus)
    if not doc:
        raise ScoutError("该域还没有教具初稿")
    if doc.get("version") != DRAFT_SCHEMA_VERSION:
        raise ScoutError(f"教具草稿版本不是 {DRAFT_SCHEMA_VERSION}，请重新生成后再审核")
    if doc.get("corpus") != corpus:
        raise ScoutError("教具草稿记录的领域与当前请求不一致")
    if not isinstance(doc.get("aids"), list):
        raise ScoutError("教具草稿 aids 格式错误")
    if doc.get("snapshot_id") != _snapshot_id(_snapshot_payload([], [], doc["aids"])):
        raise ScoutError("教具草稿快照校验失败，请重新起草")
    return doc


def _validate_release(release: dict[str, Any], concepts: set[str]) -> list[dict[str, Any]]:
    aids = release.get("aids")
    if not isinstance(aids, list):
        raise ScoutError("教具发布快照缺少 aids 列表")
    if release.get("snapshot_id") != _snapshot_id(_snapshot_payload([], [], aids)):
        raise ScoutError("教具发布快照校验失败，拒绝读取被改写的版本")
    invalid = []
    for aid in json.loads(json.dumps(aids)):
        errors = _aid_errors(aid, concepts)
        if errors:
            invalid.append(f"{aid.get('id', '未知教具')}: {', '.join(errors)}")
    if invalid:
        raise ScoutError(f"教具发布快照未过门禁：{'；'.join(invalid)}")
    expected = "published" if aids else "unpublished"
    if release.get("status") != expected:
        raise ScoutError("教具发布快照的状态与清单不一致")
    return aids


def _load_release_store(corpus: str) -> dict[str, Any] | None:
    store = _load_json(release_path(corpus))
    if store is None:
        return None
    if store.get("schema_version") != RELEASE_SCHEMA_VERSION:
        raise ScoutError("教具发布版本库格式错误，请重新执行发布验收")
    if store.get("corpus") != corpus or not isinstance(store.get("versions"), list):
        raise ScoutError("教具发布版本库的领域或版本列表格式错误")
    if not store["versions"]:
        raise ScoutError("教具发布版本库缺少版本")
    concepts = set(concepts_for(corpus))
    for expected, release in enumerate(store["versions"], start=1):
        if not isinstance(release, dict) or release.get("version") != expected:
            raise ScoutError("教具发布版本必须从 1 严格递增且不可重复")
        _validate_release(release, concepts)
    if store.get("current_version") != store["versions"][-1]["version"]:
        raise ScoutError("教具发布版本库的当前指针不是最新版本")
    return store


def approve(corpus: str, aid_ids: list[str], draft_snapshot_id: str) -> dict[str, Any]:
    try:
        with _corpus_lock(corpus):
            doc = _require_draft(corpus)
            if doc["snapshot_id"] != draft_snapshot_id:
                raise ScoutError("教具初稿已变化，请刷新页面后重新审核")
            concepts = set(concepts_for(corpus))
            by_id = {str(a.get("id") or ""): a for a in doc["aids"]}
            missing = set(aid_ids) - by_id.keys()
            if missing:
                raise ScoutError(f"找不到待发布教具：{', '.join(sorted(missing))}")
            selected = []
            invalid = []
            for aid in doc["aids"]:
                if str(aid.get("id") or "") not in set(aid_ids):
                    continue
                picked = json.loads(json.dumps(aid))
                errors = _aid_errors(picked, concepts)
                if errors:
                    invalid.append(f"{picked['id']}: {', '.join(errors)}")
                    continue
                picked["approved"] = True
                selected.append(picked)
            if invalid:
                raise ScoutError(f"教具未过发布门禁：{'；'.join(invalid)}。请重新生成并审核")

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
                "status": "published" if selected else "unpublished",
                "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "source_draft_generated_at": str(doc.get("generated_at") or "") or None,
                "snapshot_id": _snapshot_id(_snapshot_payload([], [], selected)),
                "aids": selected,
            }
            _validate_release(release, concepts)
            store["versions"].append(release)
            store["current_version"] = version
            _write_json(path, store)
            return {"corpus": corpus, "current_version": version, "release": release}
    except Timeout as exc:
        raise ScoutError("教具初稿正由另一请求审核或替换，请稍后重试") from exc


def published_aids(corpus: str) -> list[dict[str, Any]]:
    store = _load_release_store(corpus)
    if store is None:
        return []
    current = next(
        (v for v in store["versions"] if v.get("version") == store.get("current_version")), None
    )
    if current is None:
        raise ScoutError("教具发布版本库缺少当前版本")
    return json.loads(json.dumps(_validate_release(current, set(concepts_for(corpus)))))


def release_history(corpus: str) -> dict[str, Any]:
    store = _load_release_store(corpus)
    if store is None:
        return {"corpus": corpus, "current_version": None, "versions": []}
    return {
        "corpus": corpus,
        "current_version": store["current_version"],
        "versions": [
            {
                "version": v["version"],
                "status": v["status"],
                "published_at": v["published_at"],
                "snapshot_id": v["snapshot_id"],
                "aid_ids": [a["id"] for a in v["aids"]],
            }
            for v in store["versions"]
        ],
    }


def demo_host(url: str | None) -> str:
    """演示站域名。前端要在提示语里点名是谁家的站点。"""
    return urlparse(url).netloc if url else ""
