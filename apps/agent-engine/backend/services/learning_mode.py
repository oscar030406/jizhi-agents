"""学习模式人格（产品层引流钩子）——两道情景题分出 4 型，只影响呈现，不宣称提分。

设计纪律（PLAYBOOK 产品层）：这是「皮」不是「核」。模式只驱动界面语气、例子先行还是
原理先行、默认自习/共学——学习效果由检索练习/间隔重复等循证机制（「核」）负责。
对外措辞统一用「学习偏好/学习模式」，不用「性格测试/MBTI」。

零 schema 入侵：输出的 preference_text 直接写入已有的 LearnerProfile.learning_preference，
生成 Agent 的个性化链路无需任何改动即可生效。avatar_seed 供前端用 DiceBear 生成形象卡。
"""

from __future__ import annotations

from dataclasses import dataclass, field

# 两道情景题（前端 onboarding 用）：
# Q1 卡壳时你更想: solo=自己死磕查资料 / social=找人讨论问明白
# Q2 面对新知识你更想: visual=先看图理解全貌 / hands_on=先跑起来再说


@dataclass(frozen=True)
class LearningMode:
    mode_id: str
    name: str
    tagline: str
    avatar_seed: str  # DiceBear 种子，保证同模式形象一致
    preference_text: str  # 写入 LearnerProfile.learning_preference，驱动生成风格
    default_tabs: list[str] = field(default_factory=list)  # 前端多表征 tab 默认顺序
    community_default: str = "solo"  # solo=自习模式 / team=共学模式


_MODES: dict[tuple[str, str], LearningMode] = {
    ("solo", "visual"): LearningMode(
        mode_id="deep_diver",
        name="深潜绘图师",
        tagline="一张图看懂全貌，再安静地啃透它",
        avatar_seed="deep-diver-owl",
        preference_text="图解与结构图优先、原理先行、系统化讲解，适合独立深入学习",
        default_tabs=["diagram", "analogy", "code", "quiz"],
        community_default="solo",
    ),
    ("solo", "hands_on"): LearningMode(
        mode_id="code_smith",
        name="独行代码匠",
        tagline="先跑起来，报错了再回头看原理",
        avatar_seed="code-smith-fox",
        preference_text="可运行代码示例优先、实操任务驱动、示例先行原理随后",
        default_tabs=["code", "quiz", "diagram", "analogy"],
        community_default="solo",
    ),
    ("social", "visual"): LearningMode(
        mode_id="study_captain",
        name="共学领航员",
        tagline="和队友对着图讨论，比一个人快",
        avatar_seed="captain-dolphin",
        preference_text="图解优先、生活类比丰富、鼓励式语气，适合组队讨论式学习",
        default_tabs=["diagram", "analogy", "quiz", "code"],
        community_default="team",
    ),
    ("social", "hands_on"): LearningMode(
        mode_id="sprint_partner",
        name="冲刺拍档",
        tagline="组个队立个目标，边做边聊边通关",
        avatar_seed="sprint-rabbit",
        preference_text="实操项目优先、短平快任务拆解、目标导向与即时反馈",
        default_tabs=["code", "quiz", "analogy", "diagram"],
        community_default="team",
    ),
}

DEFAULT_MODE = _MODES[("solo", "hands_on")]


def resolve_learning_mode(stuck_style: str, approach_style: str) -> LearningMode:
    """两道情景题 → 学习模式。非法输入回退默认模式（不阻断 onboarding）。"""
    key = (stuck_style.strip().lower(), approach_style.strip().lower())
    return _MODES.get(key, DEFAULT_MODE)


def all_modes() -> list[LearningMode]:
    return list(_MODES.values())
