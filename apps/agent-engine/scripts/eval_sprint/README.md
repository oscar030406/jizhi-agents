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

# D 数字扰动检出率（第二版，配对比较）
node --import tsx ../agent-engine/scripts/eval_sprint/d_numeric_perturbation.mjs --selftest
node --import tsx ../agent-engine/scripts/eval_sprint/d_numeric_perturbation.mjs --dry-run
node --import tsx ../agent-engine/scripts/eval_sprint/d_numeric_perturbation.mjs --n 90 --budget 1
```

代理不用自己剥，脚本进程内把 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` 删掉再发请求，
启动时会打印剥掉了哪几个。

## 四个脚本

| 脚本 | 量什么 | 默认成本上限 | 主要参数 |
|---|---|---:|---|
| `a_parity.mjs` | 主域与制造侧两个库的质量差，四维盲评 + 蓝图/旁路/脚手架三样读数 | ¥3 | `--groups --slots --judges --no-judge-panel --courses` |
| `b_ablation.mjs` | 四档消融爬升表 | ¥3 | `--rung N --judge --domain --requirement` |
| `c_judge_stability.mjs` | 判官对同一条断言的自稳性（选项置换三轮） | ¥1 | `--from --ids --n --judge` |
| `d_numeric_perturbation.mjs` | 判官能不能分辨「同一屏改了一个数」与原屏（配对判据） | ¥1 | `--n --judge --courses --set --max-tokens` |

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

## D 数字扰动：第一版为什么作废，第二版怎么量

**第一版（2026-08-22）真跑了 200 次调用（¥0.29），那批数作废。** 两条实测原因：

1. 它把**单句**喂给判官（「参数向减小损失的方向移动了 0.2 个单位。」），而
   `JUDGE_SYSTEM` 是为整屏教学文本写的。200 条里 118 条（59%）判官一条断言都没抽出来，
   抽样看回复它反过来说「您没有提供教学正文」。**这是评测器与被测对象不匹配，不是产品漏检。**
2. 剔掉无回复后剩 82 条：扰动句标出 88.5%，**原句误标 87.1%**。原句一个字没改也几乎全被标——
   因为它们本身带数字，而判官被要求「宁严勿松……编造的具体数字至少判 uncertain」。
   第一版量的是「这句有没有数字」，不是「这个数改错了没」。88.5% 在 87.1% 的底噪上等于零。

第二版针对这两条改：

- **整屏喂**。判官输入用产品 `runJudge` 的原样形态
  （`场景标题：…\n教学文本：\n…`，见 `hallucination-audit.ts:464`），
  整屏正文由产品的 `extractTeachingText` 现抠。扰动版 = 原版整屏把那一句换掉，
  **其余一字不动**——每一对都跑运行时断言（抠掉各自那一句后两屏逐字相同），不靠人相信。
- **配对判据**。同一屏原版与扰动版各判一次，只有
  「扰动版判 incorrect/uncertain **且** 原版判 supported」才算一次成功检出。
  两版都被标记 `bothFlagged`，不算成功——那正是第一版量到却没显出来的那一格。

**样本换了来源。** 冻结集 `data/eval/numeric_perturbation_set.jsonl` 的 100 条里只有 **21 条**
能定位回教学正文（脚本每次跑都现算这个数并落进报告）；其余 79 条出自
`scenes[].audit.rationale`（53 条）、`audit.claims[].claim`（11 条）等**审核日志字段**——
`build_numeric_perturbation_set.py` 的 `collect_strings` 遍历整份课程 JSON 的每一个字符串，
不区分课文和元数据。拿它去问判官，等于让判官核对审核系统自己的日志。

所以第二版从 `extractTeachingText` 的输出里现采，扰动规则与那份 py 完全同一套
（value_x2 / unit_swap / consequence_flip），配对率 100%（样本本来就是从整屏里采的）。
40 门课 / 370 屏可造 288 对（value_x2=217、unit_swap=37、consequence_flip=34），
默认轮转发牌取 90 对、稀有类先取满，142 次调用（原版整屏按屏去重共用），dry-run 估 ¥0.42。

**读数的时候注意两条**：

- 旁路（`mergeNumericBypass`）补进来的断言一律 `uncertain`，意思是「这条没被真正判过」。
  它会把两档一起推向 `bothFlagged`，**分辨率大概率不升反降**。这不是旁路变差，
  是它本来就不做分辨——它做的是把漏抽的数字标出来让人看见（报告第四节那张进池率表）。
- 判官回复解析不了的单记 `parseFailed`，从所有率的分母里剔除，报告里写清剔了几对，
  明细 jsonl 里留回复开头 200 字。第一版是靠人工抽样才发现它在说「您没有提供教学正文」的，
  那种发现不该靠运气。

## 现成开关与还缺的开关

`b_ablation.mjs --dry-run` 会现查盘（在产品代码里搜 `process.env.<NAME>`）并打印结论。截至写这份 README：

- 现成：`LECTURE_SCENE_MODE=0`（关讲义场景，走六类兜底）、`SLIDE_TEMPLATE_MODE=0`（关版式槽位）、
  `NUMERIC_BYPASS=0`（关数字旁路，已加在 `lib/config/feature-flags.ts:123`）
- 还缺：`AUDIT_GATE`（关审核门）、`COURSE_COHERENCE`（关蓝图连贯）

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
- 冻结集 `numeric_perturbation_set.jsonl` 大半不是教学正文（见上面 D 那一节）。
  它没被重建——D 的脚本不改 `build_numeric_perturbation_set.py`。要重建的话，
  `collect_strings` 应当只走 `scenes[].content`，把 `audit` / `actions` 整棵剪掉。
- D 每档只判一次，一对样本的差里混着判官自身的抖动（抖动幅度见 C）。压掉要每档重复 3 次，成本×3。
