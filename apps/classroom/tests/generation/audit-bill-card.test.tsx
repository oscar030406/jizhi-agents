// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ClassroomCompletePage } from '@/components/scene-renderers/classroom-complete';
import { I18nProvider } from '@/lib/hooks/use-i18n';
import type { Scene } from '@/lib/types/stage';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function slideScene(id: string, audit?: Partial<NonNullable<Scene['audit']>>): Scene {
  return {
    id,
    stageId: 's1',
    type: 'slide',
    title: `页 ${id}`,
    order: Number(id),
    content: { type: 'slide', canvas: { elements: [] } },
    ...(audit
      ? {
          audit: {
            verdict: 'pass',
            decision: 'allow',
            totalClaims: 0,
            flaggedCount: 0,
            uncertainCount: 0,
            incorrectCount: 0,
            rounds: 1,
            durationMs: 1000,
            judgeModel: 'test',
            rationale: '',
            claims: [],
            grounded: true,
            evidenceCount: 1,
            ...audit,
          } as NonNullable<Scene['audit']>,
        }
      : {}),
  } as unknown as Scene;
}

describe('审核账单卡', () => {
  test('聚合各场景 audit：断言总数/修订页/幻觉率如实呈现', async () => {
    const scenes = [
      slideScene('1', { totalClaims: 7 }),
      slideScene('2', { totalClaims: 8, verdict: 'revised', flaggedCount: 2 }),
      slideScene('3', { totalClaims: 5, incorrectCount: 1, uncertainCount: 1, verdict: 'caveat' }),
      slideScene('4'), // 未经审（无 audit）不进分母
    ];
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      createRoot(host).render(
        <I18nProvider>
          <ClassroomCompletePage scenes={scenes} title="测试课" />
        </I18nProvider>,
      );
    });
    const text = host.textContent ?? '';
    expect(text).toContain('审核智能体已核验 20 条事实断言');
    expect(text).toContain('3 页经审');
    expect(text).toContain('1 页标记后修订放行');
    expect(text).toContain('1 条存疑已标注');
    // 1/20 = 5.0%
    expect(text).toContain('5.0%');
    expect(text).toContain('1 条未通过核验');
  });

  test('全程未经审（引擎离线）不渲染账单——不编造零', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      createRoot(host).render(
        <I18nProvider>
          <ClassroomCompletePage scenes={[slideScene('1'), slideScene('2')]} title="测试课" />
        </I18nProvider>,
      );
    });
    expect(host.textContent).not.toContain('已核验');
  });
});
