// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * /report 的「重新计算」按钮：提示必须绑在 /api/adaptive/blueprint 的真实返回上。
 *
 * 病灶：按钮里挂了一个固定 900ms 的 setTimeout 弹「已按当前画像重新计算」，
 * 跟接口返回没关系。引擎挂起时（lib/generation/learner-profile.ts 的
 * FETCH_TIMEOUT_MS = 25_000）用户 0.9 秒看到绿色成功，再等最长 25 秒才看到「引擎离线」。
 * 这里钉三件事：请求还没回来时不许弹提示、成功只弹一次成功、失败弹的是失败。
 */

const toastMock = { success: vi.fn(), error: vi.fn(), warning: vi.fn() };

vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('motion/react', () => ({ motion: { div: 'div' } }));
vi.mock('@number-flow/react', () => ({ default: () => null }));
vi.mock('@/components/site-header', () => ({ SiteHeader: () => null }));
vi.mock('@/components/report/evidence-trajectory-chart', () => ({
  EvidenceTrajectoryChart: () => null,
}));
vi.mock('@/lib/knowledge/use-domain-context', () => ({
  loadEffectiveDomainContext: async () => ({
    kind: 'ready',
    context: {
      domain: 'ai',
      label: '人工智能',
      source: 'profile-domain',
      status: 'ready',
      isAi: true,
      registered: true,
    },
    courseDomains: { s1: { domain: 'ai', corpus: 'ai' } },
  }),
}));
vi.mock('@/lib/utils/stage-storage', () => ({
  listStages: async () => [{ id: 's1', name: '测试课' }],
  loadStageData: async () => ({
    stage: { id: 's1', name: '测试课' },
    scenes: [],
    outline: { outlines: [] },
  }),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { default: ReportPage } = await import('@/app/report/page');

/** 把已排队的微任务放干净。 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

let host: HTMLElement;
let root: Root;

const profileResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ fields: { domain: 'ai', role: '学生' } }),
});

const unavailableResponse = () => ({
  ok: false,
  status: 503,
  json: async () => ({}),
});

function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
  if (!found) throw new Error(`没找到按钮：${label}`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  toastMock.warning.mockClear();
  window.localStorage.setItem('learnerProfile', JSON.stringify({ domain: 'ai', role: '学生' }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  window.localStorage.clear();
});

describe('/report 重新计算', () => {
  it('请求挂起时不弹提示，成功返回后才弹一次成功', async () => {
    let release: (res: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/profile') return Promise.resolve(profileResponse());
        if (url === '/api/adaptive/blueprint') {
          return new Promise((resolve) => (release = resolve));
        }
        if (url === '/api/domain-path/ai') return Promise.resolve(unavailableResponse());
        throw new Error(`未预期的请求：${url}`);
      }),
    );

    await act(async () => root.render(<ReportPage />));
    await flush();
    // 首次加载不弹提示。
    expect(toastMock.success).not.toHaveBeenCalled();

    act(() => button('重新计算').click());
    expect(button('计算中…').disabled).toBe(true);

    // 老实现在这里已经弹过成功了（900ms 定时器）。现在请求没回来就什么都不弹。
    await new Promise((r) => setTimeout(r, 1000));
    await flush();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();

    await act(async () => {
      release({
        ok: true,
        status: 200,
        json: async () => ({
          blueprint: {
            mastery_vector: { rag: 0.4 },
            weak_concepts: ['rag'],
            recommended_difficulty: 'L2',
            diagnosis_summary: '测试',
            learning_risks: [],
          },
        }),
      });
      await Promise.resolve();
    });
    await flush();

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(button('重新计算').disabled).toBe(false);

    vi.unstubAllGlobals();
  });

  it('等待期间显示四张骨架卡，数据到了就换成真卡', async () => {
    // 病灶：blueprint 到达前整块不渲染，到达后凭空插一行卡把下面全推下去。
    let release: (res: unknown) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/profile') return Promise.resolve(profileResponse());
        if (url === '/api/adaptive/blueprint') {
          return new Promise((resolve) => (release = resolve));
        }
        if (url === '/api/domain-path/ai') return Promise.resolve(unavailableResponse());
        throw new Error(`未预期的请求：${url}`);
      }),
    );
    await act(async () => root.render(<ReportPage />));
    await flush();
    expect(host.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(4);
    expect(host.textContent).toContain('覆盖概念数');

    await act(async () => {
      release({
        ok: true,
        status: 200,
        json: async () => ({
          blueprint: {
            mastery_vector: { rag: 0.4 },
            weak_concepts: ['rag'],
            recommended_difficulty: 'L2',
            diagnosis_summary: '测试',
            learning_risks: [],
          },
        }),
      });
      await Promise.resolve();
    });
    await flush();
    expect(host.querySelectorAll('.animate-pulse').length).toBe(0);
    expect(host.textContent).toContain('覆盖概念数');

    vi.unstubAllGlobals();
  });

  it('引擎离线时骨架卡必须消失——不许永久假装数据在路上', async () => {
    // 这一条钉的是判据本身：条件写成 bp === null 也能让上面那条用例过，
    // 但 offline / no-profile / no-course 三个终态下 bp 同样是 null，
    // 骨架卡会永远停在那里。所以判据必须是 bpState.kind === 'loading'。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/profile') return profileResponse();
        if (url === '/api/adaptive/blueprint') {
          return unavailableResponse();
        }
        if (url === '/api/domain-path/ai') return unavailableResponse();
        throw new Error(`未预期的请求：${url}`);
      }),
    );
    await act(async () => root.render(<ReportPage />));
    await flush();

    expect(host.querySelectorAll('.animate-pulse').length).toBe(0);

    vi.unstubAllGlobals();
  });

  it('引擎返回非 2xx 时弹的是失败，不是成功', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/profile') return profileResponse();
        if (url === '/api/adaptive/blueprint') {
          return unavailableResponse();
        }
        if (url === '/api/domain-path/ai') return unavailableResponse();
        throw new Error(`未预期的请求：${url}`);
      }),
    );

    await act(async () => root.render(<ReportPage />));
    await flush();
    act(() => button('重新计算').click());
    await flush();

    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    expect(button('重新计算').disabled).toBe(false);

    vi.unstubAllGlobals();
  });
});
