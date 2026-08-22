from __future__ import annotations

import json
from pathlib import Path
from typing import List

from backend.schemas.evaluation import E2ECase
from backend.schemas.learner import LearnerProfile, PretestQuestion


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"


def load_learner_profiles() -> List[LearnerProfile]:
    path = DATA_DIR / "learner_profiles" / "learner_profiles.json"
    return [LearnerProfile(**item) for item in json.loads(path.read_text(encoding="utf-8"))]


def get_learner_profile(profile_id: str) -> LearnerProfile:
    for profile in load_learner_profiles():
        if profile.id == profile_id:
            return profile
    raise KeyError(f"unknown learner profile: {profile_id}")


def load_pretest_questions() -> List[PretestQuestion]:
    path = DATA_DIR / "quiz" / "pretest_questions.jsonl"
    questions = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            questions.append(PretestQuestion(**json.loads(line)))
    return questions


def load_e2e_cases(gold: str = "v1") -> List[E2ECase]:
    """gold='v1' 用原金标（难度由诊断算法生成，自证基线）；
    gold='v2' 用独立金标 data/eval/gold_v2/（难度由独立准则生成，破循环，Phase A-1）。"""
    if gold == "v2":
        path = DATA_DIR / "eval" / "gold_v2" / "e2e_cases.jsonl"
    else:
        path = DATA_DIR / "eval" / "e2e_cases.jsonl"
    cases = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            cases.append(E2ECase(**json.loads(line)))
    return cases

