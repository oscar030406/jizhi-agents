"""扫描件 PDF 的 VLM 转写（WO-N16 A1 补强）。

## 这个模块解决什么

`pdf_extract` 判出扫描件之后原来就退回了——理由写得清楚，但书还是进不来。
用户的原话是「扫描件人类能读我们读不了」，那不是能力边界，是我们没做。

管理者手上的教材大量是扫描件。实测验收包三本：

    S7-1200 PLC编程及应用（第3版）廖常初   259页  每页 3 字
    智能制造导论 周济 李培根              408页  每页 0 字
    机器人技术基础 刘英 朱银龙             210页  每页 0 字

零文本层，整本是图。抽取器做得再好也读不出来，得让视觉模型看。

## 选型（实测，不是查文档）

拿廖常初书第 41 页（纯文字页、有真实标题层级可核）跑了三个：

| 模型 | 耗时 | 结果 |
|---|---|---|
| `deepseek-ai/DeepSeek-OCR` | 4.1s | 正文准，但裹着 `<|ref|><|det|>[[45,62,930,126]]` 版面坐标，要写剥离层 |
| `PaddlePaddle/PaddleOCR-VL-1.5` | 13.9s | **退化成 `1. 2. 3. … 161.` 数字循环，废掉** |
| **`Qwen/Qwen3-VL-8B-Instruct`** | 17.0s | **直接出干净 markdown，标题层级与编号全对** |

选 Qwen3-VL-8B。决定性理由不是质量分高一点，是**两个专用 OCR 都不吃自定义
prompt**——我用「图片用 `[图：描述]` 代替、一个字都不要编」去调，DeepSeek-OCR
返回 0 字、PaddleOCR 只吐了个页码。换成它们惯用的固定指令才动，但那样就**没法
约束它别编造图纸内容**，而那恰恰是这里最不能让步的一条：接线图上一根线错了
是安全事故。

## dpi：100 而不是 150

    dpi=100   827×1249   in=1077 tok  out=709 tok  转写 1177 字
    dpi=150  1241×1873   in=2364 tok  out=710 tok  转写 1179 字

**输入 token 少 55%，转写内容几乎一字不差。** 877 页合计约 0.94M 输入 +
0.62M 输出，8B 档是个位数人民币。

## 图怎么办：图随文走，不解释

VLM **不描述图纸内容**（元件、连线关系）——那是编造风险最高处。
页图原样存进 `figures/`，正文里留 `[图：pNNN → figures/pNNN.png]` 占位，
课程生成引用到这一块时嵌原图。学习者看真图纸，不看模型转述。
图旁的解释只用原书正文自带的图注文字。

## 断点续跑

877 页跑一小时，中间断一次不能全重来。每页转写完立刻落盘成
`pages/pNNN.md`，重跑时已存在的页直接跳过。这也让页级进度成为可能——
投币口那次「转了八分钟只有三个字」的教训刚流过血。
"""
from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

#: 渲染页图的分辨率。100 与 150 的转写内容实测几乎一致，输入 token 差一倍多。
RENDER_DPI = 100

#: 默认走这个（两个专用 OCR 模型实测都不可用，理由见模块文档）。
#: 开环境变量口子（L7）：换厂商时这条离线链的失败形态是「模型不存在」，
#: 发现得晚——给个不改码的替换通道。
import os as _os

TRANSCRIBE_MODEL = _os.environ.get("TRANSCRIBE_MODEL", "Qwen/Qwen3-VL-8B-Instruct")

#: 同时转几页。8B 档延迟约 17s/页，4 路把 877 页压到一小时出头；
#: 再高就开始撞限流，而且失败重试的代价变大。
CONCURRENCY = 4

TRANSCRIBE_PROMPT = (
    "把这一页扫描件转写成 markdown。要求：\n"
    "1. 只转写图上真实存在的文字，一个字都不要编。看不清的地方写 `[?]`，不要猜。\n"
    "2. 保留标题层级（用 # ## ###）、编号列表、段落结构。\n"
    "3. 图片、表格、电路图、梯形图这类非文字内容，用一行 `[图：简短描述]` 代替。"
    "**绝对不要描述图里的元件、连线、数值**——描述错了会被当成操作依据。\n"
    "4. 页眉页脚的孤立页码不要转写。\n"
    "5. 直接输出 markdown，不要任何解释、不要代码围栏。"
)

#: 转写结果里的图占位。课程生成认这个格式去嵌原图。
# 注意 re.M：这个模式要在整篇多行文本里逐行匹配。第一版漏了它，
# `match()` 单行测试是绿的、`sub()` 在整页文本上却一处都替换不到——
# 图引用全部丢失，而拼装出来的 markdown 看起来完全正常。
FIGURE_LINE = re.compile(r"^[ 	]*\[图[：:]\s*(?P<caption>[^\]]*)\][ 	]*$", re.M)


@dataclass
class PageResult:
    page: int
    text: str
    #: 这一页有几行是图占位。图密集章节靠它识别。
    figure_lines: int = 0
    error: str | None = None


@dataclass
class TranscribeReport:
    pages_total: int = 0
    pages_done: int = 0
    pages_failed: int = 0
    pages_skipped: int = 0
    figure_lines: int = 0
    chars: int = 0
    failures: list[dict] = field(default_factory=list)

    @property
    def figure_density(self) -> float:
        """图占位行占总产出行的比例。高的章节是「图密集（已带原图）」，不是「信息缺失」。"""
        return self.figure_lines / max(1, self.pages_done)

    def summary(self) -> str:
        parts = [f"转写 {self.pages_done}/{self.pages_total} 页", f"{self.chars:,} 字"]
        if self.pages_skipped:
            parts.append(f"跳过已转写 {self.pages_skipped} 页")
        if self.pages_failed:
            parts.append(f"失败 {self.pages_failed} 页（这些页的内容不会进库）")
        if self.figure_lines:
            parts.append(f"图占位 {self.figure_lines} 处（原图已存，课程里嵌原件）")
        return "；".join(parts) + "。"


#: 一页里同一个短串重复多少次算退化。**按实测分布定，不是拍的**：
#: 廖常初书 259 页里有 `[?]` 的 26 页，个数分布是
#: 1×5页 / 2×9页 / 3×2页 / 4×1页 / 5×1页 // 7,8,11,11,11,11,13,1807 各一页——
#: 正常页落在 1–5，退化页从 7 起跳，中间有干净空档。取 6 卡在空档里。
MAX_REPEATED_TOKEN = 6

#: 退化检测看的短串。都是模型卡住时最容易刷的东西。
_DEGENERATE_TOKENS = ("[?]", "[图：", "...", "。。。")


def looks_degenerate(text: str) -> str | None:
    """这页是不是模型卡住刷出来的。是就返回原因，不是返回 None。

    模型会在某些页把同一个 token 刷到 max_tokens。实测全本 259 页里 8 页退化，
    最坏一页刷了 1807 个 `[?]`——那页是软件安装截图，开头转得好好的
    （「欢迎使用 STEP 7 Professional」），转到密集小字的许可协议时开始重复。

    **这种输出看起来是正常转写**：有正文、有结构、字数还很多（7913 字）。
    不检测就直接进库，检索命中的是一串 `[?] [?] [?]`。

    与 PaddleOCR 那次「退化成 1. 2. 3. … 161. 数字循环」同一个失败模式——
    自回归生成的通病，不绑某个模型，所以检测放在通用层。
    """
    for token in _DEGENERATE_TOKENS:
        n = text.count(token)
        if n > MAX_REPEATED_TOKEN:
            return f"疑似退化：「{token}」重复 {n} 次（上限 {MAX_REPEATED_TOKEN}）"
    # 另一种形态：整页几乎只有一种字符
    stripped = "".join(text.split())
    if len(stripped) > 200 and len(set(stripped)) < 12:
        return f"疑似退化：整页只有 {len(set(stripped))} 种字符"
    return None


def page_path(out_dir: Path, page: int) -> Path:
    return out_dir / "pages" / f"p{page:04d}.md"


def figure_path(out_dir: Path, page: int) -> Path:
    return out_dir / "figures" / f"p{page:04d}.png"


def count_figure_lines(text: str) -> int:
    return sum(1 for line in text.splitlines() if FIGURE_LINE.match(line))


def render_page(doc, page: int, dest: Path, dpi: int = RENDER_DPI) -> Path:
    """把一页渲成 png 落盘。原图要留着——课程里嵌的是它，不是模型的转述。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    doc[page].get_pixmap(dpi=dpi).save(dest)
    return dest


def transcribe_pdf(
    pdf: Path,
    out_dir: Path,
    *,
    call_model: Callable[[Path], str],
    on_progress: Callable[[int, int], None] | None = None,
    max_pages: int | None = None,
) -> TranscribeReport:
    """逐页转写一本扫描件。**已转写的页直接跳过**，支持断点续跑。

    `call_model` 收一张页图的路径、返回 markdown——把 API 细节留在外面，
    这个函数只管分页、落盘、续跑、统计，测试里可以塞个假的进来。
    """
    import fitz

    doc = fitz.open(pdf)
    total = doc.page_count if max_pages is None else min(doc.page_count, max_pages)
    report = TranscribeReport(pages_total=total)

    # 渲染在主线程做（PyMuPDF 的 Document 不是线程安全的），调模型才并发。
    # 每页各写各的文件，所以顺序天然无关；只有计数与报告要上锁。
    tally = Lock()

    def note_done(text: str, skipped: bool = False) -> None:
        with tally:
            if skipped:
                report.pages_skipped += 1
            report.pages_done += 1
            report.chars += len(text)
            report.figure_lines += count_figure_lines(text)
            done = report.pages_done
        if on_progress:
            on_progress(done, total)

    def note_failed(page: int, why: str) -> None:
        with tally:
            report.pages_failed += 1
            report.failures.append({"page": page, "error": why})
            done = report.pages_done
        if on_progress:
            on_progress(done, total)

    def transcribe_one(page: int, image: Path) -> None:
        target = page_path(out_dir, page)
        try:
            text = call_model(image).strip()
        except Exception as exc:  # 单页失败不该毁掉整本
            note_failed(page, f"{type(exc).__name__}: {exc}")
            return
        if not text:
            # 空结果不落盘：落了下次续跑会当成「已转写」，那一页就永远缺了。
            note_failed(page, "模型返回空")
            return
        degenerate = looks_degenerate(text)
        if degenerate:
            # 退化的输出**不落盘**，理由同上：落了就再也不会重转。
            # 报到 failures 里，管理者能看见这一页没转成。
            note_failed(page, degenerate)
            return
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        note_done(text)

    try:
        pending: list[tuple[int, Path]] = []
        for page in range(total):
            target = page_path(out_dir, page)
            if target.exists() and target.stat().st_size > 0:
                # 断点续跑：这一页上次已经转完了。图也应该在，缺了就补渲。
                if not figure_path(out_dir, page).exists():
                    render_page(doc, page, figure_path(out_dir, page))
                note_done(target.read_text(encoding="utf-8"), skipped=True)
                continue
            pending.append((page, render_page(doc, page, figure_path(out_dir, page))))

        if pending:
            with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
                list(pool.map(lambda args: transcribe_one(*args), pending))
    finally:
        doc.close()

    (out_dir / "transcribe.json").write_text(
        json.dumps(
            {
                "pdf": pdf.name,
                "model": TRANSCRIBE_MODEL,
                "dpi": RENDER_DPI,
                "pages_total": report.pages_total,
                "pages_done": report.pages_done,
                "pages_failed": report.pages_failed,
                "figure_lines": report.figure_lines,
                "failures": report.failures[:50],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return report


def assemble(out_dir: Path, pdf_name: str) -> str:
    """把逐页 markdown 拼成一份，图占位补上可解析的引用。

    占位从 `[图：接线示意]` 变成 `[图：接线示意 → figures/p0123.png]`——
    切块时随文走，课程生成据此嵌原图。
    """
    pages = sorted((out_dir / "pages").glob("p*.md"))
    chunks: list[str] = [f"# {Path(pdf_name).stem}\n"]
    for page_file in pages:
        page = int(page_file.stem[1:])
        body = page_file.read_text(encoding="utf-8")
        rel = f"figures/p{page:04d}.png"
        body = FIGURE_LINE.sub(
            lambda m: f"[图：{m.group('caption').strip() or '原书插图'} → {rel}]", body
        )
        chunks.append(body)
    return "\n\n".join(chunks)
