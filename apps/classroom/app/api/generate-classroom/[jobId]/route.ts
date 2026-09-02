import { type NextRequest } from 'next/server';
import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import {
  isValidClassroomJobId,
  readClassroomGenerationJob,
} from '@/lib/server/classroom-job-store';
import { authorizeInternalCorpusService } from '@/lib/server/corpus-access';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import { createLogger } from '@/lib/logger';

const log = createLogger('ClassroomJob API');

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  let resolvedJobId: string | undefined;
  try {
    const { jobId } = await context.params;
    resolvedJobId = jobId;

    if (!isValidClassroomJobId(jobId)) {
      return apiError('INVALID_REQUEST', 400, 'Invalid classroom generation job id');
    }

    const serviceAccess = await authorizeInternalCorpusService(
      req,
      req.headers.get('x-jizhi-service-corpus')?.trim() ?? '',
    );
    if (serviceAccess.attempted && !serviceAccess.ok) return serviceAccess.response;

    const job = await readClassroomGenerationJob(jobId);
    if (!job) {
      return apiError('INVALID_REQUEST', 404, 'Classroom generation job not found');
    }
    if (serviceAccess.attempted) {
      if (
        !job.ownerOrgId ||
        job.ownerOrgId !== serviceAccess.orgId ||
        job.corpus !== serviceAccess.corpus
      ) {
        return apiError('UNAUTHORIZED', 403, '内部服务无权访问该造课任务。');
      }
    } else if (
      job.ownerOrgId ||
      (job.ownerAccountId &&
        (await accountForSession(req.cookies.get(SESSION_COOKIE)?.value))?.id !==
          job.ownerAccountId)
    ) {
      return apiError('INVALID_REQUEST', 404, 'Classroom generation job not found');
    }

    const pollUrl = `${buildRequestOrigin(req)}/api/generate-classroom/${jobId}`;

    return apiSuccess({
      jobId: job.id,
      status: job.status,
      step: job.step,
      progress: job.progress,
      message: job.message,
      pollUrl,
      pollIntervalMs: 5000,
      scenesGenerated: job.scenesGenerated,
      totalScenes: job.totalScenes,
      // 课号在生成中就往外报。job 记录里它早就有了（第一次进度上报就写），
      // 但这个路由原来只转发 `result.classroomId`——要等成功才有，于是
      // 「生成中进课堂看已完成的屏」在协议层拿不到课号。2026-08-21 实测：
      // job 文件里 classroomId=Xl_l7SQNEV 全程存在，轮询响应里一次都没出现。
      classroomId: job.classroomId ?? job.result?.classroomId,
      result: job.result,
      error: job.error,
      done: job.status === 'succeeded' || job.status === 'failed',
    });
  } catch (error) {
    log.error(`Classroom job retrieval failed [jobId=${resolvedJobId ?? 'unknown'}]:`, error);
    return apiError(
      'INTERNAL_ERROR',
      500,
      'Failed to retrieve classroom generation job',
      error instanceof Error ? error.message : String(error),
    );
  }
}
