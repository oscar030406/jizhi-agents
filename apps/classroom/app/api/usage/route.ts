import { NextRequest } from 'next/server';
import { corpusOwnership, orgForAccount } from '@/lib/accounts/org-store';
import { sessionTokenFromCookieHeader } from '@/lib/accounts/session';
import { accountForSession } from '@/lib/accounts/store';
import { createLogger } from '@/lib/logger';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isValidClassroomId,
  readClassroom,
  type PersistedClassroomData,
} from '@/lib/server/classroom-storage';
import { courseVisibleToOrg } from '@/lib/server/course-access';
import {
  readUsageRecords,
  type UsageRecord,
  type UsageKind,
  type UsageUnit,
} from '@/lib/server/usage-storage';

const log = createLogger('UsageAPI');

interface Bucket {
  key: string;
  kind: UsageKind;
  unit: UsageUnit;
  requests: number;
  // LLM token totals (0 for non-LLM).
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  // Non-token quantity (images / seconds / characters).
  quantity: number;
}

function emptyBucket(key: string, kind: UsageKind, unit: UsageUnit): Bucket {
  return {
    key,
    kind,
    unit,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    quantity: 0,
  };
}

function unitOf(r: UsageRecord): UsageUnit {
  return r.unit ?? 'token';
}

function addTo(bucket: Bucket, r: UsageRecord): void {
  bucket.requests += 1;
  bucket.inputTokens += r.inputTokens;
  bucket.outputTokens += r.outputTokens;
  bucket.cacheReadTokens += r.cacheReadTokens;
  bucket.cacheCreationTokens += r.cacheCreationTokens;
  // `inputTokens` is the provider-reported prompt token total; for
  // OpenAI-compatible providers it already includes cached input tokens. Keep
  // cache read/write counts as separate breakdown fields, but don't add them
  // again to the displayed aggregate.
  bucket.totalTokens += r.inputTokens + r.outputTokens;
  bucket.quantity += r.quantity ?? 0;
}

function dayKey(createdAt: number): string {
  return new Date(createdAt).toISOString().slice(0, 10);
}

function courseAttributedToOrg(
  course: PersistedClassroomData,
  orgId: string,
  ownership: ReadonlyMap<string, string>,
): boolean {
  if (!courseVisibleToOrg(course, orgId, ownership)) return false;
  const corpora = [
    course.stage.origin?.corpus?.trim() || course.stage.origin?.domain?.trim(),
    course.generation?.profile.corpus?.trim() || course.generation?.profile.domain?.trim(),
  ].filter((corpus): corpus is string => Boolean(corpus));
  const owners = new Set(corpora.map((corpus) => ownership.get(corpus)).filter(Boolean));
  // 公共课虽可见，但账本没有发起账户，无法唯一归属某家机构，不能计入机构视图。
  return owners.size === 1 && owners.has(orgId);
}

/**
 * GET /api/usage
 *
 * Aggregates the deployment-wide usage log (data/usage/*.jsonl) by model, by
 * day, and by modality. Pure usage — no cost. Optional `?months=YYYY-MM,...`.
 */
export async function GET(req: NextRequest) {
  try {
    const account = await accountForSession(
      sessionTokenFromCookieHeader(req.headers.get('cookie') ?? undefined),
    );
    if (!account) {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '登录后才能查看用量');
    }
    if (account.role !== 'manager') {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '用量仅对管理者开放');
    }
    const org = await orgForAccount(account.id);
    if (!org) {
      return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '当前管理者不属于任何机构');
    }

    const monthsParam = req.nextUrl.searchParams.get('months');
    const months = monthsParam ? monthsParam.split(',').map((s) => s.trim()) : undefined;

    const [allRecords, ownership] = await Promise.all([
      readUsageRecords({ months }),
      corpusOwnership(),
    ]);
    const classroomIds = [
      ...new Set(
        allRecords.flatMap((record) =>
          record.classroomId && isValidClassroomId(record.classroomId) ? [record.classroomId] : [],
        ),
      ),
    ];
    const visibleClassrooms = new Set(
      (
        await Promise.all(
          classroomIds.map(async (id) => {
            const course = await readClassroom(id);
            return course && courseAttributedToOrg(course, org.id, ownership) ? id : null;
          }),
        )
      ).filter((id): id is string => id !== null),
    );
    const records = allRecords.filter(
      (record) => record.classroomId && visibleClassrooms.has(record.classroomId),
    );

    const byModel = new Map<string, Bucket>();
    const byDay = new Map<string, Bucket>();
    const byKind = new Map<UsageKind, Bucket>();
    let totalRequests = 0;
    let totalLlmTokens = 0;

    for (const r of records) {
      totalRequests += 1;
      if (r.kind === 'llm') {
        totalLlmTokens += r.inputTokens + r.outputTokens;
      }

      const mk = r.modelString || r.modelId;
      if (!byModel.has(mk)) byModel.set(mk, emptyBucket(mk, r.kind, unitOf(r)));
      addTo(byModel.get(mk)!, r);

      const dk = dayKey(r.createdAt);
      if (!byDay.has(dk)) byDay.set(dk, emptyBucket(dk, 'llm', 'token'));
      addTo(byDay.get(dk)!, r);

      if (!byKind.has(r.kind)) byKind.set(r.kind, emptyBucket(r.kind, r.kind, unitOf(r)));
      addTo(byKind.get(r.kind)!, r);
    }

    return apiSuccess({
      totals: { requests: totalRequests, llmTokens: totalLlmTokens },
      byModel: [...byModel.values()].sort((a, b) => b.requests - a.requests),
      byDay: [...byDay.values()].sort((a, b) => a.key.localeCompare(b.key)),
      byKind: [...byKind.values()],
    });
  } catch (error) {
    log.error('Usage aggregation failed:', error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Failed to read usage',
    );
  }
}
