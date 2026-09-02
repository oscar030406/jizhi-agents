import { type NextRequest } from 'next/server';
import { corpusOwnership } from '@/lib/accounts/org-store';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import { isValidClassroomId, listClassrooms, readClassroom } from '@/lib/server/classroom-storage';
import { canReadCourse, courseCorpora, courseReaderForRequest } from '@/lib/server/course-access';
import { authorizeInternalCorpusService } from '@/lib/server/corpus-access';
import { isCourseLearnerReleased } from '@/lib/generation/learner-release';
import { createLogger } from '@/lib/logger';

const log = createLogger('Classroom API');

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    const serviceAccess = await authorizeInternalCorpusService(
      request,
      request.headers.get('x-jizhi-service-corpus')?.trim() ?? '',
    );
    if (serviceAccess.attempted && !serviceAccess.ok) return serviceAccess.response;

    // 无 id ⇒ 公共课程墙清单（未登录可读；目录不存在时返回空数组，
    // 由前端决定隐藏整个区块，不编造占位课程）
    if (!id) {
      if (serviceAccess.attempted) {
        return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '内部服务不允许读取课程清单。');
      }
      const [summaries, ownership, reader] = await Promise.all([
        listClassrooms({ learnerReleasedOnly: true }),
        corpusOwnership(),
        courseReaderForRequest(request),
      ]);
      const classrooms = (
        await Promise.all(
          summaries.map(async (summary) => {
            const classroom = await readClassroom(summary.id);
            return classroom && canReadCourse(summary.id, classroom, reader, ownership)
              ? summary
              : null;
          }),
        )
      ).filter((summary): summary is (typeof summaries)[number] => summary !== null);
      return apiSuccess({ classrooms });
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const classroom = await readClassroom(id);
    if (serviceAccess.attempted) {
      const corpora = classroom ? courseCorpora(classroom) : new Set<string>();
      if (
        !classroom ||
        corpora.size !== 1 ||
        !corpora.has(serviceAccess.corpus) ||
        classroom.ownerOrgId !== serviceAccess.orgId
      ) {
        return apiError(API_ERROR_CODES.UNAUTHORIZED, 403, '内部服务无权访问该课程。');
      }
      if (!isCourseLearnerReleased(classroom)) {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
      }
      return apiSuccess({ classroom });
    }

    const [ownership, reader] = await Promise.all([
      corpusOwnership(),
      courseReaderForRequest(request),
    ]);
    // 学习者与匿名访问统一 fail-closed；所属机构 owner 可进入草稿查看审核结果。
    if (
      !classroom ||
      !canReadCourse(id, classroom, reader, ownership) ||
      (reader.memberRole !== 'owner' && !isCourseLearnerReleased(classroom))
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
