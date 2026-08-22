import { describe, expect, it } from 'vitest';
import { formBadgeKey } from '@/components/stage/scene-sidebar';
import type { Scene } from '@/lib/types/stage';

const scene = (over: Partial<Scene>): Scene =>
  ({
    id: 's',
    stageId: 'st',
    order: 0,
    type: 'slide',
    title: '页',
    content: { type: 'slide', canvas: { elements: [] } },
    ...over,
  }) as unknown as Scene;

describe('formBadgeKey', () => {
  it('只有 procedural-skill 正源形态才配「实操指南」', () => {
    expect(
      formBadgeKey(
        scene({
          type: 'interactive',
          title: '更换刹车片',
          content: { type: 'interactive', url: '', widgetType: 'procedural-skill' },
        }),
      ),
    ).toBe('stage.formBadge.practice');
  });

  it('N1：标题带「实践」的讲义页降级为「实践建议」，不再冒充实操指南', () => {
    expect(formBadgeKey(scene({ title: '最佳实践总结' }))).toBe('stage.formBadge.practiceTip');
  });

  it('普通交互教具不被 procedural 分支抢走', () => {
    expect(
      formBadgeKey(
        scene({
          type: 'interactive',
          title: '动手试一试',
          content: { type: 'interactive', url: '', widgetType: 'simulation' },
        }),
      ),
    ).toBe('stage.formBadge.interactive');
  });

  it('标题无实践线索的讲义页不标徽标', () => {
    expect(formBadgeKey(scene({ title: '什么是向量检索' }))).toBeNull();
  });
});
