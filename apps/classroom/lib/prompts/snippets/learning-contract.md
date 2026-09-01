## Teaching-quality LearningContract (machine checked)

The outline is a learning sequence, not a slide inventory. Return a fourth required top-level key,
`learningContract`, in the same JSON response as `languageDirective`, `courseTitle`, and `outlines`.
No second model call is reserved for filling this in, and a structurally incomplete contract is rejected.

Use this exact shape:

```json
"learningContract": {
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
    { "sceneId": "quiz, pbl, game, or procedural scene id", "objectiveIds": ["O1"] }
  ],
  "grounding": {
    "sourceRefs": ["one or more allowed grounding refs below"],
    "claimPolicy": "cite-or-mark-uncertain"
  }
}
```

Hard rules:

- Every objective has all four fields. `action` must be observable; `condition` and
  `successCriterion` make it measurable.
- Every phase array is non-empty and references an ID that exists in `outlines`. A compact course may
  reuse a scene when it genuinely performs more than one role.
- Practice requires learner action, not another explanation slide.
- Feedback names how the learner sees an error and retries.
- Transfer uses a situation not already used by the demonstration.
- Every objective ID appears in `assessmentMap`; assessment evidence must come from a quiz, PBL,
  game, or procedural task rather than self-reported understanding.
- Do not invent source titles or URLs. Copy only route-provided grounding identifiers.

{{#if groundingRefs}}
Allowed grounding refs for this request (copy identifiers exactly): {{groundingRefs}}
{{/if}}
