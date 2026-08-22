/**
 * 掌握策略层：三元组 → 掌握判定 / 下一步 / 到期复习。
 *
 * 钉住的是移植时最容易走样的四条：证据封顶（高估计低置信不算掌握）、
 * 门槛即游标（已掌握自动跳过，test-out）、复习优先于推进、
 * 缺置信度按 0 处理（不确定当不会，不当会）。
 */
import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_FLOOR,
  MASTERY_GATE,
  REVIEW_THRESHOLD,
  dueReviews,
  nextObjective,
  snapshotsFromProfile,
  statusOf,
} from '@/lib/evidence/policy';

const mastered = { estimate: 0.95, confidence: 0.5, recall: 0.9 };

describe('statusOf', () => {
  it('没测过是 new，测过没过线是 learning', () => {
    expect(statusOf(undefined)).toBe('new');
    expect(statusOf({ estimate: 0.5, confidence: 0.5, recall: 0.5 })).toBe('learning');
  });

  it('证据封顶：estimate 过线但 confidence 在地板下，不算掌握', () => {
    expect(statusOf({ estimate: 0.99, confidence: CONFIDENCE_FLOOR - 0.01, recall: 0.99 })).toBe(
      'learning',
    );
    expect(statusOf({ estimate: MASTERY_GATE, confidence: CONFIDENCE_FLOOR, recall: 0.9 })).toBe(
      'mastered',
    );
  });
});

describe('dueReviews', () => {
  it('只有已掌握且 recall 跌破阈值的进队，最遗忘的排最前', () => {
    const due = dueReviews({
      forgotten: { ...mastered, recall: 0.3 },
      fading: { ...mastered, recall: 0.5 },
      fresh: mastered,
      learning: { estimate: 0.5, confidence: 0.5, recall: 0.2 }, // 没掌握≠遗忘
    });
    expect(due.map((t) => t.key)).toEqual(['forgotten', 'fading']);
    expect(due[0].recall).toBeLessThan(REVIEW_THRESHOLD);
  });
});

describe('dueReviews 错题置顶', () => {
  it('最近错过的排在没错过的前面，同层内按 recall 升序', () => {
    const due = dueReviews(
      {
        forgotten: { ...mastered, recall: 0.1 },
        slipped: { ...mastered, recall: 0.5 },
      },
      { errorProne: new Set(['slipped']) },
    );
    expect(due.map((t) => t.key)).toEqual(['slipped', 'forgotten']);
    expect(due[0].errorProne).toBe(true);
  });
});

describe('nextObjective', () => {
  it('复习优先于推进', () => {
    const step = nextObjective(['a', 'b'], {
      a: { ...mastered, recall: 0.2 },
      b: { estimate: 0.4, confidence: 0.3, recall: 0.4 },
    });
    expect(step.action).toBe('review');
    expect(step.key).toBe('a');
  });

  it('门槛即游标：已掌握跳过，没测过的先 probe', () => {
    const step = nextObjective(['a', 'b', 'c'], { a: mastered });
    expect(step).toMatchObject({ action: 'probe', key: 'b', status: 'new' });
  });

  it('测过没过门的 practice；全过门 complete', () => {
    expect(
      nextObjective(['a'], { a: { estimate: 0.6, confidence: 0.6, recall: 0.6 } }).action,
    ).toBe('practice');
    expect(nextObjective(['a'], { a: mastered }).action).toBe('complete');
  });
});

describe('snapshotsFromProfile', () => {
  it('缺 confidence 按 0（封住旧数据的假精通），缺 recall 退回 estimate', () => {
    const s = snapshotsFromProfile({ conceptMastery: { x: 0.95 } });
    expect(s.x).toEqual({ estimate: 0.95, confidence: 0, recall: 0.95 });
    expect(statusOf(s.x)).toBe('learning'); // 高分无置信 → 不算掌握
  });
});
