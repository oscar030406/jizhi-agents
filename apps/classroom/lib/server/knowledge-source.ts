/**
 * 「原件与处理过程」的读取层：一个知识库收了哪些原文件、每个文件切出多少块、
 * 哪些文件被退回、退回的理由是什么。
 *
 * 真源与 `knowledge-center.ts` 同一条：**引擎数据目录里的产物文件本身**，不问引擎进程。
 *
 * | 字段 | 真源 |
 * |---|---|
 * | 原件清单 | 主域 `ai` 走 `data/knowledge_base/*_docs/*.md`；其余走 `<域>_intake/readiness.json` 的 `source_dir` |
 * | 每个原件切出多少块 | 数索引里 `source_id` 的 `#` 前缀 |
 * | 退回清单 | `readiness.json` 的 `intake.rejected`（`{file, reason}` 数组） |
 * | 圈出范围 | `readiness.json` 的 `intake.scoped_out` |
 *
 * 反查规则（两套，都在磁盘上逐库实测过命中率）：
 * - **主域**：`source_id` 去掉 `#sN` 就是 `*_docs/<stem>.md`。AgentGuide 那一支的 source_id
 *   只有下划线前的前缀（`ag009` ↔ `ag009_22-parlant-....md`），所以先全等、失败再按 `_` 前缀。
 *   实测 386 个 stem 全部命中，425 个原件里 39 个没有切块（AgentGuide 未入库的 17 篇
 *   + `sample_docs` 的 22 篇测试语料）。
 * - **扩展域**：`scripts/ingest_domain.py:235` 那条 slug —— 相对路径去扩展名后把所有
 *   非 `[0-9A-Za-z]` 折成 `-`、转小写。实测 vecdb 42/42、rag-adv 30/30、odoo 881/881、
 *   iotdb 242/242。中文文件名会被整段折没，vecdb 有 2 处碰撞，页面把候选都列出来，
 *   不挑一个显示。
 *
 * 纪律：读不到就是 `null` / 空数组，页面如实留白——不拿占位数顶。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { enginePath, indexPathOf, isValidCorpusName } from './knowledge-center';

/** 与 `backend/rag/intake.py` 的 `READABLE_SUFFIXES` 同一份口径。 */
const READABLE_SUFFIXES = new Set(['.md', '.markdown', '.txt']);

/**
 * 与 `backend/rag/intake.py:74` 的 `SKIP_DIRS` 同一份口径：整棵跳过，**且刻意不进退回清单**。
 * 这里必须跟着抄，否则「原目录有 K 个、收了 N 个、退了 M 个」三个数对不上账。
 */
const SKIP_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
]);

/** 弹层里一次最多送多少字节原文。超出就截断并告知，不静默截。 */
const MAX_TEXT_BYTES = 256 * 1024;

/** 目录递归的深度上限。防的是符号链接成环，不是业务约束。 */
const MAX_DEPTH = 8;

export interface SourceFileRow {
  /** 相对原件根目录的路径，也是读取接口的参数。 */
  rel: string;
  bytes: number;
  /** 这个原件切出多少块。0 = 在盘上但没进索引。 */
  chunks: number;
  /** 第一块的标题，用来告诉看的人这个文件是哪一章。索引里没有就是 null。 */
  title: string | null;
  /** 退回理由。没被退回、或这个库根本没有退回记录时为 null。 */
  rejected: string | null;
  /** 扩展名在白名单内 = 页面上能点开看。 */
  readable: boolean;
  /** 与它折成同一个 slug 的其他原件。非空 = 切块归属无法唯一定位。 */
  collides: string[];
}

export interface SourceGroup {
  /** 相对路径的第一段（主域就是 `*_docs` 目录名）。 */
  name: string;
  files: SourceFileRow[];
  bytes: number;
  chunks: number;
}

export interface SourceView {
  corpus: string;
  /** 原件根目录，展示用。主域给引擎相对路径，扩展域给 readiness.json 里那串原样。 */
  rootLabel: string;
  /** 根目录在不在这台机器上。扩展域存的是接入时的绝对路径，换机就断。 */
  rootExists: boolean;
  /** 根目录在引擎数据目录之外（扩展域的原件不随数据目录一起走）。 */
  external: boolean;
  groups: SourceGroup[];
  totals: { files: number; bytes: number; chunks: number; unindexed: number };
  /** 索引里的块总数，用来跟逐文件加总对账。 */
  indexChunks: number;
  /** 索引里有、盘上反查不到原件的 source_id 前缀。 */
  orphans: string[];
  /** `intake.rejected`。这个库没留退回记录时为 null——与「退回 0 个」不是一回事。 */
  rejected: Array<{ file: string; reason: string }> | null;
  /** 退回理由按原句分桶的计数，多的在前。 */
  rejectedBuckets: Array<{ reason: string; count: number }>;
  /** 人工按前缀圈掉的范围，以及其中有多少个仍然在索引里（口径对不上就得说）。 */
  scopedOut: { prefixes: string[]; files: string[]; stillIndexed: number } | null;
}

export interface SourceFileDetail {
  rel: string;
  bytes: number;
  /** 原文超过 256 KB 被截断。 */
  truncated: boolean;
  text: string;
  chunks: Array<{ sourceId: string; title: string; url: string | null; excerpt: string }>;
}

/** `readiness.json` 里本模块读到的那几个字段。 */
interface ReadinessSlice {
  source_dir?: string;
  intake?: {
    rejected?: Array<{ file?: string; reason?: string }>;
    scoped_out?: { prefixes?: string[]; files?: string[] } | null;
  };
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/**
 * `scripts/ingest_domain.py:235` 那条 slug，逐字复刻：
 * `re.sub(r"[^0-9A-Za-z]+", "-", rel.rsplit(".", 1)[0]).strip("-").lower() or "doc"`。
 *
 * `rsplit(".", 1)` 而不是「取扩展名」：`.gitignore` 这种全是扩展名的文件在 Python 那边
 * 切完只剩空串，最终落到兜底的 `doc`。这里跟着走，否则反查会在这类文件上错位。
 */
function slugOf(rel: string): string {
  const cut = rel.lastIndexOf('.');
  const base = cut === -1 ? rel : rel.slice(0, cut);
  return base.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'doc';
}

/** 主域文件名 → 候选 source_id 前缀。先全等，失败再按下划线前缀（AgentGuide 那一支）。 */
function mainKeys(rel: string): string[] {
  const base = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const prefix = base.split('_')[0];
  return prefix && prefix !== base ? [base, prefix] : [base];
}

interface SourceRoot {
  /** 原件根目录的绝对路径。取不到为 null。 */
  dir: string | null;
  label: string;
  /** 主域：根目录是知识库目录，只收 `*_docs/` 下的 .md。 */
  main: boolean;
  readiness: ReadinessSlice | null;
}

/**
 * 原件根目录。
 *
 * 主域 `ai` 建于入库链之前，没有 `readiness.json`，原件就散在知识库目录下的 `*_docs/` 里。
 * 扩展域的原件**不在引擎数据目录内**（`corpora/<域>/` 下只有索引和向量），
 * 唯一的指向是 `readiness.json` 里那串接入时那台机器的绝对路径。
 */
async function sourceRootOf(corpus: string): Promise<SourceRoot> {
  const kb = enginePath('data/knowledge_base');
  if (corpus === 'ai') {
    return { dir: kb, label: 'data/knowledge_base/*_docs/', main: true, readiness: null };
  }
  const readiness = await readJson<ReadinessSlice>(
    enginePath(`data/knowledge_base/${corpus}_intake/readiness.json`),
  );
  const declared = readiness?.source_dir?.trim();
  if (!declared) {
    // 引擎侧 H5 修复后：原件在引擎外时 source_dir 落 null、原始路径进 source_dir_note。
    // 这里把 note 透出成 label，让页面能说清是「路径不可移植」而不是「没有原件」。
    const note = (readiness as { source_dir_note?: string } | null)?.source_dir_note?.trim();
    return { dir: null, label: note ?? '', main: false, readiness };
  }
  // 新格式是相对引擎根的 posix 路径（data/knowledge_base/...）；存量 readiness
  // 里还有接入机绝对路径，原样保留兜底——在那台机器上仍然可用。
  const isAbsolute = path.isAbsolute(declared) || /^[A-Za-z]:[\\/]/.test(declared);
  const dir = isAbsolute ? declared : enginePath(declared);
  return { dir, label: declared, main: false, readiness };
}

/** 走一遍原件目录。跳过的目录与 `intake.py` 一致，否则对不上账。 */
async function walkFiles(
  root: string,
  main: boolean,
): Promise<Array<{ rel: string; bytes: number }>> {
  const out: Array<{ rel: string; bytes: number }> = [];
  async function visit(dir: string, prefix: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || depth >= MAX_DEPTH) continue;
        // 主域只有一层：知识库目录下的 `*_docs/`。其余目录（corpora、各域 intake）不是原件。
        if (main && (depth > 0 || !entry.name.endsWith('_docs'))) continue;
        await visit(abs, rel, depth + 1);
      } else if (entry.isFile()) {
        if (main && (depth === 0 || !entry.name.endsWith('.md'))) continue;
        try {
          out.push({ rel, bytes: (await fs.stat(abs)).size });
        } catch {
          /* stat 不到就不列——不编一个字节数 */
        }
      }
    }
  }
  await visit(root, '', 0);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 索引里每个 source_id 前缀的块数与首块标题。
 *
 * ponytail: 整个 jsonl 读进内存再逐行解析（最大的 iotdb 索引 4.8 MB，这一页 force-dynamic
 * 每次渲染都会读一遍）。天花板是索引上到几百 MB，那时改成流式扫描或让入库链把
 * 「每个原件切出多少块」直接写进产物文件。
 */
async function chunkIndex(corpus: string): Promise<Map<string, { count: number; title: string }>> {
  const map = new Map<string, { count: number; title: string }>();
  let text: string;
  try {
    text = await fs.readFile(enginePath(indexPathOf(corpus)), 'utf-8');
  } catch {
    return map;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: { source_id?: unknown; title?: unknown };
    try {
      row = JSON.parse(line) as { source_id?: unknown; title?: unknown };
    } catch {
      continue;
    }
    if (typeof row.source_id !== 'string') continue;
    const stem = row.source_id.split('#')[0];
    const hit = map.get(stem);
    if (hit) hit.count += 1;
    else map.set(stem, { count: 1, title: typeof row.title === 'string' ? row.title : '' });
  }
  return map;
}

export async function readSourceView(corpus: string): Promise<SourceView | null> {
  if (!isValidCorpusName(corpus)) return null;
  const root = await sourceRootOf(corpus);
  const counts = await chunkIndex(corpus);
  const indexChunks = [...counts.values()].reduce((a, c) => a + c.count, 0);

  const rejectedRaw = root.readiness?.intake?.rejected;
  const rejected = Array.isArray(rejectedRaw)
    ? rejectedRaw.map((r) => ({ file: String(r?.file ?? ''), reason: String(r?.reason ?? '') }))
    : null;
  const rejectedBy = new Map((rejected ?? []).map((r) => [r.file, r.reason]));
  const buckets = new Map<string, number>();
  for (const r of rejected ?? []) buckets.set(r.reason, (buckets.get(r.reason) ?? 0) + 1);

  const files = root.dir ? await walkFiles(root.dir, root.main) : [];
  const rootExists = root.dir ? files.length > 0 || (await stat(root.dir)) : false;

  // 先把每个文件落到它命中的那个 source_id 前缀上，再回头看哪些前缀被多个文件占了。
  const keyed = files.map((f) => {
    const keys = root.main ? mainKeys(f.rel) : [slugOf(f.rel)];
    const key = keys.find((k) => counts.has(k)) ?? keys[keys.length - 1];
    return { ...f, key };
  });
  // 碰撞只在**能入库的文件**之间算。vecdb 那批中文名图片折出来的 slug 会跟同目录的
  // .md 撞在一起（`Milvus/chapter6/图1.png` 与 `Milvus/chapter6/底层架构.md` 都 → `milvus-chapter6`），
  // 但图片压根没进过索引，把它算成「无法唯一定位」是虚报：21 个文件报警，实际只有 2 处。
  const byKey = new Map<string, string[]>();
  for (const f of keyed) {
    if (!READABLE_SUFFIXES.has(path.extname(f.rel).toLowerCase())) continue;
    byKey.set(f.key, [...(byKey.get(f.key) ?? []), f.rel]);
  }

  const groups = new Map<string, SourceGroup>();
  const counted = new Set<string>();
  let totalBytes = 0;
  let totalChunks = 0;
  let unindexed = 0;
  for (const f of keyed) {
    const hit = counts.get(f.key);
    const readable = READABLE_SUFFIXES.has(path.extname(f.rel).toLowerCase());
    const row: SourceFileRow = {
      rel: f.rel,
      bytes: f.bytes,
      chunks: hit?.count ?? 0,
      title: hit?.title || null,
      rejected: rejectedBy.get(f.rel) ?? null,
      readable,
      collides: readable ? (byKey.get(f.key) ?? []).filter((r) => r !== f.rel) : [],
    };
    totalBytes += row.bytes;
    // 加总按 source_id 前缀去重：碰撞时那几块是共用的，逐文件相加会把它们数两遍，
    // 加出来的总数比索引里实际的块数还多。
    const fresh = hit && !counted.has(f.key) ? hit.count : 0;
    if (hit) counted.add(f.key);
    totalChunks += fresh;
    // 被退回的文件不算「在盘未入库」——顶部对账条与下面那张表的状态列必须同口径
    // （表里三态互斥，一个文件只显示「退回」）。原来两处都数，odoo 会写成
    // 「在盘未入库 82 / 退回 82」，而表里根本没有一行是「在盘未入库」。
    if (row.chunks === 0 && !row.rejected) unindexed += 1;
    const name = f.rel.includes('/') ? f.rel.slice(0, f.rel.indexOf('/')) : '（根目录）';
    const group = groups.get(name) ?? { name, files: [], bytes: 0, chunks: 0 };
    group.files.push(row);
    group.bytes += row.bytes;
    group.chunks += fresh;
    groups.set(name, group);
  }

  const claimed = new Set(keyed.filter((f) => counts.has(f.key)).map((f) => f.key));
  const scopedRaw = root.readiness?.intake?.scoped_out;
  const scopedFiles = (scopedRaw?.files ?? []).map(String);

  return {
    corpus,
    rootLabel: root.label,
    rootExists,
    external: !root.main,
    groups: [...groups.values()].sort((a, b) => b.files.length - a.files.length),
    totals: { files: keyed.length, bytes: totalBytes, chunks: totalChunks, unindexed },
    indexChunks,
    orphans: [...counts.keys()].filter((k) => !claimed.has(k)).sort(),
    rejected,
    rejectedBuckets: [...buckets.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    scopedOut: scopedRaw
      ? {
          prefixes: (scopedRaw.prefixes ?? []).map(String),
          files: scopedFiles,
          // 「圈出去」的文件仍在索引里 = 报告与索引对不上账。iotdb 就是这一处：
          // 索引是后来用 --index-only 补建的，没吃 scoped_out。页面必须说出来。
          stillIndexed: scopedFiles.filter((f) => counts.has(slugOf(f))).length,
        }
      : null,
  };
}

async function stat(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 按需读单个原件的正文与它切出的块。
 *
 * 路径闸：`rel` 只能落在这个库自己的原件根目录里。根目录是服务端从 `readiness.json`
 * 现算的，不接受调用方指定；`rel` 先 `path.resolve` 再校验前缀，`..` 与绝对路径都穿不出去。
 * 扩展名再卡一道白名单，免得把 npz / 图片当文本读出来。
 */
export async function readSourceFile(
  corpus: string,
  rel: string,
): Promise<SourceFileDetail | null> {
  if (!isValidCorpusName(corpus) || !rel || rel.includes('\0')) return null;
  const root = await sourceRootOf(corpus);
  if (!root.dir) return null;
  const base = path.resolve(root.dir);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  if (!READABLE_SUFFIXES.has(path.extname(abs).toLowerCase())) return null;

  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch {
    return null;
  }
  const truncated = buf.byteLength > MAX_TEXT_BYTES;

  const key = root.main ? mainKeys(rel) : [slugOf(rel)];
  const chunks: SourceFileDetail['chunks'] = [];
  let indexText = '';
  try {
    indexText = await fs.readFile(enginePath(indexPathOf(corpus)), 'utf-8');
  } catch {
    /* 没有索引就只给原文 */
  }
  for (const line of indexText.split('\n')) {
    if (!line.trim()) continue;
    let row: { source_id?: unknown; title?: unknown; url?: unknown; content?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    if (typeof row.source_id !== 'string') continue;
    const stem = row.source_id.split('#')[0];
    if (!key.includes(stem)) continue;
    const content = typeof row.content === 'string' ? row.content : '';
    chunks.push({
      sourceId: row.source_id,
      title: typeof row.title === 'string' ? row.title : '',
      url: typeof row.url === 'string' && row.url ? row.url : null,
      excerpt: content.replace(/\s+/g, ' ').trim().slice(0, 80),
    });
  }
  // 主域先全等再退到下划线前缀：两个键都命中时只认全等的那一批，免得把同前缀的另一篇算进来。
  const exact = chunks.filter((c) => c.sourceId.split('#')[0] === key[0]);

  return {
    rel,
    bytes: buf.byteLength,
    truncated,
    text: buf.subarray(0, MAX_TEXT_BYTES).toString('utf-8'),
    chunks: exact.length > 0 ? exact : chunks,
  };
}
