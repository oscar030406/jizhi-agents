/**
 * 首屏过程回放五帧的数据可溯源性（components/home/generation-replay.tsx）。
 *
 * 这个测试的作用不是覆盖分支，是把「回放里那几句话真的来自磁盘上那门课」钉死：
 * 课程 / 场景 id 写死在组件里，需求原文抄成了常量——任何一处漂了，这里就红。
 * 落盘的课被重生成、审核判定变了导致场景不再 verdict==='revised' 时也会红：
 * 那时该换一门课的 id，不该让首页继续挂着一段对不上号的回放。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REPLAY_COURSE_ID,
  REPLAY_REQUIREMENT,
  REPLAY_SCENE_ID,
  buildReplayFrames,
} from '@/components/home/generation-replay';
import type { AuditClaim, SceneAudit } from '@/lib/generation/hallucination-audit';
import type { Scene } from '@/lib/types/stage';

const ROOT = process.cwd();
const readJson = (rel: string) => JSON.parse(readFileSync(resolve(ROOT, rel), 'utf-8'));

describe('过程回放的数据源', () => {
  it('帧 1 的需求原文与 data/learning-path.json 一字不差', () => {
    const path = readJson('data/learning-path.json') as {
      nodes: Array<{ courseId?: string; requirement?: string }>;
    };
    const node = path.nodes.find((n) => n.courseId === REPLAY_COURSE_ID);
    expect(node?.requirement).toBe(REPLAY_REQUIREMENT);
  });

  it('写死的课程 + 场景在落盘数据里真的凑得齐五帧', () => {
    const course = readJson(`data/classrooms/${REPLAY_COURSE_ID}.json`) as { scenes: Scene[] };
    const frames = buildReplayFrames(course.scenes, REPLAY_SCENE_ID);
    expect(frames).not.toBeNull();
    // 帧 2 教材出处、帧 3 讲义正文、帧 4 打回记录，缺一不可
    expect(frames!.sources.length).toBeGreaterThan(0);
    expect(frames!.lecture.length).toBeGreaterThan(0);
    expect(frames!.catches.length).toBeGreaterThan(0);
    for (const c of frames!.catches) {
      expect(c.claim).toBeTruthy();
      expect(c.reason).toBeTruthy();
      expect(c.fix).toBeTruthy();
    }
  });
});

function scene(over: Partial<Scene> & { audit?: unknown }): Scene {
  return {
    id: 's1',
    title: '场景',
    type: 'slide',
    content: { canvas: { elements: [{ type: 'text', content: '<p>讲义正文</p>', top: 0 }] } },
    ...over,
  } as unknown as Scene;
}

const goodAudit: SceneAudit = {
  verdict: 'revised',
  claims: [{ claim: '原句', verdict: 'uncertain', reason: '理由', fix: '改后句' }],
  totalClaims: 1,
  flaggedCount: 0,
  uncertainCount: 1,
  incorrectCount: 0,
  judgeModel: 'a',
  rounds: 2,
  durationMs: 1,
  decision: 'publish_with_warnings',
  rationale: '',
  grounded: true,
  evidenceCount: 1,
  judgeModels: ['a', 'b'],
  sources: [{ source_id: 'hl04s01#s5', title: 'Happy-LLM 第4章' }],
};

describe('挑帧判据：凑不齐就整块不上', () => {
  it('场景 id 对不上 → null', () => {
    expect(buildReplayFrames([scene({ audit: goodAudit })], '不存在')).toBeNull();
  });

  it('verdict 不是 revised → null（没被打回改写就没有高潮帧）', () => {
    expect(
      buildReplayFrames([scene({ audit: { ...goodAudit, verdict: 'caveat' } })], 's1'),
    ).toBeNull();
  });

  it('断言没有 fix → null（帧 4 的三栏填不满）', () => {
    const claims: AuditClaim[] = [{ claim: '原句', verdict: 'uncertain', reason: '理由' }];
    expect(buildReplayFrames([scene({ audit: { ...goodAudit, claims } })], 's1')).toBeNull();
  });

  it('没有教材出处 → null（帧 2 没东西可圈）', () => {
    expect(buildReplayFrames([scene({ audit: { ...goodAudit, sources: [] } })], 's1')).toBeNull();
  });

  it('讲义正文为空 → null（帧 3 空着）', () => {
    const s = scene({ audit: goodAudit, content: { canvas: { elements: [] } } } as never);
    expect(buildReplayFrames([s], 's1')).toBeNull();
  });

  it('同一章节的多段证据合并成一条 chip，段数记在 count 上', () => {
    const sources = [
      { source_id: 'hl04s01#s5', title: 'Happy-LLM 第4章' },
      { source_id: 'hl04s01#s2', title: 'Happy-LLM 第4章' },
      { source_id: 'hl01s01#s1', title: 'Happy-LLM 第1章' },
    ];
    const frames = buildReplayFrames([scene({ audit: { ...goodAudit, sources } })], 's1');
    expect(frames!.sources).toEqual([
      { title: 'Happy-LLM 第4章', count: 2 },
      { title: 'Happy-LLM 第1章', count: 1 },
    ]);
    // 「共 N 段」写的是合并前的段落数，不是章节数
    expect(frames!.sourceCount).toBe(3);
  });
});
