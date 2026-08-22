// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  ProfileImpactPreview,
  profileImpact,
} from '@/components/generation/profile-impact-preview';
import type { LearnerProfileFields } from '@/lib/types/generation';

/**
 * 画像影响预览的两条不变量：
 * 1. **零 LLM 零请求**——预览是本地纯函数算的。这条红了说明有人为了让预览更好看
 *    去调了引擎，那就不再是「切一档立刻变」了。
 * 2. **切画像真的变**——两份差得最远的画像，预览文案必须不同。这条红了说明预览
 *    退化成了一段与画像无关的固定说明。
 */

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ZERO: LearnerProfileFields = {
  domain: 'ai',
  role: '非计算机专业转行',
  programming_level: 0,
  python_level: 0,
  agent_level: 0,
  rag_level: 0,
  engineering_level: 0,
};

const BACKEND: LearnerProfileFields = {
  domain: 'ai',
  role: '后端开发转 Agent 应用',
  programming_level: 3,
  python_level: 3,
  agent_level: 1,
  rag_level: 1,
  engineering_level: 3,
};

const ADVANCED: LearnerProfileFields = {
  ...BACKEND,
  agent_level: 3,
};

describe('profileImpact：确定性，且真的随画像变', () => {
  it('同一份画像两次调用逐字相同', () => {
    expect(profileImpact(ZERO)).toEqual(profileImpact(ZERO));
  });

  it('零基础 → 零基础姿态、代码有行数上限与结构闸', () => {
    const rows = profileImpact(ZERO);
    const tier = rows.find((r) => r.label === '讲解姿态')!;
    const code = rows.find((r) => r.label === '代码怎么写')!;
    expect(tier.value).toContain('零基础');
    expect(code.value).toContain('不超过 5 行');
    // beginnerCodeFormOnly：零基础档摘录里不许出现 import/def/class
    expect(code.value).toContain('挡掉');
  });

  it('后端转型 → 转行者姿态、代码不再设行数上限', () => {
    const rows = profileImpact(BACKEND);
    expect(rows.find((r) => r.label === '讲解姿态')!.value).toContain('转行者');
    expect(rows.find((r) => r.label === '代码怎么写')!.value).not.toContain('不超过');
  });

  it('有 Agent 实战经历 → 进阶姿态，例子换成生产场景', () => {
    const rows = profileImpact(ADVANCED);
    expect(rows.find((r) => r.label === '讲解姿态')!.value).toContain('进阶');
    expect(rows.find((r) => r.label === '例子取自')!.value).toContain('生产场景');
  });

  it('两份画像的预览至少有两行不一样（不是一段固定说明）', () => {
    const a = profileImpact(ZERO);
    const b = profileImpact(BACKEND);
    const differing = a.filter((row, i) => row.value !== b[i].value);
    expect(differing.length).toBeGreaterThanOrEqual(2);
  });

  it('知识库名走 domain-labels 真源，不上裸英文 id', () => {
    const rows = profileImpact({ ...BACKEND, corpus: 'odoo' });
    const corpusRow = rows.find((r) => r.label === '参考资料读')!;
    expect(corpusRow.value).toBe('企业管理系统 Odoo');
    expect(corpusRow.value).not.toBe('odoo');
  });
});

describe('ProfileImpactPreview 组件', () => {
  it('渲染不发任何网络请求（零 LLM 零等待）', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const host = document.createElement('div');
    document.body.appendChild(host);
    await act(async () => {
      createRoot(host).render(<ProfileImpactPreview profile={ZERO} />);
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="profile-impact"]')).not.toBeNull();
    expect(host.textContent).toContain('零基础');
    vi.unstubAllGlobals();
  });
});
