/**
 * 同题异人对比代理（异步 job 化）。
 *
 * 引擎 /internal/v1/personalize/compare 在 api 模式下为每个画像各跑一遍
 * 完整七 Agent 闭环，耗时数分钟——同步转发必超时。改为 job 模式：
 * POST 创建 job 立即返回 jobId，后台（next/server after）调引擎并把结果
 * 落进进程内 Map；前端 GET /api/compare?job=<id> 轮询取状态与结果。
 */

import { after, type NextRequest } from 'next/server';
import { nanoid } from 'nanoid';
import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import { sessionTokenFromCookieHeader } from '@/lib/accounts/session';
import { accountForSession } from '@/lib/accounts/store';

const log = createLogger('Compare Proxy');

export const dynamic = 'force-dynamic';

interface CompareJob {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  createdAt: number;
  result?: Record<string, unknown>;
  error?: string;
}

// ponytail: 进程内 Map，进程重启即丢——对比结果是一次性展示，不值得落盘；
// 挂 globalThis 防 dev HMR 重载模块后 POST/GET 各拿一份 Map。
const g = globalThis as unknown as { __compareJobs?: Map<string, CompareJob> };
const jobs = (g.__compareJobs ??= new Map<string, CompareJob>());

/**
 * 引擎超时兜底。页面上标的 14–18 分钟是从预生成对照里两个画像的实测
 * duration_ms 相加算出来的，超时必须罩得住这个区间——原来的 15 分钟比标注还短，
 * 线上实测两次都死在 905 秒（WO-A1 §2.1）。
 */
const ENGINE_TIMEOUT_MS = 20 * 60 * 1000;
/** 完结 2 小时后的 job 清掉，防 Map 无界增长 */
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

interface CompareRequestBody {
  learningGoal: string;
  profiles: Array<{ preset_id: string }>;
}

async function runCompareJob(jobId: string, base: string, body: CompareRequestBody) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}/internal/v1/personalize/compare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
      },
      body: JSON.stringify({ learningGoal: body.learningGoal, profiles: body.profiles }),
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!resp.ok) {
      throw new Error(`引擎返回 HTTP ${resp.status}`);
    }
    const payload = (await resp.json()) as { data?: Record<string, unknown> };
    if (!payload.data) {
      throw new Error('引擎响应缺少 data 字段');
    }
    job.status = 'succeeded';
    job.result = payload.data;
    log.info(
      `Compare job ${jobId} done for goal "${body.learningGoal}" ` +
        `(${body.profiles.length} profiles, ${Math.round((Date.now() - job.createdAt) / 1000)}s)`,
    );
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
    log.warn(`Compare job ${jobId} failed: ${job.error}`);
  }
}

export async function POST(req: NextRequest) {
  const base = process.env.GROUNDING_URL;
  if (!base) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      503,
      'GROUNDING_URL 未配置，多智能体引擎不可用',
    );
  }
  // 发起侧鉴权：一次对比要占引擎十几分钟，公共页已经不给未登录访客入口，
  // 接口这一侧也要挡住直接打 POST 的。GET 轮询不加——带 jobId 的深链是只读的。
  const account = await accountForSession(sessionTokenFromCookieHeader(req.headers.get('cookie') ?? undefined));
  if (!account) {
    return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '登录后才能发起对比');
  }
  try {
    const body = (await req.json()) as Partial<CompareRequestBody>;
    if (!body.learningGoal || !Array.isArray(body.profiles) || body.profiles.length < 2) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'learningGoal 与至少两个 profiles 为必填',
      );
    }

    // 顺手清掉过期 job
    for (const [id, j] of jobs) {
      if (Date.now() - j.createdAt > JOB_TTL_MS) jobs.delete(id);
    }

    const jobId = nanoid(10);
    jobs.set(jobId, { status: 'queued', createdAt: Date.now() });
    const input: CompareRequestBody = {
      learningGoal: body.learningGoal,
      profiles: body.profiles,
    };
    after(() => runCompareJob(jobId, base, input));
    log.info(`Compare job ${jobId} queued for goal "${input.learningGoal}"`);
    return apiSuccess({ jobId, status: 'queued', pollIntervalMs: 10000 }, 202);
  } catch (err) {
    log.error('Compare job creation failed:', err);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      '创建对比任务失败',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function GET(req: NextRequest) {
  const jobId = new URL(req.url).searchParams.get('job');
  if (!jobId) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, '缺少 job 查询参数');
  }
  const job = jobs.get(jobId);
  if (!job) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, '对比任务不存在或已过期');
  }
  return apiSuccess({
    jobId,
    status: job.status,
    elapsedMs: Date.now() - job.createdAt,
    done: job.status === 'succeeded' || job.status === 'failed',
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
  });
}
