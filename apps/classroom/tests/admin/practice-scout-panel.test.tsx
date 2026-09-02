// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PracticeScoutPanel } from '@/components/admin/practice-scout-panel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const project = {
  id: 'p1',
  name: '跨域项目',
  org: 'example/repo',
  level: 'starter',
  difficulty: 2,
  hours: '2 小时',
  prereq: '无',
  steps: ['运行'],
  cost: '免费',
  networkNote: '',
  why: '验证领域能力',
  acceptance: '成功运行',
  deliverable: '仓库',
  resumeAdvice: '记录结果',
  links: [],
  approved: true,
};

const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const button = (host: HTMLElement, label: string) => {
  const found = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(label),
  );
  if (!found) throw new Error(`找不到按钮：${label}`);
  return found;
};

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

describe('PracticeScoutPanel 发布版本', () => {
  it('发布与恢复都生成新版本，并把当前版本同步到界面', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!init?.method) {
          return response({
            success: true,
            draft: {
              corpus: 'ai',
              status: 'draft',
              snapshot_id: `sha256:${'d'.repeat(64)}`,
              projects: [project],
              publication: {
                corpus: 'ai',
                current_version: 1,
                versions: [
                  {
                    version: 1,
                    status: 'published',
                    published_at: '2026-09-01T00:00:00+00:00',
                    snapshot_id: 'a'.repeat(64),
                    project_ids: ['p1'],
                  },
                ],
              },
            },
          });
        }
        if (url.endsWith('/approve')) {
          return response({
            success: true,
            publication: {
              corpus: 'ai',
              current_version: 2,
              release: {
                version: 2,
                status: 'published',
                published_at: '2026-09-01T01:00:00+00:00',
                snapshot_id: 'b'.repeat(64),
                restored_from_version: null,
                projects: [project],
              },
            },
          });
        }
        if (url.endsWith('/restore')) {
          expect(JSON.parse(String(init.body))).toEqual({ version: 1 });
          return response({
            success: true,
            publication: {
              corpus: 'ai',
              current_version: 3,
              release: {
                version: 3,
                status: 'published',
                published_at: '2026-09-01T02:00:00+00:00',
                snapshot_id: 'a'.repeat(64),
                restored_from_version: 1,
                projects: [project],
              },
            },
          });
        }
        throw new Error(`意外请求：${url}`);
      }),
    );

    await act(async () => {
      root.render(<PracticeScoutPanel corpus="ai" />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('当前为 v1');

    await act(async () => {
      button(host, '发布勾选的 1 项').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('当前为 v2');
    expect(host.textContent).toContain('版本 v2 已发布');

    await act(async () => {
      button(host, '恢复此版').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('当前为 v3');
    expect(host.textContent).toContain('已将 v1 恢复为新版本 v3');
  });
});
