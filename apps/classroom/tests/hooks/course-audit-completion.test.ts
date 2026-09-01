import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(process.cwd(), 'lib/hooks/use-scene-generator.ts'), 'utf-8');

describe('交互造课全课程终审闭环', () => {
  it('逐屏审核不再后台丢失，终审通过后才宣布完成', () => {
    expect(source).not.toContain('void auditPromise');
    expect(source).toContain('const auditResult = await fetchSceneAudit(');
    expect(source).toContain('const speechAudit = await auditSceneSpeech(');
    expect(source).toContain('const released = await finalizeCourse(signal)');
    expect(source).toContain('const release = decideCourseLearnerRelease({');
    expect(source).toContain('const released = release.eligible');
  });

  it('v2 缺终审或内容哈希变化时补跑，同哈希失败不重复', () => {
    expect(source).toContain('contract?.version !== 2');
    expect(source).toContain(
      'state.stage?.courseAudit?.courseContentHash === hashCourseScenes(state.scenes)',
    );
    expect(source).not.toContain('contract?.version !== 2 ||\n        state.stage?.courseAudit ||');
    expect(source).toContain('backfillMissingCourseAudit();');
  });
});
