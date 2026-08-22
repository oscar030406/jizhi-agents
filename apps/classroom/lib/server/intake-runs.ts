/**
 * 领域接入 run 的读取层：run 列表、run.json、events.jsonl。
 *
 * 真源是引擎数据目录里的 `knowledge_base/intake_runs/<run_id>/`，**直接读文件、不问引擎进程**。
 * 理由与 `lib/server/knowledge-center.ts` 同一条：这两个文件本来就是引擎自己落的盘，
 * 引擎的查询端点也只是去读它们；多一跳只多一个「引擎离线时页面空白」的失败态。
 * 接入 run 结束后的回放因此在引擎停机时照常可用（这是本页的验收项之一）。
 *
 * 字段口径全部按 `docs/03-design/domain-intake-run-schema-20260815.md`。
 * **阶段清单不在这里抄第二份**：站号、标签、依赖都从 run.json 的 `stages` 里读，
 * 那是引擎写下的那一份。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 一条事件。前七个字段每条都有，其余按 kind 各自附带（`detail`、`error`、`cleaned`…）。 */
export interface IntakeEvent {
  seq: number;
  ts: number;
  iso: string;
  run_id: string;
  stage: string;
  kind: string;
  message: string;
  [extra: string]: unknown;
}

// partial：站跑完了但少了一块可选成分（⑧ 的示例提示词生成失败即如此）。
// 与 done 同属跑完的收尾形态，引擎那边 kind 也是 stage_done，差别只在这个 status。
export type StageStatus =
  | 'waiting'
  | 'running'
  | 'done'
  | 'partial'
  | 'failed'
  | 'skipped'
  | 'pending';

export interface IntakeStageSlot {
  order: number;
  label: string;
  deps: string[];
  optional: boolean;
  status: StageStatus;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  detail: Record<string, unknown> | null;
  error: string;
}

export interface IntakeRunRecord {
  run_id: string;
  corpus: string;
  scope: string;
  status: 'running' | 'done' | 'failed';
  created_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  options: Record<string, unknown>;
  limits: Record<string, unknown>;
  files: Array<{ name: string; original: string; bytes: number }>;
  stages: Record<string, IntakeStageSlot>;
  products: Record<string, string>;
  warnings: string[];
  error: string;
}

export interface IntakeRunSummary {
  runId: string;
  corpus: string;
  scope: string;
  status: IntakeRunRecord['status'];
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  files: number;
  /** 各状态各几站。口径与引擎 `list_runs()` 的 `stage_counts` 一致。 */
  stageCounts: Record<StageStatus, number>;
  error: string;
}

/** run 目录名的字符集，与引擎 `_safe_run_id` 同一条——外部输入不可信。 */
export function isValidRunId(runId: string): boolean {
  return /^[0-9A-Za-z:-]{1,64}$/.test(runId);
}

function runsDir(): string {
  const data =
    process.env.ENGINE_DATA_DIR || path.join(process.cwd(), '..', 'agent-engine', 'data');
  return path.join(data, 'knowledge_base', 'intake_runs');
}

/** 展示用：run 目录的引擎相对路径。空态里要把它摆出来，看的人能直接去磁盘核。 */
export const RUNS_DIR_LABEL = 'data/knowledge_base/intake_runs/';

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export async function readRunRecord(runId: string): Promise<IntakeRunRecord | null> {
  if (!isValidRunId(runId)) return null;
  return readJson<IntakeRunRecord>(path.join(runsDir(), runId, 'run.json'));
}

/**
 * 增量拉取。`since` 传上次拿到的 `nextSeq`，返回体与引擎
 * `GET /runs/{id}/events` 同形，前端两条路（读盘 / 走引擎）可以互换。
 *
 * ponytail: 整个 events.jsonl 每次读一遍再按 seq 过滤。天花板是单 run 事件上万条时
 * 每次轮询都要重读全文——真到那一步再按行偏移量做游标缓存。眼下一次 run 十几条。
 */
export async function readRunEvents(
  runId: string,
  since = 0,
  limit = 500,
): Promise<{
  runId: string;
  status: string;
  nextSeq: number;
  truncated: boolean;
  events: IntakeEvent[];
  /** 同一次读盘顺手带上 run.json。每站的 `duration_ms` 只有它有，前端不必再开一条路去取。 */
  record: IntakeRunRecord;
} | null> {
  const record = await readRunRecord(runId);
  if (!record) return null;
  let text = '';
  try {
    text = await fs.readFile(path.join(runsDir(), runId, 'events.jsonl'), 'utf-8');
  } catch {
    /* 事件文件还没落第一行：返回空事件，status 仍然如实给 */
  }
  const all: IntakeEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as IntakeEvent;
      if ((event.seq ?? 0) >= since) all.push(event);
    } catch {
      /* 半行：写盘正写到一半时读到的。丢掉这一行，下次轮询会再拿到完整的 */
    }
  }
  const events = all.slice(0, limit);
  return {
    runId,
    status: record.status,
    nextSeq: events.length ? events[events.length - 1].seq + 1 : since,
    truncated: all.length > limit,
    events,
    record,
  };
}

const STATUSES: StageStatus[] = [
  'done',
  'partial',
  'failed',
  'skipped',
  'pending',
  'running',
  'waiting',
];

/** run 列表，新的在前。目录不存在（一次都没跑过）时返回空数组，页面出空态。 */
export async function listRuns(limit = 30): Promise<IntakeRunSummary[]> {
  let names: string[];
  try {
    const entries = await fs.readdir(runsDir(), { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && isValidRunId(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  names.sort().reverse(); // run_id 以时间戳打头，字典序倒排 = 新的在前
  const rows: IntakeRunSummary[] = [];
  for (const name of names.slice(0, limit)) {
    const record = await readRunRecord(name);
    if (!record) continue;
    const stages = Object.values(record.stages ?? {});
    rows.push({
      runId: record.run_id ?? name,
      corpus: record.corpus ?? '',
      scope: record.scope ?? '',
      status: record.status,
      createdAt: record.created_at,
      finishedAt: record.finished_at ?? null,
      durationMs: record.duration_ms ?? null,
      files: (record.files ?? []).length,
      stageCounts: Object.fromEntries(
        STATUSES.map((s) => [s, stages.filter((x) => x?.status === s).length]),
      ) as Record<StageStatus, number>,
      error: record.error ?? '',
    });
  }
  return rows;
}
