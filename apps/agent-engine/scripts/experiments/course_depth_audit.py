r"""课程深度审计：越靠后的课是不是越薄？薄在语料还是薄在生成？

    cd apps/agent-engine
    python scripts/experiments/course_depth_audit.py --json data/eval/course_depth_audit.json
    python scripts/experiments/course_depth_audit.py --selftest

## 为什么要这一份

2026-08-15 用户的观察：「已有课程的质量和要求的复杂度成反比——越往后的课（如实际岗位类）
生成得越简略，按理教材对越后面的应该讲得越详细。是不是模型支撑不起更高强度的教学？」

「是不是模型的问题」这句要用数据判，不能靠感觉。本脚本一条 LLM 都不调、不联网，
只读盘 + 跑本地 TF-IDF 检索，量三组数：

1. **产出**：每门课的正文字数、每场景均字数、摘录占比、引用 chunk 数、场景/题目数。
2. **要求的复杂度**：不是我们自己判的，取学习路径单一真源
   `apps/classroom/data/learning-path.json` 里每个节点现成的 `stage` 与 `difficulty`。
3. **语料供给**：两条独立口径。
   - 标签供给：这门课主概念在 `knowledge_index.jsonl` 里有多少块、多少字。
     主概念的推法沿用 `derive_scene_concepts.py`（场景引用的 chunk 的 concept_tags 计票）。
   - 检索供给：把生产查询**原样重放**一遍，数有多少块能过生产的充分性门。
     生产查询形状见 `apps/classroom/lib/server/classroom-generation.ts:519`
     （`courseTitle + outline.title + outline.description`），落库的课只留得下前两段，
     所以这里用 `课名 + 场景标题`，是生产查询的**截短版**（口径缺陷写在下面）。

## 口径与已知缺陷（用数之前必须知道）

- **字数按中日韩汉字计**（`[一-鿿]`），与 `course_wall_audit.py` 同口径，便于对照。
  英文术语、代码、公式不计入。代码密集的课会被低估——所以另出一列「非空白字符总数」。
- **检索供给用 TF-IDF 后端，不是生产默认的 bge-m3 向量后端**。向量后端的查询嵌入要调
  硅基流动的 API（`backend/rag/embedding_retriever.py:EMBED_ENDPOINT`），那就不是零 LLM 了。
  TF-IDF 是仓库里现成的消融对照后端（`RETRIEVER_BACKEND=tfidf`），门阈值 0.05 是
  `scripts/calibrate_retrieval_gate.py` 标定的。两套后端量纲不同，**这里的绝对值不能
  和向量后端的召回数比**，只能用于课与课之间的横向排序。
- **样本 23 门，路径内 19 门**。这个量级只够看方向，不够下显著性结论。
  相关系数一律附排列检验 p 值与 n，别把它当成统计显著。
- 文本提取（去标签、剔代码段、认摘录块）直接复用 `course_wall_audit.py` 的三个判据，
  两份审计共用同一口径；改那边这边跟着变，这是有意的。
"""

from __future__ import annotations

import argparse
import ast
import json
import random
import re
import sys
from collections import Counter
from pathlib import Path

_HERE = Path(__file__).resolve()
_ENGINE = _HERE.parents[2]
_REPO = _HERE.parents[4]
sys.path.insert(0, str(_ENGINE))
sys.path.insert(0, str(_HERE.parent))

from course_wall_audit import EXCERPT_BLOCK, MONO_P, plain  # noqa: E402

CLASSROOMS = _REPO / "apps" / "classroom" / "data" / "classrooms"
LEARNING_PATH = _REPO / "apps" / "classroom" / "data" / "learning-path.json"
JOBS = _REPO / "apps" / "classroom" / "data" / "classroom-jobs"
INDEX = _ENGINE / "data" / "knowledge_base" / "knowledge_index.jsonl"

CJK = re.compile(r"[一-鿿]")
#: 正文里的行内引用标记，与 backend/rag/retriever.py:extract_citations 同一条正则
CITATION = re.compile(r"\[([A-Za-z0-9_\-]+#s\d+)\]")
#: 版式装不下时展开器留在页面上的截断痕，两条字面量出自
#: apps/classroom/lib/generation/slide-templates.ts:165 与 :391。
#: 数它是为了判断「一页装不下」是不是当前的瓶颈——命中为 0 时先看 selftest 的正例对照。
TRUNCATED = re.compile(r"…（其余 \d+ 条见讲稿）|# …共 \d+ 行，其余见讲稿")


# ── 产出侧：一门课量出来什么 ──────────────────────────────────────────────


def _cjk(text: str) -> int:
    return len(CJK.findall(text))


def _dense(text: str) -> int:
    """非空白字符数。汉字口径会漏掉代码与英文术语，这一列用来兜底对照。"""
    return len(re.sub(r"\s", "", text))


def measure_course(course: dict) -> dict:
    """只吃一个已解析的课程 dict，不碰磁盘——这样 --selftest 能拿假课直接验。"""
    scenes = course.get("scenes") or []
    canvas_cjk = canvas_dense = excerpt_cjk = quiz_cjk = speech_cjk = 0
    excerpt_blocks = quiz_questions = truncated = 0
    text_elements = grounded_scenes = 0
    claims = flagged = 0
    forms: Counter[str] = Counter()
    cited: set[str] = set()

    for scene in scenes:
        content = scene.get("content") or {}
        forms[content.get("type")] += 1

        for element in (content.get("canvas") or {}).get("elements", []) or []:
            html = element.get("content")
            if not isinstance(html, str):
                continue
            text_elements += 1
            cited.update(CITATION.findall(html))
            truncated += len(TRUNCATED.findall(html))
            # 等宽段落是代码，先剔掉再算行文字数（判据同 course_wall_audit）
            text = plain(MONO_P.sub("", html))
            canvas_cjk += _cjk(text)
            canvas_dense += _dense(text)
            for block in EXCERPT_BLOCK.findall(text):
                excerpt_blocks += 1
                excerpt_cjk += _cjk(block)

        for question in content.get("questions") or []:
            quiz_questions += 1
            parts = [question.get("question") or "", question.get("analysis") or ""]
            parts += [o.get("label") or "" for o in question.get("options") or []]
            quiz_cjk += sum(_cjk(p) for p in parts)

        for action in scene.get("actions") or []:
            if isinstance(action, dict) and isinstance(action.get("text"), str):
                speech_cjk += _cjk(action["text"])

        audit = scene.get("audit") or {}
        # grounded 是生产当场记下的：这一页到底有没有拿到教材证据。
        # 比任何事后代理指标都硬——它是管线自己的判词，不是我们复原的。
        grounded_scenes += int(bool(audit.get("grounded")))
        claims += int(audit.get("totalClaims") or 0)
        flagged += int(audit.get("flaggedCount") or 0)
        for claim in audit.get("claims") or []:
            cited.update(claim.get("sourceIds") or [])

    body_cjk = canvas_cjk + quiz_cjk
    n = max(len(scenes), 1)
    return {
        "id": course.get("id"),
        "name": (course.get("stage") or {}).get("name", "?"),
        "createdAt": course.get("createdAt"),
        "scenes": len(scenes),
        "forms": dict(forms),
        "quiz_questions": quiz_questions,
        "canvas_cjk": canvas_cjk,
        "canvas_dense": canvas_dense,
        "quiz_cjk": quiz_cjk,
        "speech_cjk": speech_cjk,
        "body_cjk": body_cjk,
        "body_per_scene": round(body_cjk / n, 1),
        "excerpt_blocks": excerpt_blocks,
        "excerpt_cjk": excerpt_cjk,
        # 摘录占比的分母是画布正文（摘录只出现在画布，不出现在题目里）
        "excerpt_share": round(excerpt_cjk / max(canvas_cjk, 1), 3),
        "own_cjk": body_cjk - excerpt_cjk,
        # 剔掉教材摘录后「我们自己写的那部分」的每场景篇幅——本审计里最要紧的一列
        "own_per_scene": round((body_cjk - excerpt_cjk) / n, 1),
        "text_elements": text_elements,
        "truncated_slots": truncated,
        "grounded_scenes": grounded_scenes,
        "ungrounded_scenes": len(scenes) - grounded_scenes,
        "claims": claims,
        "flagged_claims": flagged,
        # 判词里出现过的 id 原样计数；哪些是库里真有的块，由 build_rows 拿索引筛
        "cited_raw": len(cited),
        "_cited": sorted(cited),
    }


# ── 位置侧：课在学习路径的哪一段（分类不是我们判的） ─────────────────────


def load_path_positions() -> tuple[dict[str, dict], dict[str, str]]:
    """courseId → {stage, difficulty, node}；外加 stage → 路径自己写的中文小标题。"""
    data = json.loads(LEARNING_PATH.read_text(encoding="utf-8"))
    titles = {s["id"]: s["title"] for s in data.get("stages", [])}
    out: dict[str, dict] = {}
    for node in data.get("nodes", []):
        cid = node.get("courseId")
        if cid:
            out[cid] = {
                "stage": node.get("stage"),
                "stage_title": titles.get(node.get("stage"), "?"),
                "difficulty": node.get("difficulty"),
                "node": node.get("id"),
            }
    return out, titles


def load_requirements() -> dict[str, str]:
    """courseId → 生成时的需求原文（截断预览）。取自生成任务落盘，不是我们复述的。"""
    out: dict[str, str] = {}
    for path in sorted(JOBS.glob("*.json")):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue  # 目录里有写了一半的 .tmp 残留
        cid = (job.get("result") or {}).get("classroomId")
        req = (job.get("inputSummary") or {}).get("requirementPreview")
        if cid and req and cid not in out:
            out[cid] = req
    return out


# ── 供给侧一：标签供给 ────────────────────────────────────────────────────


def load_chunks() -> list[dict]:
    rows = []
    for line in INDEX.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        tags = row.get("concept_tags")
        if isinstance(tags, str):  # 索引里这个字段有时是 Python 字面量串
            try:
                tags = ast.literal_eval(tags)
            except (ValueError, SyntaxError):
                tags = []
        row["concept_tags"] = [str(t) for t in (tags or [])]
        rows.append(row)
    return rows


def tag_supply(chunks: list[dict]) -> dict[str, dict]:
    """concept_tag → 该标签下有多少块、多少字。这是「这个题目语料厚不厚」的静态口径。"""
    out: dict[str, dict] = {}
    for row in chunks:
        for tag in row["concept_tags"]:
            slot = out.setdefault(tag, {"chunks": 0, "chars": 0})
            slot["chunks"] += 1
            slot["chars"] += len(row.get("content") or "")
    return out


def main_concept(cited: list[str], tags_of: dict[str, list[str]]) -> tuple[str | None, dict]:
    """按 chunk 计票取主概念，并列按名字定序——判据与 derive_scene_concepts.py 一致。"""
    votes: Counter[str] = Counter()
    for sid in cited:
        for tag in tags_of.get(sid, []):
            votes[tag] += 1
    if not votes:
        return None, {}
    ranked = sorted(votes.items(), key=lambda kv: (-kv[1], kv[0]))
    return ranked[0][0], dict(ranked)


# ── 供给侧二：把生产检索重放一遍 ──────────────────────────────────────────


def retrieval_supply(queries: dict[str, list[str]]) -> dict[str, dict]:
    """courseId → 每条查询能过生产充分性门的块数（TF-IDF 后端）。

    门禁与 `TfidfKnowledgeRetriever.search` 完全一致：**只用原始查询**算余弦
    （不掺概念标签，理由见 retriever.py:78-83），过 MIN_SCORE，且正文长度过
    MIN_CHUNK_CHARS。差别只在这里不截 top_k——要量的是「供给有多少」，
    不是「一次给了几块」。
    """
    import numpy as np
    from scipy.sparse import hstack
    from sklearn.metrics.pairwise import cosine_similarity

    from backend.rag.retriever import (
        MIN_CHUNK_CHARS,
        MIN_SCORE,
        TfidfKnowledgeRetriever,
        _strip_heading_marks,
        load_index,
    )

    retriever = TfidfKnowledgeRetriever(load_index())
    long_enough = np.array(
        [len(_strip_heading_marks(c.content)) >= MIN_CHUNK_CHARS for c in retriever.chunks]
    )

    flat = [(cid, q) for cid, qs in queries.items() for q in qs]
    texts = [q for _, q in flat]
    matrix = hstack(
        [retriever.word_vec.transform(texts), retriever.char_vec.transform(texts)]
    ).tocsr()
    sims = cosine_similarity(matrix, retriever.matrix)
    eligible = ((sims >= MIN_SCORE) & long_enough).sum(axis=1)
    top1 = sims.max(axis=1)

    out: dict[str, dict] = {}
    for (cid, _), n_ok, best in zip(flat, eligible, top1):
        slot = out.setdefault(cid, {"per_query": [], "top1": []})
        slot["per_query"].append(int(n_ok))
        slot["top1"].append(round(float(best), 4))
    for slot in out.values():
        qs = slot["per_query"]
        slot["queries"] = len(qs)
        slot["mean_eligible"] = round(sum(qs) / max(len(qs), 1), 1)
        slot["min_eligible"] = min(qs)
        slot["starved_queries"] = sum(1 for q in qs if q < 2)  # MIN_CHUNKS=2：判为「无可用接地」
        slot["mean_top1"] = round(sum(slot["top1"]) / max(len(slot["top1"]), 1), 4)
    return out


# ── 相关：小样本，只看方向 ────────────────────────────────────────────────


def spearman(xs: list[float], ys: list[float], iters: int = 10000, seed: int = 0):
    """返回 (rho, 排列检验双侧 p, n)。n<5 直接返回 None——那个量级算了也没意义。"""
    from scipy.stats import spearmanr

    n = len(xs)
    if n < 5:
        return None, None, n
    rho = float(spearmanr(xs, ys).statistic)
    rng = random.Random(seed)
    shuffled = list(ys)
    hits = 0
    for _ in range(iters):
        rng.shuffle(shuffled)
        if abs(float(spearmanr(xs, shuffled).statistic)) >= abs(rho) - 1e-12:
            hits += 1
    return round(rho, 3), round((hits + 1) / (iters + 1), 4), n


# ── 组装 ──────────────────────────────────────────────────────────────────


def build_rows(with_retrieval: bool = True) -> list[dict]:
    positions, _ = load_path_positions()
    requirements = load_requirements()
    chunks = load_chunks()
    tags_of = {r["source_id"]: r["concept_tags"] for r in chunks}
    supply = tag_supply(chunks)

    rows: list[dict] = []
    queries: dict[str, list[str]] = {}
    for path in sorted(CLASSROOMS.glob("*.json")):
        course = json.loads(path.read_text(encoding="utf-8"))
        row = measure_course(course)
        row["id"] = row["id"] or path.stem
        cid = row["id"]
        row.update(positions.get(cid, {"stage": None, "stage_title": "未进学习路径", "difficulty": None, "node": None}))
        row["requirement"] = requirements.get(cid, "")

        # 判词里的 id 有一部分在索引里查无此块（判官在未接地页上自造的占位 id）。
        # 引用数必须按索引筛过再用，否则「引用块数」这一列会被伪 id 抬高。
        cited_ids = row.pop("_cited")
        real = [i for i in cited_ids if i in tags_of]
        row["cited_chunks"] = len(real)
        row["bogus_citations"] = len(cited_ids) - len(real)
        row["bogus_ids"] = [i for i in cited_ids if i not in tags_of]

        row["cited_ids"] = real
        concept, votes = main_concept(real, tags_of)
        row["main_concept"] = concept
        row["concept_votes"] = votes
        row["supply_chunks"] = supply.get(concept, {}).get("chunks", 0) if concept else 0
        row["supply_chars"] = supply.get(concept, {}).get("chars", 0) if concept else 0

        title = row["name"]
        queries[cid] = [
            f"{title} {s.get('title') or ''}".strip() for s in course.get("scenes") or []
        ] or [title]
        rows.append(row)

    if with_retrieval:
        probe = retrieval_supply(queries)
        for row in rows:
            row["retrieval"] = probe.get(row["id"], {})
    return rows


def selftest() -> int:
    """一条可跑的检查：拿构造好的假课验每个计数口径，再验相关函数不说谎。"""
    fake = {
        "id": "T1",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "stage": {"name": "测试课"},
        "scenes": [
            {
                "title": "第一节",
                "content": {
                    "type": "slide",
                    "canvas": {
                        "elements": [
                            {"content": "<p>你好世界</p>"},  # 4 汉字
                            {"content": "<p style='font-family:monospace'>代码不算字</p>"},
                            {
                                "content": (
                                    "<p>📖 一二三四五\n—— 摘自《测试教材》[ab01s01#s1]</p>"
                                )
                            },  # 摘录块：📖 后 5 字 + 尾注「摘自测试教材」6 字 = 11
                            # 截断痕正例：真课里命中 0 处时，靠这一条证明探测器不是瞎的
                            {"content": "<p>…（其余 3 条见讲稿）</p>"},
                        ]
                    },
                },
                "actions": [{"text": "口播三个字"}],  # 5 汉字
                "audit": {"claims": [{"sourceIds": ["ab01s01#s1", "ab01s02#s3"]}]},
            },
            {
                "title": "小测",
                "content": {
                    "type": "quiz",
                    "questions": [
                        {
                            "question": "问题一",
                            "analysis": "解析二",
                            "options": [{"label": "甲"}, {"label": "乙"}],
                        }
                    ],
                },
            },
        ],
    }
    m = measure_course(fake)
    assert m["scenes"] == 2, m["scenes"]
    assert m["forms"] == {"slide": 1, "quiz": 1}, m["forms"]
    assert m["quiz_questions"] == 1
    assert m["text_elements"] == 4, m["text_elements"]
    # 画布：4（你好世界）+ 11（摘录块内汉字）+ 6（截断痕「其余条见讲稿」）= 21；等宽段落被剔掉
    assert m["canvas_cjk"] == 21, m["canvas_cjk"]
    assert m["excerpt_blocks"] == 1 and m["excerpt_cjk"] == 11, (m["excerpt_blocks"], m["excerpt_cjk"])
    # 截断痕探测器正例：真课里数出 0 处时，这一条保证 0 是真的 0
    assert m["truncated_slots"] == 1, m["truncated_slots"]
    # 题目：问题一3 + 解析二3 + 甲1 + 乙1 = 8
    assert m["quiz_cjk"] == 8, m["quiz_cjk"]
    assert m["speech_cjk"] == 5, m["speech_cjk"]
    assert m["body_cjk"] == 29 and m["body_per_scene"] == 14.5, (m["body_cjk"], m["body_per_scene"])
    assert m["own_cjk"] == 18 and m["own_per_scene"] == 9.0, (m["own_cjk"], m["own_per_scene"])
    # 引用 chunk：判词里 2 个 + 摘录尾注行内 1 个（与判词重合）→ 去重后 2 个
    assert m["cited_raw"] == 2, m["cited_raw"]
    # audit 里没写 grounded → 记未接地；这两页都没写，所以接地 0 页
    assert m["grounded_scenes"] == 0 and m["ungrounded_scenes"] == 2, m["grounded_scenes"]

    empty = measure_course({"id": "T0", "stage": {"name": "空课"}, "scenes": []})
    assert empty["scenes"] == 0 and empty["body_per_scene"] == 0.0
    assert empty["truncated_slots"] == 0 and empty["own_per_scene"] == 0.0

    concept, votes = main_concept(
        ["c1", "c2", "c3"], {"c1": ["rag"], "c2": ["rag", "agent_basics"], "c3": ["agent_basics"]}
    )
    # rag 与 agent_basics 各 2 票，并列按名字定序 → agent_basics
    assert concept == "agent_basics" and votes == {"agent_basics": 2, "rag": 2}, (concept, votes)
    assert main_concept([], {}) == (None, {})

    rho, p, n = spearman([1, 2, 3, 4, 5, 6], [2, 4, 6, 8, 10, 12], iters=2000)
    assert rho == 1.0 and n == 6 and p < 0.01, (rho, p, n)
    rho_neg, _, _ = spearman([1, 2, 3, 4, 5, 6], [6, 5, 4, 3, 2, 1], iters=200)
    assert rho_neg == -1.0, rho_neg
    assert spearman([1, 2], [1, 2])[0] is None

    # 探测器自证：真索引里必须有块，且真课目录里必须有课。产出为 0 先怀疑探测器。
    chunks = load_chunks()
    assert len(chunks) > 100, f"知识索引只读到 {len(chunks)} 块，先查 {INDEX}"
    assert all(isinstance(r["concept_tags"], list) for r in chunks)
    courses = list(CLASSROOMS.glob("*.json"))
    assert len(courses) >= 20, f"课程目录只读到 {len(courses)} 门，先查 {CLASSROOMS}"
    positions, titles = load_path_positions()
    assert len(positions) >= 15 and "direction" in titles, (len(positions), titles)
    reqs = load_requirements()
    assert len(reqs) >= 20, f"只解析出 {len(reqs)} 条需求原文，先查 {JOBS}"

    print("selftest 通过：口径 17 项 + 相关函数 3 项 + 探测器自证 5 项")
    return 0


STAGE_ORDER = {"foundation": 0, "core": 1, "direction": 2, "practice": 3, None: 9}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path, help="逐课明细落盘路径")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--no-retrieval", action="store_true", help="跳过 TF-IDF 重放（快，但少一列供给）")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    rows = build_rows(with_retrieval=not args.no_retrieval)
    rows.sort(key=lambda r: (STAGE_ORDER[r["stage"]], r["difficulty"] or 9, -r["body_cjk"]))

    def sup(r: dict) -> float:
        """一门课的检索供给：每条生产查询平均有多少块过门。没跑重放时退回标签供给。"""
        return (r.get("retrieval") or {}).get("mean_eligible", float("nan"))

    print(f"{'课程':<26}{'段':<6}{'难':>3}{'页':>4}{'接地页':>6}{'正文字':>7}{'页均':>6}{'自有页均':>7}"
          f"{'摘录%':>7}{'引用块':>6}{'伪引用':>6}{'题':>4}{'标签供给':>7}{'检索供给':>8}{'截断':>5}")
    print("-" * 118)
    for r in rows:
        print(f"{r['name'][:24]:<26}{(r['stage'] or '—'):<6}{str(r['difficulty'] or '—'):>3}"
              f"{r['scenes']:>4}{r['grounded_scenes']:>6}{r['body_cjk']:>7}{r['body_per_scene']:>6.0f}"
              f"{r['own_per_scene']:>7.0f}{100 * r['excerpt_share']:>7.1f}{r['cited_chunks']:>6}"
              f"{r['bogus_citations']:>6}{r['quiz_questions']:>4}"
              f"{r['supply_chunks']:>7}{sup(r):>8}{r['truncated_slots']:>5}")

    scenes_all = sum(r["scenes"] for r in rows)
    grounded_all = sum(r["grounded_scenes"] for r in rows)
    cited_all = sum(r["cited_chunks"] for r in rows)
    bogus_all = sum(r["bogus_citations"] for r in rows)
    print(f"\n合计 {len(rows)} 门课，正文 {sum(r['body_cjk'] for r in rows)} 汉字，场景 {scenes_all} 个")
    print(f"  生产记下的接地页：{grounded_all}/{scenes_all} = {100 * grounded_all / scenes_all:.1f}%"
          f"（判据 scene.audit.grounded）")
    print(f"  判词引用的 id：库里真有 {cited_all} 个，查无此块 {bogus_all} 个 = "
          f"{100 * bogus_all / max(cited_all + bogus_all, 1):.1f}%，"
          f"涉及 {sum(1 for r in rows if r['bogus_citations'])} 门课")
    print(f"  版式截断痕：{sum(r['truncated_slots'] for r in rows)} 处"
          f"（判据 slide-templates.ts:165/:391；探测器正例对照见 --selftest）")

    # 语料利用率：全库有多少块从来没被任何一门课引用过。
    # 「语料够不够」和「语料有没有被取到」是两件事，这一段分的就是这两件事。
    chunks = load_chunks()
    used = {i for r in rows for i in r["cited_ids"]}
    chars = {c["source_id"]: len(c.get("content") or "") for c in chunks}
    print(f"\n语料利用率：全库 {len(chunks)} 块 / {sum(chars.values())} 字，"
          f"被这 23 门课引用过的去重 {len(used)} 块 = {100 * len(used) / len(chunks):.1f}%"
          f"（字数口径 {100 * sum(chars[i] for i in used) / sum(chars.values()):.1f}%）")
    by_book: Counter[str] = Counter(c["source_id"][:2] for c in chunks)
    hit_book: Counter[str] = Counter(i[:2] for i in used)
    print("  按 source_id 前缀（一本书一个前缀）：" + "，".join(
        f"{k} {hit_book.get(k, 0)}/{v}" for k, v in sorted(by_book.items())))

    print("\n离散度（哪一列是常量，哪一列在变）")
    for label, key in [("每场景自有讲解字数", "own_per_scene"), ("每场景正文字数", "body_per_scene"),
                       ("场景数", "scenes"), ("正文总字数", "body_cjk")]:
        v = [float(r[key]) for r in rows]
        mean = sum(v) / len(v)
        sd = (sum((x - mean) ** 2 for x in v) / len(v)) ** 0.5
        print(f"  {label:<12} 均值 {mean:>8.1f}  标准差 {sd:>7.1f}  变异系数 {sd / mean:>5.3f}  "
              f"区间 [{min(v):.0f}, {max(v):.0f}]")

    by_stage: dict[str, list[dict]] = {}
    for r in rows:
        by_stage.setdefault(r["stage"] or "未进路径", []).append(r)
    print("\n按学习路径分段（分类出处：apps/classroom/data/learning-path.json 的 stages/nodes）")
    for stage in sorted(by_stage, key=lambda s: STAGE_ORDER.get(s, 9)):
        g = by_stage[stage]
        n = len(g)
        rets = [sup(r) for r in g if r.get("retrieval")]
        print(f"  {stage:<12}{n:>2} 门  "
              f"正文均 {sum(r['body_cjk'] for r in g) / n:>7.0f} 字  "
              f"自有页均 {sum(r['own_cjk'] for r in g) / sum(r['scenes'] for r in g):>5.0f} 字  "
              f"场景均 {sum(r['scenes'] for r in g) / n:>4.1f}  "
              f"标签供给均 {sum(r['supply_chunks'] for r in g) / n:>6.0f} 块  "
              f"检索供给均 {(sum(rets) / len(rets) if rets else float('nan')):>6.1f} 块  "
              f"接地率 {100 * sum(r['grounded_scenes'] for r in g) / sum(r['scenes'] for r in g):>5.1f}%")

    print("\n相关（Spearman + 10000 次排列检验；n 这个量级只看方向，不作显著性结论）")
    inpath = [r for r in rows if r["difficulty"]]
    have = [r for r in rows if r.get("retrieval")]
    pairs = [
        ("路径难度 vs 正文字数", [r["difficulty"] for r in inpath], [r["body_cjk"] for r in inpath]),
        ("路径难度 vs 页均字数", [r["difficulty"] for r in inpath], [r["body_per_scene"] for r in inpath]),
        ("路径难度 vs 自有页均", [r["difficulty"] for r in inpath], [r["own_per_scene"] for r in inpath]),
        ("路径难度 vs 场景数", [r["difficulty"] for r in inpath], [r["scenes"] for r in inpath]),
        ("标签供给 vs 正文字数", [r["supply_chunks"] for r in rows], [r["body_cjk"] for r in rows]),
        ("引用块数 vs 正文字数", [r["cited_chunks"] for r in rows], [r["body_cjk"] for r in rows]),
        ("场景数 vs 正文字数", [r["scenes"] for r in rows], [r["body_cjk"] for r in rows]),
        ("摘录占比 vs 页均字数", [r["excerpt_share"] for r in rows], [r["body_per_scene"] for r in rows]),
    ]
    if have:
        pairs += [
            ("检索供给 vs 正文字数", [sup(r) for r in have], [r["body_cjk"] for r in have]),
            ("检索供给 vs 摘录占比", [sup(r) for r in have], [r["excerpt_share"] for r in have]),
            ("检索供给 vs 自有页均", [sup(r) for r in have], [r["own_per_scene"] for r in have]),
        ]
    for label, xs, ys in pairs:
        rho, p, n = spearman(xs, ys)
        print(f"  {label:<20} rho={rho:>6}  p={p:<8} n={n}")

    # 供给厚而产出薄：这一格才是模型/管线嫌疑，语料解释不了。
    # 供给轴优先用检索重放（生产查询口径），没跑重放时退回标签供给。
    axis = "检索供给" if have else "标签供给"
    key = (lambda r: sup(r)) if have else (lambda r: float(r["supply_chunks"]))
    pool = have or rows
    med_sup = sorted(key(r) for r in pool)[len(pool) // 2]
    med_own = sorted(r["own_per_scene"] for r in pool)[len(pool) // 2]
    print(f"\n四象限（中位数切分）：{axis} {med_sup}，自有页均 {med_own} 字")
    for label, cond in [
        ("供给厚 + 自有讲解薄（模型/管线嫌疑）", lambda r: key(r) >= med_sup and r["own_per_scene"] < med_own),
        ("供给薄 + 自有讲解薄（语料嫌疑）", lambda r: key(r) < med_sup and r["own_per_scene"] < med_own),
        ("供给薄 + 自有讲解厚（自撰多，需人工查真伪）", lambda r: key(r) < med_sup and r["own_per_scene"] >= med_own),
        ("供给厚 + 自有讲解厚", lambda r: key(r) >= med_sup and r["own_per_scene"] >= med_own),
    ]:
        hit = [r for r in pool if cond(r)]
        print(f"  {label}：{len(hit)} 门 " + "、".join(r["name"][:14] for r in hit))

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\n落盘 {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
