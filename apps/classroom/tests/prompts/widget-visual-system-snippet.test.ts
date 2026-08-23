import { describe, expect, test } from 'vitest';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

/**
 * 视觉设计系统（原 simulation-content 专属的 55 行：色数上限/对比度/中文字体栈/
 * 暗色/tabular-nums）抽成 snippets/widget-visual-system.md 后挂全六类。
 * 这条测试钉住「挂上了且真的展开了」——{{snippet:xxx}} 名字打错时 loader 不会报错，
 * 只会把字面量原样留在提示词里（静默回退病的提示词版）。
 */
const WIDGET_PROMPTS = [
  PROMPT_IDS.SIMULATION_CONTENT,
  PROMPT_IDS.DIAGRAM_CONTENT,
  PROMPT_IDS.CODE_CONTENT,
  PROMPT_IDS.GAME_CONTENT,
  PROMPT_IDS.VISUALIZATION3D_CONTENT,
  PROMPT_IDS.PROCEDURAL_SKILL_CONTENT,
] as const;

// 片段身体里的两句标志性内容：一句设计规则、一句中文字体栈
const MARKERS = ['NEVER use purple or violet', 'PingFang SC'];

describe('widget visual system snippet mounted across all six widget prompts', () => {
  for (const id of WIDGET_PROMPTS) {
    test(`${id} system prompt contains the shared visual design system`, () => {
      const prompts = buildPrompt(id, {});
      expect(prompts, `buildPrompt(${id}) returned null`).not.toBeNull();
      const system = prompts!.system;
      for (const marker of MARKERS) {
        expect(system, `${id} missing visual-system marker "${marker}"`).toContain(marker);
      }
      // 引用必须已展开——留着字面量说明 snippet 名不存在
      expect(system).not.toContain('{{snippet:widget-visual-system}}');
    });
  }
});
