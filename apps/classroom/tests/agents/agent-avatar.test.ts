/**
 * Agent 拟人头像自测：七个 key 各渲染出一个带无障碍标签的 SVG。
 * 头像是纯展示组件，测「都画得出来」即可，不测像素。
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AgentAvatar,
  AGENT_PERSONAS,
  type AgentKey,
} from '@/components/agents/agent-avatar';

const KEYS = Object.keys(AGENT_PERSONAS) as AgentKey[];

describe('AgentAvatar', () => {
  it('正好七个拟人形象', () => {
    expect(KEYS).toHaveLength(7);
    expect(new Set(KEYS.map((k) => AGENT_PERSONAS[k].name)).size).toBe(7);
  });

  it.each(KEYS)('%s 渲染出 SVG 且带拟人名标签', (key) => {
    const html = renderToStaticMarkup(createElement(AgentAvatar, { agent: key, size: 32 }));
    expect(html).toContain('<svg');
    expect(html).toContain(`aria-label="${AGENT_PERSONAS[key].name}（${AGENT_PERSONAS[key].role} Agent）"`);
  });
});
