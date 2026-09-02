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
    objectiveIds: ['O1'],
  },
  {
    id: 's2',
    type: 'interactive' as const,
    title: 'Independent practice',
    description: 'Try a new input and submit an observable response.',
    keyPoints: ['Practice', 'Submit', 'Objective O1'],
    order: 2,
    teachingObjective: 'O1',
    widgetType: 'game' as const,
    widgetOutline: { challenge: 'Complete a new case' },
  },
  {
    id: 's3',
    type: 'interactive' as const,
    title: 'Feedback and retry',
    description: 'Inspect actionable feedback, revise the response, and retry.',
    keyPoints: ['Feedback', 'Revision', 'Retry'],
    order: 3,
    teachingObjective: 'O1',
    widgetType: 'game' as const,
    widgetOutline: { challenge: 'Revise the answer after feedback' },
  },
  {
    id: 's4',
    type: 'pbl' as const,
    title: 'Performance evidence',
    description: 'Produce a grounded answer for a complete unfamiliar task.',
    keyPoints: ['Goal', 'Product', 'Standards'],
    order: 4,
    teachingObjective: 'O1',
    pblConfig: {
      projectTopic: 'Grounded answer task',
      projectDescription: 'Produce and justify a grounded answer.',
      targetSkills: ['Evidence selection', 'Grounded writing'],
    },
  },
  {
    id: 's5',
    type: 'interactive' as const,
    title: 'Reflect and revise',
    description: 'Compare the product with the standard and revise it.',
    keyPoints: ['Reflection', 'Revision', 'Standards'],
    order: 5,
    teachingObjective: 'O1',
    widgetType: 'game' as const,
    widgetOutline: { challenge: 'Find the evidence gap and revise' },
  },
  {
    id: 's6',
    type: 'quiz' as const,
    title: 'Transfer assessment',
    description: 'Apply the skill to an unseen case.',
    keyPoints: ['Unseen case', 'Evidence'],
    order: 6,
    teachingObjective: 'O1',
    quizConfig: { questionCount: 1, difficulty: 'medium' as const, questionTypes: ['text'] },
  },
];

const contract = {
  teachingStrategy: 'ubd',
  strategyEvidence: {
    essentialQuestion: 'How can an answer remain trustworthy on an unseen question?',
    enduringUnderstanding: 'A trustworthy answer is constrained by traceable evidence.',
    performanceEvidence: 's4',
    reflectionRevision: 's5',
    transfer: 's6',
  },
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
  feedbackRetry: ['s3'],
  transferApplication: ['s6'],
  assessmentMap: [{ sceneId: 's6', objectiveIds: ['O1'] }],
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

  it('repairs one rejected teaching contract with the validator violations', async () => {
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          languageDirective: 'Teach in English.',
          courseTitle: 'Grounded Answers',
          learningContract: { ...contract, learnerPractice: ['s1'] },
          outlines,
        }),
      )
      .mockResolvedValueOnce(
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
    expect(aiCall).toHaveBeenCalledTimes(2);
    expect(aiCall.mock.calls[1][1]).toContain(
      'learnerPractice must reference an interactive or pbl scene',
    );
  });

  it('stops after one explicit repair when the response remains incomplete', async () => {
    const invalid = JSON.stringify({
      languageDirective: 'Teach in English.',
      courseTitle: 'Slide Inventory',
      outlines: outlines.slice(0, 1),
    });
    const aiCall = vi.fn().mockResolvedValue(invalid);

    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach grounded answering' },
      undefined,
      undefined,
      aiCall,
      { enforceLearningContract: true },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('after one quality revision');
    expect(result.error).toContain('learningContract is missing');
    expect(aiCall).toHaveBeenCalledTimes(2);
  });

  it('does not repair when the teaching-quality gate is disabled', async () => {
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
    );

    expect(result.success).toBe(true);
    expect(aiCall).toHaveBeenCalledTimes(1);
  });
});
