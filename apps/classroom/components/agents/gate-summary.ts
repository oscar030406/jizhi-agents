/**
 * 一门课的门禁账：把场景按「审核门禁怎么裁的」分桶，再拼成一句平铺话。
 *
 * 为什么单独成文件：这句话是对外可见的数字，要能脱开 React 直接跑测试
 * （tests/agents/gate-summary.test.ts）。
 *
 * 口径（与 lib/generation/hallucination-audit.ts 的 decision 字段一一对应）：
 * - publish               → 直接放行
 * - publish_with_warnings → 带风险标记放行
 * - block_pending_review  → 裁决为拦截转人工
 * - 有 audit 但 decision 不是上面三种（早于门禁裁决字段的旧记录）→ 单列一桶
 * - 没有 audit            → 单列一桶
 *
 * 「通过审核门禁」= 前两桶之和。后三桶一律照实说，不因为「不好看」就省略——
 * 已落库课程里真有场景被裁成拦截（提示工程入门 1 个、多 Agent 协作与编排 2 个）。
 */

import type { Scene } from '@/lib/types/stage';

export interface GateSummary {
  /** 本课场景总数 = 下面五个桶之和 */
  total: number;
  publish: number;
  publishWithWarnings: number;
  blocked: number;
  /** 有审核记录但没有门禁裁决字段（旧数据） */
  undecided: number;
  /** 完全没有审核记录 */
  unaudited: number;
  /** 通过门禁 = publish + publishWithWarnings */
  passed: number;
  /** 展示用的一句话，数字全部来自上面的桶 */
  sentence: string;
}

export function summarizeGate(scenes: readonly Scene[]): GateSummary {
  const bucket = { publish: 0, publishWithWarnings: 0, blocked: 0, undecided: 0, unaudited: 0 };

  for (const scene of scenes) {
    const decision = scene.audit?.decision;
    if (!scene.audit) bucket.unaudited += 1;
    else if (decision === 'publish') bucket.publish += 1;
    else if (decision === 'publish_with_warnings') bucket.publishWithWarnings += 1;
    else if (decision === 'block_pending_review') bucket.blocked += 1;
    else bucket.undecided += 1;
  }

  const total = scenes.length;
  const passed = bucket.publish + bucket.publishWithWarnings;
  const base = { total, ...bucket, passed };

  if (total === 0) return { ...base, sentence: '本课没有场景。' };

  const breakdown = [
    [bucket.publish, '直接放行'],
    [bucket.publishWithWarnings, '带风险标记放行'],
  ] as const;
  const detail = breakdown
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} 个${label}`)
    .join('、');

  const rest = [
    [bucket.blocked, '裁决为拦截转人工'],
    [bucket.undecided, '有审核记录但没有门禁裁决'],
    [bucket.unaudited, '没有审核记录'],
  ] as const;
  const restText = rest
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} 个${label}`)
    .join('、');

  if (passed === 0) {
    return { ...base, sentence: `本课 ${total} 个场景没有一个通过审核门禁：${restText}。` };
  }
  if (!restText) {
    return { ...base, sentence: `本课 ${total} 个场景全部通过审核门禁（${detail}）。` };
  }
  return {
    ...base,
    sentence: `本课 ${total} 个场景，${passed} 个通过审核门禁（${detail}）；${restText}。`,
  };
}
