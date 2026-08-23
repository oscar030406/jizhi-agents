"""扫描件 VLM 转写（WO-N16 A1 补强）。

`pdf_extract` 判出扫描件之后原来就退回——理由写得清楚，但书进不来。
用户原话「扫描件人类能读我们读不了」，那不是能力边界，是没做。

这个文件锁三件最容易坏的：**断点续跑**（877 页断一次不能全重来）、
**图占位不被解释**（编造接线图是安全事故）、**图引用能被下游解析**。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.rag import pdf_transcribe as T

fitz = pytest.importorskip("fitz", reason="没装 PyMuPDF")


def _fake_pdf(path: Path, pages: int) -> Path:
    doc = fitz.open()
    for i in range(pages):
        doc.new_page().insert_text((72, 72), f"page {i}", fontsize=11)
    doc.save(path)
    doc.close()
    return path


def _fake_model(calls: list[str]):
    def call(img: Path) -> str:
        calls.append(img.name)
        return f"# {img.stem}\n\n正文若干。\n\n[图：接线示意]\n"

    return call


def test_断点续跑只补缺的那一页(tmp_path: Path) -> None:
    """877 页跑两小时，中间断一次全重来是不可接受的。"""
    pdf = _fake_pdf(tmp_path / "b.pdf", 5)
    out = tmp_path / "out"
    calls: list[str] = []

    first = T.transcribe_pdf(pdf, out, call_model=_fake_model(calls))
    assert first.pages_done == 5 and len(calls) == 5

    T.page_path(out, 2).unlink()
    calls.clear()
    second = T.transcribe_pdf(pdf, out, call_model=_fake_model(calls))

    assert calls == ["p0002.png"], f"只该补第 2 页，实际调用 {calls}"
    assert second.pages_skipped == 4
    assert second.pages_done == 5


def test_单页失败不毁掉整本(tmp_path: Path) -> None:
    """一页超时/限流是常态。失败要记下来，其余页照转。"""
    pdf = _fake_pdf(tmp_path / "b.pdf", 4)

    def flaky(img: Path) -> str:
        if img.stem == "p0001":
            raise TimeoutError("模型超时")
        return "# ok\n\n正文。\n"

    rep = T.transcribe_pdf(pdf, tmp_path / "out", call_model=flaky)
    assert rep.pages_done == 3 and rep.pages_failed == 1
    assert rep.failures[0]["page"] == 1
    assert "TimeoutError" in rep.failures[0]["error"]
    assert "失败 1 页" in rep.summary(), "失败要说出来，不能只体现在数字里"


def test_模型返回空算失败不算转写成功(tmp_path: Path) -> None:
    """空字符串落盘会被下次续跑当成「已转写」，那一页就永远缺了。"""
    pdf = _fake_pdf(tmp_path / "b.pdf", 2)
    out = tmp_path / "out"
    rep = T.transcribe_pdf(pdf, out, call_model=lambda img: "   ")
    assert rep.pages_done == 0 and rep.pages_failed == 2
    assert not T.page_path(out, 0).exists(), "空结果不许落盘"


def test_原图逐页落盘(tmp_path: Path) -> None:
    """课程里嵌的是原图，不是模型的转述——图必须留着。"""
    pdf = _fake_pdf(tmp_path / "b.pdf", 3)
    out = tmp_path / "out"
    T.transcribe_pdf(pdf, out, call_model=_fake_model([]))
    assert len(list((out / "figures").glob("*.png"))) == 3


def test_图占位拼装成可解析的引用(tmp_path: Path) -> None:
    """占位要带上原图路径，切块时随文走，课程生成据此嵌图。"""
    pdf = _fake_pdf(tmp_path / "b.pdf", 2)
    out = tmp_path / "out"
    T.transcribe_pdf(pdf, out, call_model=_fake_model([]))

    md = T.assemble(out, "b.pdf")
    refs = [line for line in md.splitlines() if "→ figures/" in line]
    assert len(refs) == 2, f"两页两处图引用，实际 {refs}"
    assert "figures/p0000.png" in md and "figures/p0001.png" in md


def test_图占位正则要在多行文本里生效() -> None:
    """踩过：第一版漏了 `re.M`，`match()` 单行测试绿、`sub()` 在整页文本上
    一处都替换不到——图引用全丢，而拼出来的 markdown 看着完全正常。"""
    body = "正文一段\n[图：接线示意]\n正文二段\n[图：梯形图]\n"
    assert T.count_figure_lines(body) == 2
    assert T.FIGURE_LINE.sub("X", body).count("X") == 2


def test_提示词禁止描述图纸内容() -> None:
    """接线图上一根线错了是安全事故。这条约束写在提示词里，不许被「优化」掉。

    这也是选 Qwen3-VL 而不是专用 OCR 的决定性理由：两个专用 OCR 都不吃
    自定义 prompt，根本下不了这条指令。
    """
    p = T.TRANSCRIBE_PROMPT
    assert "不要描述图里的元件" in p
    assert "一个字都不要编" in p
    assert "[图：" in p


def test_模型与分辨率是实测定下来的常量() -> None:
    """换模型/换 dpi 前先看模块文档里的实测表，别拍脑袋改。"""
    assert T.TRANSCRIBE_MODEL == "Qwen/Qwen3-VL-8B-Instruct"
    assert T.RENDER_DPI == 100, "150dpi 输入 token 多一倍多，转写内容几乎一字不差"


# ── 图资产入库 ────────────────────────────────────────────────

def test_转写的原图搬进库(tmp_path, monkeypatch):
    """图落在 run 目录是过程产物，run 随时可清。课程生成读 `corpora/<库>/`——
    不搬过去，正文里的 `[图：… → figures/pNNN.png]` 全是死链。"""
    from backend.services import domain_intake as di

    monkeypatch.setattr(di, "CORPORA_DIR", tmp_path / "corpora")

    class _Run:
        dir = tmp_path / "run"
        corpus = "probe"
        docs_dir = tmp_path / "run" / "docs"

    for book in ("PLC教材", "机器人基础"):
        figs = _Run.dir / "transcribed" / book / "figures"
        figs.mkdir(parents=True)
        for page in range(3):
            (figs / f"p{page:04d}.png").write_bytes(b"\x89PNG")

    got = di._install_figures(_Run())
    assert got == {"figures": 6}

    names = sorted(p.name for p in (tmp_path / "corpora" / "probe" / "figures").glob("*.png"))
    # 带书名前缀：两本书都有 p0000.png，平铺会互相覆盖
    assert "PLC教材-p0000.png" in names and "机器人基础-p0000.png" in names
    assert len(names) == 6


def test_没转写过的库不建空figures目录(tmp_path, monkeypatch):
    from backend.services import domain_intake as di

    monkeypatch.setattr(di, "CORPORA_DIR", tmp_path / "corpora")

    class _Run:
        dir = tmp_path / "run"
        corpus = "probe"
        docs_dir = tmp_path / "run" / "docs"

    _Run.dir.mkdir(parents=True)
    assert di._install_figures(_Run()) == {}


def test_投料自带的figures也搬进库(tmp_path, monkeypatch):
    """管理者可能直接投一份**已经转写好的**教材包，图在 `docs/**/figures/`。

    2026-08-23 实测：离线转写的 PLC 书投进去，295 块建成、九站全过，
    但正文里 322 条 `[图：… → figures/pNNN.png]` 全是死链——
    zip 解压只解 md/txt/rst/pdf 把 png 跳了，`_install_figures` 又只看
    `transcribed/`。两处都漏，图一张都没进库。
    """
    from backend.services import domain_intake as di

    monkeypatch.setattr(di, "CORPORA_DIR", tmp_path / "corpora")

    class _Run:
        dir = tmp_path / "run"
        corpus = "probe"
        docs_dir = tmp_path / "run" / "docs"

    figs = _Run.docs_dir / "PLC教材" / "figures"
    figs.mkdir(parents=True)
    for page in range(3):
        (figs / f"p{page:04d}.png").write_bytes(b"\x89PNG")

    got = di._install_figures(_Run())
    assert got == {"figures": 3}
    names = sorted(p.name for p in (tmp_path / "corpora" / "probe" / "figures").glob("*"))
    assert names == ["PLC教材-p0000.png", "PLC教材-p0001.png", "PLC教材-p0002.png"]


def test_两个来源的图都搬且不撞名(tmp_path, monkeypatch):
    from backend.services import domain_intake as di

    monkeypatch.setattr(di, "CORPORA_DIR", tmp_path / "corpora")

    class _Run:
        dir = tmp_path / "run"
        corpus = "probe"
        docs_dir = tmp_path / "run" / "docs"

    a = _Run.dir / "transcribed" / "链内书" / "figures"
    a.mkdir(parents=True)
    (a / "p0000.png").write_bytes(b"\x89PNG")
    b = _Run.docs_dir / "投料书" / "figures"
    b.mkdir(parents=True)
    (b / "p0000.png").write_bytes(b"\x89PNG")

    assert di._install_figures(_Run()) == {"figures": 2}
    names = sorted(p.name for p in (tmp_path / "corpora" / "probe" / "figures").glob("*"))
    assert names == ["投料书-p0000.png", "链内书-p0000.png"]
