from __future__ import annotations

import json
import re
import threading
from functools import lru_cache
from pathlib import Path
from typing import Iterable, List, Sequence

from scipy.sparse import hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from backend.rag.ingest import load_markdown_chunks
from backend.schemas.resources import KnowledgeChunk, RetrievalResult


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DOC_DIR = PROJECT_ROOT / "data" / "knowledge_base" / "sample_docs"
DEFAULT_INDEX_PATH = PROJECT_ROOT / "data" / "knowledge_base" / "knowledge_index.jsonl"

# 领域语料库（"换语料库即换领域"）：默认索引是 AI 领域；其他领域各自一个子目录。
CORPORA_DIR = PROJECT_ROOT / "data" / "knowledge_base" / "corpora"
DEFAULT_CORPUS_ALIASES = {"", "default", "ai"}
#: 语料名进路径，字符集先卡死（外部 HTTP 参数是不可信输入）。
#: 单一真源：检索入口、语料库枚举、接入流水线三处都用这一条。
CORPUS_NAME_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,31}")


# ── 充分性门阈值 ────────────────────────────────────────────────────────────
# 低于这些线的检索结果不足以支撑事实陈述，宁可不接地也不喂噪声。
# 三个数都可按语料重标；改动请连带重跑 scripts/calibrate_retrieval_gate.py。
# MIN_SCORE 由 scripts/calibrate_retrieval_gate.py 扫出来，不是拍的：
# 未命中查询（石油管道形变、宋代瓷器）top1 分别是 0.0154 和 0.0000；
# 命中查询 top1 是 0.106~0.415。0.05 落在这两簇中间，三条命中全过、两条未命中全拦。
# 定到 0.12（语料分数的 P50）会误杀——"RAG 检索增强生成"这种明确命中只剩 1 块。
MIN_SCORE = 0.05      # TF-IDF 余弦 + tag 加成后的分数下限
MIN_CHUNK_CHARS = 80  # 去掉标题标记后的正文字符下限（裸标题不算证据）
MIN_CHUNKS = 2        # 少于这么多块就判定为"本次无可用接地"


def normalize_query_terms(values: Iterable[str]) -> str:
    return " ".join(v for v in values if v).strip()


def _strip_heading_marks(text: str) -> str:
    """去掉 markdown 标题标记与空白，用来判断这一块有没有正文。

    `# 2.1 注意力机制` 这种块在原始长度上看有 11 个字符，但正文是空的，
    引用它等于没引用——检索分数却可能因为标题命中关键词而虚高。
    """
    lines = [re.sub(r"^\s*#+\s*", "", ln).strip() for ln in text.splitlines()]
    return "".join(ln for ln in lines if ln)


class TfidfKnowledgeRetriever:
    def __init__(self, chunks: Sequence[KnowledgeChunk]):
        if not chunks:
            raise ValueError("knowledge base is empty")
        self.chunks = list(chunks)
        # 混合特征：词级(英文术语/标签/精确词) + 字符 n-gram(中文子串匹配)。
        # 中文无空格，纯词级会把整段中文当一个 token 导致检索失效；
        # char_wb n-gram 让中文按 2-4 字子串匹配，无需引入 jieba 等重依赖（守极简门）。
        self.word_vec = TfidfVectorizer(
            analyzer="word", ngram_range=(1, 2), token_pattern=r"(?u)\b[\w\-]+\b", lowercase=True
        )
        self.char_vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), lowercase=True)
        corpus = [self._document_text(chunk) for chunk in self.chunks]
        self.matrix = hstack([self.word_vec.fit_transform(corpus), self.char_vec.fit_transform(corpus)]).tocsr()

    def _vectorize(self, text: str):
        return hstack([self.word_vec.transform([text]), self.char_vec.transform([text])]).tocsr()

    def _document_text(self, chunk: KnowledgeChunk) -> str:
        tags = " ".join(chunk.concept_tags)
        return f"{chunk.title} {chunk.topic} {chunk.difficulty} {tags} {chunk.content}"

    def search(self, query: str, concept_tags: Sequence[str] | None = None, top_k: int = 6) -> RetrievalResult:
        concept_tags = concept_tags or []
        # 两套分数，用途不同：
        #   排序分——查询 + 概念标签一起向量化，帮助召回同主题内容
        #   门禁分——**只用原始查询**
        # 必须分开。goal_concepts 对完全无关的查询也会返回兜底概念（实测
        # "宋代瓷器烧制工艺" → ['agent_basics','rag','evaluation']），这些词被拼进
        # 查询文本后，查询与 AI 语料的余弦被抬到 0.30，门卡在这个分数上等于没卡。
        # 相关性要用用户真正问的那句话来量，不能用系统自己补进去的词。
        query_text = normalize_query_terms([query, " ".join(concept_tags)])
        scores = cosine_similarity(self._vectorize(query_text), self.matrix)[0]
        raw_scores = cosine_similarity(
            self._vectorize(normalize_query_terms([query])), self.matrix
        )[0]
        tag_set = {tag.lower() for tag in concept_tags}
        # 排序分 = 余弦 + tag 加成；但充分性门只卡**原始余弦**。
        # 教训：tag 加成每命中一个概念加 0.08，两个 tag 就能把余弦 0.01 的无关块顶到
        # 0.17。实测「宋代瓷器烧制工艺」这种完全不相关的查询，因为 goal_concepts 给了
        # 兜底概念，三个无关块全部越过了 0.05 的线。tag 命中说明"这块被标注为该主题"，
        # 不说明"这块的内容支持这次查询"——拿它当相关性证据是错的。
        ranked = []
        for index, chunk in enumerate(self.chunks):
            tag_bonus = 0.08 * len(tag_set.intersection({tag.lower() for tag in chunk.concept_tags}))
            ranked.append((float(scores[index]) + tag_bonus, float(raw_scores[index]), chunk))
        ranked.sort(key=lambda item: item[0], reverse=True)

        # 充分性门。原来是无条件返回 top_k，只在最高分 ≤0.05 时挂一句警告字符串——
        # 而那句警告下游没人读，低分块照样被当成「事实边界」喂进生成 prompt。
        # 实测后果：某场景拿到的「唯一事实来源」总共 544 字符，里面是 11 字符的裸标题
        # `# 2.1 注意力机制` 和一段离题代码；生成器被逼着照它写，判官再照它判，
        # 双方都在拿噪声当真值。
        #
        # 三道过滤，任一不过就不入选：
        #   1. 分数下限——低于此线的相关性不足以支撑事实陈述
        #   2. 长度下限——裸标题、单行断句不是可引用的证据
        #   3. 自足性——纯标题行（全是 # 或极短）没有正文，引它等于没引
        # 对照：有道 QAnything 生产配置是 rerank 分 <0.35 直接丢、chunk 800 字。
        # 我们用 TF-IDF 余弦，量纲不同，阈值按本地语料分布定在 0.12。
        # 顺序要紧：**先过滤，再取 top_k**。
        # 反过来做（先 top_k 再过滤）会被 tag 加成坑——加成把一批原始相关性很低的块
        # 顶进 top_k，过滤又把它们全刷掉，最后一块不剩，明明是命中的查询也被判成
        # 证据不足。实测 "Agent 工具调用与函数参数设计" 就是这样从 6 块变成 0 块的。
        eligible = [
            (rank_score, chunk)
            for rank_score, cosine, chunk in ranked
            if cosine >= MIN_SCORE and len(_strip_heading_marks(chunk.content)) >= MIN_CHUNK_CHARS
        ]
        selected = [
            chunk.model_copy(update={"score": round(rank_score, 4)})
            for rank_score, chunk in eligible[:top_k]
        ]

        source_ids = [chunk.source_id for chunk in selected]
        evidence_summary = "; ".join(f"{c.title}({c.source_id})" for c in selected[:4])

        # 证据不足是要下游据此改变行为的信号，不是一句可有可无的提示：
        # 命中数低于 MIN_CHUNKS 时明确告诉调用方「这次没有可用接地」。
        if len(selected) < MIN_CHUNKS:
            warning = (
                f"证据不足：过滤后仅 {len(selected)} 块可用（阈值 {MIN_CHUNKS}）。"
                f"本次不应声称有资料支撑，请按通识讲解处理并显式标注未接地。"
            )
        else:
            warning = None

        return RetrievalResult(
            retrieved_chunks=selected,
            source_ids=source_ids,
            evidence_summary=evidence_summary,
            missing_evidence_warning=warning,
        )


def load_index(
    index_path: Path = DEFAULT_INDEX_PATH,
    doc_dir: Path = DEFAULT_DOC_DIR,
    *,
    include_superseded: bool = False,
) -> List[KnowledgeChunk]:
    """索引的**唯一**装载口。默认只给活块，归档块（`superseded`）不返回。

    整库重建之后旧块留在索引里（见 `backend.rag.ingest.write_index`）。它们的用途
    只有一个：让已经出过的课按 source_id 还查得到出处。新课绝不该引到过期内容，
    所以这一层默认把它们滤掉——过滤放在这里而不是各个检索器里，是因为检索侧的
    四条路（默认 ai 的 TF-IDF、按域 TF-IDF、向量后端、`build_embedding_index.py`
    建 npz）全都从这个函数取块。放在下游就是四份实现，改漏一份就是归档块混进新课。

    `include_superseded=True` 只给按 id 精确溯源用（`lookup_source`）。
    """
    if index_path.exists():
        chunks = []
        for line in index_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                chunks.append(KnowledgeChunk(**json.loads(line)))
        # 「索引有没有内容」按原始行数判，不按过滤后的条数判：一个只剩归档块的库
        # 应该如实报「没有可检索素材」，而不是掉头去扫 docs/ 把 markdown 现切一遍
        # 冒充索引——那样重建失败会被伪装成成功。
        if chunks:
            return chunks if include_superseded else [c for c in chunks if not c.superseded]
    return load_markdown_chunks(doc_dir)


def corpus_index_path(corpus: str) -> Path | None:
    """语料名 → 索引文件路径；名字不合法返回 None。

    检索器构建与按 id 溯源共用这一条。两处各写一遍 `CORPORA_DIR / name / ...`
    迟早分叉，而「同一份数据两条读取路径只改了一条」是这个库反复吃过的亏。
    """
    name = corpus.strip().lower()
    if name in DEFAULT_CORPUS_ALIASES:
        return DEFAULT_INDEX_PATH
    return CORPORA_DIR / name / "knowledge_index.jsonl" if CORPUS_NAME_RE.fullmatch(name) else None


def lookup_source(source_id: str, corpus: str = "default") -> KnowledgeChunk | None:
    """按 source_id 精确取块：**活块优先，归档兜底**。旧课渲染出处走这条。

    为什么是这个优先级——重建之后同一个 id 可能有两条（活块 + 归档块，见
    `write_index` 的「撞号是常态」）：

    - 活块在：同一个文件同一个节序，通常只是内容被更新过，给最新的是对的。
    - 活块不在（文件被移出语料、或重切之后节数变少）：给归档块。这一条就是
      「已经出的课出处永不断链」的全部兑现方式，没有它这个 id 就是 404。

    查不到返回 None——调用方该把它当死链处理，不要拿别的块顶上。
    """
    path = corpus_index_path(corpus)
    if path is None:
        return None
    # ponytail: 每次调用全量读一遍索引。出处渲染是页面级低频操作，真成瓶颈再挂
    # lru_cache——注意那样就得跟着 refresh_corpora 一起清，否则重建后查到的是旧的。
    fallback = None
    for chunk in load_index(path, path.parent / "docs", include_superseded=True):
        if chunk.source_id != source_id:
            continue
        if not chunk.superseded:
            return chunk
        fallback = fallback or chunk
    return fallback


@lru_cache(maxsize=1)
def get_retriever():
    # KR1：向量后端优先（bge-m3 语义检索，查询嵌入失败自动降级 TF-IDF）；
    # RETRIEVER_BACKEND=tfidf 强制旧后端（消融对照）。函数内 import 破循环依赖。
    from backend.rag.embedding_retriever import maybe_embedding_retriever

    # 路径显式传，别吃 load_index 的默认参数：默认参数在 def 那一刻就绑死了，
    # 之后改模块级的 DEFAULT_INDEX_PATH（测试替身、换库）这一支照旧读老路径，
    # 而上面那一支读的是新路径——同一个函数里两条路各读一个库，静默且难查。
    emb = maybe_embedding_retriever(DEFAULT_INDEX_PATH)
    return emb if emb is not None else TfidfKnowledgeRetriever(load_index(DEFAULT_INDEX_PATH, DEFAULT_DOC_DIR))


#: 冷构建单飞锁（WO-L1）。lru_cache 未命中时不锁：两个请求同时打进冷库，
#: 两边都 miss、都各自建一遍检索器，GIL 下互相拖慢——实测 odoo 单建 7.2s、
#: 并发×2 变 13.2s/条，全部超过 classroom 侧超时，屏级证据整片丢失。
#: 加锁后第二个请求等第一个建完直接吃缓存命中（0.001ms）。
# ponytail: 全局锁把不同库的冷构建也串行化了；冷构建是体检开跑/接入后的偶发事件，
# 真要并行再改成按库分锁。
_CORPUS_BUILD_LOCK = threading.Lock()


@lru_cache(maxsize=8)
def _get_corpus_retriever_cached(corpus: str):
    name = corpus.strip().lower()
    if name in DEFAULT_CORPUS_ALIASES:
        return get_retriever()
    index = corpus_index_path(name)
    if index is None:
        return None
    root = index.parent
    try:
        from backend.rag.embedding_retriever import maybe_embedding_retriever

        emb = maybe_embedding_retriever(root / "knowledge_index.jsonl")
        if emb is not None:
            return emb
        return TfidfKnowledgeRetriever(load_index(root / "knowledge_index.jsonl", root / "docs"))
    except Exception:  # 目录不存在 / 索引为空 / 索引损坏 —— 一律视为"尚未建设"
        return None


def get_corpus_retriever(corpus: str):
    """按领域语料库取检索器；**该领域未建库时返回 None**，绝不回退到默认语料。

    建库方式：把该领域文档放进 `data/knowledge_base/corpora/<corpus>/docs/*.md`
    （带 front matter），或直接放已构建的 `knowledge_index.jsonl` 到同级目录。
    """
    with _CORPUS_BUILD_LOCK:
        return _get_corpus_retriever_cached(corpus)


# refresh_corpora 与既有测试都用 `.cache_clear()`，缓存挪进内层后把入口原样接上。
get_corpus_retriever.cache_clear = _get_corpus_retriever_cached.cache_clear  # type: ignore[attr-defined]


def refresh_corpora() -> None:
    """丢掉按域检索器的进程内缓存。

    `get_corpus_retriever` 有 lru_cache，而它对未建库的域缓存的是 `None`——
    接入流水线刚把新库落盘、或者索引被重建之后，不清这一层就要重启引擎才看得见
    （实测过：新库建好，`_corpus_status()` 里仍是 available=false）。
    **默认语料 ai 的 `get_retriever` 不清**：它没被这条链改过，清了只是白白重算
    1704 块的 TF-IDF 矩阵。
    """
    get_corpus_retriever.cache_clear()
    # 向量层的缓存也要清：③ 站建索引之前它已经把「这库没 npz」缓存成 None，
    # 不清的话向量索引建完本进程永远升不上去（停在 TF-IDF），
    # 而 ⑤ 站已经往事件流里写了「检索后端可升级」——屏幕上就成了假话。
    # 代价：lru_cache 无单键失效，这是全域清，别的库要冷加载一次。
    # 2026-08-17 重测：ai 3.6s / iotdb 3.4s / odoo 7.2s（缓存命中 0.001ms）。
    # 旧注释写的「odoo 648ms / iotdb 2510ms」是 .po 语料时代量的，rst 重建后块变大
    # 一个量级，已作废——冷加载现在是秒级不是毫秒级，别再照旧数估算代价。
    # 接入是管理员偶发操作，仍然认了；但体检链路已在 preflight 预热目标库（WO-L1）。
    try:
        from backend.rag.embedding_retriever import get_embedding_retriever

        get_embedding_retriever.cache_clear()
    except (ImportError, AttributeError):
        # 向量层不可用（缺依赖或未启用）时不该拖垮刷新本身
        pass


def extract_citations(text: str) -> List[str]:
    return sorted(set(re.findall(r"\[([A-Za-z0-9_\-]+#s\d+)\]", text)))

