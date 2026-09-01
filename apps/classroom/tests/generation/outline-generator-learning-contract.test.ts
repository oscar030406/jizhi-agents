import { describe, expect, it, vi } from 'vitest';

import { generateSceneOutlinesFromRequirements } from '@/lib/generation/outline-generator';

const outlines = [
  {
    id: 's1',
    type: 'slide' as const,
    title: 'Activate and demonstrate',
    description: 'Elicit prior knowledge and show one worked example.',
    keyPoints: ['Prior knowledge', 'Worked example'],
    order: 1,
  },
  {
    id: 's2',
    type: 'interactive' as const,
    title: 'Practice and retry',
    description: 'Try a new input, inspect feedback, and retry.',
    keyPoints: ['Practice', 'Feedback', 'Retry'],
    order: 2,
    widgetType: 'game' as const,
    widgetOutline: { challenge: 'Complete a new case' },
  },
  {
    id: 's3',
    type: 'quiz' as const,
    title: 'Transfer assessment',
    description: 'Apply the skill to an unseen case.',
    keyPoints: ['Unseen case', 'Evidence'],
    order: 3,
    quizConfig: { questionCount: 1, difficulty: 'medium' as const, questionTypes: ['text'] },
  },
];

const contract = {
  objectives: [
    {
      id: 'O1',
      action: 'produce a grounded answer',
      condition: 'given an unseen question and the course corpus',
      successCriterion: 'the answer cites evidence or marks the claim uncertain',
    },
  ],
  prerequisiteActivation: ['s1'],
  demonstration: ['s1'],
  learnerPractice: ['s2'],
  feedbackRetry: ['s2'],
  transferApplication: ['s3'],
  assessmentMap: [{ sceneId: 's3', objectiveIds: ['O1'] }],
  grounding: { sourceRefs: ['corpus:ai'], claimPolicy: 'cite-or-mark-uncertain' },
};

describe('non-streaming outline LearningContract gate', () => {
  it('returns a validated contract from the same model response', async () => {
    const aiCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        languageDirective: 'Teach in English.',
        courseTitle: 'Grounded Answers',
        learningContract: contract,
        outlines,
      }),
    );

    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach grounded answering', learnerProfile: { corpus: 'ai' } },
      undefined,
      undefined,
      aiCall,
      { enforceLearningContract: true },
    );

    expect(result.success).toBe(true);
    expect(result.data?.learningContract).toEqual(contract);
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('blocks a structurally incomplete response without spending a repair model call', async () => {
    const aiCall = vi.fn().mockResolvedValue(
      JSON.stringify({
        languageDirective: 'Teach in English.',
        courseTitle: 'Slide Inventory',
        outlines: outlines.slice(0, 1),
      }),
    );

    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach grounded answering' },
      undefined,
      undefined,
      aiCall,
      { enforceLearningContract: true },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('learningContract is missing');
    expect(aiCall).toHaveBeenCalledTimes(1);
  });
});
