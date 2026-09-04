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

const { default: SkillsPage } = await import('@/app/skills/skills-view');
type SkillMapData = import('@/app/skills/skills-view').SkillMapData;

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
    {
      skill: '还没成课的技能',
      covered: false,
      score: 0.1,
      source_id: '',
      source_title: '',
    },
  ],
};

/**
 * 主库 ai 的首屏数据由服务端外壳（app/skills/page.tsx）把 `data/skill-map-ai.json`
 * 快照传进来。外域仍然只走 `/api/skills?domain=...`。
 */
const snapshot = {
  exported_at: '2026-09-04T00:42:02.218Z',
  domain: 'ai',
  jobs: [job],
  corpora: [],
  market_stats: {},
  provenance: {},
} as unknown as SkillMapData & { exported_at: string };

const view = () => (
  <SkillsPage
    snapshot={snapshot}
    jobSkills={[
      { skill: '智能体基础', covered: true, courses: [{ title: '已成课', courseId: 'c1' }] },
      { skill: '还没成课的技能', covered: false, courses: [{ title: '未成课', courseId: null }] },
    ]}
    jobId="ai-engineer"
  />
);

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

describe('/skills 主库读快照、外域读接口', () => {
  it('主库首屏直接出快照，不发 /api/skills，也不请求任何公开静态文件', async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === '/api/classroom') return json({ classrooms: [] });
        if (url === '/api/practice-scout/ai') {
          return json({ status: 'missing', projects: [], reason: '尚未发布实操项目' });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(view()));
    await flush();
    await flush();

    // 引擎那条路要逐条技能做检索，冷启动实测 ~38 秒；主库不该让每个人替它等一次。
    expect(requests).not.toContain('/api/skills?domain=ai');
    expect(requests).not.toContain('/skill-map.json');
    expect(host.textContent).toContain(job.title);
    expect(host.textContent).toContain('知识库覆盖按 2026-09-04 快照');
  });

  it('主库的技能下面写清楚有没有对口的课', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/classroom') return json({ classrooms: [] });
        if (url === '/api/practice-scout/ai') {
          return json({ status: 'missing', projects: [], reason: '尚未发布实操项目' });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(view()));
    await flush();
    await flush();
    // 岗位卡默认折着，展开才看得到技能行
    const toggle = host.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => toggle.click());

    expect(host.textContent).toContain('已有课：已成课');
    expect(host.textContent).toContain('课程生成中：未成课');
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

    await act(async () => root.render(view()));
    await flush();
    await flush();

    expect(host.textContent).toContain('岗位技能地图暂时不可用');
    expect(host.textContent).not.toContain('本机构管理者尚未提供');
    // 外域一个字节的主库快照都不许漏出去
    expect(host.textContent).not.toContain(job.title);
  });
});
