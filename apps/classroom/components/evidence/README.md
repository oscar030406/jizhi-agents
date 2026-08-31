# components/evidence

`/evidence` 证据页专用的展示组件。只有 `app/evidence/page.tsx` 会渲染它们。

新文件的收编条件：这个组件只服务证据页，且带对外数字或复算口径。
只在首页出现的组件放 `components/home/`，两边都用的放 `components/ui/`。

数字纪律：这里任何数字的真源是 `apps/agent-engine/data/metrics.json`，
改数先改真源，再跑 `python apps/agent-engine/scripts/check_metrics.py`。

- `audit-showcase.tsx` —— 审核智能体三栏纠错卡 + 课程选择器。
  根元素 `id="audit-showcase"` 是外部深链锚点（`components/home/six-requirements.tsx`
  指过来），**不要改**。挑选逻辑是纯函数，测试在 `tests/evidence/audit-showcase.test.ts`。
- `metrics-ledger.tsx` —— 折叠式指标台账（值 / 口径 / 复算命令三列）。
  2026-08-31 起已从 `/evidence` 撤下，页面不再渲染它，深链也已删。
  **文件不要删**：`metrics.json` 有 12 条 citations 指向它，其中 6 个指标只引这一处，
  删文件 `check_metrics.py` 会判「引用文件不存在」。
- `tutor-replay.tsx` —— 导学一轮静态回放，只读 `public/tutor-replay.json`。
  根元素 `id="tutor-replay"` 是锚点，**不要改**。
