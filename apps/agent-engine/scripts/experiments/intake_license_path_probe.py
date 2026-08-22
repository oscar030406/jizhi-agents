"""跑一次小库接入 run，检查 license evidence 串里没有绝对路径。

evidence 会透传到接入页上屏，绝对路径等于把跑机器的用户名印给评委看。
跑完把临时语料库与 run 目录删干净（run_id 打在 stdout 上，出事能手工找回）。

用法（任意工作目录）：
    python apps/agent-engine/scripts/experiments/intake_license_path_probe.py
退出码 0 = 无绝对路径，1 = 命中。
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ENGINE))

from backend.services import domain_intake as di  # noqa: E402

CORPUS = "h3probe"

DOCS = {
    "01-入门.md": "# 温度计入门\n\n## 什么是量程\n\n量程是仪表能测的区间。"
    + "超出量程的读数不可信，这一段是为了让文件长度过分诊下限而写的说明文字。" * 6,
    "02-进阶.md": "# 校准\n\n## 两点校准\n\n取冰点与沸点两个已知点，做线性拟合。"
    + "校准周期取决于漂移速率，这一段同样是为了凑够字符数的说明文字。" * 6,
    "03-常见问题.md": "# 常见问题\n\n## 读数跳变\n\n多半是接触不良。"
    + "排查顺序是先接线后探头，最后才怀疑主板，这一段仍是凑字数的说明文字。" * 6,
}


def main() -> int:
    files = [(name, body.encode("utf-8")) for name, body in DOCS.items()]
    run = di.create_run(files, CORPUS)
    print("run_id:", run.run_id)
    try:
        di.execute(run)
        record = json.loads((run.dir / "run.json").read_text(encoding="utf-8"))
        lic = record["stages"]["receive"]["detail"]["license"]
        print("status:", record["status"])
        print("license:", json.dumps(lic, ensure_ascii=False))
        blob = (run.dir / "run.json").read_text(encoding="utf-8") + (
            run.dir / "events.jsonl"
        ).read_text(encoding="utf-8")
        bad = [tok for tok in ("C:\\\\", "D:\\\\", "C:/Users", "D:/UserData") if tok in blob]
        print("绝对路径命中:", bad or "无")
        return 1 if bad else 0
    finally:
        for path in (
            di.CORPORA_DIR / CORPUS,
            di.KB / f"{CORPUS}_intake",
            di.GOLD_DIR / CORPUS,
            di.KB / f"{CORPUS}_docs",
            run.dir,
        ):
            if path.exists():
                shutil.rmtree(path, ignore_errors=True)
                print("清掉", path.name)


if __name__ == "__main__":
    raise SystemExit(main())
