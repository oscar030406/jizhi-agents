/**
 * 项目带练：把一张已发布实操卡按当前账户画像拆成里程碑（引擎 practice-scout/{corpus}/guide）。
 *
 * 画像从账户档案读（登录态），未登录按默认档（L2、工程自评 1）拆——公共访客也能看到
 * 带练长什么样，但进度只有登录后才记。引擎同档缓存，首次生成实测 90-150 秒，超时给 170 秒。
 * 引擎不可达或拒绝时把原因原样回给页面，不编一份里程碑。
 */

import type { NextRequest } from 'next/server';

import { accountForSession, readProfileEnvelope } from '@/lib/accounts/store';
import { activeFields } from '@/lib/accounts/profiles';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { createLogger } from '@/lib/logger';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { requireCorpusVisible } from '@/lib/server/corpus-access';

const log = createLogger('PracticeGuide API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface GuideReading {
  source_id: string;
  why: string;
}

export interface GuideMilestone {
  index: number;
  title: string;
  goal: string;
  build: string[];
  how: string[];
  acceptance: string;
  engineering_habit: { title: string; how: string };
  pitfalls: string[];
  reading: GuideReading[];
  check_question: string;
  expected_points: string[];
  minutes: number;
}

export interface PracticeGuide {
  overview: string;
  fit: string;
  milestones: GuideMilestone[];
  management: { cadence: string; tracking: string };
}

export interface PracticeGuidePayload {
  corpus: string;
  project_id: string;
  project_name?: string;
  profile_key: string;
  decisions: {
    tier: string;
    engineering_level: number;
    milestone_count: number;
    readme_used: boolean;
    evidence_ids: string[];
  };
  generated_at: string;
  guide: PracticeGuide;
  cached: boolean;
  /** 是否按登录账户的画像拆的；false = 访客默认档 */
  personalized: boolean;
}

/** 引擎只看这几项；别的画像字段（昵称、学历）不影响拆法，不传。 */
const PROFILE_KEYS = [
  'programming_level',
  'agent_level',
  'engineering_level',
  'time_budget_hours',
  'role',
] as const;

export async function POST(req: NextRequest) {
  const base = process.env.GROUNDING_URL?.replace(/\/$/, '');
  if (!base) return apiError(API_ERROR_CODES.PROVIDER_DISABLED, 503, '实操引擎尚未配置。');

  const body = (await req.json().catch(() => null)) as {
    corpus?: string;
    projectId?: string;
    refresh?: boolean;
  } | null;
  const corpus = body?.corpus?.trim() ?? '';
  const projectId = body?.projectId?.trim() ?? '';
  if (!corpus || !projectId) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'corpus 与 projectId 必填。');
  }
  const access = await requireCorpusVisible(corpus);
  if (!access.ok) return access.response;

  const profile: Record<string, unknown> = {};
  let personalized = false;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    const account = await accountForSession(token);
    const env = account ? await readProfileEnvelope(account.id) : null;
    const fields = env ? activeFields(env) : null;
    if (fields) {
      for (const key of PROFILE_KEYS) {
        if (fields[key] !== undefined && fields[key] !== null) profile[key] = fields[key];
      }
      personalized = Object.keys(profile).length > 0;
    }
  }

  try {
    const resp = await fetch(`${base}/api/practice-scout/${encodeURIComponent(corpus)}/guide`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-token': process.env.GROUNDING_TOKEN ?? '',
      },
      body: JSON.stringify({ project_id: projectId, profile, refresh: body?.refresh === true }),
      // 首次生成实测 90-150 秒（6000 token 的结构化输出 + README + 检索），同档第二次是缓存秒回
      signal: AbortSignal.timeout(170_000),
      cache: 'no-store',
    });
    if (!resp.ok) {
      const detail = ((await resp.json().catch(() => null)) as { detail?: string } | null)?.detail;
      log.warn(`guide ${corpus}/${projectId} HTTP ${resp.status}: ${detail ?? ''}`);
      return apiError(
        API_ERROR_CODES.UPSTREAM_ERROR,
        502,
        detail ? `带练路线没生成出来：${detail}` : '带练路线服务返回错误。',
      );
    }
    const payload = (await resp.json()) as Omit<PracticeGuidePayload, 'personalized'>;
    log.info(
      `guide ${corpus}/${projectId} key=${payload.profile_key} cached=${payload.cached} personalized=${personalized}`,
    );
    return apiSuccess({ ...payload, personalized } satisfies PracticeGuidePayload);
  } catch (error) {
    log.warn(`guide ${corpus}/${projectId} failed: ${String(error)}`);
    return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, '带练路线服务暂时不可用。');
  }
}
