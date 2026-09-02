// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgBadge } from '@/components/home/org-badge';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('首页机构指派课程', () => {
  it('unavailable 指派展示原因且不生成课堂链接', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/org') return json({ org: { name: '甲方培训中心' } });
        if (url === '/api/org/assignments') {
          return json({
            assignments: [
              {
                id: 'asg-unavailable',
                courseId: 'course-mfg',
                title: '智能制造课程',
                availability: 'unavailable',
                unavailableReason: '机构课程暂不可用：课程尚未通过发布审核。',
              },
            ],
          });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => root.render(<OrgBadge />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain('智能制造课程');
    expect(host.textContent).toContain('机构课程暂不可用');
    expect(host.querySelector('a[href="/classroom/course-mfg"]')).toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});
