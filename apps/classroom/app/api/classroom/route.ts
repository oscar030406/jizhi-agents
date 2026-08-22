import { type NextRequest } from 'next/server';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  isValidClassroomId,
  listClassrooms,
  readClassroom,
} from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('Classroom API');

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

    // 无 id ⇒ 公共课程墙清单（未登录可读；目录不存在时返回空数组，
    // 由前端决定隐藏整个区块，不编造占位课程）
    if (!id) {
      const classrooms = await listClassrooms();
      return apiSuccess({ classrooms });
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
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
