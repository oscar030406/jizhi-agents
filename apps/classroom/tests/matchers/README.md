# tests/matchers

给 vitest 加的自定义断言。一个断言族一个文件，在 `tests/setup-env.ts` 里 import 一行完成注册。

- `llm-judge.ts` —— 语义断言 `toMatchLlmRubric` / `toBeSimilarTo`（LLM 按 rubric 打分、bge-m3 余弦）。
  默认不联网：没配 key 时用 `describe.skipIf(!llmRubricReady())` / `describe.skipIf(!similarityReady())`
  把用例标成 skipped；漏了 skipIf 直接调会抛错，不会静默变绿。
- `llm-judge.example.test.ts` —— 上面两个 matcher 的用法示例，外加不花钱的自检。
