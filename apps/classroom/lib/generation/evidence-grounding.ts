/**
 * Evidence grounding bridge — the "李代桃僵" seam.
 *
 * When GROUNDING_URL points at the multi-agent engine's controlled knowledge
 * base, scene generation is grounded: a retrieval agent supplies evidence
 * chunks with stable source ids, the (unchanged) layout generator is fenced to
 * those facts, and the audit judge verifies claims AGAINST the evidence rather
 * than against parametric memory. Any failure or empty hit degrades silently
 * to the original ungrounded pipeline — UX must never depend on the bridge.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('Evidence Grounding');

export interface EvidenceChunk {
  source_id: string;
  title: string;
  content: string;
  concept_tags: string[];
  /**
   * 引擎标注：false = 形态超出该学习者档位上限的保底块（例如零基础档拿到
   * 20 行无注释生产代码），可用于事实接地，但不得作摘录引用。字段缺省视为可引用
   * （旧引擎/其他调用方兼容）。
   */
  quotable?: boolean;
}

export interface EvidenceBundle {
  chunks: EvidenceChunk[];
  matchedConcepts: string[];
  summary: string;
  /** 检索用的领域语料库名——摘录咬合打分要按同一个语料查块向量 */
  corpus?: string;
  /** fringe 模式下被跳过的块（概念已达标），带理由——选段决策可见性的数据源 */
  skipped?: Array<{ source_id: string; title: string; reason: string }>;
  /** 引擎选段模式：plain=全量检索；fringe=按掌握度跳过已会的块 */
  selectionMode?: string;
}

const MAX_CHUNK_CHARS = 700;
// 超时不是拍的，按引擎冷启动实测定（2026-08-17 复现，WO-L1）：引擎的按域检索器
// 懒加载，首次命中要读 npz + 建 TF-IDF 兜底，最大库 odoo(3046 块)单次冷启动 7.2s、
// 两屏并发撞冷缓存 13.2s；旧值 6s 正卡在冷启动区间里，体检池 12/48 屏的
// 「证据检索桥不可达（TimeoutError）」全是这么来的（ai 库常驻焐热 0 中招，
// iotdb 并发冷启动 6.8s 偶发中招，odoo 必中）。20s = 实测最大 13.2s 留半倍余量，
// 与学情诊断桥的 25s 同量级；引擎真挂时是连接拒绝秒败，不吃满超时。
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Fetch evidence for a scene topic. Returns null when unconfigured, no hits, or any failure.
 *
 * `corpus` is the training domain (the learner profile's `domain`: ai /
 * manufacturing / industrial-internet / software). The engine keeps one corpus
 * per domain and returns an empty hit set for a domain whose corpus has not
 * been built — it never substitutes another domain's material. So picking
 * 智能制造 today yields ungrounded generation (badge: 未接地), which is the
 * honest outcome, not AI material dressed up as manufacturing evidence.
 */
export async function fetchEvidence(
  query: string,
  corpus?: string,
  mastery?: Record<string, number>,
  // 只在「配置了但调用真失败」时回调（网络错/非200）；未配置与零命中不算失败。
  // 调用方用它把桥失联推成车间红行——静默降级裸生成是彩排翻过的车。
  onFailure?: (message: string) => void,
  // 摘录难度上限（L1-L4）：按学习者姿态档传入。摘录带着自身难度进正文，
  // 姿态指令压不住摘录（2A 纯净测 beginner 44.4% 病根）——超档块由引擎跳过带理由。
  maxDifficulty?: string,
  // 摘录代码形态上限（最长代码块行数，0/省略=不设限）：难度档管不住代码长度，
  // L1 档语料里照样有 21 行无注释的生产级 class。同样由引擎跳过带理由。
  maxCodeLines?: number,
  // 入门段代码结构闸：含 import / def / class / 装饰器的块跳过。
  // **长度也管不住结构**——2026-08-13 实测，零基础学员拿到的摘录是
  // `import numpy` + `def query(...)`，行数没超 5 行上限，形态整段超纲。
  // 判据来自外部教材：蟒蛇书 1-6 章 129 个文件里这三种结构出现率都是 0%，
  // 全书才 57%/31%/25%（`scripts/experiments/textbook_code_ladder.py` 可复算）。
  beginnerCodeForm?: boolean,
): Promise<EvidenceBundle | null> {
  const base = process.env.GROUNDING_URL;
  if (!base) return null;
  try {
    const params: Record<string, string> = { query, top_k: '6', corpus: corpus || 'default' };
    // 掌握度触发引擎侧 outer-fringe 选段：跳过已会概念的块（带理由回传）。
    // 键可以是场景标题——概念词表在引擎侧，标题→概念的映射不归客户端管。
    if (mastery && Object.keys(mastery).length > 0) {
      params.mastery = JSON.stringify(mastery);
    }
    if (maxDifficulty) {
      params.max_difficulty = maxDifficulty;
    }
    if (maxCodeLines && maxCodeLines > 0) {
      params.max_code_lines = String(maxCodeLines);
    }
    if (beginnerCodeForm) {
      params.beginner_code_form = 'true';
    }
    const url = `${base.replace(/\/$/, '')}/internal/v1/personalize/evidence?${new URLSearchParams(params)}`;
    const attempt = () =>
      fetch(url, {
        headers: { 'x-internal-token': process.env.GROUNDING_TOKEN ?? '' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: 'no-store',
      });
    let resp: Response;
    try {
      resp = await attempt();
    } catch (err) {
      // 屏级重试一次再放弃。冷启动超时后引擎仍在后台把检索器建完
      // （客户端 abort 不取消引擎侧工作），立刻重试大概率命中已建好的缓存——
      // 一次失败就裸奔，等于把工程抖动记成「模型不会用资料」。
      log.info(`Evidence fetch failed once (${err instanceof Error ? err.name : 'error'}), retrying`);
      resp = await attempt();
    }
    if (!resp.ok) {
      onFailure?.(`证据检索桥返回 HTTP ${resp.status}`);
      return null;
    }
    const payload = (await resp.json()) as {
      data?: {
        chunks?: EvidenceChunk[];
        matched_concepts?: string[];
        evidence_summary?: string;
        missing_evidence_warning?: string | null;
        skipped?: Array<{ source_id: string; title: string; reason: string }>;
        selection_mode?: string;
      };
    };
    const chunks = payload.data?.chunks ?? [];
    if (chunks.length === 0) return null;
    // 引擎判定「证据不足」时会带回 missing_evidence_warning。
    // 这个字段以前在这里被静默丢弃，前端永远收不到信号，于是低质证据和高质证据
    // 在下游长得一模一样。现在透传上去，让调用方能选择降级为「未接地」。
    const warning = payload.data?.missing_evidence_warning ?? null;
    if (warning) {
      log.info(`Grounding insufficient, degrading to ungrounded: ${warning}`);
      return null;
    }
    return {
      chunks,
      matchedConcepts: payload.data?.matched_concepts ?? [],
      summary: payload.data?.evidence_summary ?? '',
      corpus: params.corpus,
      // 引擎回传的选段决策（outer-fringe 跳过的块 + 模式）原样透传——
      // 这是「车间」面板的检索行数据源，此前在这里被丢弃。
      ...(payload.data?.skipped?.length ? { skipped: payload.data.skipped } : {}),
      ...(payload.data?.selection_mode ? { selectionMode: payload.data.selection_mode } : {}),
    };
  } catch (err) {
    log.warn(`Evidence fetch failed (falling back to ungrounded): ${String(err)}`);
    onFailure?.(`证据检索桥不可达（${err instanceof Error ? err.name : 'error'}）`);
    return null;
  }
}

/**
 * Render evidence as a fact-fence block appended to the outline description.
 *
 * 口径几经修改，两处教训写在这里：
 *
 * 1. 原文写的是「以下资料是本场景全部事实性内容的**唯一来源**」。这句话把模型逼进
 *    「上下文不充分也要硬答」的区间——Google 的 sufficient context 研究（arXiv:2411.06037）
 *    正是这个现象：强模型在证据不足时倾向硬答而非弃答。改成「可能相关也可能无关」，
 *    对齐有道 QAnything 的生产口径。
 * 2. 每块证据用 XML 式边界包起来。原来是 `[id] 标题：正文` 一行流，模型分不清一块
 *    到哪结束，容易把相邻块的内容混着当同一条事实。
 */
export function evidenceDirective(bundle: EvidenceBundle): string {
  const blocks = bundle.chunks
    .map(
      (c) =>
        `<资料 id="${c.source_id}">\n  <标题>${c.title}</标题>\n` +
        `  <正文>${c.content.slice(0, MAX_CHUNK_CHARS)}</正文>\n</资料>`,
    )
    .join('\n');
  return (
    `\n\n【参考资料】以下资料**可能相关，也可能无关**，只使用你确认与本场景相关的部分。\n` +
    `- 引用其中的事实时，陈述要与资料一致；\n` +
    `- 资料没有覆盖到的地方，讲通识即可，**不要编造具体数字、人名、年份、论文标题**；\n` +
    `- 教学类比、举例方式、讲解顺序不受资料限制，自由发挥。\n${blocks}`
  );
}

/** Plain-text evidence context for the audit judge. */
export function evidenceForJudge(bundle: EvidenceBundle): string {
  return bundle.chunks
    .map((c) => `[${c.source_id}] ${c.title}：${c.content.slice(0, MAX_CHUNK_CHARS)}`)
    .join('\n');
}

// ── 接地拼装（E3 路线落地）─────────────────────────────────────────────
//
// 路线实验的结论：事实内容从语料摘录直出（87% 达成率）显著优于让模型转述（51%）。
// 落地铁律是「位置由模型排，内容由机器贴」——绝不让模型自己抄原文：
// 模型在版面上放一个 {{摘录:source_id}} 占位符，生成完由 injectExcerpts()
// 把语料原文机械替换进去。模型手抄必然漂移，占位符替换零漂移，
// 且注入文本逐字来自证据块，审计时天然 supported。

const EXCERPT_PLACEHOLDER = /\{\{\s*摘录\s*[:：]\s*([A-Za-z0-9_#\-]+)\s*\}\}/g;

/**
 * 从不承载摘录块的文本里剥掉占位符。
 *
 * 摘录协议只对板书正文有效（injectExcerpts 走 content.canvas.elements）。模型
 * 偶尔会把 {{摘录:xxx}} 写进讲稿台词，那里没有注入环节，占位符就原样念给学习者听
 * ——实测 6 门种子课里有 3 门中招，共 7 处。剥掉即可：台词少一个占位符照样通顺，
 * 而正文里的同一段原文已经贴出来了。
 */
export function stripExcerptPlaceholders(text: string): string {
  if (!text.includes('{{')) return text;
  return text.replace(EXCERPT_PLACEHOLDER, '').replace(/\s{2,}/g, ' ').trim();
}
// 讲义阅读流没有物理画布约束（2026-08-03 讲义真形态），盒预算上限放宽；
// 无盒字段（表格单元等）维持保守上限。
const MAX_EXCERPT_CHARS = 1600;
const NO_BOX_CHARS = 600;

/** 拼装指令：教模型用占位符排版摘录，自己只写衔接。附在 evidenceDirective 之后。 */
export function excerptDirective(bundle: EvidenceBundle): string {
  // 只列可引用的块：引擎把超出档位形态上限的保底块标 quotable=false，
  // 它继续参与事实接地（evidenceDirective 吃全部），但不进摘录清单。
  const quotable = bundle.chunks.filter((c) => c.quotable !== false);
  if (quotable.length === 0) return '';
  const menu = quotable
    .map((c) => `  - {{摘录:${c.source_id}}} —— ${c.title}（${c.content.length} 字）`)
    .join('\n');
  return (
    `\n\n【拼装模式】本场景的核心事实内容用**教材摘录**呈现，你负责编排和衔接：\n` +
    `- 讲解某个机制的正文位置，放一个独立的 text 元素，内容**只写占位符**，可选清单：\n${menu}\n` +
    `- 占位符只能从上面这份清单里选 id。【参考资料】里出现、但清单里没有的资料，` +
    `只能用你自己的话讲——写成占位符会被替换器当未知 id 清掉，版面上只剩一句没有下文的导读；\n` +
    `- 占位符会被替换成教材原文（含出处标注），元素必须预留足够版面：width ≥ 760、height ≥ 240` +
    `（约容纳 300 字）。盒子留小了替换器会按盒裁短原文，教学内容就丢了；\n` +
    `- 你自己写的元素承担：导读（这段摘录讲什么、读时注意什么）、承接、与学习者背景的连接、练习题；\n` +
    `- **术语和概念的第一次交代由你自己写**（按本页读者的档位要求来），不要留给摘录代劳：` +
    `摘录会因为前文已引用、超出档位、不自包含等原因被机械丢弃，押在摘录里的定义会跟着一起消失；\n` +
    `- 每页最多 1-2 个摘录占位符，选**承载推导和因果**的那几段，不要全部塞进去；\n` +
    `- 不要改写、续写或概括摘录内容——那是替换器的事，你写的衔接文字不得替摘录复述其中的数据、公式与结论；
` +
    `- **不要用「摘录中提到的」「如摘录所示」「上述摘录」这类指代摘录的措辞**。` +
    `摘录会被机械丢弃（前文已引用、超出档位、与上文不咬合都会丢），丢了之后这些话就指向一段` +
    `页面上根本不存在的引文，读者看到的是自相矛盾：说好没贴出来，又让人去看没贴出来的东西。` +
    `要提那个事实就直接陈述（「教材规定超两倍切 STOP」），不要绕道指向引文。`
  );
}

/**
 * 引用导语判定：这一句是不是在给下面的摘录打预告。
 * 判定口径 v2（2026-08-10 首版实测翻车：只认冒号收尾把两门新课摘录清零——模型常写
 * 「教材对此有更完整的展开。」句号收尾，意图在词不在标点）：含引用意图词或冒号收尾。
 * 注入端（没导语就不贴）与清理端（摘录没贴成就把导语一起撤）共用同一口径——
 * 两边口径一旦分家，就会出现「按 A 的标准要求写、按 B 的标准留不下来」的空头支票。
 */
const hasQuoteIntent = (line: string): boolean =>
  /[：:]\s*$/.test(line) || /教材|原文|引用|摘录|表述|展开|指出|写道|如下|来看/.test(line.slice(-30));

/**
 * 同一件事的严口径：这一句**整句就是**一句预告，删掉它不会带走别的内容。
 * 放行用宽口径（hasQuoteIntent，宁可多贴）、删除用严口径（宁可少删）——
 * 拒贴的代价是少一段引文，误删的代价是学习者的正文没了，两边不该同一把尺。
 */
const LEAD_IN_TAIL =
  /(?:[：:]|(?:教材|原文|摘录|引用)[^。！？\n]{0,16}(?:表述|展开|指出|写道|如下|来看)[^。！？\n]{0,4}[。.]?)\s*$/;

/** HTML → 纯文本。注入跑在 md→elements 之后，element.content 是 HTML，判定必须在纯文本上做。 */
const plainText = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

// ── 摘录咬合（第五道缰绳）────────────────────────────────────────────────
//
// 判官审计实测：08-10 批 supports 55% / related 40% / unrelated 5%，
// 08-11 批 52% / 34% / **14%**——用户原话「牛头不对马嘴」。前四道缰绳管的是
// 数量与形态（去重/上限/自包含/有导语），一条也不管「这段引文是否支撑上一句话」。
//
// 信号是选出来的不是拍的（scripts/calibrate_excerpt_relevance.py，91 条判官三档标注）：
// bge-m3 余弦 supports|unrelated 分离度 0.83（置换 p=0.001，两批各 0.90/0.80）；
// 字符 2/3/4-gram 重合、最长公共子串、TF-IDF 余弦全部淘汰（sep ≤0.37，p ≥0.11，
// 且在 unrelated 最多的那批上几乎归零）。所以只能走引擎侧向量打分，纯本地算不出来。
//
// 打分器不可用一律**放行**：桥失联不是「不咬合」的证据，UX 不依赖桥（本文件第一条家规）。

/** 前文窗口：必须与校准时判官看到的一致（末 160 字），换窗口即换量纲，阈值作废。 */
const RELEVANCE_CTX_WINDOW = 160;

interface RelevanceTable {
  threshold: number;
  /** 与占位符出现顺序一一对应；每行 = sid → 余弦（引擎没打出分的 sid 不进表） */
  rows: Array<Map<string, number>>;
}

/**
 * 引擎侧摘录咬合打分（只读、零 LLM）。任何失败返回 null = 放行。
 * 阈值由引擎随响应回传，客户端不留第二份——数字单一真源。
 */
async function fetchExcerptRelevance(
  contexts: string[],
  sourceIds: string[],
  corpus?: string,
): Promise<RelevanceTable | null> {
  const base = process.env.GROUNDING_URL;
  if (!base || contexts.length === 0 || sourceIds.length === 0) return null;
  try {
    const resp = await fetch(
      `${base.replace(/\/$/, '')}/internal/v1/personalize/excerpt-relevance`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
        },
        body: JSON.stringify({
          contexts: contexts.map((c) => c.slice(-RELEVANCE_CTX_WINDOW)),
          source_ids: sourceIds,
          corpus: corpus || 'default',
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: 'no-store',
      },
    );
    if (!resp.ok) {
      log.warn(`摘录咬合打分返回 HTTP ${resp.status}，本次全部放行`);
      return null;
    }
    const payload = (await resp.json()) as {
      data?: { threshold?: number; scores?: Array<Array<number | null>>; reason?: string };
    };
    const scores = payload.data?.scores;
    const threshold = payload.data?.threshold;
    if (!scores?.length || typeof threshold !== 'number') {
      log.info(`摘录咬合打分不可用（${payload.data?.reason ?? '无 scores'}），本次全部放行`);
      return null;
    }
    const rows = scores.map((row) => {
      const m = new Map<string, number>();
      row.forEach((v, j) => {
        if (typeof v === 'number' && sourceIds[j]) m.set(sourceIds[j], v);
      });
      return m;
    });
    return { threshold, rows };
  } catch (err) {
    log.warn(`摘录咬合打分不可达（${err instanceof Error ? err.name : 'error'}），本次全部放行`);
    return null;
  }
}

/**
 * 一条真的贴进正文的教材出处。**这就是资源的「依据」子盒**（设计稿 §4.3）。
 *
 * 依据与审计成对但不合并：**依据答「这句话哪来的」，由检索产出**；
 * 审计答「这句话对不对」，由判官产出（`scene.audit`）。此前两者都只挂在 audit 上，
 * 于是「资源的依据」这个值只有判官跑过才存在——那是把检索的产物寄存在判官身上。
 * 分开之后，「无依据段落占比」这个数不必等判官就能算。
 */
export interface ExcerptPlacement {
  /** 教材出处 id。 */
  sourceId: string;
  /** 出处标题，答辩时给人看的。 */
  title?: string;
  /** 与前文的咬合分（bge-m3 余弦）。取不到时缺省。 */
  relevance?: number;
  /** 模型原挑的那条不咬合、被换掉时，记下原来那条。 */
  swappedFrom?: string;
}

export interface ExcerptStats {
  injected: number;
  unknown: number;
  deduped: number;
  capped: number;
  rejected: number;
  noLead: number;
  /** 与前文不咬合、且没有可换的候选，整条丢弃 */
  irrelevant: number;
  /** 模型挑的那条不咬合，换成候选清单里咬合的另一条 */
  swapped: number;
  /** 逐条落位记录 = 依据子盒。计数说明「贴了几条」，这个说明「贴的是哪几条」。 */
  placements: ExcerptPlacement[];
  /** 掉了摘录之后，正文里被改写掉的悬空指代数（见 `DANGLING_EXCERPT_REF`）。 */
  danglingRefsFixed: number;
}

/**
 * 把生成内容里的 {{摘录:id}} 占位符机械替换成证据原文。
 *
 * 递归走任意 JSON 结构的字符串字段——scene content 的元素形态很多
 * （text/markdown/表格单元），逐字段替换比枚举元素类型稳。
 * 未知 id 的占位符直接清除并记数：宁可版面空一块，不能留花括号垃圾给学习者看。
 *
 * 三趟走位（都在深拷贝上干跑，只有最后一趟落到真内容上）：
 *   ① 收集每个占位符的「前文 + 出处」——前文要跨元素累计，占位符常独占一个元素，
 *      只看同元素内前文必然为空（判官第一版就是这么拿到 22 条假 unrelated 的）；
 *   ② 拿分回来后再干跑一遍，判断这一页是否需要开去重豁免口子；
 *   ③ 真替换。
 * 三趟的遍历顺序完全一致，所以占位符序号能对齐分数矩阵的行号。
 */
/**
 * 摘录没贴成时留在正文里的短说明。
 *
 * **不是装饰，是诚实性的一部分。** 六条丢弃分支原本一律 `return ''`：
 * 统计里记了原因，页面上一个字都没有，而提示词强制写的导语
 * （「教材对此的原文表述是：」）还留着——线上实锤是屏 1 正文写着
 * 「根据上述规则」而页面上根本没有规则，指代悬空。
 *
 * 之前用「摘录占位符残留数 = 0」验证这条链，被骗了：0 是因为剥除不是替换。
 *
 * 留一句带 id 的说明，学习者至少知道这里本该有引用、可以去查那个出处。
 */
function excerptGap(sid: string, why: string): string {
  return `（这里本应引用教材 [${sid}]，${why}）`;
}

export async function injectExcerpts(
  content: unknown,
  bundle: EvidenceBundle,
  usedIds?: Set<string>,
): Promise<ExcerptStats> {
  // 去重缰绳的边界（2A run-20260811：18 份 beginner 资源里 7 份整页只剩回指，
  // 两例两轮稳定 miss 都落在这 7 份里）。一页贴不出任何教材原文、却留着提示词强制
  // 写的导语时，这一页就成了空头支票——判官原话：「说『教材对 RAG 核心定义的原文
  // 表述是：（本段教材前文已引用…）』——假设读者已从前文获得定义」，据此把零基础页
  // 判成 advanced。所以这种页放行第一条被去重挡下的出处：跨页重复一次，好过整页空手。
  //
  // 先在深拷贝上干跑一遍再决定，而不是扫一眼占位符了事：占位符还会被 capped /
  // 不自包含 / 无导语挡掉，「有新出处」不等于「贴得出来」——b2-rag 就是一条被去重、
  // 一条是图解段被拒，静态扫描看不出它最后一条都没剩。
  const quotable = bundle.chunks.filter((c) => c.quotable !== false).map((c) => c.source_id);
  let relevance: RelevanceTable | null = null;
  if (quotable.length > 0) {
    try {
      const sites: string[] = [];
      injectOnce(structuredClone(content), bundle, new Set(), null, true, null, sites);
      if (sites.length > 0) {
        relevance = await fetchExcerptRelevance(sites, quotable, bundle.corpus);
      }
    } catch {
      // 内容不可克隆 / 打分意外失败：不打分即全放行，行为同旧版
    }
  }

  let exempt: string | null = null;
  if (usedIds) {
    try {
      const probe = injectOnce(
        structuredClone(content), bundle, new Set(usedIds), null, true, relevance,
      );
      if (probe.stats.injected === 0) exempt = probe.firstDeduped;
    } catch {
      // 内容不可克隆（理论上不会——scene content 是纯 JSON）：不开口子，行为同旧版
    }
  }
  return injectOnce(content, bundle, usedIds, exempt, false, relevance).stats;
}

function injectOnce(
  content: unknown,
  bundle: EvidenceBundle,
  usedIds: Set<string> | undefined,
  exempt: string | null,
  dry: boolean,
  relevance: RelevanceTable | null,
  /** 给了就把每个占位符的「跨元素前文」按出现顺序推进来（收集趟专用） */
  siteSink?: string[],
): {
  stats: ExcerptStats;
  firstDeduped: string | null;
} {
  // 只认可引用的块：模型若擅自写了不可引用块的占位符，走「未知 id」路径被清掉——
  // 不可引用块只喂事实，不进正文引文（超档形态不印给学习者）。
  const byId = new Map(
    bundle.chunks.filter((c) => c.quotable !== false).map((c) => [c.source_id, c]),
  );
  const stats: ExcerptStats = {
    injected: 0, unknown: 0, deduped: 0, capped: 0,
    rejected: 0, noLead: 0, irrelevant: 0, swapped: 0, placements: [], danglingRefsFixed: 0,
  };
  let firstDeduped: string | null = null;
  // 掉了几条摘录（unknown/capped/rejected/noLead/irrelevant 五条丢弃路径）。用于回收导语，
  // 与 stats 分开数是因为 deduped 不算丢弃——它还留了一行回指。
  let drops = 0;
  // 占位符序号：三趟遍历顺序一致，用它对齐 relevance.rows 的行号。
  let site = 0;
  // 跨元素累计的讲义前文（判官同口径：前面所有元素的正文 + 本元素内占位符之前那段）。
  // 占位符常常独占一个元素，只看同元素前文必然为空。
  let acc = '';
  // 两道机械缰绳（提示词写了「每页 1-2 条」，实测模型一页塞 7 条、
  // 同一段原文全课重复贴 3.4 次——版面纪律不能指望指令，只能收进代码）：
  // ① 每场景最多 2 条；② 全课已用过的出处不再整段重贴，换成一行回指。
  const MAX_PER_SCENE = 2;
  // 第三道缰绳（2026-08-10 用户实拍：RAG 课摘录整段是「如图8.7所示…启动后
  // 访问 localhost:7860」的实操图解说明，脱离原书截图毫无教学价值——
  // 「大部分引用都是诸如此类」）：摘录必须自包含可读。教材里的图引用/操作
  // 指引类段落对判官核事实无害，但不配整段贴给学习者当引文——宁缺毋滥。
  const FIGURE_REF = /如图\s*\d+[.．]\d+|如下图|见图\s*\d|所示.{0,6}(所示)?/;
  const OPERATIONAL = /完整的?代码(可以)?在|code\/chapter|启动后访问|localhost:\d+|建议读者亲自|点击加载|如图所示/;
  const selfContained = (text: string): boolean => {
    const figureHits = (text.match(new RegExp(FIGURE_REF.source, 'g')) ?? []).length;
    return figureHits < 2 && !(figureHits >= 1 && OPERATIONAL.test(text)) && !OPERATIONAL.test(text);
  };
  /**
   * 换一条更咬合的候选。返回 null 时用 reason 区分两种空手：
   * 「无候选」= 清单里根本没有别的可用块；「全被拒」= 有候选但没一条过线。
   * 这两种在日志里必须分得开——前者要补语料，后者要改选段，处方不一样。
   */
  const pickCandidate = (
    row: Map<string, number>,
    chosen: string,
  ): { sid: string | null; score: number; reason: string } => {
    const pool = [...byId.entries()].filter(
      ([id, c]) => id !== chosen && !usedIds?.has(id) && selfContained(c.content),
    );
    if (pool.length === 0) return { sid: null, score: 0, reason: '无候选' };
    const best = pool
      .map(([id]) => ({ sid: id as string | null, score: row.get(id) ?? -1, reason: '' }))
      .filter((c) => c.score >= (relevance?.threshold ?? 1))
      .sort((a, b) => b.score - a.score)[0];
    return best ?? { sid: null, score: 0, reason: `全被拒（${pool.length} 条候选均低于阈值）` };
  };

  const replaceIn = (text: string, charBudget: number): string =>
    text.replace(EXCERPT_PLACEHOLDER, (_m, rawSid: string, offset: number) => {
      const n = site++;
      const before = plainText(text.slice(0, typeof offset === 'number' ? offset : 0));
      if (siteSink) siteSink.push((acc + before).slice(-RELEVANCE_CTX_WINDOW));
      let sid = rawSid;
      let chunk = byId.get(sid);
      if (!chunk) {
        stats.unknown += 1;
        drops += 1;
        return excerptGap(sid, '这一条在本次检索的证据里没找到');
      }
      // 第五道缰绳：与讲义前文不咬合就先换候选，换不到才丢。
      // 打分器没给这一条打分（桥失联 / 索引里没这块）一律放行——不打分不等于不咬合。
      const row = relevance?.rows[n];
      const own = row?.get(sid);
      if (row && relevance && own !== undefined && own < relevance.threshold) {
        const pick = pickCandidate(row, sid);
        if (pick.sid) {
          if (!dry) {
            log.info(
              `[swapped] ${sid}(${own.toFixed(3)}) → ${pick.sid}(${pick.score.toFixed(3)})`,
            );
          }
          stats.swapped += 1;
          sid = pick.sid;
          chunk = byId.get(sid)!;
        } else {
          stats.irrelevant += 1;
          drops += 1;
          if (!dry) {
            log.info(`[irrelevant] ${sid} 咬合 ${own.toFixed(3)} < ${relevance.threshold}，${pick.reason}`);
          }
          return excerptGap(sid, '但那段原文与这里讲的不咬合，贴上去反而误导');
        }
      }
      if (usedIds?.has(sid) && sid !== exempt) {
        stats.deduped += 1;
        firstDeduped ??= sid;
        return `（本段教材前文已引用，见 [${sid}]）`;
      }
      if (stats.injected >= MAX_PER_SCENE) {
        stats.capped += 1;
        drops += 1;
        return excerptGap(sid, '这一屏引用已达上限，完整原文见该出处');
      }
      if (!selfContained(chunk.content)) {
        stats.rejected += 1;
        drops += 1;
        return excerptGap(sid, '那段原文脱离上下文读不通，没有直接贴出');
      }
      // 第四道缰绳（摘录相关性审计：46% 的引文贴主题不咬论点）：提示词已强制
      // 「占位符前一句必须点明引用意图」，这里机械验收。
      // 判定口径 v2（2026-08-10 首版实测翻车：只认冒号收尾把两门新课摘录清零
      // ——模型常写「教材对此有更完整的展开。」句号收尾，意图在词不在标点）：
      // 前一行含引用意图词（教材/原文/引用/摘录/表述/展开/指出/写道）或以
      // 冒号收尾即放行，两者皆无才拒。
      // 只管讲义流内嵌场景：槽位/回退版式的专用摘录盒（占位符即全部内容，
      // 前文天然为空）豁免——它的咬合由版面设计承担，不是模型行为。
      // 判定必须在纯文本上做：注入跑在 md→elements 之后，element.content 是
      // HTML——直接取「前一行」会拿到 <p style=…> 开标签（首版实测 6/6 误杀）。
      // 剥标签解实体后取最后一个非空自然语言行再判。
      if (before.trim()) {
        const lastLine = (before.split('\n').filter((l) => l.trim()).pop() ?? '').trim();
        if (!hasQuoteIntent(lastLine)) {
          stats.noLead += 1;
          drops += 1;
          if (!dry) log.info(`[noLead] 前一句「${lastLine.slice(-60)}」`);
          return excerptGap(sid, '此处没有交代引用意图，原文未直接贴出');
        }
      }
      stats.injected += 1;
      // 记下这一条落位——依据子盒是**值**，不是日志。日志跑完就没了，
      // 值要跟着资源落盘，才谈得上「每个事实断言的出处」可对质。
      if (!dry) {
        stats.placements.push({
          sourceId: sid,
          ...(chunk.title ? { title: chunk.title } : {}),
        });
      }
      exempt = null; // 豁免只用一次：同一 id 在本页再出现照常回指
      usedIds?.add(sid);
      // 语料是 markdown，标题行（# 7.2 RAG）在幻灯片摘录块里原样露出很难看，
      // 且不承载讲解内容——剥掉标题标记与多余空行，只留正文。
      const source = chunk.content
        .replace(/^#{1,6}\s+.*$/gm, '')
        .replace(/\n{2,}/g, '\n')
        .trim();
      const limit = Math.min(MAX_EXCERPT_CHARS, charBudget);
      const body = source.length > limit ? `${truncateClean(source, limit)}……` : source;
      return `📖 ${body}\n—— 摘自《${chunk.title}》[${chunk.source_id}]`;
    });
  /**
   * 摘录没贴成，前一个元素的导语就成了空头支票（2A 实测 4 处：b2-rag
   * 「关于系统具体的工作模式，教材里有更完整的展开：」后面什么都没有，
   * b2/b3-kv-cache 同形——那三处是模型引用了 quotable=false 的保底块，
   * 走「未知 id」被清掉）。导语是提示词强制要写的，所以每掉一条摘录必然留一句。
   *
   * 只撤最后一句，不动整段：讲义流里 md→elements 逐段成元素，导语常常独占一个
   * 元素（撤完整段变空），但也可能是长段落的收尾一句（b3-kv-cache 那两处 140 字）。
   * 切点取最后一个句末标点；整段就是一句导语时从开标签之后切。
   */
  const dropLeadIn = (prev: unknown): void => {
    if (!prev || typeof prev !== 'object') return;
    const obj = prev as Record<string, unknown>;
    const html = obj.content;
    if (typeof html !== 'string' || !html.trim()) return;
    const closing = /(?:<\/[A-Za-z][^>]*>\s*)*$/.exec(html)?.[0] ?? '';
    const body = html.slice(0, html.length - closing.length);
    const openEnd = body.startsWith('<') ? body.indexOf('>') : -1;
    let cut = Math.max(...['。', '！', '？', '；', '\n'].map((ch) => body.lastIndexOf(ch)));
    if (cut < openEnd) cut = openEnd;
    const tail = body.slice(cut + 1);
    // 含标签的尾巴不碰（切点可能落在行内 <code> 里）；长尾巴不碰（那是正文不是导语）
    if (!tail.trim() || tail.length > 60 || tail.includes('<')) return;
    if (!LEAD_IN_TAIL.test(plainText(tail).trim())) return;
    const kept = body.slice(0, cut + 1) + closing;
    obj.content = plainText(kept).trim() ? kept : '';
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => {
        const before = drops;
        walk(child);
        if (drops > before && i > 0) dropLeadIn(node[i - 1]);
      });
      return;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (typeof value === 'string' && value.includes('{{')) {
          obj[key] = replaceIn(
            value,
            key === 'content' ? excerptCharBudget(obj) : NO_BOX_CHARS,
            // 模型会原样照抄提示词示例（{{摘录:资料id}}，中文 id 不进 ASCII
            // 正则）——残余的摘录花括号一律清除，不能漏给学习者看
          ).replace(/\{\{\s*摘录[^}]*\}\}/g, '');
        } else {
          walk(value);
        }
        // 前文累计只收 content 字段（元素正文所在），且用**替换前**的原文——
        // 三趟遍历必须看到同一份前文，否则收集趟与真替换趟的序号对不上。
        // 只留末 400 字：打分窗口才 160，再长只是让字符串白白变长。
        if (key === 'content' && typeof value === 'string') {
          acc = (acc + '\n' + plainText(value).replace(/\{\{[^}]*\}\}/g, '')).slice(-400);
        }
      }
    }
  };
  walk(content);
  // 摘录掉了，正文里指向它的话就悬空了——`dropLeadIn` 撤的是**前面**那句导语，
  // 后面正文里的指代它管不到。第三代对照课屏 1 的原形：摘录被 rejected、
  // 诚实说明也留了，紧接着正文写「注意摘录中提到的关键数字：超两倍切 STOP」，
  // 读者视角自相矛盾——说好没贴出来，又让人去看没贴出来的东西。
  if (drops > 0) stats.danglingRefsFixed = fixDanglingExcerptRefs(content);
  return { stats, firstDeduped };
}

/**
 * 指向摘录的措辞 → 直接陈述。确定性替换，不调模型。
 *
 * 改写后的说法仍然是真的：内容本来就出自教材，只是不再让读者去找一段没贴出的引文。
 * 顺序有讲究——长串在前，否则「摘录中提到的」会先被「摘录中」那条吃掉半截。
 */
const DANGLING_EXCERPT_REF: ReadonlyArray<readonly [RegExp, string]> = [
  [/如上述摘录所示|如摘录所示|正如摘录中所说/g, '按教材的说法'],
  [/摘录中提到的|摘录里提到的|摘录中给出的|摘录里给出的/g, '教材规定的'],
  [/摘录中提到|摘录里提到|摘录中说明|摘录中指出/g, '教材规定'],
  [/上述摘录|上面的摘录|前述摘录|前面的摘录|这段摘录|该摘录/g, '教材'],
  [/摘录中的|摘录里的/g, '教材里的'],
  [/参见上面的摘录|详见摘录/g, '详见该出处'],
];

/**
 * 把正文里指向摘录的措辞改写掉，返回改了几处。
 *
 * **只在这一屏真的掉过摘录时调用**。摘录贴出来了的时候「摘录中提到的」指得实、
 * 不该动——那时候改写只是把一个有效指针换成泛指，白白丢信息。
 */
function fixDanglingExcerptRefs(content: unknown): number {
  let fixed = 0;
  const rewrite = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(rewrite);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (typeof value !== 'string') {
        rewrite(value);
        continue;
      }
      // 只改正文字段：`sourceId`、`title` 这些不是给人读的句子。
      if (key !== 'content' && key !== 'text') continue;
      let next = value;
      for (const [re, to] of DANGLING_EXCERPT_REF) {
        next = next.replace(re, () => {
          fixed += 1;
          return to;
        });
      }
      if (next !== value) obj[key] = next;
    }
  };
  rewrite(content);
  return fixed;
}

/**
 * 有损截断的干净收尾（用户 08-03 实拍：句中腰斩「…的关键...」+公式被斩半）。
 * 从预算点回退到最近的句界（。！？；换行），且保证截出的片段里 $...$ / $$...$$
 * 配平——宁可少一句，不能留半条公式。句界回退最多让出 40% 预算，否则按原点硬切。
 */
function truncateClean(source: string, limit: number): string {
  const floor = Math.floor(limit * 0.6);
  let cut = limit;
  const isBalanced = (s: string): boolean =>
    ((s.match(/\$\$/g) ?? []).length % 2 === 0) && ((s.match(/\$/g) ?? []).length % 2 === 0);
  // 候选句界从后往前找
  for (let i = limit; i >= floor; i--) {
    if (/[。！？；\n]/.test(source[i - 1] ?? '') && isBalanced(source.slice(0, i))) {
      cut = i;
      break;
    }
    if (i === floor) cut = limit;
  }
  let out = source.slice(0, cut);
  if (!isBalanced(out)) {
    // 硬切点落在公式里：退到上一个 $$ / $ 之前
    const lastDD = out.lastIndexOf('$$');
    if ((out.match(/\$\$/g) ?? []).length % 2 === 1 && lastDD >= 0) out = out.slice(0, lastDD);
    if ((out.match(/\$/g) ?? []).length % 2 === 1) out = out.slice(0, out.lastIndexOf('$'));
  }
  return out.trimEnd();
}

/**
 * 摘录字数预算：按占位符所在 text 元素的盒子算还能装多少字。
 *
 * 模型给摘录预留的高度经常不够（用户实测：整段原文溢出画布底被截断，
 * 学习者只看到半句话）。提示词已要求预留 240px 高，但版面纪律不能指望指令——
 * 这里按渲染指标（16px 字号、1.5 行高、盒内 10px padding、摘录块自身
 * padding 与出处行）反算容量，装不下就裁短加省略号。裁短是有损的，
 * 但「短而完整可读」优于「长而被画布腰斩」。
 * 非 text 元素（表格单元等）没有可靠盒子，维持 MAX_EXCERPT_CHARS。
 */
function excerptCharBudget(el: Record<string, unknown>): number {
  if (el.type !== 'text' || typeof el.width !== 'number' || typeof el.height !== 'number') {
    return NO_BOX_CHARS;
  }
  const FONT = 16;
  const LINE = FONT * 1.5;
  // 盒 padding 10×2 + blockquote 左 border 3 + 自身 padding ≈13×2；出处行 ≈ 行高 + 上边距 8
  const availWidth = el.width - 20 - 29;
  const availHeight = el.height - 20 - 19 - (LINE + 8);
  const charsPerLine = Math.floor(availWidth / FONT);
  const maxLines = Math.floor(availHeight / LINE);
  if (charsPerLine <= 0 || maxLines <= 0) return 60;
  return Math.max(60, charsPerLine * maxLines);
}

/**
 * 开跑前问一句：这个库里查不查得到与需求相关的资料。
 *
 * ## 为什么要单开一个函数，不复用 `fetchEvidence`
 *
 * `fetchEvidence` 会把检索不可用降级成 `null`，但对**开跑前的判断**不够：
 * 「本机没配检索」和「已配置的检索桥失败」必须分开。前者保持本地开发语义，
 * 后者若静默放行，就会产出一门零据课。
 *
 * ## 为什么要有这道闸
 *
 * 2026-08-23 ③ 跨域三联实测：一条领域中性的需求
 * （「给零基础新人的入门第一课」）在 ai / smart-manufacturing / iotdb
 * **三个库里检索全部返回空**，产品照样生成了三门通用 Python 课，
 * 证据块 0、所有屏 `grounded: false`。记录是诚实的，但学习者拿到的是
 * 一门看起来正常的课，而它跟所选的库毫无关系。
 *
 * 返回 `null` = 不该拦（没配检索，或检索确有命中）。返回字符串 = 拦车理由，人话。
 * 一旦配置 `GROUNDING_URL`，非 200、非法响应和调用异常都必须失败显式化。
 */
export async function zeroEvidenceReason(
  requirement: string,
  corpus?: string,
): Promise<string | null> {
  const base = process.env.GROUNDING_URL;
  if (!base) return null; // 没配检索：本地开发常态，不拦
  const query = requirement.trim();
  if (!query) return null;
  try {
    const params = new URLSearchParams({ query, top_k: '6', corpus: corpus?.trim() || 'default' });
    const resp = await fetch(
      `${base.replace(/\/$/, '')}/internal/v1/personalize/evidence?${params}`,
      {
        headers: { 'x-internal-token': process.env.GROUNDING_TOKEN ?? '' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        cache: 'no-store',
      },
    );
    if (!resp.ok) {
      return `检索服务请求失败（HTTP ${resp.status}）。为避免生成无出处课程，本次生成已停止，请稍后重试。`;
    }
    const payload = (await resp.json()) as { data?: { chunks?: unknown[] } };
    const chunks = payload.data?.chunks;
    if (!Array.isArray(chunks)) {
      return '检索服务响应格式无效（缺少 data.chunks 数组）。为避免生成无出处课程，本次生成已停止，请稍后重试。';
    }
    if (chunks.length > 0) return null;
    const where = corpus?.trim() ? `知识库「${corpus.trim()}」` : '当前知识库';
    return (
      `${where}里查不到与这条需求相关的资料（检索 0 命中）。\n` +
      `继续生成的话，整门课都会没有出处可依——那不是这个产品该给的东西。\n` +
      `两条出路：把需求写得贴近这个库真正讲的内容，或者换一个库。`
    );
  } catch {
    return '检索服务调用异常或响应无法解析。为避免生成无出处课程，本次生成已停止，请稍后重试。';
  }
}
