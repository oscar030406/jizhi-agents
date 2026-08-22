# learning_eval —— 学习成效评测

回答一个问题：**一个零基础的人只靠这份材料，能不能学会、能不能上手干活？**

不是「幻灯片有几个元素」「教具能不能点」。判据在学习者那一侧。

## 两个脚本

| 脚本 | 干什么 | 什么时候跑 |
|---|---|---|
| `build_bank.mjs` | 给定主题 + 参考教材，生成四层题库 | 换主题时跑一次 |
| `run_eval.mjs` | 多臂对照跑分，报相对教材达成率 | 每次要验收改动时跑 |

## 四层题

| 层 | 测什么 | 权重意图 |
|---|---|---|
| recall 复述 | 材料里直接写了的 | 底线，塌了后面不用看 |
| transfer 迁移 | 材料没直说、学明白了就该会 | 区分「念结论」和「讲透原理」 |
| operate 实操 | 给有 bug 的代码/写错的配置/线上现象，判断+改正 | 对应岗位上排查事故 |
| deliver 交付 | 给一个岗位任务，产出能验收的东西 | 学完能不能上手干活 |

后两层是岗位培训的重点。注意力机制只是第一个试验品，最终要评的是
RAG / Agent 编排 / 护栏 / 评测 / 部署整条线，所以出题这一步做成了生成器而不是手写题。

## 六个实验臂

所有带材料的臂都受同一条约束：**只能依据材料作答，材料没讲到的写「材料未提及」**。

| 臂 | 喂什么 | 约束 | 作用 |
|---|---|---|---|
| `blank` | 空材料 | 有 | **下限锚点**。测模型守不守约束，理应≈0 |
| `prior` | 什么都不给 | 无 | 先验天花板。不进公式，只说明题对模型有多容易 |
| `placebo` | 同一本教材的**无关**章节 | 有 | 尺子自检。它涨分说明判官在给「像教材的东西」送分 |
| `textbook` | 参考教材原章节 | 有 | **上限锚点** |
| `upstream` | 上游生成的课 | 有 | 对照 |
| `fork` | 我们生成的课 | 有 | 被测 |

下限锚点为什么不是「什么都不给、自由作答」：第一次冒烟测里它拿 4.00/4，
比读教材的 2.50 还高——因为其他臂闭卷、它开卷，口径不对等。
下限必须是同样的约束加空材料，测的才是「约束有没有被遵守」。

裸分没有意义。报的是相对教材达成率：

```
g = (本臂均分 − 无材料均分) / (教材均分 − 无材料均分)
```

分母太小（< 0.3 分）时脚本会拒绝解读——那说明题目区分度不够，先修题库。

## 四个防自欺的设计

1. **判官看不到材料**。学生看材料答题，判官只看「题 + 评分要点 + 答案」判分。
   判官看不到材料就没法被篇幅和排版影响。旧版是判官自己答自己打分，那是自评。
2. **学生与判官异厂商**。同族模型互判会自我偏好。
3. **接地率核对**。回答里的关键论断有几条能在材料里找到依据。
   接地率低而分数高 = 分是模型自己挣的，不是材料教的。
   不测这个，整套评测的效度就只建立在 prompt 里那句「只能依据材料」的祈使句上。
4. **逐题泄漏筛查**。空材料臂就能答到 1.5 分以上的题自动标出来，
   并给出剔掉这些题重算的结果。

## 怎么跑

```bash
cd apps/agent-engine

# 1. 抓课程材料（每门约 13 分钟）
node scripts/run_zero_prior_batch.mjs --runs 3 --only fork

# 2. 生成题库（换主题时才需要）
node scripts/learning_eval/build_bank.mjs --config ../../data/eval/banks/attention.config.json

# 3. 跑评测（两种模式都要跑，见下）
node scripts/learning_eval/run_eval.mjs --bank ../../data/eval/banks/attention.json --runs 2 --closed-book
node scripts/learning_eval/run_eval.mjs --bank ../../data/eval/banks/attention.json --runs 2
```

## 开卷和闭卷

**默认开卷**：材料和题目一起给学生。它测的是「材料里查不查得到」。

**`--closed-book` 闭卷两阶段**：先读材料写 ≤600 字笔记（**看不到题**）→ 换新会话，
材料收走，只拿笔记答题。它测的才是「学没学会」。笔记会落盘（`notes_<stamp>.json`）供抽读。

两个都不是真值，从两头夹：

- 开卷**高估长材料**——能查到的东西更多。
- 闭卷**低估长材料**——600 字笔记对 38k 字的教材压到 1.5%，对 5k 字的课压到 12%，
  压缩比差 8 倍。

实测（2 题）：换成闭卷后教材从 3.50 掉到 1.50，我们的课纹丝不动 1.00。
**两个数都要报，并写清各自往哪边偏。**

学生作答会缓存在 `data/eval/learning_gain/answers.cache.json`（每 20 条落一次盘），
改判官重跑判分不用重新答题。

## 换个主题怎么跑

这套东西对主题是解耦的。换到 RAG 文本分块（岗位技能主线）只改三个地方：

```bash
# 1. 参考教材：从 PDF 抽一章，作为上限锚点
#    （已抽好：data/eval/baseline/rag_chunking_ref.txt）

# 2. 生成题库
node scripts/learning_eval/build_bank.mjs --config ../../data/eval/banks/rag-chunking.config.json

# 3. 生成课程（换 --requirement）
node scripts/capture_course.mjs --url http://localhost:3210 --label ragchunk_r1 \
  --requirement "我想学 RAG 里的文本分块：怎么把文档切成块、块多大、要不要重叠"

# 4. 跑评测：换题库、换材料前缀、安慰剂用另一个主题的教材
node scripts/learning_eval/run_eval.mjs \
  --bank ../../data/eval/banks/rag-chunking.json \
  --fork-prefix ragchunk --upstream-prefix "" \
  --placebo data/eval/baseline/textbook_ch3.txt --runs 2
```

上限锚点、安慰剂、篇幅对照三个臂的材料都从题库配置里读，不写死路径——
写死了换主题时会拿注意力的教材去当 RAG 的锚点，而且**不报错**，只给出一个错的数。

## 数据在哪

```
data/eval/banks/<slug>.config.json     题库配置（主题、参考教材、各层题数）
data/eval/banks/<slug>.json            生成出来的题库
data/eval/baseline/textbook_ch3.txt    上限锚点：《从零构建大模型》第 3 章
data/eval/baseline/placebo.txt         安慰剂：同书第 2 章（分词，与注意力无关）
apps/agent-engine/data/eval/zero_prior/      capture_course.mjs 抓的课程材料
apps/agent-engine/data/eval/learning_gain/   跑分结果
```
