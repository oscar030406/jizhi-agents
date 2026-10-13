/**
 * 调度实验的回放作业（默认关闭）。
 *
 * 只在 SCHED_K > 0 时存在，否则 404。一单 = 一个登录会话提交的一次「判题」：
 * 经派发器排队，拿到槽位后占住槽位到「派发时刻 + 注入的记录时长」这个绝对截止时刻，
 * 不执行代码、不调模型。截止时刻按派发器的单调时钟算：派发到开始之间的延迟不加到
 * 占用上，定时器的迟到也不逐单累积（Windows 的定时器粒度约 15.6 ms，所以最后 20 ms
 * 不靠定时器，改用 setImmediate 看表）。
 * 时长与打分都来自回放轨迹（论文仓 prechecks/platform_replay/），由负载发生器
 * experiments/scheduling/replay-trace.mjs 逐单带上。
 */

import { NextRequest, NextResponse } from 'next/server';

import { accountForSession } from '@/lib/accounts/store';
import { SESSION_COOKIE } from '@/lib/accounts/session';
import { dispatch, nowUs, schedConfig, schedSlot } from '@/lib/server/classroom-dispatch';

export const runtime = 'nodejs';

interface ReplayJob {
  jobId: number;
  student: number;
  serviceMs: number;
  predictedCostS: number;
  limitMs: number;
}

/** 最后这段不交给定时器：它的粒度在 Windows 上约 15.6 ms */
const FINE_US = 20_000;

function sleepUntilUs(deadlineUs: number): Promise<void> {
  return new Promise((resolve) => {
    const step = () => {
      const left = deadlineUs - nowUs();
      if (left <= 0) resolve();
      else if (left > FINE_US) setTimeout(step, Math.floor((left - FINE_US) / 1000));
      else setImmediate(step);
    };
    step();
  });
}

export async function POST(req: NextRequest) {
  if (schedConfig().k <= 0) return new NextResponse(null, { status: 404 });
  const account = await accountForSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!account) return NextResponse.json({ error: '未登录' }, { status: 401 });
  const job = (await req.json()) as ReplayJob;

  await dispatch(
    {
      jobClass: 'codebench',
      predictedCostS: job.predictedCostS,
      limitMs: job.limitMs,
      meta: {
        jobId: job.jobId,
        student: job.student,
        account: account.username,
        requestedMs: job.serviceMs,
      },
    },
    () => sleepUntilUs(schedSlot()!.dispatchUs + Math.round(job.serviceMs * 1000)),
  );
  return NextResponse.json({ jobId: job.jobId });
}
