import { describe, expect, it } from 'vitest';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';

const OUTLINE_PROMPTS = [
  PROMPT_IDS.REQUIREMENTS_TO_OUTLINES,
  PROMPT_IDS.INTERACTIVE_OUTLINES,
  PROMPT_IDS.TASK_ENGINE_OUTLINES,
] as const;

describe('outline learning-contract prompt', () => {
  for (const promptId of OUTLINE_PROMPTS) {
    it(`${promptId} 要求同一次模型输出携带可机器校验的教学契约`, () => {
      const prompt = buildPrompt(promptId, {
        requirement: 'Teach a grounded course',
        pdfContent: 'None',
        availableImages: 'No images available',
        researchContext: 'None',
        teacherContext: '',
        userProfile: '',
        groundingRefs: ['corpus:ai'],
        hasSourceImages: false,
        imageEnabled: false,
        videoEnabled: false,
        mediaEnabled: false,
      });

      expect(prompt).not.toBeNull();
      const text = `${prompt!.system}\n${prompt!.user}`;
      expect(text).toContain('learningContract');
      expect(text).toContain('standard | ubd | feynman');
      expect(text).toContain('Enduring Understanding');
      expect(text).toContain('GRASPS');
      expect(text).toContain('WHERETO');
      expect(text).toContain('learner explains before any standard explanation');
      expect(text).toContain('1–2 smallest gaps');
      expect(text).toContain('analogy boundary');
      expect(text).toMatch(/unseen\s+situation/);
      expect(text).toContain('Never combine `ubd` and `feynman`');
      expect(text).toContain('essentialQuestion');
      expect(text).toContain('enduringUnderstanding');
      expect(text).toContain('performanceEvidence');
      expect(text).toContain('reflectionRevision');
      expect(text).toContain('learnerExplanation');
      expect(text).toContain('gapDiagnosis');
      expect(text).toContain('diagnosedGapCount');
      expect(text).toContain('plainLanguageRebuild');
      expect(text).toContain('analogyBoundary');
      expect(text).toContain('prerequisiteActivation');
      expect(text).toContain('demonstration');
      expect(text).toContain('learnerPractice');
      expect(text).toContain('feedbackRetry');
      expect(text).toContain('transferApplication');
      expect(text).toContain('assessmentMap');
      expect(text).toContain('successCriterion');
      expect(text).toContain('strict order');
      expect(text).toContain('quiz or PBL');
      expect(text).toContain('teachingObjective');
      expect(text).toContain('Every interactive or PBL practice scene');
      expect(text).toContain('collect learner input and visibly respond');
      expect(text).toContain('explicit completion criteria');
      expect(text).toContain('Plan in this order: objectives');
      expect(text).toContain('Complete cross-reference example');
      expect(text).toContain('corpus:ai');
      expect(text).not.toContain('{{groundingRefs}}');

      const exampleJson = prompt!.system.match(
        /### Complete cross-reference example[\s\S]*?```json\s*([\s\S]*?)```/,
      )?.[1];
      const example = JSON.parse(exampleJson!);
      expect(
        example.outlines.every(
          (outline: { objectiveIds?: string[] }) => outline.objectiveIds?.length,
        ),
      ).toBe(true);
    });
  }

  it('standard prompt does not contradict the four-key contract or omit scene mappings', () => {
    const prompt = buildPrompt(PROMPT_IDS.REQUIREMENTS_TO_OUTLINES, {
      requirement: 'Teach a grounded course',
      pdfContent: 'None',
      availableImages: 'No images available',
      researchContext: 'None',
      teacherContext: '',
      userProfile: '',
      groundingRefs: ['corpus:ai'],
      hasSourceImages: false,
      imageEnabled: false,
      videoEnabled: false,
      mediaEnabled: false,
    });

    expect(prompt).not.toBeNull();
    expect(prompt!.user).toContain('"learningContract"');
    expect(prompt!.user).toContain('"objectiveIds": ["O1"]');
    expect(prompt!.user).not.toContain('All three keys are required');
    expect(prompt!.user).not.toContain('default 15-30 minutes');
  });
});
