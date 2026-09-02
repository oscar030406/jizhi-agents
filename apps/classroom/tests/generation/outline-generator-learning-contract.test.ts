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
      issueCount: 3,
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

const vocationalOutlines = outlines.map((outline) => {
  if (outline.id === 's2') {
    return {
      ...outline,
      widgetType: 'procedural-skill' as const,
      widgetOutline: {
        task: 'Inspect the workcell before startup',
        steps: ['Confirm isolation', 'Inspect guarding', 'Record the result'],
        successCriteria: ['Unsafe conditions block startup', 'Inspection result is recorded'],
      },
    };
  }
  if (outline.id === 's4') {
    return {
      ...outline,
      type: 'quiz' as const,
      widgetType: undefined,
      widgetOutline: undefined,
      pblConfig: undefined,
      quizConfig: {
        questionCount: 1,
        difficulty: 'medium' as const,
        questionTypes: ['text'],
      },
    };
  }
  return outline;
});
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
    expect(aiCall.mock.calls[1][0]).toContain(
      'learnerPractice is a minimal contract map',
    );
    expect(aiCall.mock.calls[1][1]).toContain(
      'learnerPractice must reference a quiz, interactive, or pbl scene',
    );
  });

  it('sceneEvidenceProbe 判无证据的屏进入修订循环，修订后覆盖即通过', async () => {
    const draft = JSON.stringify({
      languageDirective: 'Teach in English.',
      courseTitle: 'Grounded Answers',
      learningContract: contract,
      outlines,
    });
    const aiCall = vi.fn().mockResolvedValue(draft);
    const probed: string[] = [];
    let firstS2 = true;
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach grounded answering', learnerProfile: { corpus: 'ai' } },
      undefined,
      undefined,
      aiCall,
      {
        enforceLearningContract: true,
        sceneEvidenceProbe: async (outline) => {
          probed.push(outline.id);
          // 第一份草稿里 s2 无证据；修订稿（同一 JSON，夹具简化）视为已覆盖
          if (outline.id === 's2' && firstS2) {
            firstS2 = false;
            return false;
          }
          return true;
        },
      },
    );
    // 一轮修订：违规文案点名 s2 无证据；修订稿探针全覆盖 → 成功
    expect(aiCall).toHaveBeenCalledTimes(2);
    expect(aiCall.mock.calls[1][1]).toContain('has no supporting evidence in the knowledge base');
    expect(aiCall.mock.calls[1][1]).toContain('s2');
    expect(probed.filter((id) => id === 's2')).toHaveLength(2);
    expect(result.success).toBe(true);
  });

  it('sceneEvidenceProbe 两轮修订后仍无证据则拒绝生成，错误列出该屏', async () => {
    const draft = JSON.stringify({
      languageDirective: 'Teach in English.',
      courseTitle: 'Grounded Answers',
      learningContract: contract,
      outlines,
    });
    const aiCall = vi.fn().mockResolvedValue(draft);
    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach grounded answering', learnerProfile: { corpus: 'ai' } },
      undefined,
      undefined,
      aiCall,
      {
        enforceLearningContract: true,
        sceneEvidenceProbe: async (outline) => outline.id !== 's2',
      },
    );
    expect(aiCall).toHaveBeenCalledTimes(4);
    expect(result.success).toBe(false);
    expect(result.error).toContain('after 3 quality revisions');
    expect(result.error).toContain('s2');
  });

  it('rejects impossible widget and PBL payloads before scene generation', async () => {
    const brokenOutlines = outlines.map((outline) =>
      outline.id === 's2'
        ? { ...outline, widgetType: 'drag_drop' }
        : outline.id === 's4'
          ? { ...outline, widgetType: 'diagram', pblConfig: undefined }
          : outline,
    );
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          languageDirective: 'Teach in English.',
          courseTitle: 'Grounded Answers',
          learningContract: contract,
          outlines: brokenOutlines,
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
    expect(aiCall.mock.calls[1][1]).toContain('interactive widgetType must be one of');
    expect(aiCall.mock.calls[1][1]).toContain('pbl scene must not include widgetType');
    expect(aiCall.mock.calls[1][1]).toContain('pblConfig must include');
  });

  it('uses the remaining validator violation for a second and final revision', async () => {
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
          learningContract: { ...contract, transferApplication: ['s3'] },
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
    expect(aiCall).toHaveBeenCalledTimes(3);
    expect(aiCall.mock.calls[2][1]).toContain(
      'transferApplication must reference a quiz or pbl scene',
    );
  });

  it('repeats task-engine structural invariants when revising a rejected vocational outline', async () => {
    const broken = vocationalOutlines.map((outline, index) =>
      index === 0
        ? {
            ...outline,
            type: 'interactive' as const,
            widgetType: 'game' as const,
            widgetOutline: { challenge: 'Start immediately' },
          }
        : outline,
    );
    const aiCall = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          languageDirective: 'Teach in English.',
          courseTitle: 'Workcell Inspection',
          learningContract: contract,
          outlines: broken,
        }),
      )
      .mockResolvedValue(
        JSON.stringify({
          languageDirective: 'Teach in English.',
          courseTitle: 'Workcell Inspection',
          learningContract: contract,
          outlines: vocationalOutlines,
        }),
      );

    const result = await generateSceneOutlinesFromRequirements(
      { requirement: 'Teach safe workcell inspection' },
      undefined,
      undefined,
      aiCall,
      { enforceLearningContract: true, outlineEngine: 'task-engine' },
    );

    expect(result.success, result.error).toBe(true);
    expect(aiCall.mock.calls[1][0]).toContain(
      'the first item in the outlines array must be a slide',
    );
    expect(aiCall.mock.calls[1][1]).toContain('vocational scene 1 must be a slide');
  });

  it('stops after two explicit revisions when the response remains incomplete', async () => {
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
    expect(result.error).toContain('after 3 quality revisions');
    expect(result.error).toContain('learningContract is missing');
    expect(aiCall).toHaveBeenCalledTimes(4);
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
