import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { hasBillableTokens, type NormalizedUsage } from '@/lib/usage/normalize';

const log = createLogger('UsageStorage');

/** Base directory for usage logs; lands in the openmaic-data volume in Docker. */
function usageDir(baseDir?: string): string {
  return baseDir ?? path.join(process.cwd(), 'data', 'usage');
}

/** Current month's jsonl file name, e.g. usage/2026-06.jsonl. */
function monthlyFile(dir: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return path.join(dir, `${y}-${m}.jsonl`);
}

/** What kind of generation produced this usage. */
export type UsageKind = 'llm' | 'image' | 'video' | 'tts' | 'asr';
/** Unit of the non-token quantity. */
export type UsageUnit = 'token' | 'image' | 'second' | 'character';

/** Input to record one generation's usage. */
export interface UsageRecordInput {
  /** Modality. Defaults to 'llm'. */
  kind?: UsageKind;
  source: string;
  providerId: string;
  modelId: string;
  modelString: string;
  /** Token usage (LLM only). */
  usage?: NormalizedUsage;
  /** Non-token quantity: images count / seconds / characters. */
  quantity?: number;
  /** Unit for `quantity`. */
  unit?: UsageUnit;
  /**
   * Why the model stopped: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'.
   * 记它是为了把「教具 HTML 断在半截」这类失败归因清楚——达到输出上限（length）
   * 和模型自己提前收尾（stop）在产物上长得一样，不记就分不出。
   * 见 apps/engine/data/eval/model_matrix_20260730/README.md「这份数据不支持什么」。
   */
  finishReason?: string;
  /** 属于哪门课。由 `lib/ai/usage-context.ts` 的异步上下文带入，见 {@link UsageRecord.classroomId}。 */
  classroomId?: string;
  /** 发生过跨模型回落时，本来该用的那个模型 id。见 {@link UsageRecord.fallbackFrom}。 */
  fallbackFrom?: string;
}

/** A persisted usage row — pure usage, no cost. */
export interface UsageRecord {
  id: string;
  createdAt: number;
  kind: UsageKind;
  source: string;
  providerId: string;
  modelId: string;
  modelString: string;
  // LLM token counts (0 for non-LLM rows).
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  // Non-token usage (e.g. image count, video seconds, TTS characters).
  quantity?: number;
  unit?: UsageUnit;
  /** 模型为什么停：length 表示撞到输出上限（产物大概率被截断）。 */
  finishReason?: string;
  /**
   * 这次调用属于哪门课。**新增字段，只对新记录生效**——已有 jsonl 不追溯补，
   * 按时间窗猜出来的归因不是账。缺省时整个字段不落盘（见 recordUsage 里的注释）。
   * 由 `lib/ai/usage-context.ts` 的异步上下文自动带入，调用方不用逐个传。
   */
  classroomId?: string;
  /**
   * 这一行的 `modelId` 是**回落后**实际用上的模型，`fallbackFrom` 是本来该用的那个
   * （WO-M2 跨模型回落，默认关）。缺省时整个字段不落盘——没发生就是没发生。
   * 有这个字段的行不能当成「主模型的表现」来统计。
   */
  fallbackFrom?: string;
}

interface RecordOptions {
  baseDir?: string;
  /** Injected clock for deterministic tests. */
  now?: Date;
}

let counter = 0;
function makeId(now: Date): string {
  counter = (counter + 1) % 1_000_000;
  return `${now.getTime()}-${counter.toString(36)}`;
}

const ZERO_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
};

/**
 * Records one generation's usage as a jsonl line. Fire-and-forget: never throws —
 * a logging failure must not break generation.
 *
 * - LLM rows: require billable tokens (skips empty usage, e.g. a streamed
 *   OpenAI-compatible response that omitted usage).
 * - Non-LLM rows (image/video/tts/asr): require quantity > 0.
 */
export async function recordUsage(
  input: UsageRecordInput,
  opts: RecordOptions = {},
): Promise<void> {
  try {
    // 测试跑不许落生产账本。vitest 里 mock 的是**模型层**（MockLanguageModelV3），
    // 记账层照旧真写——2026-08 账本 11455 行里 4487 行 `mock-model-id` 就是这么来的。
    // 显式传了 baseDir 的（usage-storage 自己的用例）是冲临时目录写，放行。
    if (process.env.VITEST && !opts.baseDir) return;

    const kind: UsageKind = input.kind ?? 'llm';
    const usage = input.usage ?? ZERO_USAGE;

    if (kind === 'llm') {
      // 零 token 的调用原本直接丢弃（省掉计费噪声）。但截断、超时、内容过滤这些
      // 失败调用恰恰经常没有 usage——全丢掉的话，finishReason 埋了也统计不到，
      // 而那正是我们最需要归因的一类。所以：带 finishReason 的一律留。
      if (!hasBillableTokens(usage) && !input.finishReason) return;
    } else if (!input.quantity || input.quantity <= 0) {
      return;
    }

    const now = opts.now ?? new Date();
    const record: UsageRecord = {
      id: makeId(now),
      createdAt: now.getTime(),
      kind,
      source: input.source,
      providerId: input.providerId,
      modelId: input.modelId,
      modelString: input.modelString,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      reasoningTokens: usage.reasoningTokens,
      ...(input.quantity != null ? { quantity: input.quantity } : {}),
      ...(input.unit ? { unit: input.unit } : {}),
      // 课程归因。**只在有上下文时写**——不在课程生成路径里的调用
      // （web-search / verify-model / quiz-grade）本来就不属于任何课，
      // 给它们塞个空字段只会让读的人以为归因失败了。
      ...(input.classroomId ? { classroomId: input.classroomId } : {}),
      ...(input.finishReason ? { finishReason: input.finishReason } : {}),
      ...(input.fallbackFrom ? { fallbackFrom: input.fallbackFrom } : {}),
    };

    const dir = usageDir(opts.baseDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(monthlyFile(dir, now), JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    log.warn('Failed to record usage (ignored):', err);
  }
}

/** A non-LLM modality usage event (image / video / tts / asr). */
export interface GenerationUsageInput {
  kind: Exclude<UsageKind, 'llm'>;
  unit: UsageUnit;
  providerId: string;
  /** The client-requested model id; falls back to providerId when absent. */
  modelId?: string;
  quantity: number;
}

/**
 * Records a non-LLM generation's usage. Thin wrapper over {@link recordUsage}
 * that derives `source` (= kind) and `modelString` (`provider:model`) from the
 * modality, so the generate routes don't each repeat that construction.
 * Fire-and-forget like `recordUsage`.
 */
export function recordGenerationUsage(input: GenerationUsageInput): Promise<void> {
  const modelId = input.modelId || input.providerId;
  return recordUsage({
    kind: input.kind,
    unit: input.unit,
    source: input.kind,
    providerId: input.providerId,
    modelId,
    modelString: `${input.providerId}:${modelId}`,
    quantity: input.quantity,
  });
}

interface ReadOptions {
  baseDir?: string;
  /** Limit to specific YYYY-MM month files; defaults to all files in the dir. */
  months?: string[];
}

/**
 * Reads all usage records (across monthly files). Returns [] when the dir is
 * absent. Malformed lines are skipped. Legacy rows without `kind` are treated as
 * 'llm'; any legacy cost fields are simply ignored.
 */
export async function readUsageRecords(opts: ReadOptions = {}): Promise<UsageRecord[]> {
  const dir = usageDir(opts.baseDir);
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  if (opts.months?.length) {
    files = files.filter((f) => opts.months!.some((m) => f.startsWith(m)));
  }

  const records: UsageRecord[] = [];
  for (const file of files.sort()) {
    let content: string;
    try {
      content = await fs.readFile(path.join(dir, file), 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as UsageRecord;
        if (!row.kind) row.kind = 'llm'; // backward-compat
        records.push(row);
      } catch {
        // skip malformed line
      }
    }
  }
  return records;
}
