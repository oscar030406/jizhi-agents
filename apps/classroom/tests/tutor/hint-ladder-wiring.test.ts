/**
 * 三级提示阶梯在课堂侧的接线。
 *
 * 引擎那边接口早就完整了，课堂这层的字段白名单把 `hint_request` /
 * `hints_used` / `hint_question_id` **静默丢掉**——界面点不出提示，交答案也不回传，
 * 于是「看了答案照样记成会了」。这份钉的就是这三处别再断。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { tutorEvidenceDraft } from '@/lib/evidence/from-tutor';

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

/** 递归列出一棵目录下的 .ts/.tsx（源码扫描用，不进 node_modules/.next 这些） */
function walk(rel: string): string[] {
  return readdirSync(join(process.cwd(), rel), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? walk(`${rel}/${e.name}`)
      : /\.tsx?$/.test(e.name)
        ? [`${rel}/${e.name}`]
        : [],
  );
}

/** 课堂侧谁在调 /api/tutor。认字面量，不认注释里提到的路径。 */
const tutorCallers = () =>
  ['app', 'components', 'lib']
    .flatMap(walk)
    .filter((f) => /fetch\(\s*['"`]\/api\/tutor['"`]/.test(read(f)));

describe('路由转发', () => {
  const src = () => read('app/api/tutor/route.ts');

  it('三个字段真的转发出去，不是只加在入参类型上', () => {
    const s = src();
    expect(s).toContain('hint_request: body.hintRequest ?? 0');
    expect(s).toContain('hints_used: body.hintsUsed ?? 0');
    expect(s).toContain("hint_question_id: body.hintQuestionId ?? ''");
  });

  it('提示轮不会被当成坏载荷退 204', () => {
    // 提示分支既没有 decision 也没有 mode，只有 steps。
    // 少这一条判据的话引擎正常返回、界面什么都收不到——最难查的那种静默失败。
    const s = src();
    expect(s).toContain("'steps' in data");
    expect(s).toContain('isLadder');
  });

  it('LectureExchange 带 hints_used，历史回放才算得对代价', () => {
    expect(src()).toContain('hints_used?: number');
  });

  it('HintStep 的 content 语义写清了未解锁为空', () => {
    expect(src()).toContain('未解锁时 `content` 是空串');
  });
});

describe('面板', () => {
  const src = () => read('components/chat/tutor-panel.tsx');

  it('交答案时回传 hints_used', () => {
    expect(src()).toContain('hintsUsed: hintsUsedRef.current');
  });

  it('出下一题时清零——不清就等于替新题记了上一题的提示代价', () => {
    const s = src();
    expect(s).toContain('hintsUsedRef.current = 0;');
    expect(s).toMatch(/新题 = 新阶梯/);
  });

  it('累计级别以引擎回的为准，前端不自增', () => {
    const s = src();
    expect(s).toContain('Math.max(hintsUsedRef.current, got.hints_used ?? 0)');
    expect(s).toContain('不在前端自增');
  });

  it('置灰文案用引擎回的 reason，不另编一套', () => {
    expect(src()).toContain('step?.reason');
  });

  it('每级按钮标出代价，让人知情后再点', () => {
    expect(src()).toContain('verdict_cap');
  });

  it('要提示不出新题（走 hintRequest 分支）', () => {
    expect(src()).toContain('hintRequest: level');
  });
});

describe('题库分支', () => {
  /**
   * 2026-08-23 全仓扫过：课堂侧只有讲义分支（tutor-panel）在调 /api/tutor，
   * 题库分支（引擎 `tutor:pool`，按 concept 从 data/curriculum 取选择题）**没有消费方**——
   * 旧平台那个选择题页随 web-next 一起归档了（docs/archive/legacy-platform-20260809）。
   * 所以「题库导学里点不出提示」不是接线断了，是那条路整条不在课堂里。
   *
   * **2026-08-23 已裁定不建**（产品决策，不是待办）：课堂导学的形态就是讲义驱动——
   * 「题目现场从讲义正文生成」是对外写着的机制说明。题库分支的题只从
   * `data/curriculum/` 取，那里只有 llm_basics / rag / deep_learning 三份内置语料，
   * 而课堂生成的课程从不落到那个目录。为这三份造一个入口，等于给所有真实课程
   * 造一个 404「该主题暂无导学题库」的死界面。
   *
   * 下面两条不是摆设：哪天真要接回来，它们就是同一套判据的入口检查。
   */
  it('凡是走题库分支的调用点，都得带 hintQuestionId', () => {
    for (const f of tutorCallers()) {
      const s = read(f);
      // 认 `selected_index`：题库分支的作答历史独有这一格（路由里 history 的形态就是
      // `{ question_id, selected_index }`），讲义分支自由作答没有它。
      // 不认 `concept`——那个词在参数名里也出现，会把讲义分支误判进来。
      if (!/selected_index/.test(s)) continue;
      // 讲义分支的题在 question 字段里，用不上 hintQuestionId；题库分支不指明是哪道题，
      // 引擎 `_load_pool` 找不到题会抛 KeyError，被 HTTP 层转成 404——
      // 界面上显示的却是「该主题暂无导学题库」，查起来会往题库缺失的方向跑偏。
      expect(s, `${f} 走了题库分支却没带 hintQuestionId`).toContain('hintQuestionId');
    }
  });

  it('调用点只有讲义分支这一个——多出来的那个要照上面的判据补接线', () => {
    expect(tutorCallers()).toEqual(['components/chat/tutor-panel.tsx']);
  });
});

describe('证据留痕', () => {
  const base = {
    learnerKey: 'k',
    interactionId: 'i',
    sceneId: 's',
    sceneTitle: '循环监视时间',
    at: '2026-08-23T00:00:00.000Z',
  };

  it('看了兜底答案的那条，履历上看得出来', () => {
    const draft = tutorEvidenceDraft({
      ...base,
      turn: {
        mode: 'verdict',
        verdict: 'incorrect',
        expected_points: ['阈值默认 150ms'],
        profile_evidence: {
          concept: '循环监视时间',
          verdict: 'incorrect',
          confidence: 0.8,
          hints_used: 3,
          raw_verdict: 'correct',
        },
      },
    });
    expect(draft).not.toBeNull();
    const item = draft!.items[0]!;
    const because = item.verdict!.because;
    expect(item.context.hintsUsed).toBe(3);
    // 注记单开一格：塞进 missed 会被复盘的人当成一个知识缺口
    expect(because.note?.join(' ')).toContain('看了兜底答案');
    expect(because.note?.join(' ')).toContain('原始判分 correct');
    expect(because.missed).toEqual(['阈值默认 150ms']);
  });

  it('没要过提示就不留注记，也不写 hintsUsed', () => {
    const draft = tutorEvidenceDraft({
      ...base,
      turn: {
        mode: 'verdict',
        verdict: 'correct',
        expected_points: ['阈值默认 150ms'],
        profile_evidence: { concept: '循环监视时间', verdict: 'correct', confidence: 0.8 },
      },
    });
    const item = draft!.items[0]!;
    expect(item.context.hintsUsed).toBeUndefined();
    expect(item.verdict!.because.note).toBeUndefined();
  });

  it('提示代价不在这里二次打折——分值仍是引擎压过档的那份', () => {
    const draft = tutorEvidenceDraft({
      ...base,
      turn: {
        mode: 'verdict',
        verdict: 'partial',
        mastery_estimate: 0.5,
        profile_evidence: {
          concept: '循环监视时间',
          verdict: 'partial',
          confidence: 0.5,
          hints_used: 2,
          raw_verdict: 'correct',
        },
      },
    });
    expect(draft!.items[0]!.verdict!.score).toBe(0.5);
  });
});
