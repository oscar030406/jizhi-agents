/**
 * 课程一致性状态：屏与屏之间那点必须共享的东西。
 *
 * ## 病是「重」不是「忘」
 *
 * 一门 PLC 课四段四个类比（妈妈作业 → 炖汤 → 失控汽车 → 食堂微波炉），
 * 同一个 150ms 阈值推演三遍（140/160/300、200/310、800+200），
 * 两个教具全是步进器。三件事同一个形状：**每屏各自即兴，不知道前面做过什么**。
 *
 * 所以传的是**结构化清单**（做过什么、别再做），不是滚动摘要——
 * 摘要治的是「忘了前文」，我们的病是「重复前文」。塞更多前文只会让重复更像样。
 *
 * ## 两组字段，来源不同
 *
 * **课程级只读**：蓝图定一次，全量下发，逐屏不改。类比、语域、概念顺序属于这组——
 * 它们一旦边写边改就会漂移，而漂移正是要治的病。
 *
 * **逐屏累积**：生成一屏、记一笔、传给下一屏。已讲概念、已用数字例、已用教具形态
 * 属于这组。记的是**一句话标题不是全文**：清单要能塞进提示词还留得下写作空间。
 *
 * ## 不做什么
 *
 * 不做屏级内容预写（产出填空僵尸文）、不做全课滚动摘要（治错了病）、
 * 不做动态重规划（蓝图边写边改就失去了「定一次」的意义）。
 *
 * 蓝图管的是「不跑偏」，管不了「写砸」——生成后的 lint 与判官是另一层，两层都要。
 */

/** 课程级只读：蓝图定一次，逐屏原样下发。 */
export interface CourseFrame {
  /**
   * 这门课贯穿始终的类比，例如「就像食堂的微波炉」。
   * 认不出来就不填——**不硬造类比**，宁可没有也不要四段四个。
   */
  analogy?: string;
  /**
   * 类比的映射表：源域概念 → 目标域概念。有它模型才知道怎么把新概念挂上去，
   * 而不是每段重新发明一个比喻。
   */
  analogyMap?: Array<{ from: string; to: string }>;
  /**
   * 核心概念绑定的唯一数字例。同一个阈值只演一次——
   * 「150ms 推演三遍」就是没有这张表的后果。
   */
  numericExamples?: Array<{ concept: string; example: string }>;
  /** 概念引入顺序。排在后面的概念，前面的屏不许当已知来用。 */
  conceptOrder?: string[];
}

/** 逐屏累积：写完一屏记一笔，传给下一屏。 */
export interface CourseProgress {
  /** 已经讲过的概念（一句话标题，不是全文）。 */
  concepts: string[];
  /** 已经演过的数字例（「150ms 阈值：80ms 任务 + 70ms 余量」这种一行）。 */
  workedExamples: string[];
  /** 已经用过的教具形态 id。 */
  widgets: string[];
  /** 上一屏结尾一两句，供下一屏衔接。**只留最后一屏的**，不滚动累积。 */
  lastLines?: string;
  /**
   * 这一屏正在讲的概念。既不算「已讲过」（那会让它别再解释一遍，
   * 而它正是这屏要解释的），也不算「还没讲」（那会让它别当已知用，
   * 可它就是本屏的主题）——所以单开一格，两张清单都把它排除。
   */
  teachingNow?: string;
}

export function emptyProgress(): CourseProgress {
  return { concepts: [], workedExamples: [], widgets: [] };
}

/** 清单进提示词时的条数上限。超了只会挤掉写作空间，反而降质。 */
const MAX_LISTED = 8;

const bullet = (items: readonly string[]): string =>
  items
    .slice(-MAX_LISTED)
    .map((x) => `  · ${x}`)
    .join('\n');

/**
 * 把一致性状态写成给生成器看的一段指令。
 *
 * **负向指令要具体**：「不要重复」没用，「这些已经讲过，别再讲一遍」才有用——
 * 清单本身就是判据，模型能逐条比对。
 */
export function coherenceDirective(frame: CourseFrame, progress: CourseProgress): string {
  const lines: string[] = [];

  if (frame.analogy) {
    lines.push(
      `- 【全课统一类比】这门课自始至终用同一个类比：${frame.analogy}。` +
        `把新概念挂到这个类比的不同部位上，**不要另起炉灶换新比喻**——` +
        `每段一个新类比会让读者每段都重新建立映射。`,
    );
    if (frame.analogyMap?.length) {
      lines.push(
        `- 【类比映射】已经定好的对应关系（沿用，不要改口）：\n` +
          bullet(frame.analogyMap.map((m) => `${m.from} ↔ ${m.to}`)),
      );
    }
  }

  if (frame.numericExamples?.length) {
    lines.push(
      `- 【数字例登记】每个概念只配一组数字，已登记的照抄不要另编：\n` +
        bullet(frame.numericExamples.map((e) => `${e.concept}：${e.example}`)),
    );
  }

  if (progress.concepts.length) {
    lines.push(
      `- 【已讲过的概念】下面这些前面的屏已经讲过，**这一屏可以引用但不要重新解释**：\n` +
        bullet(progress.concepts),
    );
  }

  if (progress.workedExamples.length) {
    lines.push(
      `- 【已演过的例子】同一组数字不要再演一遍——换个角度讲同一个例子也算重复：\n` +
        bullet(progress.workedExamples),
    );
  }

  if (frame.conceptOrder?.length && progress.concepts.length) {
    const notYet = frame.conceptOrder.filter(
      (c) => !progress.concepts.includes(c) && c !== progress.teachingNow,
    );
    if (notYet.length) {
      lines.push(
        `- 【还没讲的概念】不要当成读者已知的东西来用（要用就先解释）：\n` +
          bullet(notYet),
      );
    }
  }

  if (progress.lastLines) {
    lines.push(`- 【上一屏收尾】「${progress.lastLines.slice(0, 120)}」——从这里接下去，不要重开话头。`);
  }

  return lines.length ? `\n\n【课程一致性 · 逐屏累积，必须遵守】\n${lines.join('\n')}` : '';
}

/** 比喻标记。生成器写类比时通常在要点里留一句。 */
const ANALOGY_MARK = /(就像|好比|相当于|类比成|可以想象成|把它想成)([^。；\n]{2,24})/;

/**
 * 从要点里认出这一屏用的类比。
 *
 * **不额外调模型**：多一次往返，而且抽错比不抽更糟。认不出返回 undefined，
 * 后面各屏照旧——不硬造。
 */
export function extractAnalogy(keyPoints?: readonly string[]): string | undefined {
  for (const point of keyPoints ?? []) {
    const hit = ANALOGY_MARK.exec(point);
    if (hit) return `${hit[1]}${hit[2]}`.trim();
  }
  return undefined;
}

/** 带单位的数字，用来认出「这一屏演了哪组数」。 */
const NUMERIC = /\d+(?:\.\d+)?\s*(?:ms|毫秒|秒|s|分钟|min|Hz|kHz|V|A|mA|%|字节|KB|MB|GB)/g;

/**
 * 认出这一屏演过的数字例，登记成一行。
 *
 * 只取带单位的数字：裸数字（章节号、序号、年份）当例子会把清单塞满噪声。
 */
export function extractWorkedExample(title: string, keyPoints?: readonly string[]): string | null {
  const text = [title, ...(keyPoints ?? [])].join(' ');
  const nums = [...new Set(text.match(NUMERIC) ?? [])];
  if (nums.length < 2) return null; // 一个数字构不成「推演」
  return `${title}：${nums.slice(0, 4).join(' / ')}`;
}

/** 大纲里跟一致性有关的那几个字段，够用就行。 */
interface OutlineLike {
  id: string;
  title: string;
  keyPoints?: string[];
}

/**
 * 整份大纲 → 课程级只读框架。**一次算定，每屏拿到的是同一份。**
 *
 * 三张表都在这里定，不逐屏累加：累加的东西会随生成顺序漂，
 * 而这三样恰恰是「全课必须一致」的东西——漂了就是要治的病本身。
 *
 * - 类比：整份大纲里第一个认得出的，全课一个口径。
 * - 数字例登记：一个概念只配一组数字。**同名概念只登记第一次出现的那组**，
 *   后面再出现的丢弃——「150ms 推演三遍」就是没有这张表的后果。
 * - 概念引入顺序：大纲顺序即引入顺序。有它，`coherenceDirective` 才发得出
 *   「这些还没讲，别当已知用」那一条（此前这个字段一直没人灌，等于没写）。
 */
export function courseFrameFromOutlines(allOutlines: readonly OutlineLike[]): CourseFrame {
  const frame: CourseFrame = {};

  for (const o of allOutlines) {
    const found = extractAnalogy(o.keyPoints);
    if (found) {
      frame.analogy = found;
      break;
    }
  }

  const registry: Array<{ concept: string; example: string }> = [];
  const claimed = new Set<string>();
  for (const o of allOutlines) {
    const worked = extractWorkedExample(o.title, o.keyPoints);
    // 一个概念只登记一次：第二次出现的同名概念不覆盖，也不追加。
    if (worked && !claimed.has(o.title)) {
      claimed.add(o.title);
      registry.push({ concept: o.title, example: worked.replace(`${o.title}：`, '') });
    }
  }
  if (registry.length) frame.numericExamples = registry;

  const order = allOutlines.map((o) => o.title).filter(Boolean);
  if (order.length) frame.conceptOrder = order;

  return frame;
}

/**
 * 从整份大纲算出这一屏该带的一致性状态。
 *
 * 客户端逐屏路（`fetchSceneContent`）是无状态 HTTP，服务端每次只看见一屏——
 * 但请求里本来就带着 `allOutlines`，前面几屏做过什么从大纲就能算，
 * 不用客户端另外累加一份传上来。
 *
 * 比批量路那个逐屏累加器还准一点：并发预取时同批在飞的屏互相看不见，
 * 累加器会漏；大纲是生成前就定死的，谁在前谁在后不受并发影响。
 *
 * 类比取**整份大纲里第一个**认得出的，不是「当前屏之前」的——
 * 全课统一类比得全课一个口径，第一屏和第五屏必须拿到同一个。
 */
export function coherenceFromOutlines(
  allOutlines: readonly OutlineLike[],
  currentId: string,
): { frame: CourseFrame; progress: CourseProgress } {
  const frame = courseFrameFromOutlines(allOutlines);
  const progress = emptyProgress();
  progress.teachingNow = allOutlines.find((o) => o.id === currentId)?.title;
  for (const o of allOutlines) {
    if (o.id === currentId) break; // 只算前面的屏，当前屏自己不算「已讲过」
    progress.concepts.push(o.title);
    const worked = extractWorkedExample(o.title, o.keyPoints);
    if (worked) progress.workedExamples.push(worked);
  }
  return { frame, progress };
}
