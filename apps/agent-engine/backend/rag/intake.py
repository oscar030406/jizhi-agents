"""接入的前三步：文件分诊、结构元数据、许可识别。

这是「知识库接入 Agent」的入口段。它替掉的人工劳动很具体——现在换一个知识库要人去写一个
`ingest_*.py`，在里面手写 `CURATED` 常量（收哪些文件、跳哪些、每章什么难度）。
那份脚本的存在本身就是泛化证据被污染的原因：我们证明的是「能给新域写脚本」，
不是「系统能吸收新域」。

**产物格式不变**：这一段最终仍然产出 `data/knowledge_base/<name>_docs/*.md` + front-matter，
`load_markdown_chunks` / `build_knowledge_base.py` / 嵌入索引一行不改。不发明新格式。

## 三条边界，都是诚实口径不是技术妥协

1. **格式分诊做不完**。v1 只吃 md/txt，其余进「未接入文件」清单退回。
   可控失败优于静默出乱码——退回清单是产品特性，不是缺陷。假装通吃更容易被打穿。
2. **许可自动判定有天花板**。中文开源项目常把许可写在 README 而不是 LICENSE 文件
   （`ingest_llm_deploy.py` 那次就是人去翻 README 才确认的）。这里做到「找得到就判，
   找不到就标 UNKNOWN 并阻塞」，不猜。
3. **切块行为不动**。`split_into_sections` 现有的 1704 个 chunk 和三个对外指标全建在它上面，
   这里只**旁挂**结构元数据，不改切法。
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from backend.rag.injection_scan import scan_text
from backend.rag.pdf_extract import extract_pdf

from backend.rag.ingest import split_into_sections

# --------------------------------------------------------------------------
# 步骤 0：文件分诊
# --------------------------------------------------------------------------

#: 能直读的格式。加格式就是加分支，加之前先问这个域是不是真的需要。
#:
#: `.rst` 是 08-21 加的，加它的同时必须把 `read_body` 那条转换接上——**只加后缀
#: 不还原结构等于又造一份废语料**：rst 的标题层级写在下划线里（`====` / `----`），
#: 一个 `#` 都没有，直接喂给按 `#` 切块的下游，一篇十节的文档会压成一段大平铺。
#: K1 那次 odoo 走 `.po` 就是这么丢的结构（`.po` 里连下划线都没有），金标退化成
#: `fedex` / `labels` / `../setup_configuration`，11 屏错误判定，见
#: `作品设计实现方案.docx` §7.2。
READABLE_SUFFIXES = {".md", ".markdown", ".txt", ".rst", ".pdf"}

#: 短于此长度的文件当占位符跳过。`ingest_llm_deploy.py` 里人工跳过的 `chapter1_4`
#: 就是个 131B 的占位文件——那条人工判断在这里变成规则。
MIN_USEFUL_CHARS = 200

#: 文件名命中即跳过：小结/总结类与正文重叠，收进来是重复语料。
#: 沿用既有 ingest 脚本的口径（happy-llm / llm-deploy 两个脚本都这么跳的）。
SKIP_NAME_PATTERNS = (
    re.compile(r"(?:^|[_/-])(?:summary|conclusion)(?:$|[_.-])", re.I),
    re.compile(r"(?:小结|总结|习题答案)"),
)


@dataclass
class TriagedFile:
    path: Path
    relative: str
    #: 相对根目录的路径深度。`.po` 之类还原不出标题层级时用它兜底当结构深度。
    path_depth: int
    chars: int


@dataclass
class IntakeManifest:
    accepted: list[TriagedFile] = field(default_factory=list)
    #: (相对路径, 退回理由)。这份清单要原样进就绪度报告——不许静默丢文件。
    rejected: list[tuple[str, str]] = field(default_factory=list)
    #: 扫描件 PDF：抽不出文本层，但**不是废料**——交给视觉模型逐页转写还能用。
    #: 这里只登记，实际转写在接收站①做：`triage` 是纯函数、不联网，
    #: 把一个几十分钟的网络操作塞进分诊会让它既不可中断也给不出进度。
    pending_transcribe: list[tuple[str, str]] = field(default_factory=list)
    #: 提示注入特征命中（WO-N16 B14）。**只标不拦**：我们自己的《提示工程指南》
    #: 正经讲的就是注入，正文里必然出现这些字样，拒收等于把讲安全的教材挡在门外。
    #: 处置权留给管理者——他知道自己传的是什么书。
    injection_hits: list[dict] = field(default_factory=list)

    @property
    def accepted_chars(self) -> int:
        return sum(f.chars for f in self.accepted)


#: 整棵跳过、**不进退回清单**的目录。退回清单是给人看的产物，
#: 混进 186 个 `.git` 内部文件就等于没有清单（实测：投一个 git 仓库进来，
#: 45 个正文文件配 186 条退回记录，全是 hooks 样例和对象库）。
#: 这些目录的内容从来不是教材，不需要逐条交代为什么没收。
SKIP_DIRS = {".git", ".svn", ".hg", "node_modules", ".venv", "venv", "__pycache__", ".idea", ".vscode"}


def read_body(path: Path) -> str:
    """读一个文档，**统一返回 markdown**。下游（切块、结构、金标）只认 markdown。

    非 rst 原样返回；`.rst` 过一遍 `scripts/rst_to_markdown.convert`，把下划线标题
    还原成 `#` / `##` / `###`。定级规则不是启发式，是 reStructuredText 规范本身：
    同一个装饰字符是同一级，级别按**首次出现顺序**排。那份转换器另有守门测试
    （`tests/test_rst_to_markdown.py`），顺带处理掉 `.. toctree::`（导航条目不是正文）
    与 `:doc:` 交叉引用（转成 markdown 链接，`structure_edges.page_refs()` 才认得出）。

    这里不给译文表——接入的是什么语言就是什么语言，`convert` 查不到就回落原文。
    翻译是 `scripts/rst_to_markdown.py` 那条 CLI 的事，不是接入链的事。

    `.pdf` 走 `pdf_extract`（`triage` 已经把抽不出正文的挡在外面了，能走到这里的
    都带文本层）。不在这里判扫描件——判据留在 `triage` 一处，两处判会长歪。

    编码严格读：非 utf-8 的二进制在这一行就抛，由 `triage` 退回并写明理由。
    """
    if path.suffix.lower() == ".pdf":
        return extract_pdf(path).text
    text = path.read_text(encoding="utf-8")
    if path.suffix.lower() != ".rst":
        return text
    scripts = str(Path(__file__).resolve().parents[2] / "scripts")
    if scripts not in sys.path:
        sys.path.insert(0, scripts)
    from rst_to_markdown import convert  # type: ignore[import-not-found]

    body, _hit, _miss = convert(path, {})
    return body


def normalize_rst_dir(root: Path) -> list[tuple[str, str]]:
    """把一棵目录里的 `.rst` 就地换成同名 `.md`（内容已还原成 markdown 标题层级）。

    只用在**流水线自己的 run 目录**上，不碰用户的源目录。为什么非换后缀不可：
    下游有三处只认 `.md`——`scripts/derive_kc_gold.py` 的 `rglob("*.md")`、
    `structure_edges.probe()` 的同款、以及 ⑤ 开跑前那句「这份语料里没有 .md」的判断。
    不换的话会出现「文件收进来了、索引也建了、金标一条没派生」的半哑状态，
    而这三站的失败是静默的（skipped 不算 run 失败）。

    原件不留：留着 `triage` 会把同一份内容再收一遍，索引里出现两份。
    """
    converted: list[tuple[str, str]] = []
    for rst in sorted(root.rglob("*.rst")):
        target = rst.with_suffix(".md")
        if target.exists():  # 同名 md 已在，换个不撞的名字，谁都不覆盖
            target = rst.with_name(rst.stem + ".rst.md")
        target.write_text(read_body(rst), encoding="utf-8")
        rst.unlink()
        converted.append((rst.relative_to(root).as_posix(), target.relative_to(root).as_posix()))
    return converted


def triage(root: Path) -> IntakeManifest:
    """走一遍投进来的目录，分成「能接」和「退回并说明理由」两堆。"""
    manifest = IntakeManifest()
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts[:-1]):
            continue
        relative = path.relative_to(root).as_posix()
        if path.suffix.lower() not in READABLE_SUFFIXES:
            manifest.rejected.append((relative, f"v1 不解析 {path.suffix or '无扩展名'} 格式"))
            continue
        if any(p.search(relative) for p in SKIP_NAME_PATTERNS):
            manifest.rejected.append((relative, "小结/总结类，内容与正文重叠"))
            continue
        if path.suffix.lower() == ".pdf":
            # PDF 走单独一条：抽不出正文的（扫描件、加密、损坏）在这里如实退回。
            # 不能让它带着 0 字正文往下走——那样文件记成「已接收」、切出 0 块、
            # 建个空索引，最后库建成了报告一片绿，里面什么都没有。
            extracted = extract_pdf(path)
            if extracted.reject_reason:
                if "扫描件" in extracted.reject_reason:
                    # 扫描件不退回：整本是图、没有文本层，但视觉模型读得出来。
                    # 用户原话「扫描件人类能读我们读不了」——那不是能力边界，是没做。
                    manifest.pending_transcribe.append((relative, extracted.reject_reason))
                else:
                    # 加密、损坏、装不上解析器——这些转写也救不了，如实退回。
                    manifest.rejected.append((relative, extracted.reject_reason))
                continue
            text = extracted.text
        else:
            try:
                text = read_body(path)
            except (UnicodeDecodeError, OSError) as err:
                manifest.rejected.append((relative, f"读取失败：{type(err).__name__}"))
                continue
        if len(text.strip()) < MIN_USEFUL_CHARS:
            manifest.rejected.append((relative, f"正文不足 {MIN_USEFUL_CHARS} 字符，疑似占位文件"))
            continue
        for hit in scan_text(text, relative):
            manifest.injection_hits.append(
                {"file": hit.file, "line": hit.line, "rule": hit.rule,
                 "what": hit.what, "excerpt": hit.excerpt}
            )
        manifest.accepted.append(
            TriagedFile(
                path=path,
                relative=relative,
                path_depth=len(path.relative_to(root).parts),
                chars=len(text),
            )
        )
    return manifest


# --------------------------------------------------------------------------
# 步骤 1：结构元数据（旁挂，不改切法）
# --------------------------------------------------------------------------

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*$", re.M)


@dataclass
class SectionMeta:
    order: int
    text: str
    #: H1 → H2 → H3 的标题路径。取不到标题时为空。
    heading_path: list[str]
    #: 结构深度。有标题路径用它的长度，没有就回落文件路径深度——
    #: 这条兜底是给 `.po` 之类的格式准备的：rst 的标题级别由下划线字符表达，
    #: 而下划线不是可翻译字符串、不进 `.po`，所以那条路上只能拿路径深度当结构信号。
    depth: int


def _document_title(body: str) -> str | None:
    m = re.search(r"^#\s+(.+?)\s*#*$", body, re.M)
    return m.group(1).strip() if m else None


def outline_sections(body: str, *, path_depth: int = 1) -> list[SectionMeta]:
    """给 `split_into_sections` 的每一段配上标题路径与结构深度。

    切法完全交给既有实现——这里只负责认出每段挂在哪个标题下面。
    合并过的段可能含多个标题，取**第一个**作为归属。
    """
    doc_title = _document_title(body)
    metas: list[SectionMeta] = []
    for order, text in enumerate(split_into_sections(body), start=1):
        m = _HEADING.search(text)
        path: list[str] = []
        if doc_title:
            path.append(doc_title)
        if m:
            level, heading = len(m.group(1)), m.group(2).strip()
            if level == 1:
                path = [heading]
            elif heading not in path:
                path.append(heading)
        metas.append(
            SectionMeta(
                order=order,
                text=text,
                heading_path=path,
                depth=len(path) if path else path_depth,
            )
        )
    return metas


# --------------------------------------------------------------------------
# 步骤 2：许可识别
# --------------------------------------------------------------------------

UNKNOWN_LICENSE = "UNKNOWN"

#: 判据按「越具体越先匹配」排序——CC BY-NC-SA 的正文同时含 BY-SA 的特征串，
#: 顺序反了会把 NC 系误判成 SA 系，而那两个恰恰是**不能混进同一门课**的一对。
_LICENSE_SIGNATURES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("CC-BY-NC-SA-4.0", ("attribution-noncommercial-sharealike 4.0", "by-nc-sa/4.0", "署名-非商业性使用-相同方式共享 4.0", "署名-非商业-相同方式共享")),
    ("CC-BY-NC-4.0", ("attribution-noncommercial 4.0", "by-nc/4.0")),
    ("CC-BY-SA-4.0", ("attribution-sharealike 4.0", "by-sa/4.0", "署名-相同方式共享 4.0")),
    ("CC-BY-4.0", ("attribution 4.0 international", "by/4.0")),
    ("CC0-1.0", ("cc0 1.0", "creative commons zero", "publicdomain/zero/1.0")),
    ("AGPL-3.0", ("gnu affero general public license",)),
    ("GPL-3.0", ("gnu general public license",)),
    ("Apache-2.0", ("apache license", "apache-2.0")),
    ("MIT", ("mit license", "permission is hereby granted, free of charge")),
)

_LICENSE_FILENAMES = ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "COPYING.md")

#: README 里的许可小节。中文项目常把许可写在这儿而不是 LICENSE 文件——
#: llm-deploy 就是这样（仓库没有 LICENSE 文件，许可写在 README 的 LICENSE 节）。
_README_LICENSE_SECTION = re.compile(
    r"^#{1,6}\s*(?:license|licence|许可|授权|版权)\b.*?$(.{0,1200})",
    re.I | re.M | re.S,
)

#: 宽松许可。留着只为在报告里分类展示，**不做准入判据**——见文件末尾的墓碑注释。
PERMISSIVE = frozenset({"MIT", "Apache-2.0", "CC0-1.0", "CC-BY-4.0"})


@dataclass
class LicenseInfo:
    spdx: str
    #: 在哪看到的，要能被复核。判 UNKNOWN 时写「找遍了哪些位置」。
    evidence: str

    @property
    def unknown(self) -> bool:
        """判不出许可**不阻塞接入**，只进就绪度报告的待确认项。

        一版写的是阻塞，过重了：本项目非商用、来源逐条署名，NC/SA 那类冲突不触发。
        记录仍然要留——不是为合规，是为**溯源**：依据子盒要求每个断言指得回出处，
        来源记全了许可只是顺带一列，成本为零。
        """
        return self.spdx == UNKNOWN_LICENSE


def _match_signature(text: str) -> str | None:
    low = text.lower()
    for spdx, needles in _LICENSE_SIGNATURES:
        if any(n in low for n in needles):
            return spdx
    return None


#: 向上找许可最多走几层。人一般指的是仓库里的**内容子目录**
#: （`repo/src/zh/UserGuide/Master`），而 LICENSE 躺在仓库根——只查投进来那一层
#: 会把许可明确的仓库判成 UNKNOWN（实测：IoTDB 的 Apache-2.0 就这么被判丢了）。
#: 向上找的**真正边界是 `.git`（仓库根）**，这个计数只是无 git 语料时的兜底上限。
#:
#: 定 6 不是拍的：实测 `iotdb-docs/src/zh/UserGuide/Master` 距仓库根 4 层，
#: 一版收到 4 时刚好在探到根之前停住，把 Apache-2.0 判成了 UNKNOWN——
#: 「收紧」把功能收没了。文档仓库嵌到五六层很常见，6 是留出余量后的值。
#:
#: 上限存在的意义是防止在**没有 .git 的语料**上一路走到用户主目录去认领不相干的许可。
#: 找到的许可**一律把路径写进 evidence**（相对语料根，见 `_rel`），
#: 来自上层目录时写成 `../../LICENSE`，人一眼能看出来并否掉。
_LICENSE_WALK_UP = 6


def _rel(path: Path, base: Path) -> str:
    """判据串里的路径一律相对语料根写。

    这一串会原样透传到接入页的「许可 → 判据」列，也就是会上屏。写绝对路径就把跑机器的
    用户名（`C:\\Users\\<人名>\\...`）一起印上去了。相对写法照样能看出许可来自上层目录
    （`../../LICENSE`），上面那条「上层许可人一眼能否掉」的要求不受影响。
    """
    try:
        return Path(os.path.relpath(path, base)).as_posix()
    except ValueError:  # Windows 跨盘符算不出相对路径
        return path.name


def _probe_license_dir(directory: Path, base: Path, searched: list[str]) -> LicenseInfo | None:
    for name in _LICENSE_FILENAMES:
        path = directory / name
        rel = _rel(path, base)
        searched.append(rel)
        if not path.is_file():
            continue
        spdx = _match_signature(path.read_text(encoding="utf-8", errors="ignore"))
        if spdx:
            return LicenseInfo(spdx=spdx, evidence=f"{rel} 正文匹配")
        return LicenseInfo(spdx=UNKNOWN_LICENSE, evidence=f"{rel} 存在但正文不匹配任何已知许可")

    for readme in ("README.md", "README.rst", "README.txt", "README"):
        path = directory / readme
        rel = _rel(path, base)
        searched.append(rel)
        if not path.is_file():
            continue
        section = _README_LICENSE_SECTION.search(path.read_text(encoding="utf-8", errors="ignore"))
        if section:
            spdx = _match_signature(section.group(1))
            if spdx:
                return LicenseInfo(spdx=spdx, evidence=f"{rel} 的许可小节")
    return None


def detect_license(root: Path) -> LicenseInfo:
    """先在投进来的目录找，找不到就逐层向上——LICENSE 通常在仓库根，内容在子目录。

    向上到 `.git` 所在层就停：那是仓库边界，再往上是别人的东西。
    """
    searched: list[str] = []
    base = root.resolve()
    here = base
    for _ in range(_LICENSE_WALK_UP):
        got = _probe_license_dir(here, base, searched)
        if got and not got.unknown:
            return got
        if (here / ".git").exists() or here.parent == here:
            break
        here = here.parent
    tail = "、".join(dict.fromkeys(Path(x).name for x in searched))[:120]
    return LicenseInfo(
        spdx=UNKNOWN_LICENSE,
        evidence=(
            f"未找到许可声明；自语料根向上查了 {len(searched)} 处（{tail}），"
            f"最上到 {_rel(here, base)}"
        ),
    )


# --------------------------------------------------------------------------
# 墓碑：这里一度有个 `compatible(a, b)` 许可相容性闸门——**不要加回来**
# --------------------------------------------------------------------------
# 一版据「CC BY-SA 与 CC BY-NC-SA 不能混进同一件改编作品」写了个准入判据，让生成器
# 按它挑 chunk。撤掉了，理由是那条冲突在我们的用法下**根本不触发**：
#
#   BY-SA 与 BY-NC-SA 的互斥点在「再分发时能不能加 NC 限制」。本项目非商用、
#   每条来源逐条署名进 manifest，落不到那个冲突面上。
#
# 而它的代价是实的：一道许可闸会在生成时把内容合适的 chunk 挡在外面，
# 直接伤的是覆盖率和摘录质量——也就是我们真正要保的那个东西。
#
# **许可仍然逐条记录**，那是溯源链的一部分（依据子盒要求断言指得回出处），
# 不是准入条件。判不出来的进就绪度报告的待确认项，不拦。
#
# 附带一条判据更正：调研按许可否掉的几个候选，真正该用的否决理由不是许可——
# TDengine 是「部分章节写的是闭源企业版功能，内容无法本地复现」（幻觉率进不了分母）；
# 人社部标准是「职业等级 ≠ 文本难度，是不同的轴」。按内容可核性重排，结论不变。
