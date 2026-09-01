/**
 * 泛化对比页的服务端读数。
 *
 * 纪律与 `lib/server/admin-overview.ts` 同一条：页面上每个数字都要能指回一个真源文件，
 * 读不到就返回 null / 空数组，页面显示「—」，不拿旧值顶，更不硬编码。
 * 这一页将来要当测试样例交出去，所以**资料清单每一行也得可溯源**——书名、许可、
 * 规模全部从磁盘字段读，一个字不自己写。
 *
 * 四个来源，逐个登记（新增来源要在这里补登记）：
 *
 * | 来源 | 给什么 |
 * |---|---|
 * | `knowledge_base/<库>_intake/readiness.json` | 疆域、原文目录、许可判定、收文件数/字符数、切块数 |
 * | `knowledge_base/sources_manifest.csv` | 主语料 ai 的逐篇来源：仓库、许可原文、证据等级 |
 * | `knowledge_base/knowledge_index.jsonl` | 主语料的切片数（数行，`_intake` 里没有它） |
 * | `knowledge_base/intake_runs/<run>/run.json` | ⑥⑦ 体检的分子分母与成本 |
 *
 * ai 的资料清单为什么读 CSV 不读 `ATTRIBUTION.md`：CSV 由
 * `scripts/build_knowledge_base.py` 从各篇 front-matter 生成，ATTRIBUTION 是人工维护的
 * 汇总视图，两者不一致时 ATTRIBUTION 自己写着以 CSV 为准。许可里那几句限定
 * （「仓库无 LICENSE 文件」「未声明开源许可」）在 CSV 的 license 字段里就是原文，
 * 照搬即可，不需要我们复述。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { domainLabel } from '@/lib/knowledge/domain-labels';
import { redactCaliber as redactProviderText } from '@/lib/metrics/redact-caliber';

function engineDataDir(): string {
  return process.env.ENGINE_DATA_DIR || path.join(process.cwd(), '..', 'agent-engine', 'data');
}

function kbDir(): string {
  return path.join(engineDataDir(), 'knowledge_base');
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** 资料清单的一行。`docs` 是策展后收进来的篇数，不是原仓库的文件总数。 */
export interface SourceRow {
  /** 仓库名（`owner/repo`）或原文目录——照磁盘字段写，不美化成书名。 */
  readonly name: string;
  readonly url: string;
  readonly docs: number;
  /** 许可原文，含限定语。空字符串表示该来源没登记许可。 */
  readonly license: string;
  /** 证据等级。空 = manifest 里没标级。 */
  readonly grade: string;
}

/** 一次 ⑥⑦ 体检的结果。每个数字都带分母，分母全是个位数。 */
export interface Checkup {
  /**
   * 这一轮成不成立：判官到底看没看到本库的教材。
   *
   * 判据是 `judge_evidence_pool > 0`。资料池为 0 意味着证据检索桥当时没通
   * （2026-08-16 实测过一次：引擎少配 `AI_SERVICE_TOKEN`，桥全程 401），
   * 那一轮里正文与判官都在凭模型自己的知识写和判，与「换了哪本书」无关——
   * 数字照旧落盘，但不能当体检结果读，也不许上屏当数字。
   */
  readonly grounded: boolean;
  readonly runId: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly goldTopic: string;
  readonly scenes: number;
  readonly plannedScenes: number;
  readonly hallucination: {
    readonly supported: number;
    readonly checked: number;
    readonly incorrect: number;
    readonly uncertain: number;
    readonly evidenceFromCorpus: number;
    readonly evidencePool: number;
  } | null;
  /**
   * 资料到位率：生成端真拿到教材摘录的屏数 / 总屏数（`stages.trial.detail.evidence_ready`）。
   *
   * 与 `grounded` 是两个不同的洞：`grounded` 验的是**判官**那条链有没有资料池，
   * 这里验的是**生成端**——桥超时的屏判官照样拿到 6 块资料（两条链独立），
   * 但正文是模型凭记忆写的，接地数字必须对着这一行打折扣读。
   * 2026-08-17 之前的轮次没有这个字段，读不到给 null，页面不硬造。
   */
  readonly evidenceReady: { readonly ready: number; readonly total: number } | null;
  /**
   * 覆盖那一格**已撤下**，这里只留金标规模一个数（页面拿它写口径说明，不组成比率）。
   *
   * 撤因（引擎侧 `domain_intake._metric_coverage` 的模块注释是同一条）：原先印的
   * 「命中 x / 金标 N」分母是金标全集，分子来自固定 2 屏的试跑课，而试跑大纲机械点名的
   * 知识成分恒为 10 个（`TRIAL_SCENES_PER_COURSE × 5`），剩下的从没被要求讲却记在分母里。
   * 这个比值量的是「试跑规模 ÷ 金标规模」，三个域一齐失真，主语料自己最低——
   * 既证不了泛化差、也证不了主语料好。换成小分母也不成立：那个 10 是配置常量、不随领域变。
   */
  readonly goldTotal: number | null;
  /**
   * 引擎侧写的撤因原文（`metrics.coverage.reason`，带这一轮的真实屏数与金标数）。
   * 2026-08-17 之前跑的轮次没有这个字段，那时页面退回一句不带数字的说明——
   * 补一个本地算的比值等于把撤掉的那个数又算了一遍。
   */
  readonly coverageReason: string | null;
  readonly personalization: {
    readonly dimensions: number;
    readonly blindHit: number | null;
    readonly blindTotal: number | null;
  } | null;
  readonly cost: {
    readonly calls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly engineTokens: number;
  } | null;
}

/** 一个域一栏。 */
export interface DomainPanel {
  readonly corpus: string;
  readonly label: string;
  readonly scope: string;
  /**
   * 语料入库日期（`YYYY-MM-DD`），取**索引文件的落盘时间**。
   *
   * 接入流水线不记接入时刻：`readiness.json` 里没有任何时间戳字段（键只有 domain/scope/
   * source_dir/license/intake/vocabulary/concepts/prereq_graph/prereq_meta/difficulty/
   * readiness/corpus_index），所以只能用文件时间兜底。兜底文件选索引 `knowledge_index.jsonl`
   * 而不是 `readiness.json`：后者会被重跑 ④ 覆盖（2026-08-16 09:24 实测 odoo 的被改写过一次，
   * 语料本身没动），拿它当入库日期会一天一个数。页面上照这个口径写，不说成「接入于」。
   */
  readonly sourceFileDate: string;
  /** 可检索切片数。0 = 这个域生成课程时没素材可取。 */
  readonly chunks: number;
  readonly files: number;
  readonly chars: number;
  readonly goldTopics: number;
  readonly license: { readonly spdx: string; readonly unknown: boolean; readonly evidence: string };
  readonly sourceDir: string;
  readonly sources: readonly SourceRow[];
  readonly checkup: Checkup | null;
}

// ── ⑥⑦ 体检 run ────────────────────────────────────────────────────────────

interface RunRecord {
  run_id?: string;
  corpus?: string;
  status?: string;
  finished_at?: string;
  duration_ms?: number;
  options?: { checkup?: boolean; experiment?: boolean };
  stages?: Record<string, { status?: string; detail?: Record<string, any> }>;
}

function toCheckup(record: RunRecord): Checkup | null {
  const trial = record.stages?.trial;
  const metrics = record.stages?.metrics;
  if (trial?.status !== 'done' || metrics?.status !== 'done') return null;
  const t = trial.detail ?? {};
  const m = metrics.detail ?? {};
  const hall = m.hallucination ?? {};
  const cov = m.coverage ?? {};
  const pers = m.personalization ?? {};
  const blind = pers.blind_tier_judge ?? {};
  const cost = m.cost ?? {};
  const er = t.evidence_ready ?? {};
  return {
    grounded: Number(hall.judge_evidence_pool ?? 0) > 0,
    evidenceReady:
      typeof er.ready === 'number' && typeof er.total === 'number' && er.total > 0
        ? { ready: Number(er.ready), total: Number(er.total) }
        : null,
    runId: String(record.run_id ?? ''),
    finishedAt: String(record.finished_at ?? ''),
    durationMs: Number(record.duration_ms ?? 0),
    goldTopic: String(t.gold_topic ?? ''),
    scenes: Number(t.scenes ?? 0),
    plannedScenes: Number(t.planned_scenes ?? 0),
    hallucination:
      typeof hall.claims_checked === 'number'
        ? {
            supported: Number(hall.supported ?? 0),
            checked: Number(hall.claims_checked ?? 0),
            incorrect: Number(hall.incorrect ?? 0),
            uncertain: Number(hall.uncertain ?? 0),
            evidenceFromCorpus: Number(hall.judge_evidence_from_new_corpus ?? 0),
            evidencePool: Number(hall.judge_evidence_pool ?? 0),
          }
        : null,
    goldTotal: typeof cov.gold_total === 'number' ? Number(cov.gold_total) : null,
    coverageReason: typeof cov.reason === 'string' && cov.reason ? cov.reason : null,
    personalization: pers.comparable
      ? {
          dimensions: Number(pers.differing_dimensions ?? 0),
          blindHit: blind.ran ? Number(blind.hit ?? 0) : null,
          blindTotal: blind.ran ? Number(blind.total ?? 0) : null,
        }
      : null,
    cost:
      typeof cost.llm_calls === 'number'
        ? {
            calls: Number(cost.llm_calls),
            inputTokens: Number(cost.input_tokens ?? 0),
            outputTokens: Number(cost.output_tokens ?? 0),
            engineTokens: Number(cost.engine_tokens ?? 0),
          }
        : null,
  };
}

/**
 * 每个库最近一次跑完的体检。目录名带时间戳，倒序扫，第一条命中即最新。
 *
 * **跳过 `options.experiment` 的轮次**：对照实验（比如换一版讲义提示词跑 B 臂）
 * 产出的 run 数据本身有效，但它不代表产品当前形态。这一页是要交出去的测试样例，
 * 只能展示生产形态跑出来的数。2026-08-16 实测踩到：提示词 A/B 的 B 臂比 A 臂晚 18 分钟，
 * 于是「最新一条」把实验数顶到了交付页上，而生产提示词早已还原——页面数字与产品形态对不上。
 */
async function readCheckups(): Promise<Map<string, Checkup>> {
  const runsDir = path.join(kbDir(), 'intake_runs');
  let names: string[];
  try {
    names = (await fs.readdir(runsDir)).sort().reverse();
  } catch {
    return new Map();
  }
  const out = new Map<string, Checkup>();
  for (const name of names) {
    const record = await readJson<RunRecord>(path.join(runsDir, name, 'run.json'));
    const corpus = record?.corpus;
    if (!record || !corpus || out.has(corpus)) continue;
    if (record.options?.experiment) continue;
    const checkup = toCheckup(record);
    if (checkup) out.set(corpus, checkup);
  }
  return out;
}

// ── 资料清单 ───────────────────────────────────────────────────────────────

/** manifest 的一行拆成字段。逗号在引号里不算分隔——标题里有逗号的行会被它咬。 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const REPO_RE = /^https?:\/\/[^/]*github\.com\/([^/]+\/[^/]+)/;

/**
 * 主语料 ai 的资料清单：按 GitHub 仓库归并 `sources_manifest.csv`。
 *
 * 归并键取 URL 里的 `owner/repo`，不取人工写的书名——书名会随心情变，URL 不会。
 * 许可与等级取该仓库第一条切片登记的原文（同仓库各行的 license 字段是同一个常量注入的）。
 */
export async function readMainSources(): Promise<SourceRow[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(kbDir(), 'sources_manifest.csv'), 'utf-8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(lines[0] ?? '');
  const col = (name: string) => header.indexOf(name);
  const [iUrl, iLicense, iGrade] = [col('url'), col('license'), col('grade')];
  const rows = new Map<string, { name: string; url: string; docs: number; license: string; grade: string }>();
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const url = cells[iUrl] ?? '';
    const repo = REPO_RE.exec(url)?.[1];
    if (!repo) continue;
    const hit = rows.get(repo);
    if (hit) hit.docs += 1;
    else
      rows.set(repo, {
        name: repo,
        url: `https://github.com/${repo}`,
        docs: 1,
        license: cells[iLicense] ?? '',
        grade: cells[iGrade] ?? '',
      });
  }
  return [...rows.values()].sort((a, b) => b.docs - a.docs);
}

async function countLines(file: string): Promise<number> {
  try {
    const text = await fs.readFile(file, 'utf-8');
    return text.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** 真源文件的落盘日期，读不到给空串（页面上那一行就整行不印）。 */
async function fileDate(file: string): Promise<string> {
  try {
    return (await fs.stat(file)).mtime.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

// 脱敏函数已提到 `lib/metrics/redact-caliber.ts` 当共用真源——`/admin` 的指标带也要用它
// （本页做了脱敏、那边没做，同一批字符串漏在另一个页面上）。这里只转出，本页 import 不变。
export { redactCaliber } from '@/lib/metrics/redact-caliber';

async function countGoldTopics(corpus: string): Promise<number> {
  try {
    const files = await fs.readdir(path.join(engineDataDir(), 'eval', 'kc_gold_derived', corpus));
    return files.filter((f) => f.endsWith('.json') && f !== '_freeze.json').length;
  } catch {
    return 0;
  }
}

// ── 组装 ───────────────────────────────────────────────────────────────────

/**
 * 主语料 ai。它没有 `_intake` 报告（是先于接入流水线用 ingest 脚本逐个来源建的），
 * 所以规模只能自己数：切片数 = 索引行数，篇数 = manifest 行数。
 */
async function readMainPanel(checkups: Map<string, Checkup>): Promise<DomainPanel> {
  const sources = await readMainSources();
  const [chunks, goldTopics, sourceFileDate] = await Promise.all([
    countLines(path.join(kbDir(), 'knowledge_index.jsonl')),
    countGoldTopics('ai'),
    fileDate(path.join(kbDir(), 'knowledge_index.jsonl')),
  ]);
  return {
    corpus: 'ai',
    label: domainLabel('ai'),
    scope: '智能体、大模型、检索增强与部署（主语料）',
    sourceFileDate,
    chunks,
    files: sources.reduce((a, s) => a + s.docs, 0),
    chars: 0,
    goldTopics,
    license: { spdx: '逐来源不同', unknown: false, evidence: 'knowledge_base/sources_manifest.csv 的 license 字段' },
    sourceDir: 'data/knowledge_base/*_docs（各 ingest 脚本的策展产物）',
    sources,
    checkup: checkups.get('ai') ?? null,
  };
}

/**
 * 就绪度报告里的路径是接入那台机器上的绝对路径（`D:\UserData\Desktop\…`）。
 * 这一页要交出去，别人的桌面路径不该跟着上屏——截到仓库名那一段为止，
 * 信息量不减（还是能对上是哪份资料），也不再暴露谁的机器。
 */
function tidyPath(raw: string): string {
  const unix = raw.replace(/\\/g, '/');
  const i = unix.indexOf('/references/');
  return i >= 0 ? unix.slice(i + 1) : unix.split('/').slice(-3).join('/');
}

/** 许可判定依据里的绝对路径同样截短，句子结构原样保留（「查了 54 处」这类事实不能丢）。 */
function tidyEvidence(raw: string): string {
  return raw.replace(/[A-Za-z]:[\\/][^\s，；（）]*/g, (m) => tidyPath(m));
}

// ── 体检产物：页面上印出的那几条复算路径，点开就能看内容 ──────────────────

/** 弹层里能打开的一个产物文件。`text` 已脱敏，直接上屏。 */
export interface RunArtifact {
  readonly name: string;
  readonly text: string;
}

/**
 * run 目录名是流水线生成的 `<时间戳>-<短哈希>`。
 * 这里卡的是 `run.json` 里的 `run_id` 字段——它是文件里的值、不是我们扫出来的目录名，
 * 一律按外部输入待：字符集先卡死，落到绝对路径后再验一次前缀。
 */
const RUN_ID_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

/**
 * 上屏的只有这两类小文件：体检报告与「没讲到的知识成分」清单（各 1–2 KB）。
 * 两档课程正文 `beginner.json` / `advanced.json` 各 60 KB 上下，不塞进弹层。
 */
function showableArtifact(name: string): boolean {
  return name === 'REPORT.md' || /^[a-z]+_kc_misses\.json$/.test(name);
}

/**
 * `kc_misses.json` 的 `course` 字段记的是接入那台机器上的绝对路径
 * （JSON 里反斜杠双写：`D:\\UserData\\Desktop\\…`）。与 `tidyEvidence` 同一条纪律：
 * 这一页要当测试样例交出去，别人的桌面路径不该跟着交——只留 run 目录往下那一截。
 */
function tidyArtifactText(raw: string): string {
  return redactProviderText(raw);
}

/** 一轮体检能上屏的产物。目录不在、读不到，就是空数组——页面照常渲染，不报错。 */
export async function readRunArtifacts(runId: string): Promise<RunArtifact[]> {
  if (!RUN_ID_RE.test(runId)) return [];
  const base = path.resolve(path.join(kbDir(), 'intake_runs'));
  const dir = path.resolve(base, runId, 'trial_courses');
  if (!dir.startsWith(base + path.sep)) return [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: RunArtifact[] = [];
  for (const name of names.filter(showableArtifact).sort()) {
    try {
      out.push({ name, text: tidyArtifactText(await fs.readFile(path.join(dir, name), 'utf-8')) });
    } catch {
      /* 读不到就不列——不给一个打开是空的按钮 */
    }
  }
  return out;
}

async function readIntakePanel(corpus: string, checkups: Map<string, Checkup>): Promise<DomainPanel | null> {
  const readinessFile = path.join(kbDir(), `${corpus}_intake`, 'readiness.json');
  const r = await readJson<Record<string, any>>(readinessFile);
  if (!r) return null;
  const sourceDir = String(r.source_dir ?? '');
  const files = Number(r.intake?.accepted_files ?? 0);
  return {
    corpus,
    label: domainLabel(corpus),
    scope: String(r.scope ?? ''),
    sourceFileDate: await fileDate(path.join(kbDir(), 'corpora', corpus, 'knowledge_index.jsonl')),
    chunks: Number(r.corpus_index?.chunks ?? 0),
    files,
    chars: Number(r.intake?.accepted_chars ?? 0),
    goldTopics: await countGoldTopics(corpus),
    license: {
      spdx: String(r.license?.spdx ?? 'UNKNOWN'),
      unknown: Boolean(r.license?.unknown),
      evidence: String(r.license?.evidence ?? ''),
    },
    sourceDir: tidyPath(sourceDir),
    // 这类库是整份文档树扔进来的，来源只有一个，篇数就是收下的文件数。
    sources: [
      {
        name: tidyPath(sourceDir) || domainLabel(corpus),
        url: '',
        docs: files,
        // 许可判定 + 判定依据。依据里那些绝对路径同样截掉。
        license: [
          String(r.license?.spdx ?? 'UNKNOWN'),
          tidyEvidence(String(r.license?.evidence ?? '')),
        ]
          .filter(Boolean)
          .join('：'),
        grade: '',
      },
    ],
    checkup: checkups.get(corpus) ?? null,
  };
}

/** 上屏的三栏：主语料 + 两个跨大类的新域。顺序固定，主语料在最左当参照。 */
export const SHOWCASE_CORPORA = ['ai', 'smart-manufacturing', 'iotdb'] as const;

export async function readGeneralizationPanels(): Promise<DomainPanel[]> {
  // 与 readCorporaWithDrift 同一个坑：面板名走 domainLabel，先灌注册清单，
  // 否则重投出来的新库在这页上是裸英文目录名。
  const { readDomainRegistry } = await import('@/lib/server/domain-registry');
  await readDomainRegistry().catch(() => null);
  const checkups = await readCheckups();
  const [main, ...rest] = await Promise.all([
    readMainPanel(checkups),
    ...SHOWCASE_CORPORA.filter((c) => c !== 'ai').map((c) => readIntakePanel(c, checkups)),
  ]);
  return [main, ...rest.filter((p): p is DomainPanel => p !== null)];
}

/**
 * 盘上还有哪些库没上屏。脚注用——不列出来，读者会以为盘上只有三个库。
 * 判据是有没有 `corpora/<库>/`，与页面主栏同一条（能检索才算库）。
 */
export async function readOtherCorpora(): Promise<{ corpus: string; label: string; chunks: number }[]> {
  let names: string[];
  try {
    names = (await fs.readdir(path.join(kbDir(), 'corpora'), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const rows = await Promise.all(
    names
      .filter((n) => !(SHOWCASE_CORPORA as readonly string[]).includes(n))
      .map(async (corpus) => {
        const r = await readJson<Record<string, any>>(path.join(kbDir(), `${corpus}_intake`, 'readiness.json'));
        return {
          corpus,
          label: domainLabel(corpus),
          chunks: Number(r?.corpus_index?.chunks ?? 0),
        };
      }),
  );
  return rows.sort((a, b) => b.chunks - a.chunks);
}
