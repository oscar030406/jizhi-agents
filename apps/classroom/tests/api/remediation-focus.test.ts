/**
 * 补救 outline 的「焦点」取值（WO-H4 第 1 件）。
 *
 * 焦点决定标题和 keyPoint，两者都会上场景侧栏。改之前它直接取锚点测验的场景标题，
 * 而 23 门课里 9 门的测验就叫「知识检查」——补救标题于是成了「降维讲解：知识检查」。
 *
 * 用例里的场景标题全部照抄 `data/classrooms/*.json` 的真实取值，不是编的：
 * 「知识检查」「知识检查：调用路径与参数」「矩阵乘法知识检查」「核心概念巩固」…
 *
 * 不打桩任何东西：没配 GROUNDING_URL 时证据桥直接返回 null，不传 learnerProfile
 * 时学情桥也不调，这条路由此时是纯函数。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

async function plan(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/adaptive/remediation/route');
  const request = new Request('http://localhost/api/adaptive/remediation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const resp = await POST(request as unknown as NextRequest);
  return (await resp.json()) as { outline: { title: string; keyPoints: string[] } };
}

beforeEach(() => {
  delete process.env.GROUNDING_URL;
});

describe('补救 outline 的焦点取值', () => {
  it('测验标题是纯套话时退到课程标题，不再产出「××：知识检查」', async () => {
    const { outline } = await plan({
      decision: 'downgrade_explanation',
      sceneTitle: '知识检查',
      courseTitle: '注意力权重与温度参数',
      missedPoints: ['temperature 调大，softmax 分布会怎样？'],
    });
    expect(outline.title).toBe('降维讲解：注意力权重与温度参数');
    expect(outline.title).not.toContain('知识检查');
    expect(outline.keyPoints[0]).not.toContain('知识检查');
  });

  it.each([
    ['知识检查：调用路径与参数', '调用路径与参数'],
    ['知识检查 - 评测榜单', '评测榜单'],
    ['矩阵乘法知识检查', '矩阵乘法'],
    ['LLM 能力知识检查', 'LLM 能力'],
    ['知识检查：链式法则', '链式法则'],
  ])('测验标题里带着知识点时留下知识点：%s → %s', async (sceneTitle, focus) => {
    const { outline } = await plan({
      decision: 'downgrade_explanation',
      sceneTitle,
      courseTitle: '某门课',
      missedPoints: [],
    });
    expect(outline.title).toBe(`降维讲解：${focus}`);
  });

  it.each([
    '综合知识检查',
    '知识巩固测试',
    '核心概念巩固',
    '课程总结测验',
    '阶段一知识检测',
    // 这两条是数完 32 个真实标题才发现的：剥完只剩一个「知识」，
    // 长度过了 2 字的门槛就当知识点用了，标题会变成「降维讲解：知识」。
    '综合知识测试',
    '知识小测试',
  ])(
    '其余几种通用标题一样退到课程标题：%s',
    async (sceneTitle) => {
      const { outline } = await plan({
        decision: 'add_practice',
        sceneTitle,
        courseTitle: 'RAG 检索增强生成入门',
        missedPoints: [],
      });
      expect(outline.title).toBe('针对性练习：RAG 检索增强生成入门');
    },
  );

  it('课程墙上每个真实测验标题逐条过一遍，没有一条产出套话标题', async () => {
    const { readdirSync, readFileSync } = await import('fs');
    const dir = 'data/classrooms';
    const pairs: Array<[string, string]> = [];
    for (const file of readdirSync(dir)) {
      const doc = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as {
        stage?: { name?: string };
        scenes?: Array<{ type: string; title: string }>;
      };
      for (const scene of doc.scenes ?? []) {
        if (scene.type === 'quiz') pairs.push([doc.stage?.name ?? '', scene.title]);
      }
    }
    // 下界不是精确值：课程墙会长（08-16 补课把测验场景从 32 涨到 36）。这里钉的是
    // 「真的遍历到了真数据」，不是墙的门数——门数钉死等于每加一门课就假红一次。
    expect(pairs.length).toBeGreaterThanOrEqual(32);

    for (const [courseTitle, sceneTitle] of pairs) {
      const { outline } = await plan({
        decision: 'downgrade_explanation',
        sceneTitle,
        courseTitle,
        missedPoints: [],
      });
      const focus = outline.title.replace('降维讲解：', '');
      expect(focus, `「${sceneTitle}」的焦点仍是套话`).not.toMatch(
        /^(知识|检查|检测|测验|测试|综合|巩固)+$/,
      );
      expect(focus.length, `「${sceneTitle}」的焦点太短`).toBeGreaterThanOrEqual(2);
    }
  });

  it('课程标题也拿不到时不至于空标题——退回原场景标题', async () => {
    const { outline } = await plan({
      decision: 'downgrade_explanation',
      sceneTitle: '知识检查',
      missedPoints: [],
    });
    expect(outline.title).toBe('降维讲解：知识检查');
  });

  it('答错的题干原样进 description，供生成时定位薄弱处', async () => {
    const { outline } = (await plan({
      decision: 'downgrade_explanation',
      sceneTitle: '知识检查',
      courseTitle: '注意力权重与温度参数',
      missedPoints: ['temperature 调大，softmax 分布会怎样？'],
    })) as unknown as { outline: { description: string } };
    expect(outline.description).toContain('temperature 调大，softmax 分布会怎样？');
  });
});
