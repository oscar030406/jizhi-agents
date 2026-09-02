/**
 * 教学履约判官被结构校验拒掉时，把原文落盘到 data/debug/alignment-judge/ 供诊断。
 * 只在服务端调用（hallucination-audit 被客户端引用，自己不能碰 node:fs）。
 * 测试环境不落盘；写盘失败静默——诊断设施不许反过来影响审核结论。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AlignmentJudgeReject } from '@/lib/generation/hallucination-audit';

export function persistAlignmentJudgeReject(info: AlignmentJudgeReject): void {
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return;
  try {
    const dir = join(process.cwd(), 'data', 'debug', 'alignment-judge');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const model = info.judgeModel.replace(/[^\w.-]+/g, '_').slice(0, 60);
    writeFileSync(
      join(dir, `${stamp}-${model}-attempt${info.attempt + 1}.txt`),
      `# reject: ${info.reject}\n\n${info.raw}`,
      'utf8',
    );
  } catch {
    // 落盘失败不影响审核结论
  }
}
