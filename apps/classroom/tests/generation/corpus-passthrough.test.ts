// @vitest-environment jsdom
/**
 * 换库生成的三条口径：语料名解析、生成前拦截、判官与正文同源。
 *
 * 第三条是本组的重点。判官这一路此前六个调用点没有一个传语料库名，于是无论正文
 * 接地在哪个库上，判官都读默认（ai）语料——换库生成的课被另一本书判幻觉。
 * 这里测的是「客户端到底发没发这个字段」，因为坏就坏在请求体里少一个键，
 * 服务端代码本身一直是对的。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { corpusOf, domainLabel } from '@/lib/generation/learner-profile';
import { corpusUnavailableReason } from '@/lib/server/knowledge-center';

describe('corpusOf', () => {
  it('显式选的库优先', () => {
    expect(corpusOf({ corpus: 'odoo', domain: 'ai' })).toBe('odoo');
  });

  it('没选就沿用培训领域——旧画像行为逐字节不变', () => {
    expect(corpusOf({ domain: 'manufacturing' })).toBe('manufacturing');
    expect(corpusOf({ corpus: '   ', domain: 'ai' })).toBe('ai');
    expect(corpusOf({})).toBeUndefined();
    expect(corpusOf(undefined)).toBeUndefined();
  });
});

describe('domainLabel', () => {
  it('四个建制领域给中文名', () => {
    expect(domainLabel('ai')).toBe('人工智能应用开发');
    expect(domainLabel('industrial-internet')).toBe('工业互联网');
  });

  it('盘上已接入的语料给中文名', () => {
    // 原先这张表只有四个培训领域，iotdb/odoo/pv-ops 一律裸英文上屏。
    expect(domainLabel('iotdb')).toBe('时序数据库 IoTDB');
    expect(domainLabel('odoo')).toBe('企业管理系统 Odoo');
    expect(domainLabel('pv-ops')).toBe('光伏电站运维');
  });

  it('表外语料回自己的名字，不冒充「人工智能应用开发」', () => {
    // /skills 的语料卡拿这个函数当标题。语料 id 是开放集（接入 Agent 随时能造新库），
    // 兜底到 ai 会让每张还没登记中文名的语料卡都贴成人工智能。
    for (const corpus of ['brand-new-corpus', 'whatever-the-agent-made']) {
      expect(domainLabel(corpus)).toBe(corpus);
    }
  });

  it('真没传值才用 ai——老调用点的既有默认不动', () => {
    expect(domainLabel(undefined)).toBe('人工智能应用开发');
    expect(domainLabel('')).toBe('人工智能应用开发');
  });
});

describe('未建库拦截', () => {
  it('没显式选库一律放行（含只填了培训领域的旧画像）', async () => {
    expect(await corpusUnavailableReason(undefined)).toBeNull();
    expect(await corpusUnavailableReason('')).toBeNull();
  });

  it('库名不合法当场拒绝（语料名要进路径）', async () => {
    expect(await corpusUnavailableReason('../etc/passwd')).toContain('不合法');
  });

  it('选了没建索引的库要拦住并说清楚拦在哪一步', async () => {
    const reason = await corpusUnavailableReason('nosuchcorpus');
    expect(reason).toContain('nosuchcorpus');
    expect(reason).toContain('knowledge_index.jsonl');
  });
});

describe('判官读的是正文那本书', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ success: true }),
        text: async () => JSON.stringify({ success: true }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const callAudit = async () => {
    const { fetchSceneAudit } = await import('@/lib/hooks/use-scene-generator');
    await fetchSceneAudit({
      outline: { id: 'o1', title: '测试场景', type: 'slide', order: 0 } as never,
      content: {},
      stageId: 's1',
      courseTitle: '测试课',
    });
    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]?.[1] as { body: string }).body,
    ) as { learnerProfile?: { corpus?: string; domain?: string } };
    return body;
  };

  it('画像里选了 odoo，审核请求就带着 odoo 走', async () => {
    window.localStorage.setItem("learnerProfile", JSON.stringify({ domain: "ai", corpus: "odoo" }));
    expect((await callAudit()).learnerProfile).toEqual({ domain: 'ai', corpus: 'odoo' });
  });

  it('没有画像时不多发字段——服务端照旧读默认语料', async () => {
    expect((await callAudit()).learnerProfile).toBeUndefined();
  });
});

/**
 * 第 2 页起也得读同一本书。
 *
 * 首页只生成第 1 页就跳课堂，剩下的页由课堂页续跑，而那里的 requirements 是就地
 * 新建的（只带 requirement + taskEngineMode）——画像连同 corpus 一起丢了。
 * 症状正是「换了知识库，生成出来没有任何变化」：变的只有第 1 页。
 */
describe('正文每一页都带着画像走', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ success: true, content: {} }),
        text: async () => JSON.stringify({ success: true, content: {} }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const callContent = async (requirements?: unknown) => {
    const { fetchSceneContent } = await import('@/lib/hooks/use-scene-generator');
    await fetchSceneContent({
      outline: { id: 'o2', title: '第二页', type: 'slide', order: 1 } as never,
      allOutlines: [],
      stageId: 's1',
      stageInfo: { name: '测试课' },
      ...(requirements ? { requirements: requirements as never } : {}),
    });
    return JSON.parse((vi.mocked(fetch).mock.calls[0]?.[1] as { body: string }).body) as {
      requirements?: { requirement?: string; learnerProfile?: { corpus?: string } };
    };
  };

  it('课堂页续跑不带画像时，用本地存的那份补上（换库对第 2 页起也生效）', async () => {
    window.localStorage.setItem(
      'learnerProfile',
      JSON.stringify({ domain: 'ai', corpus: 'odoo', programming_level: 1 }),
    );
    const body = await callContent({ requirement: '测试课', taskEngineMode: false });
    expect(body.requirements?.learnerProfile?.corpus).toBe('odoo');
    // 续跑那边算职教闸门要用的字段不能被覆盖掉
    expect(body.requirements?.requirement).toBe('测试课');
  });

  it('调用方显式带了画像就不覆盖（首页首场景走的是当次融合过的画像）', async () => {
    window.localStorage.setItem('learnerProfile', JSON.stringify({ corpus: 'odoo' }));
    const body = await callContent({
      requirement: '测试课',
      learnerProfile: { corpus: 'iotdb' },
    });
    expect(body.requirements?.learnerProfile?.corpus).toBe('iotdb');
  });

  it('本地没有画像就不凭空造一个', async () => {
    const body = await callContent({ requirement: '测试课' });
    expect(body.requirements?.learnerProfile).toBeUndefined();
  });
});
