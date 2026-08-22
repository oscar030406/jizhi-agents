import { describe, expect, it } from 'vitest';
import { buildPracticeGuideMarkdown } from '@/lib/export/practice-guide';
import type { Scene } from '@/lib/types/stage';
import type { SceneOutline } from '@/lib/types/generation';

const scene = {
  id: 's1',
  stageId: 'st1',
  title: '更换刹车片',
  order: 2,
  type: 'interactive',
  outlineId: 'o1',
  content: {
    type: 'interactive',
    url: '',
    widgetType: 'procedural-skill',
    widgetConfig: {
      type: 'procedural-skill',
      task: '更换前轮刹车片',
      description: '在举升机上完成前轮刹车片更换。',
      tools: ['扭力扳手', '千斤顶'],
      steps: [
        { id: 'step-1', title: '举升车辆', description: '举升至轮胎离地', successCriteria: ['车辆稳固'] },
      ],
      successCriteria: ['制动踏板行程正常'],
    },
  },
} as unknown as Scene;

const outlines: SceneOutline[] = [
  {
    id: 'o1',
    type: 'interactive',
    title: '更换刹车片',
    description: '',
    keyPoints: [],
    order: 2,
    widgetType: 'procedural-skill',
    widgetOutline: { errorConsequences: ['未紧固螺栓导致车轮脱落'] },
  },
];

describe('buildPracticeGuideMarkdown', () => {
  it('renders task, steps, acceptance, and error consequences from scene + outline', () => {
    const md = buildPracticeGuideMarkdown('汽修实训课', [scene], outlines, '维修学徒 · Agent Lv1');
    expect(md).toContain('# 实操指南 — 汽修实训课');
    expect(md).toContain('适用画像：维修学徒');
    expect(md).toContain('## 任务1：更换前轮刹车片');
    expect(md).toContain('1. **举升车辆** — 举升至轮胎离地');
    expect(md).toContain('验收点：车辆稳固');
    expect(md).toContain('### 验收标准');
    expect(md).toContain('未紧固螺栓导致车轮脱落');
  });

  it('returns null when no procedural scenes exist', () => {
    const slide = { ...scene, content: { type: 'slide', elements: [] } } as unknown as Scene;
    expect(buildPracticeGuideMarkdown('课', [slide], [], '')).toBeNull();
  });
});
