/**
 * 后补的屏必须跟这门课出自的库走，不跟浏览器此刻选的库走。
 *
 * ## 这条用例复现的是什么
 *
 * 一门课的后续屏是学习者翻页时才逐屏生成的。中间只要去别的域开过一门课，
 * localStorage 里的画像就换了，**回头补屏就跑在错的库上**。
 *
 * 2026-08-24 P4 走读实测（`juOtyfUKQ8`，iotdb 域的权限管理课）：
 * 第 4 屏的 `audit.corpus` 落盘写着 `'ai'`，证据是主语料的两块具身智能内容
 * （`em01s14#s2` 课程总结、`em01s24#s1` 正逆运动学）。仲裁自己判了
 * 「参考资料内容为 ROS2 参数系统、tf2 坐标变换、URDF 及正逆运动学，
 * 与权限机制毫无关联」——一门 iotdb 的课，拿主库的书来评。
 *
 * 下面按那次的时序造：课的出身是 iotdb，但浏览器画像已经换成了 ai。
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { SceneOutline } from '@/lib/types/generation';

const mocks = vi.hoisted(() => ({
  getCurrentModelConfig: vi.fn(),
  settingsState: vi.fn(),
  stageState: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock('@/lib/utils/model-config', () => ({
  getCurrentModelConfig: mocks.getCurrentModelConfig,
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settingsState },
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: mocks.stageState },
}));

vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ listAgents: mocks.listAgents }) },
}));

const mockFetch = vi.fn() as Mock;
vi.stubGlobal('fetch', mockFetch);

// 这套测试跑在 node 环境（默认），没有 localStorage。造一个最小存根就够——
// 被测那段只用 getItem，为一条用例把整个测试环境换成 jsdom 不划算。
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});
vi.stubGlobal('window', { localStorage });

const outline = {
  id: 'outline-1',
  type: 'slide',
  title: '权限生效机制：三步检查法',
  description: '讲清权限检查顺序',
  keyPoints: ['allowlist'],
  order: 4,
} as SceneOutline;

/** 浏览器里存着的画像——学习者中途去 ai 域开过课，所以这里是 ai。 */
const STALE_PROFILE = { domain: 'ai', education: 'bachelor', role: '转型学习者' };

function bodyOf(call: unknown[]): Record<string, unknown> {
  return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
}

describe('后补的屏跟课走，不跟浏览器此刻选的库走', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mocks.getCurrentModelConfig.mockReturnValue({});
    mocks.settingsState.mockReturnValue({
      imageProviderId: '',
      imageProvidersConfig: {},
      imageGenerationEnabled: false,
      videoProviderId: '',
      videoProvidersConfig: {},
      videoGenerationEnabled: false,
      ttsProviderId: '',
      ttsProvidersConfig: {},
    });
    mocks.listAgents.mockReturnValue([]);
    localStorage.setItem('learnerProfile', JSON.stringify(STALE_PROFILE));
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ success: true, data: {} }),
    });
  });

  it('课记了 corpus 时，判官那一路用课的 corpus，不用浏览器画像的 domain', async () => {
    mocks.stageState.mockReturnValue({
      stage: { origin: { corpus: 'iotdb', domain: 'software' } },
      scenes: [],
    });
    const { fetchSceneAudit } = await import('@/lib/hooks/use-scene-generator');
    await fetchSceneAudit({ outline, content: {}, stageId: 'stage-1' });

    const sent = bodyOf(mockFetch.mock.calls[0]) as {
      learnerProfile?: { corpus?: string; domain?: string };
    };
    expect(sent.learnerProfile?.corpus).toBe('iotdb');
    // domain 也按课记的走：混出「这门课的库 + 上一门课的域」这种组合，盘上从没存在过。
    expect(sent.learnerProfile?.domain).toBe('software');
    expect(sent.learnerProfile?.domain).not.toBe('ai');
  });

  it('课只记了 domain（没选库）时，用课的 domain 并把浏览器那份 corpus 清掉', async () => {
    localStorage.setItem(
      'learnerProfile',
      JSON.stringify({ ...STALE_PROFILE, corpus: 'smart-manufacturing' }),
    );
    mocks.stageState.mockReturnValue({ stage: { origin: { domain: 'ai' } }, scenes: [] });
    const { fetchSceneAudit } = await import('@/lib/hooks/use-scene-generator');
    await fetchSceneAudit({ outline, content: {}, stageId: 'stage-1' });

    const sent = bodyOf(mockFetch.mock.calls[0]) as {
      learnerProfile?: { corpus?: string; domain?: string };
    };
    expect(sent.learnerProfile?.domain).toBe('ai');
    // 留着上一门课的 corpus 会让 corpusOf 优先取它，等于课的出身被浏览器状态盖掉。
    expect(sent.learnerProfile?.corpus).toBeUndefined();
  });

  it('课没记出身（老课）时原样用浏览器画像，不硬造', async () => {
    mocks.stageState.mockReturnValue({ stage: {}, scenes: [] });
    const { fetchSceneAudit } = await import('@/lib/hooks/use-scene-generator');
    await fetchSceneAudit({ outline, content: {}, stageId: 'stage-1' });

    const sent = bodyOf(mockFetch.mock.calls[0]) as {
      learnerProfile?: { corpus?: string; domain?: string };
    };
    expect(sent.learnerProfile?.domain).toBe('ai');
  });
});
