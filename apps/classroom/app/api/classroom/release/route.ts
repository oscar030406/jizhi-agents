/**
 * 课程人工复核放行 / 撤回（仲裁三出口之「拦截转人工」的落地）。
 *
 * 只有课程所属机构的所有者能操作；写的是课程文件里 stage.manualRelease = {by, at, note}，
 * 发布门（learner-release）认这条记录。撤回即删除该字段，课程回到门禁判定。
 * 不改审核记录、不改内容——复核放行是「人替机器担责」，判词原样保留供追溯。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { corpusOwnership, orgForAccount } from '@/lib/accounts/org-store';
import { decideCourseLearnerRelease } from '@/lib/generation/learner-release';
import { API_ERROR_CODES, apiError, apiSuccess } from '@/lib/server/api-response';
import {
  CLASSROOMS_DIR,
  isValidClassroomId,
  readClassroom,
  writeJsonFileAtomic,
} from '@/lib/server/classroom-storage';
import { courseVisibleToOrg } from '@/lib/server/course-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function ownerAndCourse(id: string) {
  const account = await accountForSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!account || account.role !== 'manager') {
    return { error: apiError(API_ERROR_CODES.UNAUTHORIZED, 401, '需要管理者登录。') } as const;
  }
  const org = await orgForAccount(account.id);
  if (!org || org.memberRole !== 'owner') {
    return { error: apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '只有机构所有者可以复核放行。') } as const;
  }
  if (!isValidClassroomId(id)) {
    return { error: apiError(API_ERROR_CODES.INVALID_REQUEST, 400, '课程标识无效。') } as const;
  }
  const course = await readClassroom(id);
  const ownership = await corpusOwnership();
  if (!course || !courseVisibleToOrg(course, org.id, ownership)) {
    return { error: apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found') } as const;
  }
  return { account, org, course } as const;
}

async function writeManualRelease(id: string, manualRelease: unknown | null) {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  const raw = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
  const stage = { ...((raw.stage as Record<string, unknown>) ?? {}) };
  if (manualRelease) stage.manualRelease = manualRelease;
  else delete stage.manualRelease;
  await writeJsonFileAtomic(filePath, { ...raw, stage });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; note?: unknown };
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const gate = await ownerAndCourse(id);
  if ('error' in gate) return gate.error;
  const decision = decideCourseLearnerRelease(gate.course);
  if (decision.eligible && decision.protocol !== 'manual-review') {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 409, '课程已通过门禁，无需人工放行。');
  }
  if (gate.course.generating) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 409, '课程仍在生成中，不能放行。');
  }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
  const manualRelease = {
    by: gate.account.id,
    at: new Date().toISOString(),
    ...(note ? { note } : {}),
    // 放行时门禁的原判定随手存一份，追溯时能看到当时被拦的原因。
    gateReasons: [...decision.courseReasons, ...decision.blockedScenes.map((b) => `${b.sceneId}: ${b.reasons.join(',')}`)],
  };
  await writeManualRelease(id, manualRelease);
  return apiSuccess({ manualRelease });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')?.trim() ?? '';
  const gate = await ownerAndCourse(id);
  if ('error' in gate) return gate.error;
  await writeManualRelease(id, null);
  return apiSuccess({ revoked: true });
}
