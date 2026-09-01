import { describe, expect, it } from 'vitest';

import {
  applyEffectiveDomain,
  resolveEffectiveDomainContext,
} from '@/lib/knowledge/domain-context';
import { loadEffectiveDomainContext } from '@/lib/knowledge/use-domain-context';

const registry = {
  ai: { corpus: 'ai', label: 'ai', eligible: true },
  'smart-manufacturing': {
    corpus: 'smart-manufacturing',
    label: '智能制造：ROS2 与 S7-1200 PLC',
    eligible: true,
  },
};

describe('effective domain context', () => {
  it('AI 学员没有课程指派时维持画像领域', () => {
    const context = resolveEffectiveDomainContext({
      assignments: [],
      courseDomains: {},
      registry,
      profile: { domain: 'ai' },
    });

    expect(context).toMatchObject({
      domain: 'ai',
      source: 'profile-domain',
      status: 'ready',
      isAi: true,
    });
    expect(applyEffectiveDomain({ domain: 'ai', role: '学生' }, context)).toEqual({
      domain: 'ai',
      corpus: 'ai',
      role: '学生',
    });
  });

  it('智能制造课程指派覆盖残留的 AI 画像与 AI corpus', () => {
    const context = resolveEffectiveDomainContext({
      assignments: [
        {
          id: 'asg-mfg',
          courseId: 'course-mfg',
          title: 'ROS2 与 S7-1200 PLC',
          createdAt: '2026-08-31T12:00:00.000Z',
        },
      ],
      courseDomains: {
        'course-mfg': { domain: 'smart-manufacturing', title: 'ROS2 与 S7-1200 PLC' },
      },
      registry,
      profile: { domain: 'ai', corpus: 'ai' },
    });

    expect(context).toMatchObject({
      domain: 'smart-manufacturing',
      label: '智能制造：ROS2 与 S7-1200 PLC',
      source: 'course-assignment',
      status: 'ready',
      isAi: false,
      assignment: { id: 'asg-mfg', courseId: 'course-mfg' },
    });
    expect(applyEffectiveDomain({ domain: 'ai', corpus: 'ai', role: '学生' }, context)).toEqual({
      domain: 'smart-manufacturing',
      corpus: 'smart-manufacturing',
      role: '学生',
    });
  });

  it('课程归属表只给 corpus 时仍按该引擎语料域解析', () => {
    const context = resolveEffectiveDomainContext({
      assignments: [{ id: 'asg-mfg', courseId: 'course-mfg' }],
      courseDomains: { 'course-mfg': { corpus: 'smart-manufacturing' } },
      registry,
      profile: { domain: 'ai', corpus: 'ai' },
    });

    expect(context).toMatchObject({
      domain: 'smart-manufacturing',
      source: 'course-assignment',
      isAi: false,
    });
  });

  it('有课程指派但引擎尚未给出课程归属时阻断画像 AI 兜底', () => {
    const context = resolveEffectiveDomainContext({
      assignments: [{ id: 'asg-new', courseId: 'course-new', title: '新领域课程' }],
      courseDomains: {},
      registry,
      profile: { domain: 'ai', corpus: 'ai' },
    });

    expect(context.domain).toBeNull();
    expect(context.source).toBe('course-assignment');
    expect(context.status).toBe('missing-course-domain');
    expect(context.isAi).toBe(false);
    expect(context.reason).toContain('领域归属');
  });

  it('最新指派缺领域时不扫描旧 AI 指派兜底', () => {
    const context = resolveEffectiveDomainContext({
      assignments: [
        {
          id: 'asg-new-mfg',
          courseId: 'course-new-mfg',
          title: '新智能制造课',
          createdAt: '2026-09-01T12:00:00.000Z',
        },
        {
          id: 'asg-old-ai',
          courseId: 'course-old-ai',
          title: '旧 AI 课',
          createdAt: '2026-08-31T12:00:00.000Z',
        },
      ],
      courseDomains: { 'course-old-ai': { domain: 'ai' } },
      registry,
      profile: { domain: 'ai', corpus: 'ai' },
    });

    expect(context).toMatchObject({
      domain: null,
      source: 'course-assignment',
      status: 'missing-course-domain',
      assignment: { id: 'asg-new-mfg', courseId: 'course-new-mfg' },
    });
  });

  it('已知非 AI 课程域即使未进入域注册清单也不退回 AI', () => {
    const context = resolveEffectiveDomainContext({
      assignments: [{ id: 'asg-new', courseId: 'course-new', title: '新领域课程' }],
      courseDomains: { 'course-new': { domain: 'new-industry', title: '新领域课程' } },
      registry,
      profile: { domain: 'ai' },
    });

    expect(context).toMatchObject({
      domain: 'new-industry',
      source: 'course-assignment',
      status: 'unregistered',
      isAi: false,
    });
  });

  it('没有课程指派时显式 corpus 优先于画像 domain', () => {
    const context = resolveEffectiveDomainContext({
      assignments: [],
      courseDomains: {},
      registry,
      profile: { domain: 'ai', corpus: 'smart-manufacturing' },
    });

    expect(context).toMatchObject({
      domain: 'smart-manufacturing',
      source: 'profile-corpus',
      status: 'ready',
      isAi: false,
    });
  });
});

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('current-account domain context loader', () => {
  it('只消费当前账户接口返回的过滤后指派', async () => {
    const seen: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === '/api/org/assignments') {
        return response({
          success: true,
          assignments: [{ id: 'mine', courseId: 'course-mfg', title: '我的智能制造课' }],
        });
      }
      if (url === '/api/course-domains') {
        return response({
          'course-mfg': { domain: 'smart-manufacturing', title: '我的智能制造课' },
          'someone-else-ai': { domain: 'ai', title: '别人的 AI 课' },
        });
      }
      if (url === '/api/domains') return response({ entries: registry });
      throw new Error(`unexpected ${url}`);
    };

    const state = await loadEffectiveDomainContext(
      { domain: 'ai', corpus: 'ai' },
      fetcher as typeof fetch,
    );

    expect(seen).toEqual(['/api/org/assignments', '/api/course-domains', '/api/domains']);
    expect(state).toMatchObject({
      kind: 'ready',
      context: { domain: 'smart-manufacturing', source: 'course-assignment', isAi: false },
    });
  });

  it('AI 学员没有过滤后指派时保持 AI 行为', async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/org/assignments') return response({ success: true, assignments: [] });
      if (url === '/api/course-domains') return response({});
      if (url === '/api/domains') return response({ entries: registry });
      throw new Error(`unexpected ${url}`);
    };

    const state = await loadEffectiveDomainContext({ domain: 'ai' }, fetcher as typeof fetch);
    expect(state).toMatchObject({
      kind: 'ready',
      context: { domain: 'ai', source: 'profile-domain', isAi: true },
    });
  });

  it('当前账户指派接口异常时显式报错，不把未知账户当成无指派 AI 学员', async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/org/assignments') throw new Error('session store unavailable');
      if (url === '/api/course-domains') return response({});
      if (url === '/api/domains') return response({ entries: registry });
      throw new Error(`unexpected ${url}`);
    };

    const state = await loadEffectiveDomainContext({ domain: 'ai' }, fetcher as typeof fetch);
    expect(state.kind).toBe('error');
    expect(state).toHaveProperty('reason');
  });
});
