/**
 * 三个消融开关：默认行为一字不变。
 *
 * 它们与其余 feature flag **默认方向相反**——那批是「默认关、显式开」，
 * 这三个关掉的是已经在生产里跑着的能力，存在的唯一理由是拿掉某一层看质量掉多少。
 *
 * 所以最要紧的判据不是「关得掉」，是**关不掉**：未设、空串、`false`、拼错的值
 * 一概按开处理。实验开关拼错时应该退回生产行为，而不是悄悄把审核门关掉。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  isAuditGateEnabled,
  isCourseCoherenceEnabled,
  isNumericBypassEnabled,
} from '@/lib/config/feature-flags';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAMES = ['AUDIT_GATE', 'COURSE_COHERENCE', 'NUMERIC_BYPASS'] as const;
const READERS = {
  AUDIT_GATE: isAuditGateEnabled,
  COURSE_COHERENCE: isCourseCoherenceEnabled,
  NUMERIC_BYPASS: isNumericBypassEnabled,
} as const;

afterEach(() => {
  for (const n of NAMES) delete process.env[n];
});

describe('默认行为一字不变', () => {
  it.each(NAMES)('%s 未设时是开的', (name) => {
    delete process.env[name];
    expect(READERS[name]()).toBe(true);
  });

  it.each(NAMES)('%s 设成拼错的值也是开的——实验开关拼错要退回生产行为', (name) => {
    for (const bad of ['', 'false', 'off', 'no', 'FALSE', '0 ', 'zero', 'disabled']) {
      process.env[name] = bad;
      expect(READERS[name](), `${name}=${JSON.stringify(bad)} 不该关掉`).toBe(true);
    }
  });

  it.each(NAMES)('%s 只有显式字符串 0 才关', (name) => {
    process.env[name] = '0';
    expect(READERS[name]()).toBe(false);
  });
});

describe('两条路都挡住了', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf-8');

  it('审核门：整课路与逐屏路都判', () => {
    // 只挡一条的话，消融跑出来的「关审核门」那一档其实有一半的屏还在被审
    expect(read('lib/server/classroom-generation.ts')).toContain('isAuditGateEnabled()');
    expect(read('app/api/generate/scene-audit/route.ts')).toContain('isAuditGateEnabled()');
  });

  it('课程一致性：批量路与客户端逐屏路都判', () => {
    expect(read('lib/server/classroom-generation.ts')).toContain('isCourseCoherenceEnabled()');
    expect(read('app/api/generate/scene-content/route.ts')).toContain('isCourseCoherenceEnabled()');
  });

  it('审核门关掉时整个 audit 字段不写，不写一个空的', () => {
    // 写空 audit 会让读的人以为判官跑了且什么都没抓到
    expect(read('lib/server/classroom-generation.ts')).toContain(
      '...(sceneAudit ? { audit: sceneAudit } : {})',
    );
  });

  it('三个开关都用 !== \'0\'，不复用默认关语义的 readBoolean', () => {
    const src = read('lib/config/feature-flags.ts');
    for (const n of NAMES) {
      expect(src).toContain(`process.env.${n} !== '0'`);
    }
  });
});
