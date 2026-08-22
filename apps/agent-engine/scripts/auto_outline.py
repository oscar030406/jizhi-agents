"""自动大纲档：OutlineAgent 从知识库结构生成课程大纲（SEMESTER_OUTLINES 同构）。

工厂三档里的「自动课程态」：无人工大纲，任选知识库源前缀端到端出大纲，
产物落 data/outlines/<concept>.json，由 build_curriculum.py 消费（与人写大纲同管线）。

用法：
  $env:AGENT_GENERATION_MODE="api"; $env:LLM_TIMEOUT_SECONDS="300"
  python scripts\auto_outline.py --concept agent_tools --sources ha07 --title "工具使用与函数调用"
  python scripts\auto_outline.py --selftest   # 校验器自检（无网）

纪律（对应 PLAYBOOK 暗坑 §4.1）：薄材料课时野心必须受限——
对字符数低于阈值的源块，focus 里由脚本【确定性】追加禁令，不信任 LLM 自觉。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

OUTLINE_DIR = ROOT / "data" / "outlines"
INDEX_PATH = ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"

THIN_CHUNK_CHARS = 600      # 低于此数=薄材料，focus 强制注入禁令
LESSON_MIN_CHARS = 2000     # 45min 课时的源料下限（不足→确定性合并进相邻课时）
LESSON_MAX_CHARS = 12000    # 软上限（超出仅警告，生产管线分篇能扛）
LESSON_HARD_MAX = 16000     # 硬上限（超出打回 LLM 拆分——机械拆分会拆散叙事）

OUTLINE_SYSTEM = """你是课程大纲设计 Agent。任务：把给定的知识库源材料编排成一门 45 分钟/节的学期课大纲。

硬规则：
1. source_range 只能使用【材料清单】里列出的 source_id，逐字照抄，不得杜撰。
2. 每个 source_id 至多用于一节课；没用到的必须列进顶层 "skipped"（带一句原因）。
3. 每节课的源料字符总量在 {min_chars}-{max_chars} 之间（清单里给了每块字数）——太薄就合并相邻主题，太厚就拆节。
4. 课时顺序尊重源材料章节顺序（这是教材的前置依赖顺序），不要跳跃穿插。
5. focus 写教学焦点：这节课讲透什么、用材料里的哪个例子当重头戏、什么只点到为止。
   材料没写的内容一律不许要求展开。
6. exercise 是每课一道 Python 判题练习：纯标准库（顶多 math），函数名小写下划线，
   hint 一句话说清输入输出与边界（并列取字典序最小之类）。
7. lesson_id 格式：{concept}{{章号}}-{{两位节号}}，如 {concept}1-01。
8. 输出 JSON，结构：
{{"tagline": "一句话课程定位",
  "chapters": [{{"chapter_id": "ch1", "title": "第一章 …", "intro": "一两句",
                "lessons": [{{"lesson_id": "…", "title": "…",
                              "source_range": ["…"], "focus": "…",
                              "exercise": {{"function_name": "…", "hint": "…"}}}}]}}],
  "skipped": [{{"source_id": "…", "reason": "…"}}]}}
只输出 JSON。"""


def load_chunks(prefixes: list[str]) -> "OrderedDict[str, dict]":
    """按源前缀过滤索引块，按（前缀、节、子块序号）自然序返回。"""
    def sort_key(sid: str):
        sec, _, sub = sid.partition("#")
        m = re.search(r"(\d+)$", sub)
        return (sec, int(m.group(1)) if m else 0)

    rows = []
    with open(INDEX_PATH, encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            if any(d["source_id"].startswith(p) for p in prefixes):
                rows.append(d)
    if not rows:
        raise SystemExit(f"知识库里没有前缀为 {prefixes} 的块（索引：{INDEX_PATH}）")
    rows.sort(key=lambda d: sort_key(d["source_id"]))
    return OrderedDict((d["source_id"], d) for d in rows)


def material_digest(chunks: "OrderedDict[str, dict]") -> str:
    """给 OutlineAgent 看的材料清单：id + 标题 + 字数 + 开头摘录。"""
    lines = []
    for sid, d in chunks.items():
        head = re.sub(r"\s+", " ", d["content"])[:120]
        lines.append(f"- {sid} | {d['title']} | {len(d['content'])}字 | {head}")
    return "\n".join(lines)


def validate_outline(outline: dict, chunks: "OrderedDict[str, dict]", concept: str) -> list[str]:
    """确定性门禁：结构、id 存在性、去重、覆盖、字数预算、练习命名。"""
    problems: list[str] = []
    if not isinstance(outline.get("chapters"), list) or not outline["chapters"]:
        return ["chapters 缺失或为空"]

    seen_ids: set[str] = set()
    seen_fn: set[str] = set()
    used: set[str] = set()
    for ch in outline["chapters"]:
        for lesson in ch.get("lessons", []):
            lid = lesson.get("lesson_id", "?")
            if not re.fullmatch(rf"{re.escape(concept)}\d+-\d{{2}}", lid):
                problems.append(f"{lid}: lesson_id 不符合 {concept}{{章}}-{{两位节}} 格式")
            if lid in seen_ids:
                problems.append(f"{lid}: lesson_id 重复")
            seen_ids.add(lid)

            rng = lesson.get("source_range", [])
            if not rng:
                problems.append(f"{lid}: source_range 为空")
            total = 0
            for sid in rng:
                if sid not in chunks:
                    problems.append(f"{lid}: source_range 里的 {sid} 不在材料清单")
                    continue
                if sid in used:
                    problems.append(f"{lid}: {sid} 已被其他课时使用")
                used.add(sid)
                total += len(chunks[sid]["content"])
            # 预算问题（过薄/过重）全部由 repair_budget 确定性修复，不打回 LLM——LLM 算术不可靠

            ex = lesson.get("exercise") or {}
            fn = ex.get("function_name", "")
            if not re.fullmatch(r"[a-z][a-z0-9_]*", fn or ""):
                problems.append(f"{lid}: exercise.function_name 非法：{fn!r}")
            if fn in seen_fn:
                problems.append(f"{lid}: function_name {fn} 重复")
            seen_fn.add(fn)
            if not (lesson.get("focus") or "").strip():
                problems.append(f"{lid}: focus 为空")

    skipped = {s.get("source_id") for s in outline.get("skipped", [])}
    missing = set(chunks) - used - skipped
    if missing:
        problems.append(f"未覆盖且未声明 skipped 的块：{sorted(missing)[:8]}{'…' if len(missing) > 8 else ''}")
    return problems


def repair_budget(outline: dict, chunks: "OrderedDict[str, dict]", concept: str) -> list[str]:
    """确定性预算修复：薄课时（<LESSON_MIN_CHARS）合并进同章相邻课时；
    章内合并完仍薄的独节章并入相邻章边缘课时；完了统一重排 lesson_id。
    LLM 算术不可靠，预算问题一律机械修复，不烧重试轮次。返回修复日志。"""
    log: list[str] = []

    def total(lesson: dict) -> int:
        return sum(len(chunks[sid]["content"]) for sid in lesson.get("source_range", []) if sid in chunks)

    def merge(src: dict, dst: dict, src_first: bool) -> None:
        dst["source_range"] = (src["source_range"] + dst["source_range"]) if src_first \
            else (dst["source_range"] + src["source_range"])
        dst["title"] = f"{src['title']} 与 {dst['title']}" if src_first else f"{dst['title']} 与 {src['title']}"
        dst["focus"] = (src.get("focus", "") + " " + dst.get("focus", "")).strip() if src_first \
            else (dst.get("focus", "") + " " + src.get("focus", "")).strip()
        log.append(f"合并薄课时 {src.get('lesson_id')}（{total(src)} 字）→ {dst.get('lesson_id')}")

    # 1) 章内合并
    for ch in outline["chapters"]:
        lessons = ch.get("lessons", [])
        i = 0
        while i < len(lessons):
            if total(lessons[i]) >= LESSON_MIN_CHARS or len(lessons) <= 1:
                i += 1
                continue
            if i + 1 < len(lessons):
                merge(lessons[i], lessons[i + 1], src_first=True)
            else:
                merge(lessons[i], lessons[i - 1], src_first=False)
            lessons.pop(i)
    # 1.5) 硬超重课时按块边界均衡拆分（只有首段保留练习；焦点标注分段）
    for ch in outline["chapters"]:
        new_lessons = []
        for lesson in ch.get("lessons", []):
            t = total(lesson)
            if t <= LESSON_HARD_MAX:
                new_lessons.append(lesson)
                continue
            k = -(-t // LESSON_MAX_CHARS)  # ceil
            target = t / k
            parts: list[list[str]] = [[]]
            acc = 0
            for sid in lesson["source_range"]:
                if acc >= target and len(parts) < k:
                    parts.append([])
                    acc = 0
                parts[-1].append(sid)
                acc += len(chunks[sid]["content"]) if sid in chunks else 0
            marks = "一二三四五六七八九"
            for pi, part in enumerate(parts):
                seg = dict(lesson) if pi == 0 else {
                    k2: v for k2, v in lesson.items() if k2 != "exercise"}
                seg = json.loads(json.dumps(seg))
                seg["source_range"] = part
                seg["title"] = f"{lesson['title']}（{marks[pi]}）"
                seg["focus"] = lesson.get("focus", "") + f" 本节为拆分第{marks[pi]}部分，只讲所含资料，衔接处一句话呼应前后。"
                new_lessons.append(seg)
            log.append(f"拆分超重课时 {lesson.get('lesson_id')}（{t} 字）→ {len(parts)} 节")
        ch["lessons"] = new_lessons
    # 2) 独节薄章并入相邻章
    chs = outline["chapters"]
    i = 0
    while i < len(chs):
        lessons = chs[i].get("lessons", [])
        if len(lessons) == 1 and total(lessons[0]) < LESSON_MIN_CHARS and len(chs) > 1:
            if i + 1 < len(chs):
                merge(lessons[0], chs[i + 1]["lessons"][0], src_first=True)
            else:
                merge(lessons[0], chs[i - 1]["lessons"][-1], src_first=False)
            chs.pop(i)
        else:
            i += 1
    # 3) 重排 id
    for ci, ch in enumerate(chs, start=1):
        ch["chapter_id"] = f"ch{ci}"
        for li, lesson in enumerate(ch.get("lessons", []), start=1):
            lesson["lesson_id"] = f"{concept}{ci}-{li:02d}"
    # 4) 软上限警告
    for ch in chs:
        for lesson in ch.get("lessons", []):
            t = total(lesson)
            if t > LESSON_MAX_CHARS:
                log.append(f"⚠ {lesson['lesson_id']} 源料 {t} 字超软上限（分篇生成能扛，注意课时深度）")
    return log


def inject_thin_guardrails(outline: dict, chunks: "OrderedDict[str, dict]") -> None:
    """薄材料禁令：确定性追加进 focus，不信任 LLM 自觉（PLAYBOOK 暗坑 §4.1）。"""
    for ch in outline["chapters"]:
        for lesson in ch.get("lessons", []):
            thin = [chunks[sid]["title"] for sid in lesson.get("source_range", [])
                    if sid in chunks and len(chunks[sid]["content"]) < THIN_CHUNK_CHARS]
            if thin:
                names = "、".join(f"『{t}』" for t in dict.fromkeys(thin))
                lesson["focus"] = (lesson.get("focus", "").rstrip("。") + "。"
                                   + f"注意：{names} 资料较薄——严格按资料表述，"
                                     "不展开资料未写的机制细节，不编造手算示例，"
                                     "必要处注明『后续课程详解』。")


def build_outline(concept: str, sources: list[str], title: str, theory_exam_n: int) -> dict:
    from scripts.build_curriculum import TEXTBOOK_REGISTRY, _build_gateway  # noqa: E402

    chunks = load_chunks(sources)
    gateway = _build_gateway()
    if not gateway.is_enabled("ResourceGenerationAgent"):
        raise SystemExit('LLM 路由未启用：$env:AGENT_GENERATION_MODE="api"')

    system = OUTLINE_SYSTEM.format(
        min_chars=LESSON_MIN_CHARS, max_chars=LESSON_MAX_CHARS, concept=concept)
    user = f"课程主题：{title}\n\n【材料清单】（已按教材章节顺序排列）\n{material_digest(chunks)}"

    outline: dict | None = None
    problems: list[str] = []
    for _ in range(5):  # 门禁打回重试至多四轮（46 块级大纲实测 3 轮不够收敛）
        outline = gateway.structured_chat(
            "ResourceGenerationAgent", system, user, max_tokens=6000, temperature=0.0)
        if outline is None:
            raise SystemExit("OutlineAgent 生成失败（返回空）")
        problems = validate_outline(outline, chunks, concept)
        if not problems:
            break
        user += "\n\n上一稿未过大纲门禁：" + "；".join(problems[:12]) + "\n请修正后重新输出完整 JSON。"
        print("[outline] 门禁打回：", problems[:6])
    if problems:
        raise SystemExit(f"多稿均未过大纲门禁：{problems}")

    for line in repair_budget(outline, chunks, concept):
        print("[repair]", line)
    inject_thin_guardrails(outline, chunks)
    ingested = [t["title"] for t in TEXTBOOK_REGISTRY if t["ingested"]]
    return {
        "title": title,
        "tagline": outline.get("tagline", title),
        "textbooks": ingested,
        "theory_exam_n": theory_exam_n,
        "chapters": outline["chapters"],
        "_provenance": {
            "generated_by": "auto_outline.py/OutlineAgent",
            "model": os.environ.get("CURRICULUM_GENERATOR_MODEL", "Qwen/Qwen3-30B-A3B-Instruct-2507"),
            "sources": sources,
            "skipped": outline.get("skipped", []),
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }


def selftest() -> None:
    """校验器自检：不联网。"""
    chunks = OrderedDict(
        (f"xx01s01#s{i}", {"source_id": f"xx01s01#s{i}", "title": f"节{i}", "content": "字" * n})
        for i, n in enumerate([3000, 400, 3000], start=1))
    good = {"tagline": "t", "chapters": [{"chapter_id": "ch1", "title": "一", "lessons": [
        {"lesson_id": "demo1-01", "title": "a", "source_range": ["xx01s01#s1", "xx01s01#s2"],
         "focus": "讲透", "exercise": {"function_name": "f_one", "hint": "h"}},
        {"lesson_id": "demo1-02", "title": "b", "source_range": ["xx01s01#s3"],
         "focus": "讲透", "exercise": {"function_name": "f_two", "hint": "h"}}]}],
        "skipped": []}
    assert validate_outline(good, chunks, "demo") == [], validate_outline(good, chunks, "demo")

    bad = json.loads(json.dumps(good))
    bad["chapters"][0]["lessons"][1]["source_range"] = ["xx01s01#s1", "nope#s1"]
    probs = validate_outline(bad, chunks, "demo")
    assert any("已被其他课时使用" in p for p in probs), probs
    assert any("不在材料清单" in p for p in probs), probs
    assert any("未覆盖" in p for p in probs), probs

    inject_thin_guardrails(good, chunks)
    assert "资料较薄" in good["chapters"][0]["lessons"][0]["focus"]
    assert "资料较薄" not in good["chapters"][0]["lessons"][1]["focus"]

    # 预算修复：薄课时前向合并 + id 重排
    thin = {"tagline": "t", "chapters": [{"chapter_id": "ch1", "title": "一", "lessons": [
        {"lesson_id": "demo1-01", "title": "a", "source_range": ["xx01s01#s2"],  # 400 字
         "focus": "f1", "exercise": {"function_name": "f_one", "hint": "h"}},
        {"lesson_id": "demo1-02", "title": "b", "source_range": ["xx01s01#s1", "xx01s01#s3"],
         "focus": "f2", "exercise": {"function_name": "f_two", "hint": "h"}}]}],
        "skipped": []}
    log = repair_budget(thin, chunks, "demo")
    lessons = thin["chapters"][0]["lessons"]
    assert len(lessons) == 1 and lessons[0]["lesson_id"] == "demo1-01", lessons
    assert lessons[0]["source_range"] == ["xx01s01#s2", "xx01s01#s1", "xx01s01#s3"]
    assert "a 与 b" == lessons[0]["title"] and any("合并" in x for x in log), (lessons, log)

    # 硬超重拆分：首段保留练习，后段无练习，id 重排
    big = OrderedDict(
        (f"yy01s01#s{i}", {"source_id": f"yy01s01#s{i}", "title": f"节{i}", "content": "字" * 6000})
        for i in range(1, 4))  # 共 18000 字 > HARD_MAX
    fat = {"tagline": "t", "chapters": [{"chapter_id": "ch1", "title": "一", "lessons": [
        {"lesson_id": "demo1-01", "title": "大", "source_range": list(big),
         "focus": "f", "exercise": {"function_name": "f_one", "hint": "h"}}]}], "skipped": []}
    log = repair_budget(fat, big, "demo")
    lessons = fat["chapters"][0]["lessons"]
    assert len(lessons) == 2 and any("拆分" in x for x in log), (lessons, log)
    assert lessons[0].get("exercise") and not lessons[1].get("exercise")
    assert [ls["lesson_id"] for ls in lessons] == ["demo1-01", "demo1-02"]
    assert sum(len(ls["source_range"]) for ls in lessons) == 3
    print("selftest OK")


def main() -> None:
    parser = argparse.ArgumentParser(description="自动大纲档：知识库源前缀 → 学期课大纲 JSON")
    parser.add_argument("--concept", help="大纲 concept id（同时作 lesson_id 前缀）")
    parser.add_argument("--sources", help="源块前缀，逗号分隔，如 ha07 或 ha07,ha08")
    parser.add_argument("--title", help="课程主题一句话")
    parser.add_argument("--theory-exam-n", type=int, default=10)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()

    if args.selftest:
        selftest()
        return
    if not (args.concept and args.sources and args.title):
        parser.error("--concept/--sources/--title 均为必填（或使用 --selftest）")

    # 防呆：concept id 必须是概念图里的 key——catalog 用它找课程文件，
    # 名字对不上会让课程产出来却显示"生产队列中"（2026-07-24 踩过）。
    graph_path = ROOT / "data" / "knowledge_base" / "concept_graph.json"
    if graph_path.is_file():
        known = [k for k in json.loads(graph_path.read_text(encoding="utf-8")) if not k.startswith("_")]
        if args.concept not in known:
            parser.error(
                f"concept id 「{args.concept}」不在概念图里，课程会被 catalog 判为不可用。"
                f"\n可用 id：{'、'.join(known)}"
                f"\n（要开新概念，先往 data/knowledge_base/concept_graph.json 加一条）"
            )

    outline = build_outline(args.concept, args.sources.split(","), args.title, args.theory_exam_n)
    OUTLINE_DIR.mkdir(parents=True, exist_ok=True)
    out = OUTLINE_DIR / f"{args.concept}.json"
    out.write_text(json.dumps(outline, ensure_ascii=False, indent=2), encoding="utf-8")
    n_lessons = sum(len(c["lessons"]) for c in outline["chapters"])
    print(f"✅ {out}  章 {len(outline['chapters'])} · 节 {n_lessons} · "
          f"skipped {len(outline['_provenance']['skipped'])}")
    print(f"下一步：python scripts\\build_curriculum.py --concept {args.concept}")


if __name__ == "__main__":
    main()
