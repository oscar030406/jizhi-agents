/**
 * 机构课程指派：owner 指派/撤回，成员读取（学员首页「机构指派」卡的数据源）。
 * 指派只登记（courseId + 标题快照），不复制课程——学员点进的就是那门课本体。
 */

import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';

import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import {
  addAssignment,
  assignmentsOf,
  corpusOwnership,
  orgForAccount,
  removeAssignment,
} from '@/lib/accounts/org-store';
import {
  decideCourseLearnerRelease,
  isCourseLearnerReleased,
} from '@/lib/generation/learner-release';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import { courseVisibleToOrg } from '@/lib/server/course-access';
import { readCourseDomains, RETIRED_DOMAIN, UNKNOWN_DOMAIN } from '@/lib/server/course-domains';
import { readClassroom } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('OrgAssignments API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COURSE_UNAVAILABLE =
  '机构课程暂不可用：课程内容目前无法读取或已不在本机构可见范围，请联系管理者检查课程状态。';
const COURSE_UNRELEASED = '机构课程暂不可用：课程尚未通过发布审核，请联系管理者完成复核。';

function unavailable<T extends object>(assignment: T, reason: string) {
  return { ...assignment, availability: 'unavailable' as const, unavailableReason: reason };
}

function normalizeAssignmentDomain(value: string | null | undefined) {
  const domain = value?.trim();
  if (!domain || domain === UNKNOWN_DOMAIN || domain === RETIRED_DOMAIN) return null;
  return domain;
}

async function gate(needOwner: boolean) {
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account) {
    return {
      ok: false,
      error: apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '未登录。'),
    } as const;
  }
  const org = await orgForAccount(account.id);
  if (!org) {
    return {
      ok: false,
      error: apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '不在任何机构中。'),
    } as const;
  }
  if (needOwner && org.memberRole !== 'owner') {
    return {
      ok: false,
      error: apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只有机构所有者可以管理指派。'),
    } as const;
  }
  return { ok: true, account, org } as const;
}

export async function GET(): Promise<NextResponse> {
  const g = await gate(false);
  if (!g.ok) return g.error;
  const assignments =
    g.org.memberRole === 'owner'
      ? await assignmentsOf(g.org.id)
      : await assignmentsOf(g.org.id, g.account.id);
  const ownership = await corpusOwnership();
  const courseDomains = await readCourseDomains().catch(() => null);
  const assignmentViews = await Promise.all(
    assignments.map(async (assignment) => {
      const fallbackDomain = normalizeAssignmentDomain(
        assignment.domain ??
          (assignment.courseId ? courseDomains?.[assignment.courseId]?.domain : undefined),
      );
      const assignmentWithDomain = {
        ...assignment,
        domain: fallbackDomain,
      };
      let classroom: Awaited<ReturnType<typeof readClassroom>>;
      try {
        classroom = await readClassroom(assignment.courseId);
      } catch (error) {
        log.warn(`assignment course read failed (${assignment.courseId}): ${String(error)}`);
        return unavailable(assignmentWithDomain, COURSE_UNAVAILABLE);
      }
      if (!classroom || !courseVisibleToOrg(classroom, g.org.id, ownership)) {
        return unavailable(assignmentWithDomain, COURSE_UNAVAILABLE);
      }
      if (!isCourseLearnerReleased(classroom)) {
        return unavailable(assignmentWithDomain, COURSE_UNRELEASED);
      }
      return { ...assignmentWithDomain, availability: 'ready' as const };
    }),
  );
  return apiSuccess({
    assignments: assignmentViews,
    orgName: g.org.name,
    memberRole: g.org.memberRole,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const g = await gate(true);
  if (!g.ok) return g.error;
  const body = (await req.json().catch(() => ({}))) as {
    learnerAccountId?: string;
    courseId?: string;
    title?: string;
  };
  const learnerAccountId = String(body.learnerAccountId ?? '').trim();
  if (!learnerAccountId) {
    return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '请选择要指派的学员。');
  }
  const courseId = String(body.courseId ?? '').trim();
  const classroom = courseId ? await readClassroom(courseId) : null;
  if (!classroom) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, '课程不存在。');
  }
  const ownership = await corpusOwnership();
  if (!courseVisibleToOrg(classroom, g.org.id, ownership)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, '课程不存在或无权访问。');
  }
  const release = decideCourseLearnerRelease(classroom);
  if (!release.eligible) {
    log.warn(
      `assignment blocked for draft course ${courseId}: ${[
        ...release.courseReasons,
        ...release.blockedScenes.flatMap((scene) => scene.reasons),
      ].join(',')}`,
    );
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      409,
      '课程尚未通过学习者发布审核，已保留为待复核草稿。',
    );
  }
  const courseDomains = await readCourseDomains().catch(() => null);
  const newDomain = courseDomains?.[courseId]?.domain.trim();
  if (!newDomain || newDomain === UNKNOWN_DOMAIN || newDomain === RETIRED_DOMAIN) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 409, '无法确定该课程所属领域，已拒绝指派。');
  }

  // 标题取课程文件真源，不信任客户端可篡改的快照。
  const result = await addAssignment(
    g.org.id,
    courseId,
    classroom.stage.name,
    g.account.id,
    learnerAccountId,
    newDomain,
  );
  if (!result.ok) {
    const status = result.message.includes('领域') ? 409 : 400;
    return apiError(API_ERROR_CODES.INVALID_REQUEST, status, result.message);
  }
  log.info(`assignment ${result.assignment.id} (${result.assignment.courseId}) in org ${g.org.id}`);
  return apiSuccess({ assignment: result.assignment });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const g = await gate(true);
  if (!g.ok) return g.error;
  const id = new URL(req.url).searchParams.get('id') ?? '';
  if (!id) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '缺 id。');
  const removed = await removeAssignment(g.org.id, id);
  if (!removed) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, '指派不存在。');
  return apiSuccess({ removed: id });
}
