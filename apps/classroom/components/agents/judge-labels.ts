/**
 * 审核面板的对外称谓：模型串 → 「审核智能体甲（通义系）」。
 *
 * 为什么单独成文件：这套口径此前在三处各写一份——/agents 页（vendorFamily +
 * judgePanelLabel）、公共页审核抓错区（judgeRole，只有甲/乙没有厂商系）、
 * 课堂角标弹层（干脆裸渲完整模型 id）。同一件事三种写法，改一处必分叉。
 * 现在三处都从这里取，新增第四处也只能从这里取。
 *
 * 口径规则：
 * - 序号按**审核面板顺序**（judgeModels 数组下标）叫甲 / 乙 / 3、4…，不按模型名排；
 * - 厂商只到「族」：异厂商配置本身是要透明的（两个判官不同源才有交叉验证的意义），
 *   具体型号收进「详情」折叠（追问时要答得出），且只留模型本名——
 *   `siliconflow:` 这类供应商/路由前缀是内部代号，任何情况下不上屏；
 * - 认不出的厂商如实标「第三方模型」，不猜。
 */

/** 模型串 → 厂商族。认不出就如实说不认识，不猜。 */
export function vendorFamily(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('qwen')) return '通义系';
  if (m.includes('deepseek')) return 'DeepSeek 系';
  if (m.includes('minimax') || m.includes('abab')) return 'MiniMax 系';
  if (m.includes('glm') || m.includes('zhipu')) return '智谱系';
  return '第三方模型';
}

/** 面板顺序 → 审核智能体称谓（不含厂商族） */
export function judgeRole(index: number): string {
  return index === 0 ? '审核智能体甲' : index === 1 ? '审核智能体乙' : `审核智能体${index + 1}`;
}

/** 面板顺序 + 模型串 → 「审核智能体甲（通义系）」 */
export function judgeLabel(model: string, index: number): string {
  return `${judgeRole(index)}（${vendorFamily(model)}）`;
}

/** 整组判官 → 「审核智能体甲（通义系）、审核智能体乙（DeepSeek 系）」 */
export function judgePanelLabel(models: readonly string[]): string {
  return models.map(judgeLabel).join('、');
}

/**
 * 分歧轨迹里的一条「模型名 → 判定」换成「审核智能体甲 → 判定」。
 *
 * 新数据不需要这一道了：`lib/generation/hallucination-audit.ts` 的 `crossValidate`
 * 从 2026-08-17 起在写入处就只写面板称谓，模型串根本不进字符串。
 * 这个函数留着是为**历史数据**——08-17 之前落盘的审核记录里模型名还嵌在里面，
 * 不迁移，靠渲染时抹（课堂角标弹层当初就是漏了这一道才把完整模型 id 摆上屏）。
 * 没有 ` → ` 分隔符的旧格式当成纯判定处理，不丢内容。
 */
export function maskJudgeVerdict(entry: string, index: number): string {
  const at = entry.indexOf(' → ');
  const tail = at >= 0 ? entry.slice(at + 3) : entry;
  return `${judgeRole(index)} → ${tail}`;
}

/** 仲裁模型 → 「仲裁（通义系）」 */
export function arbiterLabel(model: string): string {
  return `仲裁（${vendorFamily(model)}）`;
}

/**
 * 只留模型本名，去掉路由前缀与命名空间：
 * `siliconflow:Qwen/Qwen3.6-35B-A3B` → `Qwen3.6-35B-A3B`。
 * 被追问「用的什么判官」时要答得出具体型号，但供应商前缀是内部路由代号，对外无意义。
 */
export function modelName(model: string): string {
  return model.split(/[:/]/).filter(Boolean).pop() ?? model;
}

/**
 * 「详情」折叠里的行：称谓 + 脱敏后的模型型号。
 * 只在用户主动展开时渲染，默认不糊脸。
 */
export function modelDetailRows(
  judgeModels: readonly string[],
  arbiterModel?: string,
): Array<{ role: string; model: string }> {
  const rows = judgeModels.map((m, i) => ({ role: judgeLabel(m, i), model: modelName(m) }));
  if (arbiterModel) rows.push({ role: arbiterLabel(arbiterModel), model: modelName(arbiterModel) });
  return rows;
}
