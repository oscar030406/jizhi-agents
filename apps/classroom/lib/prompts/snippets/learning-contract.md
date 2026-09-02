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
  "learnerPractice": ["interactive or pbl scene id where the learner performs"],
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

- Every objective has all four fields. `action` must be observable; `condition` and
  `successCriterion` make it measurable.
- Every phase array is non-empty and references an ID that exists in `outlines`. A compact course may
  reuse a scene when it genuinely performs more than one role.
- Practice requires learner action, not another explanation slide.
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
Allowed grounding refs for this request (copy identifiers exactly): {{groundingRefs}}
{{/if}}
