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
import { readClassroom } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('OrgAssignments API');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  const visibleAssignments = (
    await Promise.all(
      assignments.map(async (assignment) => {
        const classroom = await readClassroom(assignment.courseId).catch(() => null);
        if (!classroom || !courseVisibleToOrg(classroom, g.org.id, ownership)) return null;
        return g.org.memberRole === 'owner' || isCourseLearnerReleased(classroom)
          ? assignment
          : null;
      }),
    )
  ).filter((assignment): assignment is NonNullable<typeof assignment> => assignment !== null);
  return apiSuccess({ assignments: visibleAssignments, orgName: g.org.name });
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
  if (!courseVisibleToOrg(classroom, g.org.id, await corpusOwnership())) {
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
  // 标题取课程文件真源，不信任客户端可篡改的快照。
  const result = await addAssignment(
    g.org.id,
    courseId,
    classroom.stage.name,
    g.account.id,
    learnerAccountId,
  );
  if (!result.ok) return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, result.message);
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
