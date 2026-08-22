"""zip 与 git 两条投料形态：解成一棵目录树，剩下的交给既有 `triage`。

为什么要有这两条：管理端原本只收 multipart 多文件，而一个真实知识库动辄
几百上千个文件（iotdb 922、odoo 963），浏览器多选选不动。少了这两条口，
管理者就只能找工程师跑 CLI ——那正是要废掉的路径。

**这里不读文件内容、不判格式好坏**，只负责把投料还原成 `<run>/docs/` 下的一棵树。
分诊、退回清单、许可识别全在 `backend.rag.intake.triage` 里，一份口径。
这个模块做的是它做不了的那两件事：不可信压缩包的解压安全，和外网仓库的拉取。

## 两条安全线（都有测试盯着）

- **zip slip**：条目名可以写 `../../etc/passwd` 或绝对路径。解之前先把目标路径
  resolve 出来，落在目标目录之外的一律**整包拒绝**（不是跳过——一个越界条目
  说明这个包不可信，剩下的也不该收）。
- **zip bomb**：`info.file_size` 是包里自己写的，攻击者说多少是多少，不能信。
  真正的闸设在写盘的循环里，按**实际写出的字节数**累加，超了立刻中止。

## 只解可读格式

一个仓库里的图片、字体、二进制远多于文档。全解出来既撑大解压量（正经仓库会被
体积闸误伤），又会给退回清单塞进几百条「不解析 .png」。所以按
`READABLE_SUFFIXES` 过一道，跳掉的只报个数。
"""
from __future__ import annotations

import io
import os
import shutil
import subprocess
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

from backend.rag.intake import READABLE_SUFFIXES, SKIP_DIRS


class SourceError(RuntimeError):
    """投料形态本身出的问题：包坏了、路径越界、超限、clone 失败。"""


#: clone 超时。大陆机房拉 GitHub 卡死是常态，宁可两分钟后失败并指路，
#: 也不让管理者对着转圈的进度条等下去。
CLONE_TIMEOUT = int(os.environ.get("INTAKE_CLONE_TIMEOUT", "120") or 120)

#: 超时/失败后统一给这句——它得说清「改走哪条路」，不是只报错。
FALLBACK_TO_ZIP = "请在本地 `git clone --depth 1` 之后把目录打成 zip，改走 zip 上传那条路。"

_CHUNK = 64 * 1024


def _readable(name: str) -> bool:
    return PurePosixPath(name).suffix.lower() in READABLE_SUFFIXES


# 「原体大、正文小」的格式：原文件字节数与最终可切块正文相差两个数量级
# （实测 104MB 的扫描版教材抽出正文 0 字、83MB 的文字版 PDF 抽出 0.57MB）。
# 这类文件**不吃正文预算**（max_bytes 那条按 MAX_EST_CHUNKS×1400 折的是
# 正文量，真正文闸门在切块站 check_budget）——只设独立的磁盘保护上限。
# 2026-08-23 第六坎实证：验收包 245MB 的 PDF 原体积被计入 280MB 正文预算，
# ①站直接中止；而这些 PDF 抽出的正文合计不到 1MB。
_EXTRACTED_SUFFIXES = {".pdf"}
# 独立上限与上游对齐：上传整包 nginx 侧 1GB、Next 侧 2GB，解压后这类文件
# 总量不可能远超包本身（PDF 本就压缩过）。2GB 防的是炸盘，不是正文超量。
EXTRACTED_TOTAL_CAP = 2_000_000_000


def _is_extracted_format(name: str) -> bool:
    return PurePosixPath(name).suffix.lower() in _EXTRACTED_SUFFIXES


def _inside(root: Path, target: Path) -> bool:
    """target 是否真的落在 root 里面。root 自身不算（条目不能就是根目录）。"""
    try:
        return target.resolve().relative_to(root).parts != ()
    except ValueError:
        return False


def extract_zip(source: Path, dest: Path, max_bytes: int) -> dict[str, int]:
    """把 zip 解到 `dest`，只解可读格式。返回 {files, bytes, skipped}。

    **收的是磁盘上的路径，不是 bytes。** 早先这里签名是 `blob: bytes`，
    调用方 `await archive.read()` 把整个上传体读进内存再 `io.BytesIO` 包一层——
    401MB 的包就是 401MB 常驻，加解压缓冲实测让 uvicorn 涨到 830MB，
    与 next-server 的 2058MB 叠加把 3.9G 的机器打爆（2026-08-22 内核 OOM 记录）。

    `zipfile` 直接读文件时按中央目录 seek，从不整包驻留，改这一处就够。
    """
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    files = written = skipped = extracted_bytes = 0
    try:
        archive = zipfile.ZipFile(source)
    except zipfile.BadZipFile as exc:
        raise SourceError(f"不是有效的 zip 包：{exc}") from exc
    with archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            # 反斜杠是 Windows 打包工具的历史遗留；先归一，免得穿越片段藏在里面。
            name = info.filename.replace("\\", "/")
            if not _inside(root, dest / name):
                raise SourceError(f"zip 条目路径越界，整包拒绝：{info.filename}")
            parts = PurePosixPath(name).parts
            if any(part in SKIP_DIRS for part in parts[:-1]):
                continue
            if not _readable(name):
                skipped += 1
                continue
            target = (dest / name).resolve()
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted_fmt = _is_extracted_format(name)
            try:
                with archive.open(info) as src, target.open("wb") as out:
                    while chunk := src.read(_CHUNK):
                        if extracted_fmt:
                            extracted_bytes += len(chunk)
                            if extracted_bytes > EXTRACTED_TOTAL_CAP:
                                raise SourceError(
                                    f"PDF 类文件解压总量超过 {EXTRACTED_TOTAL_CAP / 1e9:.0f}GB 磁盘保护线，已中止解压"
                                )
                        else:
                            written += len(chunk)
                            if written > max_bytes:
                                raise SourceError(
                                    f"解压后文本总量超过上限 {max_bytes / 1e6:.0f}MB，已中止解压"
                                )
                        out.write(chunk)
            except zipfile.BadZipFile as exc:
                # 条目坏了或包头自报的大小与实际对不上（CRC 校验会在这里炸）。
                # 不让它以 500 冒出去——投料坏了是 400。
                raise SourceError(f"zip 条目「{info.filename}」解不开：{exc}") from exc
            files += 1
    if not files:
        raise SourceError("zip 里没有任何可读文档（只收 " + "/".join(sorted(READABLE_SUFFIXES)) + "）")
    return {"files": files, "bytes": written, "skipped": skipped}


def check_git_url(url: str) -> str:
    """只放行 https 的仓库地址。

    ssh (`git@host:repo`)、`git://`、`file://` 与本地路径一律拒绝——这个端点
    是拿服务器去 clone，放开 scheme 就等于给了一把读服务器文件系统的钥匙。
    """
    raw = url.strip()
    parsed = urlparse(raw)
    if parsed.scheme != "https" or not parsed.netloc:
        raise SourceError(f"只收 https:// 开头的仓库地址（收到「{raw[:80]}」）；ssh、git://、本地路径一律不收")
    if "@" in parsed.netloc:
        raise SourceError("地址里不要带凭据（user:pass@host）——run 记录会存下这个地址")
    return raw


def clone_repo(url: str, dest: Path, timeout: int = CLONE_TIMEOUT) -> dict[str, str]:
    """`git clone --depth 1` 到 `dest`。超时/失败都抛 SourceError 并指路 zip。"""
    safe = check_git_url(url)
    dest.mkdir(parents=True, exist_ok=True)
    cmd = ["git", "clone", "--depth", "1", "--single-branch", "--no-tags", "--", safe, str(dest)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise SourceError(f"clone 超过 {timeout}s 未完成，已放弃。{FALLBACK_TO_ZIP}") from exc
    except FileNotFoundError as exc:
        raise SourceError(f"这台机器上没有 git 命令。{FALLBACK_TO_ZIP}") from exc
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()
        raise SourceError(f"clone 失败：{tail[-1][:200] if tail else f'git 退出码 {proc.returncode}'}。{FALLBACK_TO_ZIP}")
    head = subprocess.run(
        ["git", "-C", str(dest), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=30
    )
    shutil.rmtree(dest / ".git", ignore_errors=True)
    return {"url": safe, "commit": (head.stdout or "").strip()[:12]}


def collect_readable(src: Path, dest: Path, max_bytes: int) -> list[tuple[str, int]]:
    """把 `src` 下的可读文档按原有目录结构搬到 `dest`。

    保结构不是洁癖：`triage` 拿 `path_depth` 当结构信号，切块时的 section 标题也带
    相对路径。压平成一层，922 个文件的层级信息就全丢了。
    """
    kept: list[tuple[str, int]] = []
    written = extracted_bytes = 0
    for path in sorted(p for p in src.rglob("*") if p.is_file()):
        rel = path.relative_to(src)
        if path.is_symlink():  # 仓库里的软链可能指到外面去，不跟
            continue
        if any(part in SKIP_DIRS for part in rel.parts[:-1]):
            continue
        if not _readable(path.name):
            continue
        # 与 extract_zip 同一套两桶预算：PDF 类按磁盘保护线，文本按正文预算
        if _is_extracted_format(path.name):
            extracted_bytes += path.stat().st_size
            if extracted_bytes > EXTRACTED_TOTAL_CAP:
                raise SourceError(
                    f"PDF 类文件总量超过 {EXTRACTED_TOTAL_CAP / 1e9:.0f}GB 磁盘保护线，已中止"
                )
        else:
            written += path.stat().st_size
            if written > max_bytes:
                raise SourceError(f"可读文本总量超过上限 {max_bytes / 1e6:.0f}MB，已中止")
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        kept.append((rel.as_posix(), target.stat().st_size))
    return kept
