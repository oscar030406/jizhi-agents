"""PDF 抽取与扫描件识别（WO-N16 A1）。

这个文件锁的核心行为是**扫描件必须被退回、且理由说人话**。
最坏的失败形态不是抽不出来，是抽出 0 字还照样往下走——文件记成「已接收」、
切出 0 块、建个空索引，最后库建成了、报告一片绿，里面什么都没有。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from backend.rag.pdf_extract import MIN_CHARS_PER_PAGE, extract_pdf

fitz = pytest.importorskip("fitz", reason="没装 PyMuPDF")

#: 验收包里的三本真书（2026-08-22 实测全是扫描件）。不在盘上就跳过。
REAL_BOOKS = Path(r"D:\UserData\Desktop\挑战杯\智能制造")


def _make_pdf(path: Path, pages: int, text_per_page: str) -> Path:
    doc = fitz.open()
    for _ in range(pages):
        page = doc.new_page()
        if text_per_page:
            page.insert_text((72, 72), text_per_page, fontsize=11)
    doc.save(path)
    doc.close()
    return path


def test_有文本层的pdf能抽出正文(tmp_path: Path) -> None:
    body = "This chapter explains the control loop in detail. " * 4
    got = extract_pdf(_make_pdf(tmp_path / "ok.pdf", 3, body))
    assert got.reject_reason is None
    assert got.pages == 3
    assert "control loop" in got.text


def test_扫描件被退回且理由能照着办(tmp_path: Path) -> None:
    """空白页模拟整页扫描图：没有文本层。"""
    got = extract_pdf(_make_pdf(tmp_path / "scan.pdf", 5, ""))
    assert got.text == ""
    assert got.reject_reason
    assert "扫描件" in got.reject_reason
    assert "OCR" in got.reject_reason, "得告诉人能怎么办，不能只说不行"
    assert str(MIN_CHARS_PER_PAGE) in got.reject_reason, "得写清是哪道门没过"


def test_坏文件不抛异常只退回(tmp_path: Path) -> None:
    """损坏/加密/根本不是 PDF 都不许把整次接入炸掉——一个坏文件不该毁掉一批书。"""
    bad = tmp_path / "broken.pdf"
    bad.write_bytes(b"%PDF-1.4 this is not really a pdf")
    got = extract_pdf(bad)
    assert got.text == ""
    assert got.reject_reason


@pytest.mark.skipif(not REAL_BOOKS.exists(), reason="验收包不在这台机器上")
def test_验收包三本书全判扫描件() -> None:
    """把 2026-08-22 的实测钉住：三本教材都是整页图、零文本层。

    量到的数：PLC 259 页每页 3 字、导论 408 页每页 0 字、机器人 210 页每页 0 字。
    带文本层的技术书每页上千字，两类之间差三个数量级，门线 50 落在空档里。
    """
    books = sorted(REAL_BOOKS.glob("*.pdf"))
    assert books, "验收包里应当有 PDF"
    for book in books:
        got = extract_pdf(book)
        assert got.reject_reason, f"{book.name} 应判为扫描件，实际抽出 {len(got.text)} 字"
        assert "扫描件" in got.reject_reason


# ── 页码噪声清理 ──────────────────────────────────────────────

from backend.rag.pdf_extract import strip_page_furniture  # noqa: E402


def test_逐页页码被清掉() -> None:
    """抽取器按页拼接，页脚的 `124 / 853` 会原样混进正文。

    实测《动手学ROS2》854 页抽出 24,854 行，其中 853 行是纯页码（占 3.4%）。
    不清就会被切进正文块，检索命中时上屏是一句「124 / 853」——往语料里掺沙子。
    """
    got = strip_page_furniture("第一段\n124 / 853\n第二段\n125 / 853\n第三段")
    assert got == "第一段\n第二段\n第三段"


def test_正文里的分数不误删() -> None:
    """只删整行就是页码的。正文里的比值、分数、章节号都要留着。"""
    for keep in ("速度是 3/4 米每秒", "占比 12 / 100 已达标", "见 3/4 章"):
        assert strip_page_furniture(keep) == keep


def test_全角斜杠与不换行空格也认() -> None:
    """PyMuPDF 抽出的页码，分隔常是 \xa0 而不是普通空格；有的书用全角斜杠。"""
    assert strip_page_furniture("正文\n12\xa0/\xa0853\n继续") == "正文\n继续"
    assert strip_page_furniture("正文\n12 ／ 853\n继续") == "正文\n继续"
