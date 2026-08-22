/**
 * redact.ts 自检。跑法：
 *   node lib/privacy/redact.check.mjs
 * （Node ≥22.7 自带 TypeScript 类型剥离与模块语法探测，无需编译、无需框架。）
 *
 * 两组用例：每类 PII 必须被替换；每类"正常技术文本"必须一字不改。
 */
import assert from 'node:assert/strict';
import { redact, redactObject } from './redact.ts';

// ── 该杀的 ────────────────────────────────────────────────────────────────
const HITS = [
  ['手机号', '学员留的联系方式是 13812345678，请回拨', '[手机号]'],
  ['邮箱', '报名邮箱 zhang.san+edu@example.com.cn 已验证', '[邮箱]'],
  ['身份证18', '证件号 11010519900307551X 核验通过', '[身份证]'],
  ['身份证15', '旧证号 110105900307551 也要脱敏', '[身份证]'],
  ['学号', '学号：2023110233 已入班', '[学号]'],
  ['学号英文', 'studentId=A20231102 绑定成功', '[学号]'],
  ['姓名标签', '姓名：张三丰 报名成功', '[姓名]'],
  ['姓名称谓', '王小明同学的答题正确率 0.62', '[姓名]'],
  ['密钥', '用 sk-abc123DEF456ghi789 调用失败', '[密钥]'],
  ['Bearer', 'header: Bearer eyJhbGciOiJIUzI1NiJ9', '[密钥]'],
  ['Windows 路径', '写入 D:\\UserData\\Desktop\\挑战杯\\out.json 完成', '[路径]'],
  ['POSIX 路径', 'cache at /home/lizexin/.cache/maic 已建立', '[路径]'],
];

for (const [label, input, placeholder] of HITS) {
  const out = redact(input);
  assert.ok(out.includes(placeholder), `${label}: 未替换 → ${out}`);
  // 原文里被替换掉的那一段不该残留
  assert.notEqual(out, input, `${label}: 输出与输入相同 → ${out}`);
}

// 具体形状抽查（防止规则改坏后仍"含占位符"但吃掉了别的内容）
assert.equal(redact('联系 13812345678'), '联系 [手机号]');
assert.equal(redact('姓名：李雷'), '姓名：[姓名]');
assert.equal(redact('学号: 20231102'), '学号: [学号]');

// ── 不该误伤的 ────────────────────────────────────────────────────────────
const KEEPS = [
  '测验正确率 0.62，门禁阈值 PUBLISH_FLOOR=0.62',
  '幻觉率 0.10 低于上限 HALLUCINATION_CEILING',
  '服务监听 127.0.0.1:8001，超时 8000ms',
  'top_k=6，返回 6 个证据块，耗时 1234ms',
  'RAG 与 Agent 的差异见 arXiv:2005.11401',
  '时间戳 1753749600000 与秒级 1753749600 都不是身份证',
  '请求 https://api.siliconflow.cn/v1/chat/completions 返回 200',
  '数学老师和班主任老师都参与了盲测',
  '版本 v1.2.3-rc4，commit 9f3a2b1',
  '相对路径 lib/privacy/redact.ts 不是绝对路径',
];

for (const text of KEEPS) {
  assert.equal(redact(text), text, `误伤：${text} → ${redact(text)}`);
}

// ── 边界 ──────────────────────────────────────────────────────────────────
assert.equal(redact(''), '');
assert.equal(redact(/** @type {any} */ (null)), '');

// ── redactObject ─────────────────────────────────────────────────────────
const cyclic = { note: '联系 13812345678' };
cyclic.self = cyclic;
const redacted = redactObject({
  apiKey: 'whatever-shape-this-is',
  GROUNDING_TOKEN: 'demo-internal-token',
  profile: { role: '在校学生', programming_level: 2, contact: 'a@b.com' },
  history: ['学号：2023110233', '正确率 0.62'],
  nested: cyclic,
});

assert.equal(redacted.apiKey, '[密钥]');
assert.equal(redacted.GROUNDING_TOKEN, '[密钥]');
assert.equal(redacted.profile.role, '在校学生');
assert.equal(redacted.profile.programming_level, 2, '数字必须保持数字类型');
assert.equal(redacted.profile.contact, '[邮箱]');
assert.deepEqual(redacted.history, ['学号：[学号]', '正确率 0.62']);
assert.equal(redacted.nested.self, '[循环引用]');
assert.equal(redactObject(42), 42);
assert.equal(redactObject(null), null);

console.log(`redact 自检通过：${HITS.length} 类 PII、${KEEPS.length} 条不误伤用例、redactObject 8 项断言`);
