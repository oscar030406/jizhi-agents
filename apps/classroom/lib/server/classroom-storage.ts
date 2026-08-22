import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

export function buildRequestOrigin(req: NextRequest): string {
  return req.headers.get('x-forwarded-host')
    ? `${req.headers.get('x-forwarded-proto') || 'http'}://${req.headers.get('x-forwarded-host')}`
    : req.nextUrl.origin;
}

/**
 * 生成这门课时**当时就知道**的档位与目标画像。
 *
 * 落在课程 JSON 的根级，不进 `stage`——`Stage` 是 `@openmaic/dsl` 的版本化公共契约，
 * 为了一个展示/审计字段去改契约不划算（图纸 §4.3 勘误）。
 *
 * 它回答的是账本 B3 那个问题：一门课的摘录难度中位数是 0.03 还是 0.54，
 * 单看数字判断不了合不合适——得知道这门课本来是给谁生成的。以前这个信息在
 * 落库那一刻全丢了。
 *
 * 脱敏（赛题第(5)款）：只落领域、学历档与五维自评这类**非身份**字段。
 * 画像里的 `role`（身份/来路自述）与 `learning_preference`（自述文本）不落盘。
 */
export interface CourseGenerationMeta {
  /** 引擎蓝图给的内容难度档（L1–L4）。 */
  recommendedDifficulty: string;
  /** 讲解姿态档：由画像前置假设直接决定，不被主题难度上限压平（`presentationTier`）。 */
  presentationTier: string;
  /** 谁做的诊断：`llm`=多智能体协同决策，`deterministic`=规则降级。缺省表示引擎没报。 */
  engine?: string;
  /** 蓝图判定的学习者类型（如「转行工程师」）。 */
  learnerType?: string;
  /** 目标画像摘要——只有非身份字段。 */
  profile: {
    domain?: string;
    /** 这门课取材自哪个知识库（`odoo` / `iotdb` …）。没显式选库就不写。 */
    corpus?: string;
    education?: string;
    programmingLevel?: number;
    pythonLevel?: number;
    agentLevel?: number;
    ragLevel?: number;
    engineeringLevel?: number;
  };
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
  /**
   * 这门课还在生成中的标记。**只在生成过程中存在，完课时删掉**。
   *
   * 有它意味着盘上这份是半成品：`scenes` 只有已经跑完的那几屏，后面的还在路上。
   * 读取方（课堂页）据此决定要不要轮询增量屏。
   * 完课后整个字段不写——不是写 `{done: n, total: n}`，那会让存量课与新课的
   * 形状不一致，读的人得多判一次。
   */
  generating?: {
    done: number;
    total: number;
    /**
     * 大纲阶段就知道的屏标题。骨架落盘时 `scenes` 还是空的，靠它让课堂页能先摆出
     * 目录与占位屏——学习者两分钟就进得来看见这门课长什么样，而不是对着进度条等
     * 九分半（2026-08-21 实测首屏 572s，其中大纲 128s、内容 124s、审核链 320s）。
     */
    plannedTitles?: string[];
  };
  /**
   * 生成期元数据。**引擎蓝图拿不到时整个字段不写**，不落空对象占位——
   * 与 `usage-storage.ts` 里 `classroomId` 同款处理：给不属于它的行塞个空字段，
   * 只会让读的人以为「算出来是空的」，而不是「压根没算」。
   *
   * 存量 23 门课都没有这个字段，读取方一律容缺；**不回填历史值**，
   * 事后按时间窗猜出来的档位不是账。
   */
  generation?: CourseGenerationMeta;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
    generation?: CourseGenerationMeta;
    /** 生成中快照传它；完课那一次不传，字段就不会写进文件。 */
    generating?: {
    done: number;
    total: number;
    /**
     * 大纲阶段就知道的屏标题。骨架落盘时 `scenes` 还是空的，靠它让课堂页能先摆出
     * 目录与占位屏——学习者两分钟就进得来看见这门课长什么样，而不是对着进度条等
     * 九分半（2026-08-21 实测首屏 572s，其中大纲 128s、内容 124s、审核链 320s）。
     */
    plannedTitles?: string[];
  };
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
    ...(data.generation ? { generation: data.generation } : {}),
    ...(data.generating ? { generating: data.generating } : {}),
  };

  await ensureClassroomsDir();
  const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
  await writeJsonFileAtomic(filePath, classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}

/** 公共课程墙的一条摘要：只吐清单需要的字段，不返回完整课程。 */
export interface ClassroomSummary {
  id: string;
  title: string;
  description?: string;
  sceneCount: number;
  createdAt: string;
  /** 审核账单：本课累计核验的断言数、判官打回数、引用的教材段落数 */
  audit: { claims: number; flagged: number; sources: number } | null;
}

/**
 * 列出公共课程墙的全部课程。
 *
 * 数据源是 data/classrooms/*.json（人工策展落盘的课），不是账户分区里的
 * 用户课程——这批课未登录也能读，是产品的门面。读失败的单个文件跳过而不是
 * 整个清单报错：一门课的文件坏了不该让整面墙消失。
 */
export async function listClassrooms(): Promise<ClassroomSummary[]> {
  let files: string[];
  try {
    files = (await fs.readdir(CLASSROOMS_DIR)).filter((f) => f.endsWith('.json'));
  } catch (error) {
    // 目录不存在 = 还没有策展课程，返回空清单（调用方据此隐藏整个区块）
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const summaries = await Promise.all(
    files.map(async (file) => {
      const id = file.replace(/\.json$/, '');
      if (!isValidClassroomId(id)) return null;
      const data = await readClassroom(id).catch(() => null);
      if (!data?.stage || !Array.isArray(data.scenes)) return null;
      return {
        id: data.id ?? id,
        title: data.stage.name ?? id,
        ...(data.stage.description ? { description: data.stage.description } : {}),
        sceneCount: data.scenes.length,
        createdAt: data.createdAt ?? '',
        audit: summarizeAudit(data.scenes),
      } satisfies ClassroomSummary;
    }),
  );

  return summaries
    .filter((s): s is ClassroomSummary => s !== null)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/**
 * 一门课引用到的教材片段 id（跨场景去重）。**全站「引用源」只此一个口径。**
 *
 * 数的是判官落盘的 `audit.sources[].source_id`，不是 `audit.claims[].sourceIds`。
 * 两者不等价：sources 是判官这一轮真正调进对照池的片段，claims 里的 sourceIds 只有
 * 被断言引用到的那些。管理端 `lib/server/admin-overview.ts` 的 `readCourseAudit` 曾经
 * 自己按 claims 数过一遍，同一个「引用源」标签在课程卡和管理端给出两个数（23 门课全对不上）。
 * 现在两端都调这里——要改口径改这一个函数，别再各数各的。
 */
export function collectSourceIds(scenes: Scene[]): Set<string> {
  const sources = new Set<string>();
  for (const scene of scenes) {
    const audit = (scene as { audit?: Record<string, unknown> }).audit;
    const srcList = Array.isArray(audit?.sources) ? audit.sources : [];
    for (const s of srcList) {
      const sid = (s as { source_id?: string }).source_id;
      if (sid) sources.add(sid);
    }
  }
  return sources;
}

/**
 * 汇总一门课的审核账单。
 *
 * 口径与评测协议一致：幻觉=判定 incorrect 的断言；uncertain 不计入。
 * 这里刻意不算「通过率」——verdict 有 caveat/revised/flagged 多档，
 * 压成一个百分比会抹平语义（公共页规格第 2 节区 B）。
 * 全课没有任何审核记录时返回 null，由调用方决定不渲染，不编造零。
 */
function summarizeAudit(scenes: Scene[]): ClassroomSummary['audit'] {
  let claims = 0;
  let flagged = 0;
  let audited = false;

  for (const scene of scenes) {
    const audit = (scene as { audit?: Record<string, unknown> }).audit;
    if (!audit) continue;
    audited = true;
    claims += typeof audit.totalClaims === 'number' ? audit.totalClaims : 0;
    const claimList = Array.isArray(audit.claims) ? audit.claims : [];
    for (const c of claimList) {
      const verdict = (c as { verdict?: string }).verdict;
      if (verdict && verdict !== 'supported') flagged += 1;
    }
  }

  return audited ? { claims, flagged, sources: collectSourceIds(scenes).size } : null;
}
