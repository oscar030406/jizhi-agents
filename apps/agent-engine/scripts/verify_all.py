from __future__ import annotations

import argparse
import subprocess
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description="一键复算确定性评测、对抗集、消融、演示缓存与提交物")
    parser.add_argument("--quick", action="store_true", help="仅跑前2个评测用例，适合开发检查；不可作为比赛数字")
    args = parser.parse_args()

    limit_args = ["--limit", "2"] if args.quick else []
    commands = [
        [sys.executable, "-m", "compileall", "-q", "backend", "scripts"],
        [sys.executable, "-m", "pytest", "-q"],
        [sys.executable, "scripts/run_eval.py", "--gold", "both", "--mode", "deterministic", *limit_args],
        [sys.executable, "scripts/run_adversarial.py", *(limit_args if args.quick else [])],
        [sys.executable, "scripts/run_difficulty_robustness.py"],
        [
            sys.executable,
            "scripts/ablation.py",
            "--gold",
            "v2",
            "--mode",
            "deterministic",
            *limit_args,
        ],
        # 机制自检建到临时目录。原来这行直接重建 data/demo_runs——把花钱跑出来的
        # 真 LLM 轨迹整个删掉换成确定性轨迹，谁跑一次 verify_all 谁清空证据，
        # 这就是 demo runs 数字历史上反复漂移的机制之一。真目录只验证不重建。
        [
            sys.executable,
            "scripts/build_demo_runs.py",
            "--mode",
            "deterministic",
            "--output-dir",
            str(ROOT / "data" / ".demo_runs_mechanism_check"),
        ],
        [
            sys.executable,
            "scripts/validate_demo_runs.py",
            "--input-dir",
            str(ROOT / "data" / ".demo_runs_mechanism_check"),
        ],
        [sys.executable, "scripts/validate_demo_runs.py"],
        # 数字止血执法器：对外数字与文档引用一致性（quick 跑引用扫描，全量再抽活值）
        [sys.executable, "scripts/check_metrics.py", *([] if args.quick else ["--live"])],
    ]
    if not args.quick:
        commands.append([sys.executable, "scripts/verify_submission.py"])

    for index, command in enumerate(commands, start=1):
        print(f"\n[{index}/{len(commands)}] {' '.join(command)}")
        subprocess.run(command, cwd=ROOT, check=True)
    print("\nALL DETERMINISTIC VERIFICATIONS PASSED")
    if args.quick:
        print("QUICK MODE: subset outputs are not valid competition metrics and submission verification was skipped.")


if __name__ == "__main__":
    main()
