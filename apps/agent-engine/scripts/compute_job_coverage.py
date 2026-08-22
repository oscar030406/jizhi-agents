"""岗位技能覆盖率——覆盖率换分母的「真算」实现（PLAYBOOK 第一档 #6）。

口径（写死，引用该数字必须带口径）：
  分母 = data/jobs/job_skill_map.json 全部岗位的技能条目（逐条，不去重——
         同一技能出现在两个岗位算两条需求）；
  分子 = 引擎证据检索（本地向量索引，corpus=ai，top_k=3）能召回材料
         且未触发 missing_evidence_warning 的条目数。
  这测的是「知识库能为该技能供给教学证据」，不是「课程已讲授该技能」——
  后者没有机械可复算的判定，禁止假装。

无关查询对照已验证分辨力（烘焙/拖拉机 → 0 命中+告警）。
用法：先起 8001（api/deterministic 均可，检索不走 LLM），然后
  python scripts/compute_job_coverage.py
产出 data/jobs/job_skill_coverage.json；数字进 data/metrics.json 由人工核对后更新。
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8001"
TOKEN = "demo-internal-token"


def probe(query: str) -> tuple[int, bool]:
    qs = urllib.parse.urlencode({"query": query, "top_k": "3", "corpus": "ai"})
    req = urllib.request.Request(
        f"{BASE}/internal/v1/personalize/evidence?{qs}",
        headers={"x-internal-token": TOKEN},
    )
    payload = json.load(urllib.request.urlopen(req, timeout=30))
    data = payload.get("data") or {}
    chunks = data.get("chunks") or []
    warned = bool(data.get("missing_evidence_warning"))
    return len(chunks), warned


def main() -> None:
    skill_map = json.load(open(ROOT / "data/jobs/job_skill_map.json", encoding="utf-8"))
    per_job: list[dict] = []
    total = covered = 0
    for job in skill_map["jobs"]:
        rows = []
        for skill in job["skills"]:
            hits, warned = probe(skill)
            ok = hits > 0 and not warned
            rows.append({"skill": skill, "hits": hits, "warned": warned, "covered": ok})
            total += 1
            covered += ok
        job_cov = sum(r["covered"] for r in rows)
        per_job.append(
            {
                "job_id": job["job_id"],
                "title": job["title"],
                "skills_total": len(rows),
                "skills_covered": job_cov,
                "coverage": round(job_cov / len(rows), 4) if rows else None,
                "uncovered": [r["skill"] for r in rows if not r["covered"]],
            }
        )
        print(f"{job['job_id']:28s} {job_cov}/{len(rows)}")

    out = {
        "caliber": (
            "分母=job_skill_map 全岗位技能条目（不去重）；分子=引擎证据检索"
            "（corpus=ai, top_k=3）有命中且无 missing_evidence_warning。"
            "测的是知识库证据供给能力，不是课程已讲授。无关查询对照已验证分辨力。"
        ),
        "computed_at": str(date.today()),
        "source": "python scripts/compute_job_coverage.py（需 8001 引擎在跑）",
        "total_skills": total,
        "covered_skills": covered,
        "coverage": round(covered / total, 4) if total else None,
        "per_job": per_job,
    }
    dest = ROOT / "data/jobs/job_skill_coverage.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n总覆盖率 {covered}/{total} = {covered / total:.1%}")
    print(f"明细 → {dest}")


if __name__ == "__main__":
    main()
