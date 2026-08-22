from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# 测试必须封闭：无论 .env 或外部 shell 怎么配，单测一律走确定性引擎，
# LLM 路径只通过注入的 FakeGateway 测（见 test_llm_paths.py）。
os.environ["AGENT_GENERATION_MODE"] = "deterministic"

