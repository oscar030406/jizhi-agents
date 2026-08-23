/**
 * 数字断言的正则旁路：判官漏抽的带单位数字，机械补进断言池。
 *
 * ## 为什么要旁路
 *
 * 判官是抽取器也是判定器。抽取这一步没有兜底——它没抽到的断言，
 * 后面整条链（判定、答辩、仲裁、修订）都碰不到，**看起来是「这一屏没有问题」，
 * 实际是「这一屏没被看过」**。数字尤其吃亏：它常常嵌在条件从句里
 * （「超过 150ms 就停机」），抽取器倾向于把整句压缩成一条概念性断言，
 * 数字与它的条件一起被抹掉。
 *
 * 而数字恰恰是最该审的一类——编造一个具体参数的代价，比说错一句概念大得多：
 * 学习者会拿它去设备上设。
 *
 * ## 弃权，不判错
 *
 * 旁路补进来的断言一律 `uncertain`，**永远不判 incorrect**。
 * 理由：旁路只知道「这里有个带单位的数字」，不知道它对不对——
 * 判对错要有对照物。查无对照就弃权，是这条旁路唯一诚实的姿态。
 * 把没查过的东西判成错，会触发修订环去改一个本来正确的数字，
 * 那比漏审更糟。
 *
 * 判官已经抽到的数字断言不重复补——去重按「同一个数字 + 同一个单位」。
 */

/** 带单位的数字。单位表按教学内容里真会出现的量纲收，不收裸数字。 */
const NUMERIC_WITH_UNIT =
  /-?\d+(?:\.\d+)?\s*(?:ms|毫秒|μs|微秒|秒|分钟|小时|天|kHz|MHz|GHz|Hz|kV|mV|mA|kW|Ω|欧姆|℃|°C|度|kPa|MPa|Pa|bar|mm|cm|km|寸|kg|吨|rpm|转|N·m|Nm|牛米|KB|MB|GB|TB|kbps|Mbps|字节|bit|[%‰倍次条]|(?:V|A|W|K|m|g|t|s|h|B)\b)/g;

/**
 * 第二层：**领域计量词**（个/轮/步/层/token/字符…）。
 *
 * 拿 100 条数字扰动集量出来的：只认物理单位时检出 79%，漏掉的 21 条**全是**
 * 这一类——「移动了 0.2 个单位」「窗口只能装 20 轮」「中文按 2 个 Token 计算」。
 * 扰动集出自 AI 域课程，那边的参数天然不带物理量纲。
 *
 * 但这层不能无条件收：「举 3 个例子」「分 4 步讲」满篇都是，全收进来就是把
 * 断言池灌满噪声，而 uncertain 断言会触发救援轮的重检索——**那是要花钱的**。
 *
 * 所以这层要**配合参数语境才生效**（见 {@link PARAM_CONTEXT}）。这道闸值多少，
 * 在 1704 块主语料（42676 句）上量过：
 *
 * | 口径 | 命中句 | 比只收物理单位多 |
 * | ---- | -----: | ---------------: |
 * | 只收物理单位 | 755（1.8%） | — |
 * | 两层 + 参数语境闸 | 774（1.8%） | **+19** |
 * | 两层不带闸 | 1080（2.5%） | +325 |
 *
 * 带闸多抓 19 句、检出率从 79% 涨到 82%；不带闸多抓 325 句、检出率涨不了多少。
 * 闸留着。
 */
const NUMERIC_WITH_COUNTER =
  /-?\d+(?:\.\d+)?\s*(?:个单位|个字符|个|轮|步|层|维|句|页|张|台|根|项|条目|token|Token|TOKEN|字|词)/g;

/**
 * 参数语境：这个数是被**规定**出来的，不是顺口一提。
 *
 * 「阈值设为 20」是参数，「举 20 个例子」不是。判据取赋值/规定的口吻，
 * 不取数字本身——数字长什么样区分不了这两者。
 */
const PARAM_CONTEXT =
  /(设为|设成|设置为|默认|缺省|阈值|上限|下限|最大|最小|至少|最多|不超过|不低于|按.{0,6}计算|取值|配置为|等于|为准|限制在|超过|低于)/;

/**
 * 条件连接词。带条件的数字断言**必须整句进池**——
 * 「超过 150ms 停机」拆掉条件就变成「150ms 停机」，那是另一个意思，
 * 而判官恰恰爱拆。
 */
const CONDITION_MARK =
  /(如果|若|当|一旦|超过|低于|大于|小于|不足|至少|最多|以上|以下|超时|达到|高于|每隔|每当)/;

/** 句子切分。数字断言以句为单位——切碎了条件就掉了。 */
const SENTENCE_SPLIT = /(?<=[。！？；\n])/;

export interface NumericClaim {
  /** 整句原文（截断到 160 字，与 AuditClaim.claim 同口径）。 */
  claim: string;
  /** 这句里出现的带单位数字，原样。 */
  numbers: string[];
  /** 这句带不带条件从句。带条件的更该审——它规定的是「什么时候会怎样」。 */
  conditional: boolean;
}

/**
 * 从教学文本里机械抽出数字断言。零模型调用。
 *
 * 一句里有多个数字算**一条**断言：「80ms 任务 + 70ms 余量 = 150ms 阈值」
 * 拆成三条会让判官对着三个孤立数字各判一次，而它们只有放在一起才有意义。
 */
export function extractNumericClaims(text: string): NumericClaim[] {
  const out: NumericClaim[] = [];
  for (const raw of text.split(SENTENCE_SPLIT)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const found = sentenceNumbers(sentence);
    if (!found.length) continue;
    out.push({
      claim: sentence.slice(0, 160),
      numbers: found,
      conditional: CONDITION_MARK.test(sentence),
    });
  }
  return out;
}

/**
 * 一句里算数的数字。两层：物理单位无条件收；领域计量词要有参数语境才收。
 *
 * 分层的代价是量出来的：只收物理单位在扰动集上检出 79%，漏的全是计量词那类；
 * 无条件收计量词会把「举 3 个例子」也拖进来，而多出来的 uncertain 断言会
 * 触发救援轮重检索——那是要花钱的。参数语境这道闸夹在中间。
 */
function sentenceNumbers(sentence: string): string[] {
  const strict = sentence.match(NUMERIC_WITH_UNIT) ?? [];
  const loose = PARAM_CONTEXT.test(sentence) ? (sentence.match(NUMERIC_WITH_COUNTER) ?? []) : [];
  return [...new Set([...strict, ...loose].map((n) => n.replace(/\s+/g, '')))];
}

/** 一条文本里出现的所有算数的数字，去空白后比对用。 */
function numberSet(text: string): Set<string> {
  return new Set(text.split(SENTENCE_SPLIT).flatMap((s) => sentenceNumbers(s)));
}

/**
 * 参考资料里有没有这条数字断言的**对照物**。
 *
 * 判据故意粗：只要资料里出现过同一个「数值+单位」就算有对照，
 * 由判官去判它对不对。这里要回答的只是「有没有东西可比」——
 * 没有可比的就弃权，这是弃权策略唯一需要的信号。
 */
export function hasCounterpart(claim: NumericClaim, evidence?: string): boolean {
  if (!evidence) return false;
  const inEvidence = numberSet(evidence);
  return claim.numbers.some((n) => inEvidence.has(n));
}

export interface BypassResult<T> {
  claims: T[];
  /** 旁路补进来几条。0 说明判官没漏。 */
  added: number;
  /** 补进来的那几条里，有几条在资料里查无对照（弃权的）。 */
  abstained: number;
}

/**
 * 判官的断言池 + 正则旁路补漏。
 *
 * 去重按「这条断言里的数字集合」：判官抽到的断言若已经覆盖同一组数字，
 * 就不再补——补了会让同一个数字被判两次，仲裁环白跑一轮。
 *
 * 补进来的一律 `uncertain`，reason 里写清它是旁路补的、以及查没查到对照，
 * **让读的人一眼看出这条没被真正判过**。
 */
export function mergeNumericBypass<
  T extends { claim: string; verdict: string; reason: string },
>(
  judged: readonly T[],
  teachingText: string,
  evidence: string | undefined,
  make: (claim: string, reason: string) => T,
): BypassResult<T> {
  const covered = new Set<string>();
  for (const c of judged) {
    for (const n of numberSet(c.claim)) covered.add(n);
  }

  const extra: T[] = [];
  let abstained = 0;
  for (const found of extractNumericClaims(teachingText)) {
    if (found.numbers.every((n) => covered.has(n))) continue; // 判官已经看过这组数
    const counterpart = hasCounterpart(found, evidence);
    if (!counterpart) abstained += 1;
    const why = counterpart
      ? '正则旁路补入：判官没抽到这条带单位的数字，参考资料里有同量纲的数可比对'
      : '正则旁路补入并弃权：判官没抽到这条带单位的数字，参考资料里也查不到可比对的数——' +
        '弃权是因为「没查过」不等于「错了」，判错会触发修订环去改一个可能本来正确的参数';
    extra.push(make(found.claim, (found.conditional ? '（带条件从句）' : '') + why));
    for (const n of found.numbers) covered.add(n);
  }

  return { claims: [...judged, ...extra], added: extra.length, abstained };
}
