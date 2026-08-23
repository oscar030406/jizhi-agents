/**
 * 接入 run 的读取层与事件推演。
 *
 * 夹具是一次**真跑出来的** run 的事件（2026-08-15，六个 markdown 文件接成一个新库，
 * 三站并行），字段照 `docs/03-design/domain-intake-run-schema-20260815.md`。
 * 用真事件当夹具，才测得出「seq 交错时能不能把三站分道」这种事——
 * 自己编的顺序事件永远是串行的，测不出并行。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deriveView } from '@/lib/knowledge/intake-run-timeline';
import {
  isValidRunId,
  listRuns,
  readRunEvents,
  readRunRecord,
  type IntakeEvent,
  type IntakeRunRecord,
} from '@/lib/server/intake-runs';

const OK_RUN = '20260815T184831-30d79d';
const BAD_RUN = '20260815T184832-329e89';

/** 起点时刻。事件里的 ts 是 epoch 秒，夹具按相对偏移写，读起来是「第几毫秒」。 */
const T0 = 1786834111.855;
const ev = (seq: number, dms: number, stage: string, kind: string, message: string, extra = {}) =>
  ({
    seq,
    ts: T0 + dms / 1000,
    iso: '2026-08-15T18:48:31-04:00',
    run_id: OK_RUN,
    stage,
    kind,
    message,
    ...extra,
  }) as IntakeEvent;

/** 三站并行的那一段：⑥⑦ 的收尾事件夹在 ③ 完成之前，seq 是交错的。 */
const OK_EVENTS: IntakeEvent[] = [
  ev(0, 0, 'run', 'run_start', '领域接入 run 开始：llm-serving-demo（6 个文件）', {
    corpus: 'llm-serving-demo',
    options: { tier_range: 'L1-L3', build_vector: false, extract_concepts: false },
  }),
  ev(1, 0, 'receive', 'stage_start', '接收与清洗 开始'),
  ev(2, 38, 'receive', 'stage_progress', '收 6 个文件（32,101 字符），退回 0 个', {
    accepted: 6,
    rejected: 0,
    chars: 32101,
  }),
  ev(3, 40, 'receive', 'stage_done', '接收与清洗 完成', {
    status: 'done',
    detail: { accepted_files: 6, accepted_chars: 32101, rejected: [] },
    error: '',
  }),
  ev(4, 40, 'chunk', 'stage_start', '切块入库 开始'),
  ev(5, 43, 'chunk', 'stage_done', '切块入库 完成', {
    status: 'done',
    detail: { sections: 33, chunks: 33 },
    error: '',
  }),
  ev(6, 44, 'index', 'stage_start', '检索索引 开始'),
  ev(7, 44, 'knowledge', 'stage_start', '知识整理 开始'),
  ev(8, 45, 'gold', 'stage_start', '金标派生并冻结 开始'),
  ev(
    9,
    47,
    'knowledge',
    'stage_progress',
    '结构信号：章级概念面 0 个，交叉引用 0 条，结构候选边 0 条',
  ),
  ev(10, 57, 'knowledge', 'stage_done', '知识整理 完成', {
    status: 'done',
    detail: {
      concepts: 0,
      prereq_clauses: 0,
      human_signoff_required: true,
      vocabulary_note: '未抽取——概念抽取要调 LLM，本次 run 的 extract_concepts 开关是关的',
    },
    error: '',
  }),
  ev(11, 77, 'gold', 'stage_done', '金标派生并冻结 完成', {
    status: 'done',
    detail: { topics: 6, knowledge_components: 21, dropped_topics: 0 },
    error: '',
  }),
  ev(12, 77, 'trial', 'stage_skipped', '尚未接入：当前版本做到金标冻结为止', {
    status: 'pending',
    error: '',
  }),
  ev(13, 91, 'metrics', 'stage_skipped', '尚未接入：当前版本做到金标冻结为止', {
    status: 'pending',
    error: '',
  }),
  ev(14, 100, 'index', 'stage_done', '检索索引 完成', {
    status: 'done',
    detail: { backend: 'TfidfKnowledgeRetriever', chunks: 33, probe_hits: 3 },
    error: '',
  }),
  ev(15, 100, 'vector', 'stage_skipped', '跳过：默认关闭——构建向量索引要调嵌入 API（真花钱）', {
    status: 'skipped',
    error: '',
  }),
  ev(16, 573, 'run', 'run_done', 'run 完成：语料库「llm-serving-demo」已可检索', {
    corpus: 'llm-serving-demo',
    warnings: [],
    duration_ms: 105,
    products: {
      corpus_index: 'data/knowledge_base/corpora/llm-serving-demo/knowledge_index.jsonl',
    },
  }),
];

const FAIL_REASON =
  '没有可接入的文件：2 个全部被退回（首条：empty.md —— 正文不足 200 字符，疑似占位文件）';

const BAD_EVENTS: IntakeEvent[] = [
  {
    ...ev(0, 0, 'run', 'run_start', '领域接入 run 开始：broken-demo（2 个文件）'),
    run_id: BAD_RUN,
  },
  { ...ev(1, 1, 'receive', 'stage_start', '接收与清洗 开始'), run_id: BAD_RUN },
  {
    ...ev(2, 9, 'receive', 'stage_failed', `接收与清洗 失败：${FAIL_REASON}`, {
      status: 'failed',
      error: FAIL_REASON,
    }),
    run_id: BAD_RUN,
  },
  {
    ...ev(3, 10, 'chunk', 'stage_skipped', '跳过：上游「接收与清洗」failed', {
      status: 'skipped',
      error: '',
    }),
    run_id: BAD_RUN,
  },
  {
    ...ev(4, 13, 'run', 'run_failed', `run 失败：${FAIL_REASON}`, {
      error: FAIL_REASON,
      cleaned: ['data/knowledge_base/corpora/broken-demo'],
    }),
    run_id: BAD_RUN,
  },
];

function slot(
  order: number,
  label: string,
  deps: string[],
  status: string,
  durationMs: number | null,
  optional = false,
) {
  return {
    order,
    label,
    deps,
    optional,
    status,
    started_at: null,
    finished_at: null,
    duration_ms: durationMs,
    detail: null,
    error: '',
  };
}

const OK_RECORD = {
  run_id: OK_RUN,
  corpus: 'llm-serving-demo',
  scope: '能把大模型部署上线并做容量规划的工程师',
  status: 'done',
  created_at: '2026-08-15T18:48:31-04:00',
  finished_at: '2026-08-15T18:48:32-04:00',
  duration_ms: 105,
  options: { tier_range: 'L1-L3', build_vector: false, extract_concepts: false },
  limits: {},
  files: [{ name: 'ld01s01.md', original: 'ld01s01.md', bytes: 6251 }],
  stages: {
    receive: slot(1, '接收与清洗', [], 'done', 39),
    chunk: slot(2, '切块入库', ['receive'], 'done', 3),
    index: slot(3, '检索索引', ['chunk'], 'done', 56),
    vector: slot(3, '向量索引（异步旁路）', ['index'], 'skipped', null, true),
    knowledge: slot(4, '知识整理', ['chunk'], 'done', 13),
    gold: slot(5, '金标派生并冻结', ['chunk'], 'done', 32),
    trial: slot(6, '试跑课程', ['gold', 'knowledge'], 'pending', null),
    metrics: slot(7, '指标复测', ['trial'], 'pending', null),
  },
  products: { corpus_index: 'data/knowledge_base/corpora/llm-serving-demo/knowledge_index.jsonl' },
  warnings: [],
  error: '',
} as unknown as IntakeRunRecord;

const BAD_RECORD = {
  ...OK_RECORD,
  run_id: BAD_RUN,
  corpus: 'broken-demo',
  status: 'failed',
  duration_ms: 15,
  error: FAIL_REASON,
  stages: {
    receive: slot(1, '接收与清洗', [], 'failed', 10),
    chunk: slot(2, '切块入库', ['receive'], 'skipped', null),
  },
} as unknown as IntakeRunRecord;

let dataDir: string;
const savedEnv = process.env.ENGINE_DATA_DIR;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-runs-'));
  process.env.ENGINE_DATA_DIR = dataDir;
  for (const [id, record, events] of [
    [OK_RUN, OK_RECORD, OK_EVENTS],
    [BAD_RUN, BAD_RECORD, BAD_EVENTS],
  ] as const) {
    const dir = path.join(dataDir, 'knowledge_base', 'intake_runs', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify(record), 'utf-8');
    await fs.writeFile(
      path.join(dir, 'events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf-8',
    );
  }
});

afterAll(async () => {
  if (savedEnv === undefined) delete process.env.ENGINE_DATA_DIR;
  else process.env.ENGINE_DATA_DIR = savedEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('接入 run 读取层', () => {
  it('run 编号进路径前先卡字符集', () => {
    expect(isValidRunId(OK_RUN)).toBe(true);
    expect(isValidRunId('../../etc')).toBe(false);
    expect(isValidRunId('')).toBe(false);
  });

  it('列表新的在前，各状态几站数得对', async () => {
    const rows = await listRuns();
    expect(rows.map((r) => r.runId)).toEqual([BAD_RUN, OK_RUN]);
    const ok = rows[1];
    expect(ok.stageCounts.done).toBe(5);
    expect(ok.stageCounts.pending).toBe(2);
    expect(ok.stageCounts.skipped).toBe(1);
    expect(rows[0].error).toBe(FAIL_REASON);
  });

  it('增量拉取按 seq 续上，不重不漏', async () => {
    const first = await readRunEvents(OK_RUN, 0, 4);
    expect(first?.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    expect(first?.truncated).toBe(true);
    const rest = await readRunEvents(OK_RUN, first!.nextSeq);
    expect(rest?.events[0].seq).toBe(4);
    expect(rest?.truncated).toBe(false);
    // 同一次读盘顺手带回 run.json，前端不必再开一条路
    expect(rest?.record.corpus).toBe('llm-serving-demo');
  });

  it('一次都没跑过时返回空列表（页面据此出空态，不摆样例数据）', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-empty-'));
    process.env.ENGINE_DATA_DIR = empty;
    try {
      expect(await listRuns()).toEqual([]);
    } finally {
      process.env.ENGINE_DATA_DIR = dataDir;
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it('没有这个 run 就是 null，不去猜', async () => {
    expect(await readRunRecord('20260101T000000-nosuch')).toBeNull();
    expect(await readRunEvents('../../etc/passwd')).toBeNull();
  });

  /** 回放的前提：这条路一个网络请求都不发。掐死 fetch，读取照常。 */
  it('不问引擎进程：网络掐死也读得出全量事件', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('这一页不该发任何网络请求');
    }) as typeof fetch;
    try {
      const payload = await readRunEvents(OK_RUN);
      expect(payload?.events).toHaveLength(OK_EVENTS.length);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('事件推演', () => {
  it('三站并行被认出来：区间重叠 + 同一波', () => {
    const view = deriveView(OK_RECORD, OK_EVENTS);
    const byId = Object.fromEntries(view.stages.map((s) => [s.id, s]));
    // ③ ④ ⑤ 都只依赖 ②，同属一波
    expect(byId.index.wave).toBe(byId.knowledge.wave);
    expect(byId.gold.wave).toBe(byId.knowledge.wave);
    expect(byId.chunk.wave).toBeLessThan(byId.index.wave);
    // 三站的运行区间互相重叠
    expect(byId.index.overlaps).toEqual(expect.arrayContaining(['knowledge', 'gold']));
    expect(byId.knowledge.overlaps).toContain('index');
    // ① ② 是串行的，没有任何重叠
    expect(byId.receive.overlaps).toEqual([]);
    // 并行的证据也在数上：各站耗时之和 > run 墙钟
    expect(view.stageMsTotal).toBeGreaterThan(view.runMs!);
  });

  it('五种站状态各归各位，不从 message 里猜', () => {
    const view = deriveView(OK_RECORD, OK_EVENTS);
    const byId = Object.fromEntries(view.stages.map((s) => [s.id, s]));
    // 同一个 kind（stage_skipped）下的两种 status 必须分开：主动关掉 vs 尚未接入
    expect(byId.vector.status).toBe('skipped');
    expect(byId.trial.status).toBe('pending');
    expect(byId.metrics.status).toBe('pending');
    expect(byId.index.status).toBe('done');
    expect(view.runStatus).toBe('done');
  });

  it('④ 的待人工签核标记来自事件本身', () => {
    const view = deriveView(OK_RECORD, OK_EVENTS);
    const knowledge = view.stages.find((s) => s.id === 'knowledge')!;
    expect(knowledge.detail?.human_signoff_required).toBe(true);
    expect(knowledge.progress).toHaveLength(1);
  });

  it('每站耗时用引擎记的那一份，不在前端重算', () => {
    const view = deriveView(OK_RECORD, OK_EVENTS);
    const byId = Object.fromEntries(view.stages.map((s) => [s.id, s]));
    expect(byId.index.durationMs).toBe(56); // run.json 的 56ms，不是事件时间差算出的 56±
    expect(byId.receive.durationMs).toBe(39);
    expect(byId.vector.durationMs).toBeNull(); // 没跑过的站不给耗时
  });

  it('回放：游标停在中间，当时在跑的站就是 running', () => {
    // 前 10 条：③④⑤ 都已发车，④ 的进度事件到了，三站都还没收尾
    const mid = deriveView(OK_RECORD, OK_EVENTS, 10);
    const byId = Object.fromEntries(mid.stages.map((s) => [s.id, s]));
    expect(byId.index.status).toBe('running');
    expect(byId.knowledge.status).toBe('running');
    expect(byId.gold.status).toBe('running');
    expect(byId.trial.status).toBe('waiting');
    expect(mid.runStatus).toBe('running');
    expect(mid.finale).toBeNull();
    // 游标在 0：一站都没开始
    expect(deriveView(OK_RECORD, OK_EVENTS, 0).stages.every((s) => s.status === 'waiting')).toBe(
      true,
    );
  });

  it('失败 run：卡在哪站、原因、清掉的半成品都在', () => {
    const view = deriveView(BAD_RECORD, BAD_EVENTS);
    expect(view.runStatus).toBe('failed');
    const failed = view.stages.find((s) => s.status === 'failed');
    expect(failed?.id).toBe('receive');
    expect(failed?.error).toBe(FAIL_REASON);
    expect(view.finale?.cleaned).toEqual(['data/knowledge_base/corpora/broken-demo']);
  });
});

describe('run_queued 排队态', () => {
  it('run_queued 显示为排队并带原话，第一站开跑自动转回进行中', () => {
    const queuedEvents = [
      ev(1, 0, 'run', 'run_queued', '前面还有 2 个接入在跑，轮到会自动开始，不用重投'),
    ];
    const q = deriveView(OK_RECORD, queuedEvents as never);
    expect(q.runStatus).toBe('queued');
    expect(q.queueNote).toContain('不用重投');

    const started = [...queuedEvents, ev(2, 1000, 'receive', 'stage_start', '开始接收')];
    const r = deriveView(OK_RECORD, started as never);
    expect(r.runStatus).toBe('running');
    expect(r.queueNote).toBeNull();
  });

  it('非排队 run 的 queueNote 为 null', () => {
    expect(deriveView(OK_RECORD, OK_EVENTS).queueNote).toBeNull();
  });
});
