"""zip 与 git 两条投料形态的安全线。

四条红线，每条一个用例：
1. zip 条目路径穿越（zip slip）——整包拒绝，一个字节都不许落到目标目录之外。
2. 解压后总量超限（zip bomb）——`info.file_size` 是包里自己写的，不能信，
   闸必须设在写盘循环里按实际字节数累加。
3. 非 https 的仓库地址——拒绝。放开 scheme 就等于给了一把读服务器文件系统的钥匙。
4. clone 超时——给明确失败原因，并指路 zip 那条。不许无限转圈。

外加一条正路：zip 解出来的目录结构要保住，`triage` 拿 path_depth 当结构信号。
"""
from __future__ import annotations

import itertools
import tempfile
import io
from pathlib import Path
import subprocess
import zipfile

import pytest

from backend.services import intake_sources as src


_zip_seq = itertools.count()


def _zip(entries: dict[str, bytes]) -> Path:
    """造一个 zip 并**落到盘上**，返回路径。

    `extract_zip` 收路径不收 bytes——整包读进内存正是 2026-08-22 把 uvicorn
    撑到 830MB、连同 next-server 一起 OOM 的原因（见 intake_sources.extract_zip
    的文档）。测试跟着走同一条路径，否则测的就不是线上跑的那条。
    """
    path = Path(tempfile.gettempdir()) / f"intake-test-{next(_zip_seq)}.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, blob in entries.items():
            zf.writestr(name, blob)
    return path


def _zip_from_bytes(raw: bytes) -> Path:
    """把手工拼的字节（坏包、越界条目）也落盘，供同一个入口使用。"""
    path = Path(tempfile.gettempdir()) / f"intake-test-raw-{next(_zip_seq)}.zip"
    path.write_bytes(raw)
    return path


# ── zip slip ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "evil",
    [
        "../escaped.md",
        "docs/../../escaped.md",
        "..\\escaped.md",  # Windows 打包工具留下的反斜杠，归一后同样是穿越
    ],
)
def test_zip_slip_rejected(tmp_path, evil):
    dest = tmp_path / "docs"
    with pytest.raises(src.SourceError, match="越界"):
        src.extract_zip(_zip({"ok.md": b"# ok\n" + b"x" * 300, evil: b"pwned"}), dest, 10_000_000)
    assert not (tmp_path / "escaped.md").exists()
    assert not (tmp_path.parent / "escaped.md").exists()


def test_zip_absolute_path_rejected(tmp_path):
    """绝对路径条目：pathlib 的 `/` 拼接会让绝对路径整个替换掉目标目录。"""
    with pytest.raises(src.SourceError, match="越界"):
        src.extract_zip(_zip({"/tmp/pwned.md": b"x" * 400}), tmp_path / "docs", 10_000_000)


# ── zip bomb ────────────────────────────────────────────────────────────────


def test_zip_bomb_total_size_rejected(tmp_path):
    """高压缩比的一堆零字节：包只有几 KB，解出来 5MB。闸按实际写出的字节数拦。"""
    bomb = _zip({f"doc-{i}.md": b"0" * 1_000_000 for i in range(5)})
    assert bomb.stat().st_size < 100_000, "这个包本身应该很小，否则测的就不是压缩比"
    with pytest.raises(src.SourceError, match="总量超过上限"):
        src.extract_zip(bomb, tmp_path / "docs", 2_000_000)


def test_lying_declared_size_fails_as_bad_input(tmp_path):
    """包里自报的 file_size 是攻击者写的，所以闸按实际写出的字节数算。

    这里把中央目录里的 uncompressed size 改成 1：stdlib 读到第 1 个字节就收工，
    CRC 对不上抛 BadZipFile。要点是这条**不能以 500 冒出去**——投料坏了是 400。
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("big.md", b"0" * 3_000_000)
    raw = bytearray(buf.getvalue())
    with zipfile.ZipFile(io.BytesIO(bytes(raw))) as probe:
        assert probe.infolist()[0].file_size == 3_000_000
    idx = raw.rfind(b"PK\x01\x02")
    raw[idx + 24 : idx + 28] = (1).to_bytes(4, "little")
    with pytest.raises(src.SourceError, match="解不开"):
        src.extract_zip(_zip_from_bytes(bytes(raw)), tmp_path / "docs", 1_000_000)


# ── zip 正路 ────────────────────────────────────────────────────────────────


def test_zip_keeps_directory_structure_and_skips_binaries(tmp_path):
    dest = tmp_path / "docs"
    stats = src.extract_zip(
        _zip(
            {
                "book/ch1/intro.md": b"# intro\n" + "正文".encode() * 200,
                "book/ch2/deep/detail.md": b"# detail\n" + "正文".encode() * 200,
                "book/img/cover.png": b"\x89PNG" + b"\x00" * 5000,
                ".git/objects/ab/cdef": b"binary",
            }
        ),
        dest,
        10_000_000,
    )
    assert stats["files"] == 2
    assert stats["skipped"] == 1  # png 记数；.git 整棵跳过、不进计数
    assert (dest / "book" / "ch2" / "deep" / "detail.md").exists()
    assert not (dest / "book" / "img").exists()
    assert not (dest / ".git").exists()


def test_zip_without_any_document_is_an_error(tmp_path):
    with pytest.raises(src.SourceError, match="没有任何可读文档"):
        src.extract_zip(_zip({"a.png": b"\x89PNG"}), tmp_path / "docs", 10_000_000)


def test_broken_zip_is_an_error(tmp_path):
    with pytest.raises(src.SourceError, match="不是有效的 zip"):
        src.extract_zip(_zip_from_bytes(b"this is not a zip"), tmp_path / "docs", 10_000_000)


# ── git url ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "git@github.com:apache/iotdb.git",
        "ssh://git@github.com/apache/iotdb.git",
        "git://github.com/apache/iotdb.git",
        "file:///etc",
        "/etc/passwd",
        "D:\\UserData\\secrets",
        "http://github.com/apache/iotdb.git",
        "",
    ],
)
def test_only_https_git_urls_accepted(url):
    with pytest.raises(src.SourceError, match="https"):
        src.check_git_url(url)


def test_https_url_with_credentials_rejected():
    with pytest.raises(src.SourceError, match="凭据"):
        src.check_git_url("https://user:token@github.com/apache/iotdb.git")


def test_https_url_accepted():
    assert src.check_git_url("  https://github.com/apache/iotdb.git ") == "https://github.com/apache/iotdb.git"


# ── clone 超时 ──────────────────────────────────────────────────────────────


def test_clone_timeout_says_what_to_do_instead(tmp_path, monkeypatch):
    """大陆机房拉 GitHub 卡死是常态。超时后必须给出「改走 zip」这句指路。"""

    def _hang(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout", 0))

    monkeypatch.setattr(src.subprocess, "run", _hang)
    with pytest.raises(src.SourceError) as err:
        src.clone_repo("https://github.com/apache/iotdb.git", tmp_path / "src", timeout=3)
    assert "超过 3s" in str(err.value)
    assert "zip" in str(err.value)


def test_clone_failure_also_points_at_zip(tmp_path, monkeypatch):
    monkeypatch.setattr(
        src.subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 128, "", "fatal: repository not found"),
    )
    with pytest.raises(src.SourceError) as err:
        src.clone_repo("https://github.com/nope/nope.git", tmp_path / "src")
    assert "repository not found" in str(err.value) and "zip" in str(err.value)


def test_clone_rejects_bad_url_before_running_git(tmp_path, monkeypatch):
    """URL 校验必须在 subprocess 之前——否则拒绝就只是个摆设。"""

    def _boom(*a, **k):
        raise AssertionError("不该走到 git")

    monkeypatch.setattr(src.subprocess, "run", _boom)
    with pytest.raises(src.SourceError, match="https"):
        src.clone_repo("file:///etc", tmp_path / "src")


# ── 目录搬运 ────────────────────────────────────────────────────────────────


def test_collect_readable_caps_total_and_keeps_structure(tmp_path):
    repo = tmp_path / "repo"
    (repo / "a" / "b").mkdir(parents=True)
    (repo / "a" / "b" / "x.md").write_bytes(b"m" * 600_000)
    (repo / "a" / "y.md").write_bytes(b"m" * 600_000)
    (repo / "a" / "z.png").write_bytes(b"\x00" * 900_000)
    dest = tmp_path / "docs"

    kept = src.collect_readable(repo, dest, 2_000_000)
    assert [rel for rel, _ in kept] == ["a/b/x.md", "a/y.md"]
    assert (dest / "a" / "b" / "x.md").exists() and not (dest / "a" / "z.png").exists()

    with pytest.raises(src.SourceError, match="总量超过上限"):
        src.collect_readable(repo, tmp_path / "docs2", 800_000)


def test_pdf_bytes_do_not_eat_the_text_budget(tmp_path):
    """第六坎（2026-08-23 验收实证）：245MB PDF 原体积被计入 280MB 正文预算，
    ①站中止。PDF 是「原体大、正文小」格式（104MB 扫描书抽出 0 字），只受
    磁盘保护线约束；正文预算只对文本后缀计数，真正文闸门在切块站。"""
    import io
    import zipfile

    from backend.services.intake_sources import extract_zip

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("book/big.pdf", b"%PDF" + b"\x00" * 300_000)  # 远超下面的文本预算
        zf.writestr("book/ch1.md", "# 一\n" + "正文" * 200)
    src = tmp_path / "p.zip"
    src.write_bytes(buf.getvalue())

    out = extract_zip(src, tmp_path / "out", max_bytes=100_000)  # 文本预算 100KB
    assert out["files"] == 2  # PDF 与 md 都解出来了，PDF 没吃掉文本预算


def test_text_budget_still_hard_stops(tmp_path):
    import io
    import pytest
    import zipfile

    from backend.services.intake_sources import SourceError, extract_zip

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a.md", "正" * 200_000)
    src = tmp_path / "t.zip"
    src.write_bytes(buf.getvalue())
    with pytest.raises(SourceError, match="文本总量"):
        extract_zip(src, tmp_path / "out", max_bytes=100_000)
