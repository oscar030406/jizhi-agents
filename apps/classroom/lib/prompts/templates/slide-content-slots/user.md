# Generation Requirements

## Scene Information

- **Title**: {{title}}
- **Description**: {{description}}
- **Key Points**:
  {{keyPoints}}

{{teacherContext}}

## Language Directive
{{languageDirective}}

**Must Follow**:

1. Output pure JSON directly: `{"template": ..., "slots": {...}, "remark": ...}`
2. Do not wrap with ```json code blocks; no text before or after the JSON
3. Choose the single template that best fits the key points; fill every required slot
