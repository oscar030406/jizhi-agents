// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PracticeProject } from '@/components/skills/practice-projects';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { TrackPractice } = await import('@/components/path/track-practice');

function project(id: string, courseIds: string[]): PracticeProject {
  return {
    id,
    name: id,
    org: 'example/repo',
    level: 'starter',
    difficulty: 1,
    hours: '2 小时',
    jobIds: [],
    courseIds,
    prereq: '无',
    steps: ['准备环境', '运行项目', '按标准验收'],
    cost: '免费',
    networkNote: '',
    why: '用于课程实操',
    acceptance: '产物可运行',
    deliverable: '项目仓库',
    resumeAdvice: '记录结果',
    links: [],
    alternatives: [],
    firsthand: true,
  };
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
  vi.unstubAllGlobals();
});

describe('TrackPractice', () => {
  it('AI 路径模块只展示 courseIds 命中的动态发布项目', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            status: 'ready',
            projects: [
              project('course-a-project', ['course-a']),
              project('course-b-project', ['course-b']),
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    await act(async () => {
      root.render(<TrackPractice corpus="ai" courseIds={['course-a']} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(requests).toEqual(['/api/practice-scout/ai']);
    expect(host.textContent).toContain('course-a-project');
    expect(host.textContent).not.toContain('course-b-project');
  });
});
