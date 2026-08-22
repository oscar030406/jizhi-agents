// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /skills 不许再被引擎的死活绑住。
 *
 * 这页原本 useEffect 里直连 /api/skills，而那条路由后面就是引擎——引擎冷启动约 60s、
 * 在服务端下线的时段里，访客看到的是「引擎离线，岗位技能地图不可用」。
 * 现在页面先读 public/skill-map.json（scripts/generate-skill-map-snapshot.mjs 落盘的
 * 快照），再后台请求引擎；请求失败就静默保持快照。
 *
 * 下面三条钉的就是这个次序：引擎全挂时正常渲染、引擎在线时数据会被换成实时的、
 * 两条路都空了才允许出空状态。
 */

vi.mock('motion/react', () => ({ motion: { div: 'div' } }));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => null }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { default: SkillsPage } = await import('@/app/skills/page');
const { CONCEPT_META } = await import('@/lib/knowledge/concept-labels');

const SNAPSHOT_PATH = join(process.cwd(), 'public', 'skill-map.json');
const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));

/** 引擎全挂：/api/skills 直接抛（连不上）。快照按需给或不给。 */
function stubFetch(handlers: Record<string, () => unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const key = Object.keys(handlers).find((k) => String(url).includes(k));
      if (!key) throw new Error(`未预期的请求：${url}`);
      return handlers[key]();
    }),
  );
}

const ok = (body: unknown) => () => ({ ok: true, status: 200, json: async () => body });
const dead = () => {
  throw new Error('ECONNREFUSED');
};
const noContent = () => ({ ok: false, status: 204, json: async () => null });

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function render(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root!: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<SkillsPage />);
  });
  await flush();
  await flush();
  return host;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('快照本身', () => {
  it('落盘产物有岗位、技能与生成时间', () => {
    expect(snapshot.jobs.length).toBeGreaterThan(0);
    expect(
      snapshot.jobs.reduce((n: number, j: { skills: unknown[] }) => n + j.skills.length, 0),
    ).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(snapshot.snapshot_at))).toBe(false);
  });
});

describe('引擎完全离线', () => {
  beforeEach(() => {
    stubFetch({ '/skill-map.json': ok(snapshot), '/api/skills': dead });
  });

  it('页面照常渲染岗位技能地图', async () => {
    const host = await render();
    expect(host.textContent).toContain(snapshot.jobs[0].title);
    expect(host.querySelectorAll('button[aria-expanded]')).toHaveLength(snapshot.jobs.length);
  });

  it('不出「读不到」空状态', async () => {
    const host = await render();
    expect(host.textContent).not.toContain('暂时读不到');
  });

  it('角落标出数据截至时间', async () => {
    const host = await render();
    expect(host.textContent).toContain('数据截至');
  });
});

describe('引擎在线', () => {
  it('后台刷新把快照换成引擎的实时数据，且不再标时间', async () => {
    const live = {
      ...snapshot,
      snapshot_at: undefined,
      jobs: [{ ...snapshot.jobs[0], title: '引擎实时返回的岗位' }],
    };
    stubFetch({ '/skill-map.json': ok(snapshot), '/api/skills': ok(live) });
    const host = await render();
    expect(host.textContent).toContain('引擎实时返回的岗位');
    expect(host.textContent).not.toContain('数据截至');
  });
});

describe('快照也没有', () => {
  it('两条路都空了才出空状态', async () => {
    stubFetch({ '/skill-map.json': noContent, '/api/skills': dead });
    const host = await render();
    expect(host.textContent).toContain('暂时读不到');
  });
});

/**
 * JD 技能提及率那张横条图的键就是引擎概念 id（`agent_basics`、`prompt_engineering`
 * 这种）。它此前被原样当界面标签上屏，还塞进了 title 属性。
 */
describe('概念 id 不当界面标签上屏', () => {
  it('技能提及率的条目印中文名，id 不出现在正文也不出现在 title 里', async () => {
    stubFetch({ '/skill-map.json': ok(snapshot), '/api/skills': dead });
    const host = await render();
    const shown = [
      host.textContent ?? '',
      ...[...host.querySelectorAll('[title]')].map((el) => el.getAttribute('title') ?? ''),
    ].join('\n');
    for (const [id, meta] of Object.entries(CONCEPT_META)) {
      if (!(id in (snapshot.market_stats?.skill_mention_share ?? {}))) continue;
      expect(shown).toContain(meta.label);
      expect(shown).not.toContain(id);
    }
  });
});
