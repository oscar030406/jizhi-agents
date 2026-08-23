import { describe, expect, it } from 'vitest';
import {
  buildMarkdown,
  buildScriptFileName,
  collectSceneScripts,
} from '@/lib/export/use-export-script';
import type { Scene } from '@/lib/types/stage';

const fallback = (order: number) => `幻灯片 ${order + 1}`;

function scene(partial: Record<string, unknown>): Scene {
  return { id: 's', stageId: 'st', title: '', order: 0, type: 'slide', ...partial } as Scene;
}

describe('collectSceneScripts', () => {
  it('concatenates speech text in action order, skips non-speech and blank speech', () => {
    const scenes = [
      scene({
        id: 's1',
        title: '导论',
        order: 0,
        actions: [
          { type: 'speech', text: ' 第一句。 ' },
          { type: 'wb.open' },
          { type: 'speech', text: '' },
          { type: 'speech', text: '第二句。' },
        ],
      }),
    ];
    expect(collectSceneScripts(scenes, fallback)).toEqual([
      { sceneId: 's1', sceneTitle: '导论', sceneOrder: 0, text: '第一句。\n第二句。' },
    ]);
  });

  it('omits scenes with no speech text and falls back for empty titles', () => {
    const scenes = [
      scene({ id: 's1', order: 0, actions: [{ type: 'wb.open' }] }),
      scene({ id: 's2', order: 1, actions: [{ type: 'speech', text: '有话说' }] }),
      scene({ id: 's3', order: 2 }), // no actions at all
    ];
    const out = collectSceneScripts(scenes, fallback);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sceneId: 's2', sceneTitle: '幻灯片 2' });
  });
});

describe('buildMarkdown', () => {
  it('escapes heading injection in stage and scene titles', () => {
    const md = buildMarkdown('# 恶意课程', [
      { sceneId: 's1', sceneTitle: '\n# Injected', sceneOrder: 0, text: 'line1\n\nline2' },
    ]);
    expect(md.startsWith('# \\# 恶意课程')).toBe(true);
    expect(md).toContain('## \\# Injected');
    expect(md).toContain('line1');
    expect(md).toContain('line2');
    expect(md).not.toMatch(/\n{3,}/);
  });
});

describe('buildScriptFileName', () => {
  it('strips illegal characters and falls back when empty', () => {
    expect(buildScriptFileName('My: Course/Name')).toBe('My-CourseName-script.md');
    expect(buildScriptFileName('///:::')).toBe('script.md');
  });
});
