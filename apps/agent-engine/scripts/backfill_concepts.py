"""给已建成的库离线补 ④ 的词表与前置图。

用法（在 apps/agent-engine 下、引擎同一个 venv + .env）：

    python scripts/backfill_concepts.py <corpus> <run_id>

为什么会有这条离线路：接入表单一直没暴露 extract_concepts 开关（2026-08-24 才补），
smart-manufacturing 与 iotdb 两次重投都因此没抽词表——就绪度的词表、前置图两道闸 ✗。
重投一次代价是整跑九站外加试跑体检的钱，而 ④ 缺的只是词表和图。

口径纪律：不另立一套抽取逻辑，sections 用 ①② 的同链函数从 run 的 docs 目录重放，
重放结果必须与库里的活块**数量一致**才继续（对不上说明口径漂了，宁可中止）；
抽取本体直接调 `domain_intake._extract_concepts`（会顺带回填 concept_tags 并刷新检索缓存），
落盘只 patch readiness.json 的相关键，其余原样。
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.services.domain_intake import KB, _extract_concepts, now_iso  # noqa: E402
from backend.rag.ingest import read_index_rows  # noqa: E402
from backend.rag.intake import (  # noqa: E402
    apply_exclusions,
    outline_sections,
    read_body,
    remembered_exclusions,
    triage,
)


class OfflineRun:
    """_extract_concepts 只碰 run 的这几个面：corpus / ctx / record / emit。"""

    def __init__(self, corpus: str, sections: list, tier_range: str, max_sections: int):
        self.corpus = corpus
        self.ctx = {"sections": sections}
        self.record = {"options": {"tier_range": tier_range, "max_sections": max_sections}}

    def emit(self, station: str, level: str, message: str, **data) -> None:
        print(f"[{station}/{level}] {message}")


def rebuild_sections(corpus: str, docs: Path, readiness: dict) -> list:
    excluded = remembered_exclusions(readiness)
    manifest = triage(docs)
    manifest.accepted, scoped = apply_exclusions(manifest.accepted, excluded)
    print(f"triage 收 {len(manifest.accepted)}，按声明剔除 {len(scoped)}（{len(excluded)} 条前缀）")

    seen: set[str] = set()
    kept = []
    for f in manifest.accepted:
        digest = hashlib.sha256(f.path.read_bytes()).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        kept.append(f)

    sections = []
    for f in kept:
        body = read_body(f.path)
        for meta in outline_sections(body, path_depth=f.path_depth):
            label = " / ".join(meta.heading_path) or f.relative
            sections.append((f"{f.relative}#{meta.order} {label}", meta.text, meta.heading_path))
    return sections


def main() -> int:
    corpus, run_id = sys.argv[1], sys.argv[2]
    docs = KB / "intake_runs" / run_id / "docs"
    readiness_path = KB / f"{corpus}_intake" / "readiness.json"
    readiness = json.loads(readiness_path.read_text(encoding="utf-8"))

    sections = rebuild_sections(corpus, docs, readiness)
    live = read_index_rows(KB / "corpora" / corpus / "knowledge_index.jsonl")
    if len(sections) != len(live):
        print(f"中止：重放出 {len(sections)} 节 ≠ 库中活块 {len(live)}，口径对不上，不写任何东西")
        return 1
    print(f"重放 {len(sections)} 节，与活块数一致")

    tier_range = str(readiness.get("corpus_index", {}).get("tier_range") or "L1-L3")
    # 第三个位置参数：抽取采样上限。默认沿引擎的 120；第一轮补站在两个新库上
    # 实测 120 采样太稀（1703 节采 120，同一概念的 support 被稀释到过不了支撑闸，
    # 候选 210 → 剩 1），加密采样是 run 参数不是判据——支撑闸本身一个字不动。
    max_sections = int(sys.argv[3]) if len(sys.argv) > 3 else 120
    run = OfflineRun(corpus, sections, tier_range, max_sections)
    vocab, graph, note = _extract_concepts(run)
    # 词表闸三态的边界（personalize_service._vocabulary_verdict）：note 里带「未抽取」
    # 判 skipped 不拦库，写「抽到 N 个」判 failed 直接把库挡出学习端。补站在
    # smart-manufacturing 上实锤过一次：抽出 1 个概念落了盘，note 被覆盖成
    # 「只抽到 1 个」，一个三指标全过、体检 passed 的库当场从学习者下拉消失。
    # 所以不足以成表（<2）就一个字节都不写——半成品词表没有任何消费方。
    if len(vocab) < 2:
        print(f"词表不足以成表（{note}），readiness 不动、不留半成品")
        return 1

    readiness["concepts"] = vocab
    readiness["vocabulary_note"] = f"{note}（{now_iso()} 由 backfill_concepts.py 离线补站，语料取自 run {run_id}）"
    readiness["prereq_graph"] = graph
    readiness["readiness"]["gate1_vocabulary"] = len(vocab) >= 2
    readiness["readiness"]["gate2_graph_connected"] = bool(graph.get("clauses"))
    readiness_path.write_text(json.dumps(readiness, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"readiness 已更新：{len(vocab)} 个概念、{len(graph.get('clauses', {}))} 组前置从句")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
