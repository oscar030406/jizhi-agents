"""集中版本化学习者状态（v4 §2.5，IntelliCode 范式，arXiv 2512.18669）。

问题：画像信息散在各 Agent 的入参与产物里（诊断的 mastery、FSRS 的卡片、反馈的难度），
没有单一事实源，掌握度更新不可审计。
方案：单一 `VersionedLearnerState` + **单写者**——所有变更只能经 `LearnerStateStore.apply()`
提交，每次变更记录（谁改的/改了什么/依据什么），版本号单调递增，历史可回放。
各 Agent 是对状态的读者；写入统一走 store（单写者策略保证一致性与可审计性）。
"""
from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, Field

from backend.schemas.learner import LearnerProfile


class StateChange(BaseModel):
    """一次状态变更的审计记录。"""
    version: int
    writer: str                 # 哪个 Agent/服务发起（如 LearnerDiagnosisAgent / FeedbackDecisionAgent）
    field: str                  # mastery_vector / current_difficulty / review_log …
    before: str                 # 变更前值的紧凑表示（审计用，非机器回放源）
    after: str
    because: List[str] = Field(default_factory=list)   # 依据链（与可见协同决策同口径）


class VersionedLearnerState(BaseModel):
    """学习者状态的单一事实源。"""
    profile_id: str
    version: int = 0
    profile: LearnerProfile
    mastery_vector: Dict[str, float] = Field(default_factory=dict)
    current_difficulty: str = "L2"
    weak_concepts: List[str] = Field(default_factory=list)
    completed_concepts: List[str] = Field(default_factory=list)
    changelog: List[StateChange] = Field(default_factory=list)


class LearnerStateStore:
    """单写者状态仓：进程内实现（演示/评测口径）。

    ponytail: 内存实现，跨进程持久化时换成文件/DB 后端（接口不变）。
    """

    def __init__(self) -> None:
        self._states: Dict[str, VersionedLearnerState] = {}

    def get_or_init(self, profile: LearnerProfile) -> VersionedLearnerState:
        if profile.id not in self._states:
            self._states[profile.id] = VersionedLearnerState(
                profile_id=profile.id, profile=profile)
        return self._states[profile.id]

    def apply(
        self,
        profile_id: str,
        writer: str,
        field: str,
        new_value,
        because: Optional[List[str]] = None,
    ) -> VersionedLearnerState:
        """唯一的写入口。字段名必须是状态上的真实字段；每次写入版本 +1 并留审计记录。"""
        state = self._states[profile_id]
        if not hasattr(state, field) or field in {"version", "changelog", "profile_id"}:
            raise ValueError(f"不可写字段：{field}")
        before = getattr(state, field)
        setattr(state, field, new_value)
        state.version += 1
        state.changelog.append(StateChange(
            version=state.version,
            writer=writer,
            field=field,
            before=_compact(before),
            after=_compact(new_value),
            because=list(because or []),
        ))
        return state

    def snapshot(self, profile_id: str) -> VersionedLearnerState:
        """只读快照（深拷贝，读者拿不到可变引用）。"""
        return self._states[profile_id].model_copy(deep=True)


def _compact(value) -> str:
    text = str(value)
    return text if len(text) <= 200 else text[:200] + "…"


# 进程级默认仓（演示口径；服务端场景按请求注入独立实例）
learner_state_store = LearnerStateStore()
