// @vitest-environment jsdom
/**
 * 技能徽章在岗位技能页上的接线：未登录看到明确文案、登录后按真实记录出徽章与证据。
 *
 * 判定本身在 tests/learner/micro-credential.test.ts 里钉，这里只钉「页面把哪几份
 * 记录喂给了判定」以及访客那条路不报错不空白。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobSkills } from '@/app/api/skills/route';
import type { AccountProfileState } from '@/lib/knowledge/account-profile';
import type { EffectiveDomainContextState } from '@/lib/knowledge/use-domain-context';
import type { JobSkillEvidence } from '@/lib/server/learning-path';
import type { LearnerProfileFields } from '@/lib/types/generation';

const contextState: EffectiveDomainContextState = {
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

let accountProfileState: AccountProfileState<LearnerProfileFields> = {
  kind: 'ready',
  source: 'anonymous-local',
  profile: { domain: 'ai', corpus: 'ai' },
};

/** 账本读取在测试里定死，免得 jsdom 里的 IndexedDB 决定测试结果。 */
let ledgerEvidence: unknown[] = [];
let ledgerThrows = false;

vi.mock('@/lib/knowledge/use-domain-context', () => ({
  useEffectiveDomainContext: () => contextState,
}));
vi.mock('@/lib/knowledge/account-profile', () => ({
  useAccountProfile: () => accountProfileState,
}));
vi.mock('@/lib/evidence/ledger', () => ({
  readLedger: async () => {
    if (ledgerThrows) throw new Error('ledger unavailable');
    return {
      learnerKey: 'k',
      evidence: ledgerEvidence,
      signals: [],
      invalidations: [],
      giveUps: [],
    };
  },
  history: (ledger: { evidence: unknown[] }) => ledger.evidence,
}));
vi.mock('motion/react', () => ({ motion: { div: 'div' } }));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/skills',
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { default: SkillsPage } = await import('@/app/skills/skills-view');
type SkillMapData = import('@/app/skills/skills-view').SkillMapData;

const SKILL = 'Agent 记忆类型设计与 RAG 对比选型';

const job: JobSkills = {
  job_id: 'agent_engineer',
  title: 'AI Agent 开发工程师',
  summary: '测试岗位',
  core_concepts: ['agent_basics'],
  covered_count: 1,
  skills: [
    { skill: SKILL, covered: true, score: 0.7, source_id: 'ha08s01#s1', source_title: '教材' },
  ],
};

const snapshot = {
  exported_at: '2026-09-04T00:42:02.218Z',
  domain: 'ai',
  jobs: [job],
  corpora: [],
  market_stats: {},
  provenance: {},
} as unknown as SkillMapData & { exported_at: string };

const skillEvidence: JobSkillEvidence[] = [
  {
    skill: SKILL,
    courses: [{ courseId: 'txRsDW0aYs', title: '智能体记忆系统详解' }],
    concepts: ['agent_basics'],
    scenes: [{ sceneId: 'scene_b', courseId: 'txRsDW0aYs', courseTitle: '智能体记忆系统详解' }],
  },
];

const view = () => (
  <SkillsPage
    snapshot={snapshot}
    jobSkills={[
      {
        skill: SKILL,
        covered: true,
        courses: [{ title: '智能体记忆系统详解', courseId: 'txRsDW0aYs' }],
      },
    ]}
    skillEvidence={skillEvidence}
    jobId="agent_engineer"
  />
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PROJECT = {
  id: 'tiny-universe',
  name: 'tiny-universe',
  org: 'datawhale',
  level: 'starter',
  difficulty: 2,
  hours: '10h',
  jobIds: ['agent_engineer'],
  courseIds: ['txRsDW0aYs'],
  prereq: '',
  steps: [],
  cost: '0',
  networkNote: '',
  why: '',
  acceptance: '',
  deliverable: '',
  resumeAdvice: '',
  links: [],
  alternatives: [],
  firsthand: true,
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/classroom') return json({ classrooms: [] });
      if (url === '/api/practice-scout/ai') return json({ status: 'ready', projects: [PROJECT] });
      throw new Error(`unexpected ${url}`);
    }),
  );
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
  ledgerEvidence = [];
  ledgerThrows = false;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  stubFetch();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

/** 岗位卡默认折着，展开才看得到技能行与徽章。 */
async function openJobCard() {
  await act(async () => root.render(view()));
  await flush();
  await flush();
  const toggle = host.querySelector('button[aria-expanded]') as HTMLButtonElement;
  await act(async () => toggle.click());
  await flush();
}

describe('/skills 技能徽章', () => {
  it('未登录访客：不报错不空白，只说清楚登录后才按学习记录判定', async () => {
    accountProfileState = {
      kind: 'ready',
      source: 'anonymous-local',
      profile: { domain: 'ai', corpus: 'ai' },
    };
    await openJobCard();
    expect(host.textContent).toContain('登录后按你的学习记录判定');
    expect(host.textContent).toContain('不是能力认证');
    // 一枚徽章都不出：没有记录就不给状态。
    expect(host.textContent).not.toContain('学习证据 ');
    // 页面主体照常渲染。
    expect(host.textContent).toContain(SKILL);
  });

  it('登录后按真实记录判定：三条齐备就亮徽章，证据可点回原处', async () => {
    accountProfileState = {
      kind: 'ready',
      source: 'server',
      profile: {
        domain: 'ai',
        corpus: 'ai',
        conceptMasteryByDomain: { ai: { agent_basics: 0.95 } },
        conceptConfidenceByDomain: { ai: { agent_basics: 0.4 } },
        practiceProgress: {
          'ai/tiny-universe': { done: [1, 2], updatedAt: '2026-09-06T12:00:00.000Z' },
        },
      },
    };
    ledgerEvidence = [
      {
        id: 'e1',
        learnerKey: 'k',
        source: { interactionId: 'i1', resourceId: 'scene_b', at: '2026-09-05T08:00:00.000Z' },
        measured: { kind: 'concept', domain: 'ai', concept: 'agent_basics' },
        verdict: { outcome: 'correct', score: 0.9, because: { hit: [], missed: [] } },
        verdictScope: 'item-level',
        context: { encounter: 1, modality: 'quiz' },
      },
    ];
    await openJobCard();
    expect(host.textContent).toContain('学习证据 3/3 · 证据齐备');
    const links = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toContain('/classroom/txRsDW0aYs');
    expect(links).toContain('/practice/ai/tiny-universe');
  });

  it('账本读不到：那一条判不了，徽章不冒充达成', async () => {
    accountProfileState = {
      kind: 'ready',
      source: 'server',
      profile: {
        domain: 'ai',
        corpus: 'ai',
        conceptMasteryByDomain: { ai: { agent_basics: 0.95 } },
        conceptConfidenceByDomain: { ai: { agent_basics: 0.4 } },
        practiceProgress: {
          'ai/tiny-universe': { done: [1], updatedAt: '2026-09-06T12:00:00.000Z' },
        },
      },
    };
    ledgerThrows = true;
    await openJobCard();
    expect(host.textContent).toContain('学习证据 2/3 · 进行中');
    expect(host.textContent).toContain('读不到不等于没做过');
  });

  it('别的领域的掌握度不进本领域的判定', async () => {
    accountProfileState = {
      kind: 'ready',
      source: 'server',
      profile: {
        domain: 'ai',
        corpus: 'ai',
        conceptMasteryByDomain: { 'smart-manufacturing': { agent_basics: 0.99 } },
        conceptConfidenceByDomain: { 'smart-manufacturing': { agent_basics: 0.9 } },
      },
    };
    await openJobCard();
    expect(host.textContent).toContain('学习证据 0/3 · 未开始');
  });
});
