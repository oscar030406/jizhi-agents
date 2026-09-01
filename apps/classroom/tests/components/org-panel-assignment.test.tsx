// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { OrgPanel } from '@/components/admin/org-panel';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('机构面板定向课程指派', () => {
  it('先选机构学员再选课程，并把精确目标提交给 API', async () => {
    let posted: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/org' && !init?.method) {
          return json({
            org: {
              id: 'org-a',
              name: '甲方培训中心',
              role: 'owner',
              memberCount: 3,
              inviteCode: 'JZ-TESTCODE',
            },
          });
        }
        if (url === '/api/org/corpora') return json({ ownership: {} });
        if (url === '/api/domains') return json({ entries: {} });
        if (url === '/api/org/members') {
          return json({
            members: [
              {
                accountId: 'owner-a',
                username: 'owner-a',
                displayName: '甲方管理员',
                role: 'owner',
                joinedAt: '2026-09-01T00:00:00.000Z',
              },
              {
                accountId: 'learner-b',
                username: 'learner-b',
                displayName: '学员乙',
                role: 'member',
                joinedAt: '2026-09-01T00:01:00.000Z',
              },
              {
                accountId: 'learner-d',
                username: 'learner-d',
                displayName: '学员丁',
                role: 'member',
                joinedAt: '2026-09-01T00:02:00.000Z',
              },
            ],
          });
        }
        if (url === '/api/org/assignments' && init?.method === 'POST') {
          posted = JSON.parse(String(init.body)) as Record<string, unknown>;
          return json({ success: true, assignment: { id: 'asg-new', ...posted } });
        }
        if (url === '/api/org/assignments') {
          return json({
            assignments: [
              {
                id: 'asg-d',
                courseId: 'course-ai',
                title: 'AI 课程',
                learnerAccountId: 'learner-d',
                learnerDisplayName: '学员丁',
                createdAt: '2026-09-01T00:03:00.000Z',
              },
            ],
          });
        }
        if (url === '/api/classroom') {
          return json({
            classrooms: [
              { id: 'course-ai', title: 'AI 课程' },
              { id: 'course-mfg', title: '智能制造课程' },
            ],
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<OrgPanel />));
    await settle();

    const selects = Array.from(host.querySelectorAll('select'));
    expect(selects).toHaveLength(2);
    const [learnerSelect, courseSelect] = selects;
    const learnerOptions = Array.from(learnerSelect.options).map((option) => option.textContent);
    expect(learnerOptions).toContain('学员乙（learner-b）');
    expect(learnerOptions).toContain('学员丁（learner-d）');
    expect(learnerOptions).not.toContain('甲方管理员（owner-a）');
    expect(courseSelect.disabled).toBe(true);
    expect(host.textContent).toContain('指派给：学员丁');

    await act(async () => {
      learnerSelect.value = 'learner-b';
      learnerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(courseSelect.disabled).toBe(false);
    // 同一课程已给学员丁，不应阻止再定向给学员乙。
    expect(Array.from(courseSelect.options).map((option) => option.value)).toContain('course-ai');

    await act(async () => {
      courseSelect.value = 'course-ai';
      courseSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const assignButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '指派',
    );
    expect(assignButton).toBeDefined();
    await act(async () => {
      assignButton!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(posted).toMatchObject({ learnerAccountId: 'learner-b', courseId: 'course-ai' });
  });
});
