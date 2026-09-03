// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobSkills } from '@/app/api/skills/route';
import type { EffectiveDomainContextState } from '@/lib/knowledge/use-domain-context';

let contextState: EffectiveDomainContextState = {
  kind: 'ready',
  context: {
    domain: 'ai',
    label: '人工智能应用开发',
    source: 'profile-domain',
    status: 'ready',
    isAi: true,
    registered: true,
  },
};

vi.mock('@/lib/knowledge/use-domain-context', () => ({
  useEffectiveDomainContext: () => contextState,
}));
vi.mock('motion/react', () => ({ motion: { div: 'div' } }));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  // 左功能栏（components/nav/learner-rail.tsx）按当前路由高亮，随 /skills 页一起挂载。
  usePathname: () => '/skills',
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { default: SkillsPage } = await import('@/app/skills/page');

const job: JobSkills = {
  job_id: 'ai-engineer',
  title: '会话过滤后的 AI 岗位',
  summary: '测试岗位',
  core_concepts: ['agent_basics'],
  covered_count: 1,
  skills: [
    {
      skill: '智能体基础',
      covered: true,
      score: 0.9,
      source_id: 'source-ai',
      source_title: 'AI 教材',
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  contextState = {
    kind: 'ready',
    context: {
      domain: 'ai',
      label: '人工智能应用开发',
      source: 'profile-domain',
      status: 'ready',
      isAi: true,
      registered: true,
    },
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  window.localStorage.setItem('learnerProfile', JSON.stringify({ domain: 'ai', corpus: 'ai' }));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('/skills 只走机构过滤接口', () => {
  it('只请求当前有效领域的 /api/skills，不请求公开静态快照', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === '/api/classroom') return json({ classrooms: [] });
        if (url === '/api/skills?domain=ai') {
          return json({ domain: 'ai', jobs: [job], corpora: [], market_stats: {}, provenance: {} });
        }
        if (url === '/api/practice-scout/ai') {
          return json({ status: 'missing', projects: [], reason: '尚未发布实操项目' });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(<SkillsPage />));
    await flush();
    await flush();

    expect(requests).toContain('/api/skills?domain=ai');
    expect(requests).not.toContain('/skill-map.json');
    expect(host.textContent).toContain(job.title);
  });

  it('/api/skills 失败时明确 unavailable，不保留旧岗位或回退快照', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/classroom') return json({ classrooms: [] });
        if (url === '/api/skills?domain=ai') return json({ error: 'unavailable' }, 503);
        if (url === '/api/practice-scout/ai') {
          return json({ status: 'missing', projects: [], reason: '尚未发布实操项目' });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(<SkillsPage />));
    await flush();
    await flush();

    expect(host.textContent).toContain('岗位技能地图暂时不可用');
    expect(host.textContent).not.toContain(job.title);
  });

  it('非 AI 有效领域读取失败时同样显示 unavailable，不伪装成岗位素材缺失', async () => {
    contextState = {
      kind: 'ready',
      context: {
        domain: 'smart-manufacturing',
        label: '智能制造',
        source: 'course-assignment',
        status: 'ready',
        isAi: false,
        registered: true,
        assignment: { id: 'assignment-mfg', courseId: 'course-mfg' },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/classroom') return json({ classrooms: [] });
        if (url === '/api/skills?domain=smart-manufacturing') {
          return json({ error: 'unavailable' }, 503);
        }
        if (url === '/api/practice-scout/smart-manufacturing') {
          return json({ status: 'missing', projects: [], reason: '尚未发布实操项目' });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(<SkillsPage />));
    await flush();
    await flush();

    expect(host.textContent).toContain('岗位技能地图暂时不可用');
    expect(host.textContent).not.toContain('本机构管理者尚未提供');
  });
});
