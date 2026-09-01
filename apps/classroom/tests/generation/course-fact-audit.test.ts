import { describe, expect, it, vi } from 'vitest';

import {
  auditCourseContent,
  hashCourseScenes,
  type AuditClaim,
  type CourseAuditScene,
  type SceneAudit,
} from '@/lib/generation/hallucination-audit';

const issue = (claim: string, verdict: AuditClaim['verdict'], reason: string): AuditClaim => ({
  claim,
  verdict,
  reason,
});

const sceneAudit = (claims: AuditClaim[]): SceneAudit => ({
  verdict: 'pass',
  claims,
  totalClaims: claims.length,
  flaggedCount: 0,
  uncertainCount: 0,
  incorrectCount: 0,
  judgeModel: 'scene-judge',
  rounds: 1,
  durationMs: 1,
  decision: 'publish',
  rationale: '逐屏审核通过',
  grounded: true,
  evidenceCount: 1,
});

const scene = (title: string, body: string, narration = ''): CourseAuditScene => ({
  id: `scene-${title}`,
  outlineId: `outline-${title}`,
  title,
  type: 'slide',
  content: { text: body },
  actions: narration ? [{ type: 'speech', text: narration }] : [],
  audit: sceneAudit([issue(body, 'supported', '逐屏审核已绑定教材证据。')]),
});

const reply = (claims: AuditClaim[]) => async () => JSON.stringify({ claims });

describe('全课程事实终审', () => {
  it('规范化哈希忽略对象键序，但覆盖最终场景五个发布字段', () => {
    const base = {
      id: 'scene-1',
      outlineId: 'outline-1',
      title: '原标题',
      type: 'slide',
      content: { alpha: 1, beta: 2 },
      actions: [{ type: 'speech', text: '原旁白' }],
    };
    const original = hashCourseScenes([base]);

    expect(hashCourseScenes([{ ...base, content: { beta: 2, alpha: 1 } }])).toBe(original);
    expect(hashCourseScenes([{ ...base, id: 'scene-2' }])).not.toBe(original);
    expect(hashCourseScenes([{ ...base, outlineId: 'outline-2' }])).not.toBe(original);
    expect(hashCourseScenes([{ ...base, title: '新标题' }])).not.toBe(original);
    expect(hashCourseScenes([{ ...base, type: 'quiz' }])).not.toBe(original);
    expect(hashCourseScenes([{ ...base, content: { alpha: 1, beta: 3 } }])).not.toBe(original);
    expect(hashCourseScenes([{ ...base, actions: [{ type: 'speech', text: '新旁白' }] }])).not.toBe(
      original,
    );
  });

  it('拦截同一阈值在不同场景出现互不相容的数字，并聚合逐屏断言与旁白', async () => {
    let submitted = '';
    let submittedSystem = '';
    const conflict = issue(
      '场景 1 将停机阈值定义为 150 ms，场景 2 在相同条件下写成 180 ms。',
      'incorrect',
      '同一条件下的同一阈值不能同时取两个值。',
    );
    const judge = async (system: string, user: string) => {
      submittedSystem = system;
      submitted = user;
      return JSON.stringify({ claims: [conflict] });
    };

    const audit = await auditCourseContent({
      courseTitle: 'PLC 安全停机',
      scenes: [
        scene('阈值设定', '响应超过 150 ms 时触发停机。', '请记住 150 ms 这条安全边界。'),
        scene('故障处置', '相同运行模式下，响应超过 180 ms 才触发停机。'),
      ],
      judgeCalls: [judge, judge],
      judgeModel: 'judge-a',
      judgeModels: ['judge-a', 'judge-b'],
    });

    expect(submitted).toContain('响应超过 150 ms');
    expect(submitted).toContain('请记住 150 ms');
    expect(submitted).toContain('响应超过 180 ms');
    expect(submittedSystem).toContain('全课程事实终审模式');
    expect(submittedSystem).toContain('只报告');
    expect(audit.decision).toBe('block_pending_review');
    expect(audit.incorrectCount).toBe(1);
    expect(audit.panelComplete).toBe(true);
    expect(audit.courseContentHash).toBe(
      hashCourseScenes([
        scene('阈值设定', '响应超过 150 ms 时触发停机。', '请记住 150 ms 这条安全边界。'),
        scene('故障处置', '相同运行模式下，响应超过 180 ms 才触发停机。'),
      ]),
    );
  });

  it('终审同时读取最终可见正文、逐屏断言账本与 Action', async () => {
    let submitted = '';
    const finalScene = scene('最终产物', '最终正文独有：安全阈值为 150 ms。', '旁白独有：先验电。');
    finalScene.audit = sceneAudit([
      issue('断言账本独有：停机前先告警。', 'supported', '逐屏审核已通过。'),
    ]);

    await auditCourseContent({
      courseTitle: '完整输入课',
      scenes: [finalScene],
      judgeCalls: [
        async (_system, user) => {
          submitted = user;
          return JSON.stringify({ claims: [] });
        },
        reply([]),
      ],
      judgeModel: 'judge-a',
    });

    expect(submitted).toContain('最终正文独有：安全阈值为 150 ms');
    expect(submitted).toContain('断言账本独有：停机前先告警');
    expect(submitted).toContain('旁白独有：先验电');
  });

  it('单屏最终正文超过提取预算时记账并 fail-closed', async () => {
    const longBody = '最终正文说明安全阈值为 150 ms。'.repeat(800);
    const audit = await auditCourseContent({
      courseTitle: '超长正文课',
      scenes: [scene('超长正文', longBody)],
      judgeCalls: [reply([]), reply([])],
      judgeModel: 'judge-a',
    });

    expect(audit.truncatedChars).toBeGreaterThan(0);
    expect(audit).toMatchObject({ verdict: 'flagged', decision: 'block_pending_review' });
  });

  it('拦截跨页互斥定义', async () => {
    const conflict = issue(
      '场景 1 把召回率定义为检出相关项占全部相关项的比例，场景 2 又定义为检出相关项占全部检出项的比例。',
      'incorrect',
      '第二个定义实际对应精确率。',
    );

    const audit = await auditCourseContent({
      courseTitle: '检索评测',
      scenes: [
        scene('召回率', '召回率是检出的相关项占全部相关项的比例。'),
        scene('指标复盘', '召回率是检出的相关项占全部检出项的比例。'),
      ],
      judgeCalls: [reply([conflict]), reply([conflict])],
      judgeModel: 'judge-a',
    });

    expect(audit.verdict).toBe('flagged');
    expect(audit.decision).toBe('block_pending_review');
  });

  it('拦截与批准材料直接冲突的最终内容，并绑定材料出处', async () => {
    const audit = await auditCourseContent({
      courseTitle: '设备响应规范',
      scenes: [scene('参数配置', '安全规范要求响应时间不超过 180 ms。')],
      judgeCall: reply([
        {
          ...issue(
            '课程写成不超过 180 ms，与批准材料规定的不超过 150 ms 冲突。',
            'incorrect',
            '批准材料给出的上限是 150 ms。',
          ),
          sourceIds: ['S1'],
        },
      ]),
      judgeModel: 'judge-a',
      evidence: '[S1] 安全规范：响应时间不得超过 150 ms。',
      evidenceCount: 1,
      sources: [{ source_id: 'S1', title: '安全规范' }],
    });

    expect(audit.claims[0].sourceIds).toEqual(['S1']);
    expect(audit.decision).toBe('block_pending_review');
  });

  it('无跨页冲突的正常课程不误伤', async () => {
    const audit = await auditCourseContent({
      courseTitle: 'RAG 入门',
      scenes: [
        scene('召回', '召回阶段先从语料中取得候选片段。'),
        scene('重排', '重排阶段对候选片段重新排序。'),
      ],
      judgeCalls: [reply([]), reply([])],
      judgeModel: 'judge-a',
    });

    expect(audit).toMatchObject({
      verdict: 'pass',
      decision: 'publish',
      totalClaims: 0,
      panelComplete: true,
    });
  });

  it('最终正文、断言账本与可见动作总预算超限时记截断并保持草稿', async () => {
    let submitted = '';
    const longNarration = '旁白再次说明安全停机阈值是 150 ms。'.repeat(800);
    const scenes = Array.from({ length: 14 }, (_, index) =>
      scene(`场景 ${index + 1}`, '设备安全规则已经过逐屏审核。', longNarration),
    );

    const audit = await auditCourseContent({
      courseTitle: '超长设备安全课',
      scenes,
      judgeCalls: [
        async (_system, user) => {
          submitted = user;
          return JSON.stringify({ claims: [] });
        },
        reply([]),
      ],
      judgeModel: 'judge-a',
    });

    expect(submitted.match(/<scene index=/g)?.length).toBeGreaterThan(0);
    expect(submitted.length).toBeLessThan(60_000);
    expect(audit.truncatedChars).toBeGreaterThan(0);
    expect(audit).toMatchObject({ verdict: 'flagged', decision: 'block_pending_review' });
    expect(audit.rationale).toContain('超出完整终审范围');
  });

  it('复用逐屏断言账本，不把大型 PBL 原始 JSON 塞给终审', async () => {
    let submitted = '';
    const pblMarker = 'RAW_PBL_PAYLOAD_SHOULD_NOT_REACH_COURSE_JUDGE';
    const pbl = scene('故障诊断项目', '占位正文');
    pbl.type = 'pbl';
    pbl.content = {
      type: 'pbl',
      project: Array.from({ length: 5000 }, () => ({ payload: pblMarker })),
    };
    pbl.audit = sceneAudit([issue('检修前必须先断电并完成验电。', 'supported', '安全规程支持。')]);

    const audit = await auditCourseContent({
      courseTitle: '设备检修',
      scenes: [pbl],
      judgeCalls: [
        async (_system, user) => {
          submitted = user;
          return JSON.stringify({ claims: [] });
        },
        reply([]),
      ],
      judgeModel: 'judge-a',
    });

    expect(submitted).toContain('检修前必须先断电并完成验电');
    expect(submitted).not.toContain(pblMarker);
    expect(audit.truncatedChars).toBeUndefined();
    expect(audit.decision).toBe('publish');
  });

  it('补齐非 speech 的 Action DSL 可见语义，并排除坐标、颜色和 ID', async () => {
    let submitted = '';
    const actionScene = scene('动作语义', '动作正文已逐屏审核。');
    actionScene.actions = [
      { type: 'discussion', topic: '为什么先验电', prompt: '说明误判后果', id: 'secret-id' },
      {
        type: 'wb_draw_text',
        content: '白板：安全阈值 150 ms',
        x: 98765,
        y: 87654,
        color: '#ABCDEF',
      },
      { type: 'wb_draw_code', code: 'if voltage > 0: stop()', language: 'python', x: 1, y: 2 },
      { type: 'wb_draw_latex', latex: 'P=UI', x: 3, y: 4 },
      {
        type: 'wb_draw_table',
        data: [
          ['状态', '动作'],
          ['带电', 'STOP'],
        ],
        x: 5,
        y: 6,
      },
      { type: 'widget_annotation', target: '#machine-secret', content: '这里显示急停状态' },
      { type: 'widget_highlight', target: '#machine-secret', content: '高亮故障灯' },
      { type: 'widget_setState', state: { hiddenValue: 314159 }, content: '切换到故障态' },
      { type: 'widget_reveal', target: '#machine-secret', content: '揭示联锁条件' },
    ];

    await auditCourseContent({
      courseTitle: '动作语义课',
      scenes: [actionScene],
      judgeCalls: [
        async (_system, user) => {
          submitted = user;
          return JSON.stringify({ claims: [] });
        },
        reply([]),
      ],
      judgeModel: 'judge-a',
    });

    for (const visible of [
      '为什么先验电',
      '说明误判后果',
      '白板：安全阈值 150 ms',
      'if voltage > 0: stop()',
      'P=UI',
      '状态',
      '带电',
      'STOP',
      '这里显示急停状态',
      '高亮故障灯',
      '切换到故障态',
      '揭示联锁条件',
    ]) {
      expect(submitted).toContain(visible);
    }
    for (const plumbing of [
      'secret-id',
      '98765',
      '87654',
      '#ABCDEF',
      '#machine-secret',
      '314159',
    ]) {
      expect(submitted).not.toContain(plumbing);
    }
  });

  it('课程终审严格拒绝非空但非法的 claim schema', async () => {
    const invalid = async () =>
      JSON.stringify({ claims: [{ claim: '冲突', verdict: 'UNSUPPORTED', reason: '非法枚举' }] });
    const audit = await auditCourseContent({
      courseTitle: '严格解析',
      scenes: [scene('场景', '逐屏断言')],
      judgeCalls: [invalid, invalid],
      judgeModel: 'judge-a',
    });

    expect(audit).toMatchObject({
      verdict: 'flagged',
      decision: 'block_pending_review',
      panelComplete: false,
      totalClaims: 0,
    });
  });

  it('双判官任一失败即阻断并留下 panelComplete=false', async () => {
    const audit = await auditCourseContent({
      courseTitle: '判官故障',
      scenes: [scene('场景', '逐屏断言')],
      judgeCalls: [
        async () => {
          throw new Error('timeout');
        },
        reply([]),
      ],
      judgeModel: 'judge-a',
    });

    expect(audit).toMatchObject({
      verdict: 'flagged',
      decision: 'block_pending_review',
      panelComplete: false,
      totalClaims: 0,
    });
  });

  it('只配置一个判官也不能冒充交叉验证', async () => {
    const audit = await auditCourseContent({
      courseTitle: '单判官配置',
      scenes: [scene('场景', '逐屏断言')],
      judgeCall: reply([]),
      judgeModel: 'judge-a',
    });

    expect(audit).toMatchObject({
      verdict: 'flagged',
      decision: 'block_pending_review',
      panelComplete: false,
    });
    expect(audit.rationale).toContain('两份合法判词');
  });

  it('仲裁未能消解的分歧保持草稿，且终审绝不调用正文修订', async () => {
    const reviseCall = vi.fn(async () => '{}');
    const disputed = '两个场景对同一设备状态给出互斥定义。';
    const audit = await auditCourseContent({
      courseTitle: '状态机',
      scenes: [scene('状态 A', '运行态允许写入。'), scene('状态 B', '运行态禁止写入。')],
      judgeCalls: [
        reply([issue(disputed, 'incorrect', '互斥。')]),
        reply([issue(disputed, 'supported', '可能条件不同。')]),
      ],
      judgeModel: 'judge-a',
      // 运行时即使误传修订调用，课程终审也必须显式压掉它。
      reviseCall,
    } as Parameters<typeof auditCourseContent>[0] & { reviseCall: typeof reviseCall });

    expect(audit.debate?.[0].arbiterVerdict).toBe('unresolved');
    expect(audit.decision).toBe('block_pending_review');
    expect(reviseCall).not.toHaveBeenCalled();
  });
});
