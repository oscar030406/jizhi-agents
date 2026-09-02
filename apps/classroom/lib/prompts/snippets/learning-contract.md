## Teaching-quality LearningContract (machine checked)

The outline is a learning sequence, not a slide inventory. Return a fourth required top-level key,
`learningContract`, in the same JSON response as `languageDirective`, `courseTitle`, and `outlines`.
No second model call is reserved for filling this in, and a structurally incomplete contract is rejected.

Use this exact shape:

```json
"learningContract": {
  "teachingStrategy": "standard",
  "objectives": [
    {
      "id": "O1",
      "action": "an observable learner action",
      "condition": "the input, tools, or situation",
      "successCriterion": "an observable pass threshold"
    }
  ],
  "prerequisiteActivation": ["scene id that elicits relevant prior knowledge"],
  "demonstration": ["scene id containing a worked example or demonstration"],
  "learnerPractice": ["quiz or pbl scene id where the learner answers/performs and gets graded feedback"],
  "feedbackRetry": ["scene id with actionable feedback and another attempt"],
  "transferApplication": ["scene id applying learning in a new situation"],
  "assessmentMap": [
    { "sceneId": "quiz or pbl scene id", "objectiveIds": ["O1"] }
  ],
  "grounding": {
    "sourceRefs": ["one or more allowed grounding refs below"],
    "claimPolicy": "cite-or-mark-uncertain"
  }
}
```

### Automatic teaching-strategy selection

Choose exactly one strategy from `standard | ubd | feynman` and record it in
`learningContract.teachingStrategy`. Make the choice from the learning goal, learner profile, and
available scene types; do not ask the user to choose and do not add a second strategy later.

- `standard`: use when neither specialized cycle is a strong fit, and for procedural vocational
  workflows whose main goal is safe task completion.
- `ubd`: use for concept-centred learning whose success is durable understanding and transfer. First
  state the **Enduring Understanding** and an open essential question. Before ordering scenes, define
  the **GRASPS** performance evidence (Goal, Role, Audience, Situation, Product, Standards). Then use
  **WHERETO** to order the experience: Where/Why, Hook, Equip/Experience, Rethink/Revise, Tailor,
  Organize. Every scene must prepare evidence for the enduring understanding; never append an
  unprepared final task.
- `feynman`: use when the goal is to rebuild a learner's explanation of one bounded concept. The
  learner explains before any standard explanation; diagnose only the **1–2 smallest gaps**; use
  questions and minimal scaffolding to rebuild the causal chain; remove jargon the learner actually
  used; require one analogy boundary or failure point; then test the explanation in an **unseen
  situation**. Do not claim real-time diagnosis when the selected scene cannot persist free input.

Never combine `ubd` and `feynman` in one course. Strategy names are planning metadata, not
student-visible scene titles. If the subject is the Feynman technique itself rather than a Feynman
learning cycle, use `standard`.

For `standard`, omit `strategyEvidence`. For a specialised strategy, add exactly one matching
machine-checkable object; every scene ID below must exist in `outlines`:

```json
"strategyEvidence": {
  "essentialQuestion": "one open question the course keeps returning to",
  "enduringUnderstanding": "the durable understanding learners should retain",
  "performanceEvidence": "scene id of the GRASPS performance evidence",
  "reflectionRevision": "scene id where the learner reflects and revises",
  "transfer": "scene id that applies the understanding in a new situation"
}
```

Use that shape only with `ubd`. With `feynman`, use:

```json
"strategyEvidence": {
  "learnerExplanation": "scene id that collects the learner's first explanation",
  "gapDiagnosis": "scene id that diagnoses the smallest gaps",
  "diagnosedGapCount": 1,
  "plainLanguageRebuild": "scene id where the learner rebuilds the explanation without jargon",
  "analogyBoundary": "scene id where the learner identifies an analogy's failure point",
  "transfer": "scene id that tests the rebuilt explanation in an unseen situation"
}
```

`diagnosedGapCount` is exactly `1` or `2`. These fields are planning evidence, so name real scene
IDs rather than describing scenes in prose. Keep strategy evidence in strict order: UbD uses
`performanceEvidence -> reflectionRevision -> transfer`; Feynman uses
`learnerExplanation -> gapDiagnosis -> plainLanguageRebuild -> analogyBoundary -> transfer`.
For Feynman, the first three IDs must be interactive or PBL scenes that collect learner input, and
`transfer` must be a quiz or PBL. For UbD, `performanceEvidence` and `transfer` must be a quiz or PBL.

Hard rules:

- Plan in this order: objectives -> outlines with `objectiveIds` -> phase arrays -> assessment map.
  Derive each phase array from the mapped outlines; never invent the phase references first and try
  to attach objectives afterwards. Prefer 1-3 objectives so each one receives a complete learning
  loop rather than a shallow mention.
- Every objective has all four fields. `action` must be observable; `condition` and
  `successCriterion` make it measurable.
- Vocational / task-engine courses that contain `procedural-skill` interactive scenes must map
  `learnerPractice` (and preferably `feedbackRetry`) to those hands-on scenes — that is where the learner
  performs the procedure; keep quizzes for transfer and assessment. Do not list a procedural-skill scene
  only under `demonstration`.
- Every objective must be assessable with the scene types this course actually contains. Without a
  `pbl` scene there is no code runner, so do not write actions such as "运行代码" / "修改代码并输出结果";
  prefer observable actions a quiz can grade — explain, identify, order the steps, complete the key
  line of code in a `short_answer`, design a call plan — and phrase `successCriterion` the same way.
- `prerequisiteActivation` is not a course overview. The mapped scene's description and keyPoints must
  contain 2–3 recall prompts addressed to the learner ("回想你上次……", "你是否曾……", "先判断：……")
  that elicit the exact prior experience the objective's `action` builds on; a slide that only
  introduces the topic or lists the agenda is misaligned.
- `transferApplication` items must open by stating a concrete new situation that never appeared in the
  demonstration or practice, then ask the learner to perform the same objective `action` there; a
  recognition question about the old example is not transfer.
- When several objectives share one `feedbackRetry` (or `transferApplication`) quiz, that quiz must
  contain at least one item per mapped objective, in objective order, and each item's stem must name
  the objective it serves (e.g. 「O2 · 重试」); a quiz that only covers one of the mapped objectives is
  misaligned for the others.
- A `feedbackRetry` quiz is not a fresh test. Each item must name the common wrong answer or misconception
  from the paired practice, state the gap against the objective's `successCriterion`, then re-ask an
  item on the same objective so the learner can retry; write this into the item stem and `analysis`.
- Every phase array is non-empty and references an ID that exists in `outlines`. A compact course may
  reuse a scene when it genuinely performs more than one role.
- Practice requires learner action that is graded, not another explanation slide. Map `learnerPractice`
  and `feedbackRetry` to **quiz or pbl** scenes: a quiz collects answers, shows `analysis` feedback and
  lets the learner retry. None of the prebuilt interactive widget templates grades learner input (they
  are exploration widgets), so an interactive scene may serve demonstration or prerequisite activation
  but must NOT be mapped to `learnerPractice` or `feedbackRetry`.
- When an objective's `action` is explanatory (解释 / 说明 / 描述 / 比较 / 画出 / 设计), its practice,
  feedbackRetry and transfer quizzes must include at least one `short_answer` question that asks the
  learner to perform that action, with a grading rubric mirroring the `successCriterion`. Recognition
  items alone (pick the right name) do not exercise an explanatory action.
- Objective wording, especially `successCriterion`, must reuse the terminology of the reference
  materials / knowledge-base excerpts verbatim (e.g. use the material's own names for stages or steps);
  do not paraphrase domain terms — the whole-course fact review treats term drift as an error.
- `learnerPractice` is a minimal contract map, not a list of every interactive scene. For every listed
  practice, keep the same-objective order `practice.order < feedbackRetry.order < assessment.order`.
  If a late interactive is not part of that loop, leave it out of `learnerPractice`.
- Every outline sets `objectiveIds` to one or more IDs from `learningContract.objectives`; use all
  relevant IDs when one scene genuinely serves more than one objective. Each objective must have
  mapped prerequisite activation, demonstration, learner practice, feedback/retry, transfer, and
  assessment evidence. `teachingObjective` may mirror the first ID for legacy consumers, but
  `objectiveIds` is the authoritative mapping.
- The scene description and key points must state how that scene serves the mapped objective's
  `action`, `condition`, and `successCriterion`; merely repeating objective keywords is not evidence.
  Later feedback scenes for a practice must share its objective ID, and a later quiz or PBL in
  `assessmentMap` must close that same objective loop.
- Every interactive or PBL practice scene used by the contract must collect learner input and visibly respond to that input; static HTML or a configuration-shaped placeholder is not learner practice. A PBL must contain a concrete deliverable, runnable milestones and microtasks, and explicit completion criteria.
- Feedback names how the learner sees an error and retries.
- Transfer uses a quiz or PBL in a situation not already used by the demonstration.
- A transfer keeps the same target action and success criterion but changes the task situation or
  input materially; renaming the example or changing only a number is not a new situation.
- Every objective ID appears in `assessmentMap`; assessment evidence must come from a quiz or PBL
  rather than a display-oriented interactive or self-reported understanding.
- Do not invent source titles or URLs. Copy only route-provided grounding identifiers.

{{#if groundingRefs}}
### Complete cross-reference example

This compact example is complete because the same objective is explicitly carried through prior
knowledge, demonstration, learner action, visible feedback/retry, and an unseen assessment. Use the
same cross-reference pattern for every objective in a larger course.

```json
{
  "languageDirective": "Teach in clear English and explain technical terms when first used.",
  "courseTitle": "Projectile Motion Practice",
  "learningContract": {
    "teachingStrategy": "standard",
    "objectives": [
      {
        "id": "O1",
        "action": "select and justify launch settings",
        "condition": "given a target distance and initial speed",
        "successCriterion": "the predicted landing error is within 5 percent"
      }
    ],
    "prerequisiteActivation": ["scene_1"],
    "demonstration": ["scene_1"],
    "learnerPractice": ["scene_2"],
    "feedbackRetry": ["scene_3"],
    "transferApplication": ["scene_4"],
    "assessmentMap": [{ "sceneId": "scene_4", "objectiveIds": ["O1"] }],
    "grounding": {
      "sourceRefs": {{groundingRefs}},
      "claimPolicy": "cite-or-mark-uncertain"
    }
  },
  "outlines": [
    {
      "id": "scene_1",
      "type": "slide",
      "title": "From Prior Knowledge to a Worked Launch",
      "description": "Elicit the learner's current prediction, then demonstrate how to select and justify settings for one worked target.",
      "keyPoints": ["State the prior prediction", "Work one launch calculation", "Check the 5 percent criterion"],
      "objectiveIds": ["O1"],
      "order": 1
    },
    {
      "id": "scene_2",
      "type": "interactive",
      "title": "Choose the Launch Settings",
      "description": "The learner changes angle and speed, submits a prediction, and sees the resulting trajectory.",
      "keyPoints": ["Manipulate both inputs", "Submit a prediction", "Compare landing error with the criterion"],
      "objectiveIds": ["O1"],
      "order": 2,
      "widgetType": "simulation",
      "widgetOutline": { "concept": "projectile_motion", "keyVariables": ["angle", "speed"] }
    },
    {
      "id": "scene_3",
      "type": "interactive",
      "title": "Read the Error and Retry",
      "description": "Visible error feedback identifies which setting caused the miss; the learner revises it and retries the same objective.",
      "keyPoints": ["Read actionable error feedback", "Revise one setting", "Retry until the criterion is met"],
      "objectiveIds": ["O1"],
      "order": 3,
      "widgetType": "game",
      "widgetOutline": { "gameType": "strategy", "challenge": "Correct a missed launch using visible error feedback" }
    },
    {
      "id": "scene_4",
      "type": "quiz",
      "title": "Transfer to a New Target",
      "description": "Apply the same action and criterion to an unseen target distance and justify the selected settings.",
      "keyPoints": ["New target situation", "Select settings", "Justify against the 5 percent criterion"],
      "objectiveIds": ["O1"],
      "order": 4,
      "quizConfig": { "questionCount": 2, "difficulty": "medium", "questionTypes": ["single", "text"] }
    }
  ]
}
```
{{/if}}

{{#if groundingRefs}}
Allowed grounding refs for this request (copy identifiers exactly): {{groundingRefs}}
{{/if}}
