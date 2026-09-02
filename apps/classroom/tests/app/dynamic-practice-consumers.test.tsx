// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PracticeLoadState, PracticeProject } from '@/components/skills/practice-projects';
import type { Scene } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  hookCalls: [] as Array<string | null>,
  stateByCorpus: {} as Record<string, PracticeLoadState>,
  courseDomains: {} as Record<string, { corpus?: string; domain?: string }>,
  scenes: [] as Scene[],
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('rough-notation', () => ({
  annotate: () => ({ show: vi.fn(), remove: vi.fn() }),
}));
vi.mock('@/components/account/account-menu', () => ({ AccountMenu: () => null }));
vi.mock('@/components/slide-renderer/components/element/TextElement/ExcerptBlock', () => ({
  parseExcerptFromHtml: () => null,
  ExcerptBlockView: () => null,
}));
vi.mock('@/lib/knowledge/use-course-domains', () => ({
  useCourseDomains: () => mocks.courseDomains,
}));
vi.mock('@/lib/store', () => ({
  useStageStore: (select: (state: { scenes: Scene[] }) => unknown) =>
    select({ scenes: mocks.scenes }),
}));
vi.mock('@/components/skills/practice-projects', () => ({
  usePublishedPractice: (corpus: string | null) => {
    mocks.hookCalls.push(corpus);
    return corpus
      ? (mocks.stateByCorpus[corpus] ?? { kind: 'missing', reason: '尚未发布' })
      : { kind: 'missing', reason: '课程领域尚未确认' };
  },
  projectsForCourse: (projects: PracticeProject[], courseId: string) =>
    projects.filter((project) => project.courseIds.includes(courseId)),
  featuredProjects: (projects: PracticeProject[]) => projects,
  PracticeCard: ({ project }: { project: PracticeProject }) => project.name,
}));

const { PracticeHighlights } = await import('@/components/home/practice-highlights');
const { PublicLanding } = await import('@/components/home/public-landing');
const { LectureSceneView } = await import('@/components/scene-renderers/lecture-scene-view');

const project = (id: string, name: string, courseId: string): PracticeProject => ({
  id,
  name,
  org: '真实开源仓库',
  level: 'starter',
  difficulty: 2,
  hours: '3 小时',
  jobIds: [],
  courseIds: [courseId],
  prereq: '完成对口课程',
  steps: ['拉取仓库', '运行基线', '完成改造'],
  cost: '免费',
  networkNote: '',
  why: '把课程知识用于真实代码',
  acceptance: '测试全部通过并提交产物',
  deliverable: '代码与实验报告',
  resumeAdvice: '说明问题、改造和结果',
  links: [{ label: '仓库', url: 'https://github.com/example/repo' }],
  alternatives: [],
  firsthand: true,
});

const scene = (id: string, courseId: string): Scene =>
  ({
    id,
    stageId: courseId,
    type: 'slide',
    title: id,
    order: 0,
    content: { elements: [] },
  }) as unknown as Scene;

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.hookCalls.length = 0;
  mocks.stateByCorpus = {};
  mocks.courseDomains = {};
  mocks.scenes = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('动态实操项目消费链', () => {
  it('公共首页固定读取 AI 发布结果，不导入旧静态项目，并展示步骤、验收和真实总数', () => {
    const aiProject = project('ai-live', 'AI 动态项目', 'ai-course');
    mocks.stateByCorpus.ai = { kind: 'ready', projects: [aiProject] };

    const html = renderToStaticMarkup(<PublicLanding />);
    const sources = [
      'components/home/public-landing.tsx',
      'components/home/practice-highlights.tsx',
    ].map((file) => readFileSync(join(process.cwd(), file), 'utf8'));

    expect(mocks.hookCalls).toContain('ai');
    expect(sources.join('\n')).not.toContain('@/data/practice-projects.json');
    expect(sources[0]).not.toContain('@/data/learning-path.json');
    expect(html).toContain('正在读取引擎生成的当前领域路径');
    expect(html).toContain('全部 1 个实操项目');
    expect(html).toContain('拉取仓库');
    expect(html).toContain('运行基线');
    expect(html).toContain('完成改造');
    expect(html).toContain('测试全部通过并提交产物');
  });

  it('首页从 ready 切到 unavailable 后立即移除旧项目并显示真实故障状态', async () => {
    const aiProject = project('ai-old', '不应残留的旧项目', 'ai-course');
    await act(async () =>
      root.render(<PracticeHighlights state={{ kind: 'ready', projects: [aiProject] }} />),
    );
    expect(host.textContent).toContain(aiProject.name);

    await act(async () =>
      root.render(
        <PracticeHighlights state={{ kind: 'unavailable', reason: '实操项目服务暂时不可用' }} />,
      ),
    );
    expect(host.textContent).not.toContain(aiProject.name);
    expect(host.textContent).toContain('实操项目服务暂时不可用');
  });

  it('智能制造课程末页只读取本课 corpus，不请求或闪现 AI 项目', async () => {
    const first = scene('sm-first', 'sm-course');
    const last = scene('sm-last', 'sm-course');
    mocks.scenes = [first, last];
    mocks.courseDomains = { 'sm-course': { corpus: 'smart-manufacturing' } };
    mocks.stateByCorpus['smart-manufacturing'] = {
      kind: 'ready',
      projects: [
        project('ai-other', 'AI 跨域项目', 'ai-course'),
        project('sm-live', '智能制造动态项目', 'sm-course'),
      ],
    };

    await act(async () => root.render(<LectureSceneView scene={last} />));

    expect(mocks.hookCalls).toContain('smart-manufacturing');
    expect(mocks.hookCalls).not.toContain('ai');
    expect(host.textContent).toContain('智能制造动态项目');
    expect(host.textContent).not.toContain('AI 跨域项目');
    expect(host.querySelector('[data-testid="course-practice-block"]')).not.toBeNull();
  });

  it('非末页不请求项目；末页失败后不保留上一轮项目', async () => {
    const first = scene('sm-first', 'sm-course');
    const last = scene('sm-last', 'sm-course');
    mocks.scenes = [first, last];
    mocks.courseDomains = { 'sm-course': { corpus: 'smart-manufacturing' } };
    mocks.stateByCorpus['smart-manufacturing'] = {
      kind: 'ready',
      projects: [project('sm-old', '不应残留的智能制造项目', 'sm-course')],
    };

    await act(async () => root.render(<LectureSceneView scene={first} />));
    expect(mocks.hookCalls).toContain(null);
    expect(mocks.hookCalls).not.toContain('smart-manufacturing');
    expect(host.textContent).not.toContain('不应残留的智能制造项目');

    mocks.hookCalls.length = 0;
    await act(async () => root.render(<LectureSceneView scene={last} />));
    expect(host.textContent).toContain('不应残留的智能制造项目');

    mocks.stateByCorpus['smart-manufacturing'] = {
      kind: 'unavailable',
      reason: '本领域实操项目状态暂时不可用',
    };
    await act(async () => root.render(<LectureSceneView scene={last} />));
    expect(host.textContent).not.toContain('不应残留的智能制造项目');
    expect(host.textContent).toContain('本领域实操项目状态暂时不可用');
  });
});
