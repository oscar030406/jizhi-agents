/**
 * 项目带练第二层的三个动作，转给引擎 practice-scout/{corpus}/guide/{tasks|grade|chat}：
 * - tasks：把某个里程碑拆成代码任务（骨架 + 判分要点 + 三级提示），同档缓存，首次约 1 分钟
 * - grade：判学习者提交的代码（任务原文由页面回传，引擎无状态）
 * - chat：伴学教练单轮对话
 * 画像取法与 ../route.ts 相同：登录账户的档案，未登录按默认档。
 */

import type { NextRequest } from 'next/server';

import { accountForSession, readProfileEnvelope } from '@/lib/accounts/store';
import { activeFields } from '@/lib/accounts/profiles';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { createLogger } from '@/lib/logger';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { requireCorpusVisible } from '@/lib/server/corpus-access';

const log = createLogger('PracticeCoach API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface CodeTask {
  id: string;
  title: string;
  brief: string;
  language: string;
  skeleton: string;
  criteria: string[];
  expected_output: string;
  hints: string[];
  bridge: string;
}

export interface CodeTasksPayload {
  corpus: string;
  project_id: string;
  profile_key: string;
  milestone: number;
  tier: string;
  generated_at: string;
  tasks: CodeTask[];
  cached: boolean;
}

export interface CodeVerdict {
  verdict: 'correct' | 'partial' | 'incorrect';
  because: string[];
  problems: string[];
  next: string;
  hints_used: number;
}

export interface CoachReply {
  reply: string;
  cited: string[];
  evidence_ids: string[];
}

const ACTIONS = { tasks: 170_000, grade: 60_000, chat: 60_000 } as const;
type Action = keyof typeof ACTIONS;

const PROFILE_KEYS = ['programming_level', 'agent_level', 'engineering_level', 'time_budget_hours', 'role'] as const;

async function profileFor(req: NextRequest): Promise<Record<string, unknown>> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return {};
  const account = await accountForSession(token);
  const env = account ? await readProfileEnvelope(account.id) : null;
  const fields = env ? activeFields(env) : null;
  const out: Record<string, unknown> = {};
  if (fields) for (const key of PROFILE_KEYS) if (fields[key] !== undefined && fields[key] !== null) out[key] = fields[key];
  return out;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (!(action in ACTIONS)) return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, '没有这个动作。');
  const base = process.env.GROUNDING_URL?.replace(/\/$/, '');
  if (!base) return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '实操引擎尚未配置。');

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const corpus = String(body?.corpus ?? '').trim();
  const projectId = String(body?.projectId ?? '').trim();
  if (!corpus || (action !== 'grade' && !projectId)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'corpus 与 projectId 必填。');
  }
  const access = await requireCorpusVisible(corpus);
  if (!access.ok) return access.response;

  const profile = await profileFor(req);
  const payload: Record<string, unknown> =
    action === 'tasks'
      ? { project_id: projectId, profile, milestone: body?.milestone, refresh: body?.refresh === true }
      : action === 'grade'
        ? { task: body?.task, code: body?.code, hints_used: body?.hintsUsed ?? 0 }
        : {
            project_id: projectId,
            profile,
            milestone: body?.milestone,
            task_id: body?.taskId ?? '',
            history: body?.history ?? [],
            message: body?.message,
          };

  try {
    const resp = await fetch(`${base}/api/practice-scout/${encodeURIComponent(corpus)}/guide/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': process.env.GROUNDING_TOKEN ?? '' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ACTIONS[action as Action]),
      cache: 'no-store',
    });
    if (!resp.ok) {
      const detail = ((await resp.json().catch(() => null)) as { detail?: string } | null)?.detail;
      log.warn(`${action} ${corpus}/${projectId} HTTP ${resp.status}: ${detail ?? ''}`);
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, detail ? `教练这一步没成：${detail}` : '教练服务返回错误。');
    }
    const data = (await resp.json()) as Record<string, unknown>;
    log.info(`${action} ${corpus}/${projectId} ok`);
    return apiSuccess(data);
  } catch (error) {
    log.warn(`${action} ${corpus}/${projectId} failed: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '教练服务暂时不可用。');
  }
}
