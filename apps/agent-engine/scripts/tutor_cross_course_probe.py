"""跨课导学验收：拿几门风格差异极大的课各取一节，打运行中的引擎 /tutor 讲义分支。

导学是相对课程的外置 agent——它只吃「这一节讲了什么」+ 画像 + 对话历史，
不读任何课程生成期预制的导学字段。所以验收标准是**跨课可用**：没见过的课扔进来
照样能出定向探问、判分、并按目标正确率带裁决降维/推进/进阶。

每门课跑 5 次调用：
  1. 空历史出题        → 期望 decision_type=probe
  2. 拿一个敷衍回答判分 → 期望 verdict=incorrect/partial，because/降维解释非空，下一步 simplify
  3. 带这条历史再出题  → 期望 decision_type=simplify，且问题与第 1 问不重复
  4. 伪造连对 3 题历史  → 期望 decision_type=challenge（进阶应用题）
  5. 口语化复述判分要点 → 期望不判 incorrect（守 08-09 调过的判分口径：只数要点命中、
     同义转述算对）。没有这一步的话，一个恒判 incorrect 的判官也能通过前四步。

用法（引擎需已在 :8001 起着（key 在 .env））：
    python scripts/tutor_cross_course_probe.py
    python scripts/tutor_cross_course_probe.py --courses _m1O5OWXON r-kOa4ogHT --scene-index 2
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLASSROOMS = ROOT.parent / "classroom" / "data" / "classrooms"
ENDPOINT = os.environ.get("TUTOR_ENDPOINT", "http://127.0.0.1:8001/internal/v1/personalize/tutor")
TOKEN = os.environ.get("AI_SERVICE_TOKEN", "demo-internal-token")

# 风格差异尽量拉大：零基础语法课 / 机器人中间件课 / 服务端部署课
DEFAULT_COURSES = ["_m1O5OWXON", "r-kOa4ogHT", "QW0aUTq_vz"]
LAZY_ANSWER = "不太清楚，大概就是那样吧，感觉挺重要的。"


def scene_lecture_text(scene: dict) -> str:
    """与 classroom/lib/classroom/lecture-text.ts 同口径：取 text 元素、去标签、按版面序拼。"""
    content = scene.get("content") or {}
    elements = (content.get("canvas") or {}).get("elements") or content.get("elements") or []
    texts = [e for e in elements if e.get("type") == "text" and isinstance(e.get("content"), str)]
    texts.sort(key=lambda e: (e.get("top", 0), e.get("left", 0)))
    body = "\n".join(re.sub(r"<[^>]*>", " ", e["content"]) for e in texts)
    return re.sub(r"[ \t]+", " ", re.sub(r"\n{2,}", "\n", body)).strip()[:3000]


def post(payload: dict) -> dict:
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-internal-token": TOKEN},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read())["data"]


def pick_scene(course: dict, index: int) -> tuple[dict, str]:
    """挑第 index 个有讲义正文的场景（测验/交互场景没有正文，跳过）。"""
    usable = [(s, t) for s in course["scenes"] if (t := scene_lecture_text(s))]
    if not usable:
        raise SystemExit(f"课程 {course['id']} 没有带讲义正文的场景")
    return usable[min(index, len(usable) - 1)]


def check(label: str, ok: bool, detail: str = "") -> bool:
    print(f"    [{'PASS' if ok else 'FAIL'}] {label}{(' — ' + detail) if detail else ''}")
    return ok


def probe_course(course_id: str, scene_index: int) -> bool:
    path = CLASSROOMS / f"{course_id}.json"
    if not path.is_file():
        print(f"  跳过 {course_id}：找不到 {path}")
        return False
    course = json.loads(path.read_text(encoding="utf-8"))
    scene, lecture = pick_scene(course, scene_index)
    title, course_title = scene.get("title", ""), course["stage"]["name"]
    print(f"\n=== {course_title} / {title}（讲义 {len(lecture)} 字）")

    base = {"lecture_text": lecture, "scene_title": title, "course_title": course_title}
    passed = True

    ask = post(base | {"prior_mastery": 0.4})
    print(f"  ① 首问（{ask.get('decision_type')}）：{ask.get('question', '')}")
    passed &= check("出题成功且是 probe", ask.get("mode") == "ask" and ask.get("decision_type") == "probe",
                    str(ask.get("because"))[:80])
    passed &= check("给出判分要点", len(ask.get("expected_points") or []) >= 2)

    grade = post(base | {"question": ask.get("question", ""),
                         "expected_points": ask.get("expected_points") or [],
                         "learner_answer": LAZY_ANSWER})
    print(f"  ② 敷衍回答判分：{grade.get('verdict')} → 下一步 {grade.get('decision_type')}")
    passed &= check("判分可用（未编造/未降级）", grade.get("mode") == "verdict")
    passed &= check("敷衍回答不判 correct", grade.get("verdict") in ("incorrect", "partial"),
                    grade.get("verdict", ""))
    passed &= check("because 链非空", bool(grade.get("because")))
    passed &= check("给了降维解释", bool(grade.get("explanation")))
    passed &= check("判错后决策=降维", grade.get("decision_type") == "simplify")
    if grade.get("quote"):
        passed &= check("引用是讲义原句", grade["quote"] in " ".join(lecture.split()))

    history = [{"question": ask.get("question", ""), "answer": LAZY_ANSWER,
                "verdict": grade.get("verdict", "incorrect")}]
    follow = post(base | {"lecture_history": history, "prior_mastery": 0.4})
    print(f"  ③ 降维追问（{follow.get('decision_type')}）：{follow.get('question', '')}")
    passed &= check("降维轮出题成功", follow.get("mode") == "ask" and follow.get("decision_type") == "simplify")
    passed &= check("没有重复第一问", follow.get("question") != ask.get("question"))
    passed &= check("带目标带说明", any("目标带" in b for b in follow.get("because") or []))

    streak = [{"question": f"Q{i}", "answer": "答", "verdict": "correct"} for i in range(3)]
    adv = post(base | {"lecture_history": streak})
    print(f"  ④ 连对后（{adv.get('decision_type')}）：{adv.get('question', '')}")
    passed &= check("连对 3 题 → 进阶挑战", adv.get("decision_type") == "challenge")
    passed &= check("掌握度累计正确", adv.get("asked") == 3 and adv.get("correct") == 3)

    # 判分口径守门：把第 1 问的判分要点口语化复述一遍当作回答。要点全覆盖、只是没用
    # 讲义原词——按 08-09 调过的口径（只数要点命中、同义转述算对）不该判 incorrect。
    points = ask.get("expected_points") or []
    good = "我觉得就是" + "；还有就是".join(p.rstrip("。") for p in points) + "，大概这个意思吧。"
    ok = post(base | {"question": ask.get("question", ""), "expected_points": points,
                      "learner_answer": good})
    print(f"  ⑤ 口语化复述要点：{ok.get('verdict')} → 下一步 {ok.get('decision_type')}")
    passed &= check("覆盖要点的口语化回答不判 incorrect", ok.get("verdict") in ("correct", "partial"),
                    ok.get("verdict", ""))
    if ok.get("verdict") == "correct":
        passed &= check("判对后决策=推进", ok.get("decision_type") == "advance")
    return bool(passed)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--courses", nargs="*", default=DEFAULT_COURSES)
    ap.add_argument("--scene-index", type=int, default=2, help="取第几个带正文的场景（默认第 3 个，避开封面页）")
    args = ap.parse_args()

    results = {}
    for cid in args.courses:
        try:
            results[cid] = probe_course(cid, args.scene_index)
        except (urllib.error.URLError, TimeoutError) as exc:
            print(f"  {cid} 请求失败：{exc}")
            results[cid] = False
    print("\n=== 跨课验收汇总")
    for cid, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {cid}")
    return 0 if all(results.values()) and results else 1


if __name__ == "__main__":
    sys.exit(main())
