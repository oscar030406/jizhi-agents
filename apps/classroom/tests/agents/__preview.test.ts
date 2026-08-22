// 临时预览生成器（用完即删）：借 vitest 的编译管线把 7 个头像渲染成 HTML。
import { it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { writeFileSync } from 'fs';
import { AgentAvatar, AGENT_PERSONAS, type AgentKey } from '@/components/agents/agent-avatar';

it('write preview html', () => {
  const keys = Object.keys(AGENT_PERSONAS) as AgentKey[];
  const cells = keys
    .map((k) => {
      const svg = renderToStaticMarkup(createElement(AgentAvatar, { agent: k, size: 96 }));
      const p = AGENT_PERSONAS[k];
      return `<div style="text-align:center;width:170px">${svg}<div>${p.name} ${p.role}</div><div style="font-size:11px;opacity:.7">${p.motto}</div></div>`;
    })
    .join('');
  const vars = (m: Record<string, string>) =>
    Object.entries(m)
      .map(([k, v]) => `--${k}:${v}`)
      .join(';');
  const light = vars({
    'red-soft': '#fdebec',
    'red-deep': '#9f2f2d',
    'blue-soft': '#e1f3fe',
    'blue-deep': '#1f6c9f',
    'green-soft': '#edf3ec',
    'green-deep': '#346538',
    'yellow-soft': '#fbf3db',
    'yellow-deep': '#956400',
    'purple-soft': '#f1edf7',
    'purple-deep': '#5e4b8b',
  });
  const dark = vars({
    'red-soft': '#3a2426',
    'red-deep': '#e0a19f',
    'blue-soft': '#1c2b38',
    'blue-deep': '#8cc0e4',
    'green-soft': '#233027',
    'green-deep': '#a8c9ab',
    'yellow-soft': '#352e1c',
    'yellow-deep': '#d4ac57',
    'purple-soft': '#2b2438',
    'purple-deep': '#c2b1de',
  });
  writeFileSync(
    'C:/Users/oscar/AppData/Local/Temp/claude/D--UserData-Desktop----/a48e8649-adab-40bb-8ef6-24ae85b138ef/scratchpad/avatars.html',
    `<div style="${light};background:#fff;padding:16px;display:flex;flex-wrap:wrap;gap:8px;font:13px sans-serif">${cells}</div>` +
      `<div style="${dark};background:#191919;color:#ddd;padding:16px;display:flex;flex-wrap:wrap;gap:8px;font:13px sans-serif">${cells}</div>`,
  );
});
