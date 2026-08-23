# eval_sprint —— 四个评测脚本

这里放的是四个一次性评测实验的跑数脚本。产物落 `docs/05-evidence/eval_sprint/`（docs 不入库），
每个脚本一份 `.jsonl` 明细 + 一份 `.md` 报告。

**跑之前先看这一条**：`--dry-run` 一次请求都不发，会把「要做什么、要花多少」整条打印出来。
没看过 dry-run 的输出就别真跑。

## 怎么跑

cwd 必须是 `apps/classroom` —— tsx 装在那边，产品代码里的 `@/` 别名也靠那边的 tsconfig 解析。

```bash
cd "D:/UserData/Desktop/挑战杯/apps/classroom"

# 公用件自检（价格解析、成本闸、盲评自检）
node --import tsx ../agent-engine/scripts/eval_sprint/common.mjs --selftest

# A 质量齐平线对照
node --import tsx ../agent-engine/scripts/eval_sprint/a_parity.mjs --dry-run
node --import tsx ../agent-engine/scripts/eval_sprint/a_parity.mjs --no-judge-panel --budget 2

# B 消融爬升（先看四档要什么开关，再一档一档跑）
node --import tsx ../agent-engine/scripts/eval_sprint/b_ablation.mjs --dry-run
node --import tsx ../agent-engine/scripts/eval_sprint/b_ablation.mjs --rung 3
node --import tsx ../agent-engine/scripts/eval_sprint/b_ablation.mjs --judge

# C 判官新域校准
node --import tsx ../agent-engine/scripts/eval_sprint/c_judge_stability.mjs --dry-run
node --import tsx ../agent-engine/scripts/eval_sprint/c_judge_stability.mjs --from <制造侧课程.json> --n 24

# D 数字扰动检出率
node --import tsx ../agent-engine/scripts/eval_sprint/d_numeric_perturbation.mjs --selftest
node --import tsx ../agent-engine/scripts/eval_sprint/d_numeric_perturbation.mjs --dry-run
```

代理不用自己剥，脚本进程内把 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` 删掉再发请求，
启动时会打印剥掉了哪几个。

## 四个脚本

| 脚本 | 量什么 | 默认成本上限 | 主要参数 |
|---|---|---:|---|
| `a_parity.mjs` | 主域与制造侧两个库的质量差，四维盲评 + 蓝图/旁路/脚手架三样读数 | ¥3 | `--groups --slots --judges --no-judge-panel --courses` |
| `b_ablation.mjs` | 四档消融爬升表 | ¥3 | `--rung N --judge --domain --requirement` |
| `c_judge_stability.mjs` | 判官对同一条断言的自稳性（选项置换三轮） | ¥1 | `--from --ids --n --judge` |
| `d_numeric_perturbation.mjs` | 三类扰动 × 旁路开/关的检出率 | ¥1 | `--n --skip-original --set` |

公用参数：`--dry-run` `--budget <元>` `--base-url <url>` `--seed <n>`。

## 省钱形态（当前唯一被批准的形态）

`a_parity.mjs --no-judge-panel`：只生成 1–2 门对照课，不开判官团，读数全部来自
落盘课程里已经有的东西——审核链的 `audit.claims` 统计、数字旁路补入/弃权条数、
脚手架残留块数。判官团那部分 0 元。

要压得更省，`--groups ai,plc-s71200 --slots 1` 就是两门课。

## 三样机制的读数各自从哪来

| 机制 | 产品实现 | 读数怎么取 |
|---|---|---|
| 蓝图三表 | `lib/generation/course-coherence.ts` `courseFrameFromOutlines` | 直接 import 跑在落盘课程上：三张表填出几张、全课有几个不同类比（漂移）、数字例重不重 |
| 数字旁路 | `lib/generation/numeric-claims.ts` `mergeNumericBypass` | 数 `audit.claims` 里 reason 带「正则旁路补入」「弃权」的条数；另用 `extractNumericClaims` 算正文里数字断言的覆盖率 |
| 脚手架清除 | `lib/generation/adaptation-lint.ts` `scrubScaffoldHtml` | 交付文本里 `findScaffoldLeak` 还认得出几块（残留）；再跑一遍 scrub 还能删几段（应为 0） |

「真删了几条」只写在服务端日志的 `[脚手架清除]` 那行，HTTP 这头看不见——
把日志文件用 `--server-log <path>` 传进来才数得到。

所有判据函数都是**直接 import 产品代码**，这边一行都没重写。重写一份，量出来的是两份代码的差。

## 现成开关与还缺的开关

`b_ablation.mjs --dry-run` 会现查盘（在产品代码里搜 `process.env.<NAME>`）并打印结论。截至写这份 README：

- 现成：`LECTURE_SCENE_MODE=0`（关讲义场景，走六类兜底）、`SLIDE_TEMPLATE_MODE=0`（关版式槽位）
- 还缺：`AUDIT_GATE`（关审核门）、`COURSE_COHERENCE`（关蓝图连贯）、`NUMERIC_BYPASS`（关数字旁路，D 的真链路两档要）

缺的三个**由人来加，脚本不碰产品代码**，该加在哪写在各脚本产出的报告里。加的时候记住一条：
默认行为一个字不许变，开关只在显式设成 `0` 时改路径。

env 是服务端进程的，脚本改不了 —— B 的跑法因此是「服务端按打印的 env 起进程 → `--rung N` 跑那一档」，
四档齐了再 `--judge` 一次性盲评。跑没跑串靠产物里记的 `env` 字段事后对账。

## 盲评怎么保证真盲

判官拿到的每一条输入只有两样东西：一个 `S001` 形态的编号，和正文。

`common.mjs` 的 `assertBlind` 是硬闸，两条判据：

1. **同形**：把每条输入里的正文和编号抠掉，剩下的骨架必须逐字相同。有任何一组多带一句
   「这是制造域的」，骨架就多出一种，当场抛，一个请求都发不出去。
2. **封锁词**：库名、档位名、批次名、扰动类型这些标识，出现在输入里就抛。

顺序由固定种子洗牌，可复算。

**盲不掉的那部分照实说**：域主题从正文本身就能读出来（讲 PLC 的课不可能读不出是 PLC）。
盲的是「哪一组、哪一档、哪一批」，不是内容。

## 成本闸

- 累计 token 与估算成本落进产物，每步之前先问一句还够不够，不够就停并把已跑完的部分落盘。
- 上限是 `--budget`，默认保守（A/B ¥3，C/D ¥1）。
- 单价取 `apps/agent-engine/backend/services/cost_meter.py` 的 `PRICE_TABLE`，脚本解析那份，不另立一张表。
- 整课生成的花费靠 `/api/usage` 的前后快照差算真实值；快照取不到才退回估算并在产物里标 `estimated`。
- dry-run 里的 token 是按字符数粗估的，只用来看量级。

## 产物与口径纪律

- 落 `docs/05-evidence/eval_sprint/<脚本>-<时间戳>.{jsonl,md}`，dry-run 的文件名带 `-dryrun`。
- 样本量如实写进报告；点估计贴着判据线时报自助重抽覆盖率。
- **这些是新口径，另立行**。既有对外数字（幻觉率 2.08% / 576 断言、适配 85.2%、覆盖 96.0%）
  是另一套口径，不合并、不覆盖、不拿这边的数去改那边。

## 已知的坑

- 制造侧两个库（`smart-manufacturing`、`plc-s71200`）在服务器上，本地盘上没有。
  跑它们要 `--base-url` 指到线上，本地只能跑主域。
- 落盘课程不带大纲的 `keyPoints`，蓝图读数用每屏正文的前若干句近似，识别率偏低——
  这是近似口径的账，不是产品的账，报告里已标注。
- B 每档只跑一门课，判官分是单点，看不出生成随机性。要下结论至少每档三门取均值。
- 扰动集是程序化造的，`value_x2` 里可能混着「翻倍后仍然正确」的句子，会被算成漏检。
