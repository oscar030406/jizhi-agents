"""PDF 正文抽取与扫描件识别（WO-N16 A1）。

## 为什么要单独判「扫描件」

管理者手里的教材大多是 PDF，这是投币口绕不开的一种形态。但 PDF 有两种：
带文本层的（电子排版直接导出）和**整页扫描图**（把纸书拍下来）。抽取器对后者
返回空字符串——不报错，就是空。

这里的危险不是抽不出来，是**抽出来 0 字还照样往下走**：文件被记成「已接收」，
切块切出 0 块，索引建了个空的，最后库建成了、报告上一片绿、里面什么都没有。
这条链上每一站单独看都「成功」了。

所以判据是：**抽完看每页平均字数**。低于门线就当扫描件退回，并在退回理由里
写清它是什么、为什么、能怎么办（OCR）。退回是可见的，静默入空库不可见。

## 门线怎么定的（不是拍的）

拿验收包里三本真书量的（2026-08-22，PyMuPDF）：

    S7-1200 PLC编程及应用（第3版）廖常初   73.7MB  259页  每页  3 字
    智能制造导论 周济 李培根              104.2MB  408页  每页  0 字
    机器人技术基础 刘英 朱银龙             47.0MB  210页  每页  0 字

三本全是每页一张整页图、零文本层。作为对照，带文本层的技术书每页通常上千字。
两类之间差着三个数量级，门线放在 `MIN_CHARS_PER_PAGE = 50` 落在空档中间，
不会误伤图多字少的正常书（图册、习题册每页也有百字级的说明文字）。

顺带一条给上游的实测：**PDF 的体积不是文本的体积**。104MB 的书抽出 0 字，
而另一本 30MB / 346 页的电子书抽出来只有 0.57MB 正文——图片占 98%。
按 PDF 原文件字节数卡上限会把正常教材全拦在门外。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

#: 每页平均字符数低于此值，判为扫描件。依据见模块文档。
MIN_CHARS_PER_PAGE = 50
#: 抽取时最多读多少页——判「是不是扫描件」不需要读完一本 400 页的书。
PROBE_PAGES = 40


#: 页眉页脚里的页码行，形如 `124 / 853`（PyMuPDF 抽出来时中间常是不换行空格）。
#: 抽取器按页拼接，这些行会原样混进正文；一本 854 页的书就是 853 行噪声（实测占 3.4%）。
#: 它们会被切进正文块，检索命中时上屏就是一句「124 / 853」——不删就是往语料里掺沙子。
_PAGE_NUMBER_LINE = re.compile(r"^\s*\d+\s*[/／]\s*\d+\s*$")


def strip_page_furniture(text: str) -> str:
    """去掉逐页重复的页码行。只删整行就是页码的，不碰正文里出现的分数。"""
    kept = [
        line
        for line in text.splitlines()
        if not _PAGE_NUMBER_LINE.match(line.replace("\xa0", " "))
    ]
    return "\n".join(kept)


@dataclass
class PdfText:
    text: str
    pages: int
    #: 抽不出正文时的人话理由；能抽出来就是 None。
    reject_reason: str | None = None


def extract_pdf(path: Path) -> PdfText:
    """抽 PDF 正文。抽不动就说清为什么，不返回空字符串让下游当成「这本书没内容」。"""
    try:
        import fitz  # PyMuPDF
    except ImportError:
        return PdfText("", 0, "环境里没装 PyMuPDF，PDF 抽取不可用（pip install pymupdf）")

    try:
        doc = fitz.open(path)
    except Exception as exc:  # 损坏、加密、根本不是 PDF
        return PdfText("", 0, f"打不开这个 PDF：{type(exc).__name__} {exc}")

    try:
        pages = doc.page_count
        if pages == 0:
            return PdfText("", 0, "这个 PDF 一页都没有")

        probe = min(pages, PROBE_PAGES)
        head = "".join(doc[i].get_text() for i in range(probe))
        per_page = len(head.strip()) / probe

        if per_page < MIN_CHARS_PER_PAGE:
            return PdfText(
                "",
                pages,
                f"扫描件（前 {probe} 页平均每页只有 {per_page:.0f} 个字符，"
                f"低于 {MIN_CHARS_PER_PAGE}）：整本是图片、没有文本层，"
                "抽不出可切块的正文。需要先做 OCR 转成文字版再投。",
            )

        # 确认有文本层了，再把整本读完
        full = head if pages <= probe else "".join(doc[i].get_text() for i in range(pages))
        return PdfText(strip_page_furniture(full), pages)
    finally:
        doc.close()
