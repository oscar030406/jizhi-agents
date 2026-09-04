// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EffectiveDomainContextState } from '@/lib/knowledge/use-domain-context';
import type { AccountProfileState } from '@/lib/knowledge/account-profile';
import type { PracticeProject } from '@/components/skills/practice-projects';
import type { JobSkills } from '@/app/api/skills/route';

let contextState: EffectiveDomainContextState = { kind: 'loading' };
let accountProfileState: AccountProfileState = {
  kind: 'ready',
  source: 'server',
  profile: { domain: 'ai', corpus: 'ai' },
};

vi.mock('@/lib/knowledge/use-domain-context', () => ({
  useEffectiveDomainContext: () => contextState,
}));
vi.mock('@/lib/knowledge/account-profile', () => ({
  useAccountProfile: () => accountProfileState,
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

/** 主库 ai 的首屏数据现在由服务端外壳传进来（快照），不再由页面自己去取。 */
let snapshot: SkillMapData;
const view = () => <SkillsPage snapshot={snapshot} jobSkills={[]} jobId="" />;

const aiJob: JobSkills = {
  job_id: 'ai-engineer',
  title: 'AI 应用工程师',
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

const skillMap = {
  domain: 'ai',
  jobs: [aiJob],
  corpora: [],
  market_stats: {},
  provenance: {},
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function project(id: string, name: string): PracticeProject {
  return {
    id,
    name,
    org: 'example/repo',
    level: 'starter',
    difficulty: 1,
    hours: '2 小时',
    jobIds: [],
    courseIds: [],
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
  contextState = { kind: 'loading' };
  accountProfileState = {
    kind: 'ready',
    source: 'server',
    profile: { domain: 'ai', corpus: 'ai' },
  };
  snapshot = skillMap as SkillMapData;
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

describe('/skills 岗位状态按领域绑定', () => {
  it('账户画像接口失败时显式停止，不加载旧画像岗位与项目', async () => {
    accountProfileState = { kind: 'error', reason: '当前账户画像暂时无法读取；未使用本地旧画像。' };
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === '/api/classroom') return json({ classrooms: [] });
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(view()));
    await flush();

    expect(host.textContent).toContain('当前账户画像暂时无法读取');
    expect(requests.some((url) => url.startsWith('/api/skills?domain='))).toBe(false);
    expect(requests.some((url) => url.startsWith('/api/practice-scout/'))).toBe(false);
  });

  it('机构课程 unavailable 时不请求任何领域岗位或项目', async () => {
    contextState = {
      kind: 'ready',
      context: {
        domain: null,
        source: 'course-assignment',
        status: 'assignment-unavailable',
        isAi: false,
        registered: false,
        assignment: {
          id: 'asg-unavailable',
          courseId: 'course-mfg',
          availability: 'unavailable',
        },
        reason: '机构课程暂不可用：课程内容目前无法读取。',
      },
    };
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === '/api/classroom') return json({ classrooms: [] });
        throw new Error(`unexpected ${url}`);
      }),
    );

    await act(async () => root.render(view()));
    await flush();

    expect(host.textContent).toContain('机构课程暂不可用');
    expect(requests.some((url) => url.startsWith('/api/skills?domain='))).toBe(false);
    expect(requests.some((url) => url.startsWith('/api/practice-scout/'))).toBe(false);
  });

  it('从 AI 切到外域且接口返回 204 时立即清掉旧岗位并固定诚实空态', async () => {
    const oldJob = { ...aiJob, title: '只属于 AI 的旧岗位' };
    // ai 那一屏来自快照，不再走 /api/skills?domain=ai
    snapshot = { ...skillMap, jobs: [oldJob] } as SkillMapData;
    const oldProject = project('generated-ai', '只属于 AI 的引擎项目');
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === '/api/classroom') return json({ classrooms: [] });
        if (url === '/api/skills?domain=ai') {
          return json({ ...skillMap, jobs: [oldJob] });
        }
        if (url === '/api/practice-scout/ai') {
          return json({ status: 'ready', projects: [oldProject] });
        }
        if (url === '/api/skills?domain=smart-manufacturing') {
          return new Response(null, { status: 204 });
        }
        if (url === '/api/practice-scout/smart-manufacturing') {
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

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
    await act(async () => root.render(view()));
    await flush();
    await flush();
    expect(host.textContent).toContain(oldJob.title);
    expect(host.textContent).toContain(oldProject.name);
    expect(requests).toContain('/api/practice-scout/ai');
    expect(host.textContent).not.toContain('llm-universe');

    contextState = {
      kind: 'ready',
      context: {
        domain: 'smart-manufacturing',
        label: '智能制造',
        source: 'course-assignment',
        status: 'ready',
        isAi: false,
        registered: true,
      },
    };
    await act(async () => root.render(view()));
    expect(host.textContent).not.toContain(oldProject.name);
    await flush();

    expect(requests).toContain('/api/skills?domain=smart-manufacturing');
    expect(requests).toContain('/api/practice-scout/smart-manufacturing');
    expect(host.textContent).not.toContain(oldJob.title);
    expect(host.textContent).not.toContain(oldProject.name);
    expect(host.textContent).toContain('岗位技能地图暂时不可用');
  });

  it('智能制造岗位缺失时仍独立展示该域引擎实操项目', async () => {
    const manufacturing = project('mfg-generated', '智能制造产线诊断项目');
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === '/api/classroom') return json({ classrooms: [] });
        if (url === '/api/skills?domain=smart-manufacturing') {
          return json({
            domain: 'smart-manufacturing',
            jobs: [],
            corpora: [],
            reason: '本机构管理者尚未提供「智能制造」的岗位画像',
          });
        }
        if (url === '/api/practice-scout/smart-manufacturing') {
          return json({ status: 'ready', projects: [manufacturing] });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    contextState = {
      kind: 'ready',
      context: {
        domain: 'smart-manufacturing',
        label: '智能制造',
        source: 'course-assignment',
        status: 'ready',
        isAi: false,
        registered: true,
      },
    };

    await act(async () => root.render(view()));
    await flush();
    await flush();

    expect(requests).toContain('/api/practice-scout/smart-manufacturing');
    expect(host.textContent).toContain(manufacturing.name);
    expect(host.textContent).toContain('本机构管理者尚未提供「智能制造」的岗位画像');
  });

  it('智能制造岗位与页面说明都使用该域引擎结果，不残留固定 AI 模块', async () => {
    const manufacturingJob: JobSkills = {
      ...aiJob,
      job_id: 'manufacturing-engineer',
      title: '智能制造系统工程师',
      summary: '产线数据采集与设备协同',
      core_concepts: ['industrial_protocol'],
      skills: [
        {
          ...aiJob.skills[0],
          skill: '工业协议集成',
          source_id: 'source-mfg',
          source_title: '智能制造教材',
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/classroom') return json({ classrooms: [] });
        if (url === '/api/skills?domain=smart-manufacturing') {
          return json({
            domain: 'smart-manufacturing',
            jobs: [manufacturingJob],
            corpora: [],
          });
        }
        if (url === '/api/practice-scout/smart-manufacturing') {
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    contextState = {
      kind: 'ready',
      context: {
        domain: 'smart-manufacturing',
        label: '智能制造',
        source: 'course-assignment',
        status: 'ready',
        isAi: false,
        registered: true,
      },
    };

    await act(async () => root.render(view()));
    await flush();
    await flush();

    expect(host.textContent).toContain(manufacturingJob.title);
    expect(host.textContent).toContain('当前展示的是「智能制造」领域的引擎结果');
    expect(host.textContent).not.toMatch(/模块一：大模型基础|RAG 与向量检索|Agent 应用开发/);
  });
});
