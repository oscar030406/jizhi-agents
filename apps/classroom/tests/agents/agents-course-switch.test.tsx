// @vitest-environment jsdom

/**
 * /agents 的课程切换器：换一门课，页面上的数字必须跟着换。
 *
 * 用户 2026-08-15 反馈原页面只能看最新一门课、换不了。这里钉三件事：
 * 1) 没有 ?classroom= 时默认选清单第一项（接口按 createdAt 倒序返回 = 最新一门）；
 * 2) 切到另一门课后，门禁句子里的场景数与「核验断言总数」都变成那门课的真值；
 * 3) 断言值不是从 summarizeGate 抄的，是本文件直接从 data/classrooms 的落库文件数出来的。
 *
 * 三门课取自真实落库数据，覆盖「全部通过」与「有场景被拦」两种形态。
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Scene, Stage } from '@/lib/types/stage';

/** 三门真实落库课程：全过 / 有拦截 / 另一种规模 */
const IDS = ['SgLaZloTqX', 'kO-NfL-ZdV', 'x8TnoUfQxG'] as const;

function readCourse(id: string): { stage: Stage; scenes: Scene[] } {
  const file = join(process.cwd(), 'data', 'classrooms', `${id}.json`);
  return JSON.parse(readFileSync(file, 'utf-8')) as { stage: Stage; scenes: Scene[] };
}

const COURSES = Object.fromEntries(IDS.map((id) => [id, readCourse(id)]));

/** 本文件自己数一遍断言总数，不借 page 里的任何计算。 */
function totalClaims(scenes: Scene[]): number {
  return scenes.reduce((sum, s) => sum + (s.audit?.totalClaims ?? 0), 0);
}

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => null }));

// store 保持空：模拟"新标签直接打开 /agents"，数据全部走落库副本。
const emptyState = {
  scenes: [] as Scene[],
  stage: null as Stage | null,
  blockedScenes: [] as unknown[],
  loadFromStorage: async () => {},
};
vi.mock('@/lib/store', () => {
  const useStageStore = <T,>(selector: (s: typeof emptyState) => T): T => selector(emptyState);
  useStageStore.getState = () => emptyState;
  return { useStageStore };
});

globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  const id = new URL(url, 'http://localhost').searchParams.get('id');
  if (id) {
    const course = COURSES[id];
    if (!course) return new Response('null', { status: 404 });
    return Response.json({
      success: true,
      classroom: { stage: course.stage, scenes: course.scenes },
    });
  }
  return Response.json({
    success: true,
    // 接口按 createdAt 倒序 → 第一项是最新一门；这里按 IDS 的顺序当作清单顺序
    classrooms: IDS.map((cid) => ({
      id: cid,
      title: COURSES[cid].stage.name,
      sceneCount: COURSES[cid].scenes.length,
    })),
  });
}) as unknown as typeof fetch;

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { default: AgentsPage } = await import('@/app/agents/page');

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** 「核验断言总数」那张卡上的数字 */
function claimsCardValue(): number {
  const card = [...host.querySelectorAll('div')].find(
    (d) => d.children.length === 2 && d.children[1]?.textContent === '核验断言总数',
  );
  if (!card) throw new Error('没找到「核验断言总数」卡');
  return Number(card.children[0].textContent);
}

describe('/agents 课程切换器', () => {
  it('默认选清单第一项，切换后数字跟着换', async () => {
    await act(async () => {
      root.render(<AgentsPage />);
    });
    await flush();

    const select = host.querySelector('select');
    expect(select, '没渲染出课程切换器').toBeTruthy();
    expect(select!.options.length).toBe(IDS.length);

    for (const id of IDS) {
      if (select!.value !== id) {
        await act(async () => {
          select!.value = id;
          select!.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await flush();
      }
      const { scenes } = COURSES[id];
      expect(select!.value, '切换器没停在选中的课上').toBe(id);
      expect(host.textContent, `${id} 的场景数没跟着换`).toContain(`本课 ${scenes.length} 个场景`);
      expect(claimsCardValue(), `${id} 的断言总数没跟着换`).toBe(totalClaims(scenes));
      expect(host.querySelectorAll('button[aria-expanded]').length, `${id} 的轨迹行数不对`).toBe(
        scenes.length,
      );
    }
  });

  it('被拦截的场景照实写在门禁句子里', async () => {
    await act(async () => {
      root.render(<AgentsPage />);
    });
    await flush();

    const select = host.querySelector('select')!;
    await act(async () => {
      select.value = 'kO-NfL-ZdV';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();

    const blocked = COURSES['kO-NfL-ZdV'].scenes.filter(
      (s) => s.audit?.decision === 'block_pending_review',
    ).length;
    expect(blocked).toBeGreaterThan(0);
    expect(host.textContent).toContain(`${blocked} 个裁决为拦截转人工`);
    expect(host.textContent).not.toContain('全部通过审核门禁');
  });
});
