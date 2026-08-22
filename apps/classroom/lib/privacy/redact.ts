/**
 * 日志与导出脱敏（赛题第五(5)款「交互记录脱敏处理」的可执行部分）。
 *
 * 纯函数、无依赖、无副作用：把可能出现的个人信息替换成占位符，再写日志或导出。
 * 设计原则是**宁可漏杀不可错杀**——误伤正常技术文本会让日志失去排障价值，
 * 所以学号/姓名一律要求有标签或姓氏前缀，不对裸数字做启发式猜测。
 *
 * 自检：`node lib/privacy/redact.check.mjs`（覆盖每类 PII + 不该误伤的用例）。
 */

export interface RedactRule {
  /** 规则名，出现在文档与自检里 */
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * 规则顺序有意义：先吃掉整段结构化串（密钥/邮箱/证件号），再处理更短的数字模式，
 * 最后兜底绝对路径。
 *
 * ponytail: 只覆盖中国大陆常见格式（手机号 1[3-9]、18/15 位身份证）。
 * 需要国际号码/护照号时按同样形状加一条规则即可。
 */
export const RULES: readonly RedactRule[] = [
  // API Key / Bearer token：日志里最常见的真泄漏
  { name: 'apiKey', pattern: /\b(?:sk|pk|ak)-[A-Za-z0-9_-]{12,}/g, replacement: '[密钥]' },
  {
    name: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: 'Bearer [密钥]',
  },
  // 邮箱要先于手机号处理：邮箱本地部分可能含 11 位数字
  {
    name: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: '[邮箱]',
  },
  // 身份证：18 位（末位可为 X）与 15 位旧号，前后不能再接数字
  { name: 'idCard18', pattern: /(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g, replacement: '[身份证]' },
  { name: 'idCard15', pattern: /(?<![\dA-Za-z])\d{15}(?![\dA-Za-z])/g, replacement: '[身份证]' },
  { name: 'phoneCN', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, replacement: '[手机号]' },
  // 学号/工号只认带标签的写法。裸数字串不猜——时间戳、端口、token 数都是裸数字。
  {
    name: 'studentId',
    pattern: /((?:学号|工号|准考证号|student[_\s-]?id|studentId)\s*[:：=]\s*)[A-Za-z0-9-]{4,24}/gi,
    replacement: '$1[学号]',
  },
  // 姓名：带字段标签的写法
  {
    name: 'nameLabeled',
    pattern: /((?:真实姓名|学员姓名|联系人|姓名|户名)\s*[:：=]\s*)[\u4e00-\u9fa5·]{2,10}/g,
    replacement: '$1[姓名]',
  },
  // 姓名：百家姓 + 称谓。限定姓氏首字，避免「数学老师」「班主任老师」被误伤。
  {
    name: 'nameHonorific',
    pattern:
      /[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜谢邹苏潘葛范彭鲁韦马苗方俞任袁柳唐罗薛雷贺倪汤黄林高梁宋郭董萧程邓刘卢蔡贾丁叶阎余杜戴夏钟田姚谭廖熊陆郝白崔康毛邱江史顾侯邵孟龙万段尹黎易常武乔赖龚文][\u4e00-\u9fa5]{1,2}(同学|老师|先生|女士|学员)/g,
    replacement: '[姓名]$1',
  },
  // 绝对路径：会泄漏本机用户名。前置 (?<![A-Za-z0-9]) 保证不吃掉 http:// 里的 "p://"
  {
    name: 'winPath',
    pattern: /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`)\],;]*/g,
    replacement: '[路径]',
  },
  {
    name: 'posixPath',
    pattern: /\/(?:home|Users|root)\/[^\s"'`)\],;]*/g,
    replacement: '[路径]',
  },
];

/** 把一段文本里的可识别个人信息替换为占位符。非字符串输入原样返回空串。 */
export function redact(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  return RULES.reduce(
    (acc, rule) => acc.replace(rule.pattern, rule.replacement),
    text,
  );
}

/** 键名本身就说明是敏感值时，整值抹掉——值可能不是我们认识的格式。 */
const SECRET_KEY_RE = /(api[_-]?key|access[_-]?key|secret|password|passwd|token|authorization|cookie)/i;

/**
 * 递归脱敏任意 JSON 结构：字符串走 {@link redact}，敏感键名整值替换为 `[密钥]`，
 * 循环引用返回 `'[循环引用]'`（否则导出日志时会栈溢出）。
 */
export function redactObject(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  // Date 没有可枚举自有属性，逐键重建会变成 {}，序列化后日志里就丢了时间。
  if (value instanceof Date) return value;
  if (seen.has(value)) return '[循环引用]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactObject(item, seen));

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[密钥]' : redactObject(item, seen);
  }
  return out;
}
