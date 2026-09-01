import { type NextRequest } from 'next/server';
import { corpusOwnership } from '@/lib/accounts/org-store';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import { isValidClassroomId, listClassrooms, readClassroom } from '@/lib/server/classroom-storage';
import { courseVisibleToOrg, viewerOrgId } from '@/lib/server/course-access';
import { isCourseLearnerReleased } from '@/lib/generation/learner-release';
import { createLogger } from '@/lib/logger';

const log = createLogger('Classroom API');

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

    // 无 id ⇒ 公共课程墙清单（未登录可读；目录不存在时返回空数组，
    // 由前端决定隐藏整个区块，不编造占位课程）
    if (!id) {
      const [summaries, ownership, orgId] = await Promise.all([
        listClassrooms({ learnerReleasedOnly: true }),
        corpusOwnership(),
        viewerOrgId(request),
      ]);
      const classrooms = (
        await Promise.all(
          summaries.map(async (summary) => {
            const classroom = await readClassroom(summary.id);
            return classroom && courseVisibleToOrg(classroom, orgId, ownership) ? summary : null;
          }),
        )
      ).filter((summary): summary is (typeof summaries)[number] => summary !== null);
      return apiSuccess({ classrooms });
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const [classroom, ownership, orgId] = await Promise.all([
      readClassroom(id),
      corpusOwnership(),
      viewerOrgId(request),
    ]);
    // 对外读取统一 fail-closed。404 不泄漏草稿是否存在；管理端仍通过原始存储读取
    // 审核详情，因此这里不会删除或藏掉管理者需要复核的内容。
    if (
      !classroom ||
      !isCourseLearnerReleased(classroom) ||
      !courseVisibleToOrg(classroom, orgId, ownership)
    ) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    return apiSuccess({ classroom });
  } catch (error) {
    log.error(
      `Classroom retrieval failed [id=${request.nextUrl.searchParams.get('id') ?? 'unknown'}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}
