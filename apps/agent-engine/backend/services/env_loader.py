from __future__ import annotations

import os
from pathlib import Path

_loaded = False


def load_dotenv_once() -> None:
    """把项目根目录 .env 读进环境变量。已存在的环境变量优先，不覆盖。"""
    global _loaded
    if _loaded:
        return
    _loaded = True
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())
