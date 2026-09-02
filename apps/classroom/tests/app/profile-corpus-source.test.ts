import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('造课画像知识库来源', () => {
  it('只使用会话过滤的运行时接口，不读取公开快照', () => {
    const source = readFileSync('components/generation/learner-profile-popover.tsx', 'utf8');

    expect(source).toContain("fetch('/api/skills'");
    expect(source).not.toContain("'/skill-map.json'");
  });
});
