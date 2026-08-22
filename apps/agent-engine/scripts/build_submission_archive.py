from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PRODUCT_ROOT = ROOT.parent / "legacy-platform"

EXCLUDED_PARTS = {
    ".git",
    ".env",
    "node_modules",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    "dist",
}
EXCLUDED_NAMES = {"server.log", "server.err.log"}
EXCLUDED_PATH_SEQUENCES = {("data", "archive")}


def main() -> None:
    parser = argparse.ArgumentParser(description="打包挑战杯双代码库提交物，自动排除密钥、缓存和构建产物")
    parser.add_argument("--engine-root", type=Path, default=ROOT)
    parser.add_argument("--product-root", type=Path, default=DEFAULT_PRODUCT_ROOT)
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "dist" / "challenge-cup-submission.zip",
    )
    args = parser.parse_args()

    repos = [args.engine_root.resolve(), args.product_root.resolve()]
    for repo in repos:
        if not (repo / ".git").exists():
            raise SystemExit(f"not a git repository: {repo}")

    files: list[tuple[Path, str]] = []
    repo_manifest = []
    for repo in repos:
        tracked = _tracked_files(repo)
        safe_files = [relative for relative in tracked if _is_safe(relative)]
        prefix = repo.name
        files.extend((repo / relative, f"{prefix}/{relative.as_posix()}") for relative in safe_files)
        repo_manifest.append(
            {
                "name": repo.name,
                "commit": _git(repo, "rev-parse", "HEAD"),
                "branch": _git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
                "file_count": len(safe_files),
            }
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    checksums: list[str] = []
    with zipfile.ZipFile(args.output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source, archive_name in sorted(files, key=lambda item: item[1]):
            data = source.read_bytes()
            archive.writestr(archive_name, data)
            checksums.append(f"{hashlib.sha256(data).hexdigest()}  {archive_name}")
        manifest = {
            "format": 1,
            "repositories": repo_manifest,
            "excluded_parts": sorted(EXCLUDED_PARTS),
            "excluded_names": sorted(EXCLUDED_NAMES),
            "excluded_path_sequences": [list(parts) for parts in sorted(EXCLUDED_PATH_SEQUENCES)],
            "notes": "Only git-tracked current source and evidence files are included. Secrets, logs, dependencies, build outputs and legacy archived runs are excluded.",
        }
        archive.writestr("SUBMISSION_MANIFEST.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        archive.writestr("SUBMISSION_CHECKSUMS.sha256", "\n".join(checksums) + "\n")

    print(f"archive: {args.output}")
    print(f"files: {len(files)}")
    for item in repo_manifest:
        print(f"  {item['name']} {item['branch']} {item['commit']} files={item['file_count']}")


def _tracked_files(repo: Path) -> list[Path]:
    output = subprocess.check_output(
        ["git", "-C", str(repo), "ls-files", "-z"],
    )
    return [Path(item.decode("utf-8")) for item in output.split(b"\0") if item]


def _is_safe(relative: Path) -> bool:
    if relative.name in EXCLUDED_NAMES:
        return False
    if any(part in EXCLUDED_PARTS for part in relative.parts):
        return False
    parts = relative.parts
    if any(
        parts[index : index + len(sequence)] == sequence
        for sequence in EXCLUDED_PATH_SEQUENCES
        for index in range(len(parts) - len(sequence) + 1)
    ):
        return False
    lowered = relative.name.lower()
    if lowered.endswith((".key", ".pem", ".p12", ".pfx")):
        return False
    return True


def _git(repo: Path, *args: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo), *args],
        text=True,
    ).strip()


if __name__ == "__main__":
    main()
