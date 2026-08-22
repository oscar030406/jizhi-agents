/**
 * 教具 → 信号，**永远不是证据**。
 *
 * 这一条是 §4.4 那张表的直接落地：教具填得满「来源」，填不满「判定」——
 * 硬造一个「停留久 = 掌握了」就是伪造判定。用例钉死这个边界，
 * 因为它最容易被后人「顺手改成证据」：反正数据都有了，看着像。
 */
import { describe, expect, it } from 'vitest';

import {
  LOW_DWELL_MS,
  WIDGET_DWELL,
  WIDGET_ENGAGED,
  widgetSignalDraft,
} from '@/lib/evidence/from-widget';

const base = {
  interactionId: 'widget:scene-1:1',
  sceneId: 'scene-1',
  at: '2026-08-12T00:00:00.000Z',
};

describe('教具只产信号', () => {
  it('产出的形状是信号，没有 measured / verdict —— 结构上就当不了证据', () => {
    const d = widgetSignalDraft({ ...base, dwellMs: 30_000 })!;
    expect(d).toHaveProperty('kind');
    expect(d).toHaveProperty('source');
    expect(d).not.toHaveProperty('measured');
    expect(d).not.toHaveProperty('verdict');
    expect(d).not.toHaveProperty('items');
  });

  it('停留极短记 lowDwell —— 权重函数认得的那个键', () => {
    const d = widgetSignalDraft({ ...base, dwellMs: 1_200 })!;
    expect(d.kind).toBe(WIDGET_DWELL);
    expect(d.kind).toBe('lowDwell'); // 与 weight.ts 的 SIGNAL_FACTORS 键一致
    expect(d.value).toBe(1200);
    expect(d.note).toContain('低于');
  });

  it('停留够久记 widgetEngaged —— 目前没消费者，但账本先如实记', () => {
    const d = widgetSignalDraft({ ...base, dwellMs: LOW_DWELL_MS + 1 })!;
    expect(d.kind).toBe(WIDGET_ENGAGED);
  });

  it('阈值边界：正好等于阈值不算短', () => {
    expect(widgetSignalDraft({ ...base, dwellMs: LOW_DWELL_MS })!.kind).toBe(WIDGET_ENGAGED);
    expect(widgetSignalDraft({ ...base, dwellMs: LOW_DWELL_MS - 1 })!.kind).toBe(WIDGET_DWELL);
  });

  it('脏数据不落盘', () => {
    expect(widgetSignalDraft({ ...base, dwellMs: -1 })).toBeNull();
    expect(widgetSignalDraft({ ...base, dwellMs: Number.NaN })).toBeNull();
  });

  it('来源三件套齐全 —— 信号靠 interactionId 挂回同一次交互的证据', () => {
    const d = widgetSignalDraft({ ...base, dwellMs: 9_000 })!;
    expect(d.source.interactionId).toBe(base.interactionId);
    expect(d.source.resourceId).toBe('scene-1');
    expect(d.source.at).toBe(base.at);
  });
});
