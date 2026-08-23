"""三级提示阶梯：hint → scaffold 子题 → 兜底答案，逐级解锁，看了答案要付代价。

钉三件事：
1. 解锁判据是代码不是模型——同样的 (请求级别, 已用级别) 每次都得出同一个结论；
2. 跳级拿不到内容——未解锁的级别连 content 都不下发，前端改不出答案来；
3. 「看了答案」必须进掌握度——两条路径（讲义判分、题库选择题）都不许把它记成「会了」。
   第 3 条是这套东西的存在理由：不记的话，提示阶梯就成了刷掌握度的捷径。
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.integration.personalize_service import run_tutor_turn  # noqa: E402
from backend.services.tutor_service import (  # noqa: E402
    TutorRequest,
    _load_pool,
    cap_verdict_by_hints,
    hint_ladder_turn,
    hint_verdict_cap,
    lecture_tutor_turn,
    tutor_turn,
)

LECTURE = (
    "注意力机制让模型在生成每个词时，给上下文中的不同位置分配权重。"
    "权重越高的位置对当前输出影响越大。多头注意力则是并行跑多组注意力，各自关注不同的关系。"
)
POINTS = ["权重决定该位置对输出的影响力", "多头注意力并行跑多组、各看不同关系"]


def _lecture_req(**kwargs):
    return TutorRequest(
        lecture_text=LECTURE, scene_title="注意力机制", course_title="大模型原理",
        question="注意力权重起什么作用？", expected_points=POINTS, **kwargs)


class FakeGateway:
    """判分只回一个固定裁决——这里测的是提示代价，不是模型判得准不准。"""

    def __init__(self, payload):
        self.payload = payload

    def is_enabled(self, agent):
        return True

    def structured_chat(self, agent, system, user, **kwargs):
        return self.payload


# ------------------------------------------------------------------ 三级都能拿到

def test_三级按顺序逐级都能拿到():
    used = 0
    for level in (1, 2, 3):
        ladder = hint_ladder_turn(_lecture_req(hint_request=level, hints_used=used))
        assert ladder.granted_level == level, f"第 {level} 级该放行"
        step = ladder.steps[level - 1]
        assert step.unlocked and step.content.strip(), f"第 {level} 级放行了就得给内容"
        used = ladder.hints_used
        assert used == level  # 累计级别回传给下一轮
    assert [s.kind for s in ladder.steps] == ["hint", "scaffold", "bottom_out"]


def test_一级指回讲义原句_三级才给全部要点():
    first = hint_ladder_turn(_lecture_req(hint_request=1)).steps[0].content
    # 一级只指路：引的必须是讲义里逐字存在的一句（与判分侧 quote 同口径，不许改写、不许造句），
    # 且不能把判分要点抖出来——那是三级的活。挑哪一句是启发式，不在这里钉死。
    quoted = first.split("「", 1)[1].split("」", 1)[0]
    assert quoted and quoted in LECTURE
    assert all(p not in first for p in POINTS)
    bottom = hint_ladder_turn(_lecture_req(hint_request=3, hints_used=2)).steps[2].content
    assert all(p in bottom for p in POINTS)


# ------------------------------------------------------------------ 解锁依赖

def test_跳级拿不到内容():
    ladder = hint_ladder_turn(_lecture_req(hint_request=3, hints_used=0))
    assert ladder.granted_level == 0
    assert ladder.hints_used == 0, "没放行就不该记账"
    assert ladder.steps[2].content == "" and not ladder.steps[2].unlocked
    assert any("不许跳级" in b for b in ladder.because)


def test_只解锁下一级_隔级仍然锁着():
    ladder = hint_ladder_turn(_lecture_req(hint_request=2, hints_used=1))
    assert ladder.granted_level == 2
    assert ladder.steps[2].content == "", "放行第 2 级不该顺带把答案漏出来"


def test_已解锁的级别可以重看():
    ladder = hint_ladder_turn(_lecture_req(hint_request=1, hints_used=2))
    assert ladder.granted_level == 1
    assert ladder.hints_used == 2, "回头重看不该把累计级别改小"
    assert ladder.steps[0].content and ladder.steps[1].content
    assert ladder.steps[2].content == ""


def test_不请求时只回状态不给新内容():
    ladder = hint_ladder_turn(_lecture_req(hint_request=0, hints_used=1))
    assert ladder.granted_level == 0
    assert ladder.steps[0].content and ladder.steps[1].content == ""


def test_越界级别直接驳回():
    ladder = hint_ladder_turn(_lecture_req(hint_request=9, hints_used=3))
    assert ladder.granted_level == 0
    assert any("没有第 9 级" in b for b in ladder.because)


# ------------------------------------------------------------------ 题库分支

def test_题库分支兜底给正确选项和解析():
    pool = _load_pool("llm_basics")
    item = pool[0]
    ladder = hint_ladder_turn(TutorRequest(
        concept="llm_basics", hint_question_id=item.question_id, hint_request=3, hints_used=2))
    assert ladder.granted_level == 3
    bottom = ladder.steps[2].content
    assert item.options[item.answer_index] in bottom
    # 二级只做排除，不能把正确项说出来
    assert item.options[item.answer_index] not in ladder.steps[1].content


def test_题库分支找不到题时报404口径的KeyError():
    with pytest.raises(KeyError):
        hint_ladder_turn(TutorRequest(concept="llm_basics", hint_question_id="不存在#q9", hint_request=1))


# ------------------------------------------------------------------ 看了答案的代价

def test_代价表按级递减():
    assert hint_verdict_cap(0) == "correct"
    assert hint_verdict_cap(1) == "correct"
    assert hint_verdict_cap(2) == "partial"
    assert hint_verdict_cap(3) == "incorrect"
    # 压档只往下压，不会把差的判分抬上去
    assert cap_verdict_by_hints("incorrect", 0)[0] == "incorrect"
    assert cap_verdict_by_hints("partial", 3)[0] == "incorrect"


def test_讲义判分_看了答案不记成会了():
    gw = FakeGateway({"verdict": "correct", "because": ["要点全覆盖"],
                      "explanation": "", "quote": ""})
    turn = lecture_tutor_turn(_lecture_req(learner_answer="权重决定影响力，多头并行", hints_used=3), gateway=gw)
    # 顶层 verdict 也得压——客户端的证据映射读的就是它，只压内层等于没压
    assert turn.verdict == "incorrect"
    assert turn.mastery_estimate == 0.0
    ev = turn.profile_evidence
    assert ev.verdict == "incorrect" and ev.raw_verdict == "correct" and ev.hints_used == 3
    assert any("看了兜底答案" in b for b in turn.because), "压档必须写进 because，不能偷偷压"
    # 看了答案 → 下一轮先降维，不是当他会了往后推
    assert turn.decision_type == "simplify"


def test_讲义判分_二级提示压到partial():
    gw = FakeGateway({"verdict": "correct", "because": ["要点全覆盖"], "explanation": "", "quote": ""})
    turn = lecture_tutor_turn(_lecture_req(learner_answer="都答到了", hints_used=2), gateway=gw)
    assert turn.verdict == "partial" and turn.mastery_estimate == 0.5
    assert turn.profile_evidence.raw_verdict == "correct"


def test_讲义判分_一级提示不罚分():
    gw = FakeGateway({"verdict": "correct", "because": ["要点全覆盖"], "explanation": "", "quote": ""})
    turn = lecture_tutor_turn(_lecture_req(learner_answer="都答到了", hints_used=1), gateway=gw)
    assert turn.verdict == "correct" and turn.mastery_estimate == 1.0
    assert turn.profile_evidence.raw_verdict == "", "没压档就不该留压档痕迹"


def test_讲义历史里的看答案记录同样压档():
    gw = FakeGateway({"question": "多头注意力和单头差在哪？", "expected_points": ["并行多组", "各看不同关系"]})
    turn = lecture_tutor_turn(_lecture_req(lecture_history=[
        {"question": "权重是什么？", "answer": "…", "verdict": "correct", "hints_used": 3},
    ]), gateway=gw)
    assert turn.mode == "ask"
    assert turn.correct == 0 and turn.mastery_estimate == 0.0, "历史里那题是看了答案的，不算对"


def test_题库分支_看了答案的题不计正确():
    pool = _load_pool("llm_basics")
    item = pool[0]
    picked = {"question_id": item.question_id, "selected_index": item.answer_index, "hints_used": 3}
    turn = tutor_turn(TutorRequest(concept="llm_basics", history=[picked]))
    assert turn.correct == 0 and turn.mastery_estimate == 0.0
    assert turn.decision.type == "simplify"
    assert any("不计正确" in b for b in turn.decision.because)
    # 同一道题自己做对的，照旧算对（压档只针对提示，不是把所有人都压一遍）
    picked["hints_used"] = 0
    clean = tutor_turn(TutorRequest(concept="llm_basics", history=[picked]))
    assert clean.correct == 1 and clean.decision.type == "advance"


# ------------------------------------------------------------------ HTTP 分流

def test_两个入口共用的分流把提示轮标成tutor_hint():
    payload = run_tutor_turn(_lecture_req(hint_request=1), "trace-hint")
    assert payload["agent"] == "tutor:hint"
    assert payload["granted_level"] == 1


def test_两个main都挂着导学路由():
    """生产起 app.main:app，本地起 backend.main:app——提示阶梯走的是既有 /tutor，
    没加新路由，但这条得钉住：哪天有人把路由挪走，两边不能只剩一边。"""
    from app.main import app as app_main
    from backend.main import app as backend_main

    path = "/internal/v1/personalize/tutor"
    for name, application in (("app.main", app_main), ("backend.main", backend_main)):
        assert any(getattr(r, "path", "") == path for r in application.routes), f"{name} 没挂 {path}"
