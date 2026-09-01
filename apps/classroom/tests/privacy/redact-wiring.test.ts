/**
 * redact 的两个接线点必须真的生效：
 * 1. lib/logger.ts —— 所有 createLogger 写出的行（服务端 API 路由把学习目标、
 *    对话轮次这类学习者输入写进日志，见 app/api/compare/route.ts:119）
 * 2. lib/export/practice-guide.ts —— 用户点「导出实操指南」下载的 Markdown 里的画像行
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/lib/logger';
import { summarizeLearnerProfile } from '@/lib/export/practice-guide';
import type { LearnerProfileFields } from '@/lib/types/generation';

function captureLog(fn: () => void): string {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  fn();
  const lines = [...spy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0]));
  return lines.join('\n');
}

type StructuredLogLine = {
  timestamp: string;
  level: string;
  tag: string;
  message: string;
};

function parseStructuredLog(out: string): StructuredLogLine {
  return JSON.parse(out) as StructuredLogLine;
}

const originalLogFormat = process.env.LOG_FORMAT;

beforeEach(() => {
  process.env.LOG_FORMAT = 'json';
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalLogFormat === undefined) {
    delete process.env.LOG_FORMAT;
  } else {
    process.env.LOG_FORMAT = originalLogFormat;
  }
});

describe('logger 接 redact', () => {
  const log = createLogger('RedactWiring');

  it('字符串参数里的手机号被替换', () => {
    const out = captureLog(() => log.info('学员留的联系方式是 13812345678，请回拨'));
    expect(out).toContain('[手机号]');
    expect(out).not.toContain('13812345678');
  });

  it('对象参数走 redactObject：敏感键整值抹掉，值里的邮箱也换掉', () => {
    const out = captureLog(() =>
      log.info('profile:', { apiKey: 'whatever', contact: 'zhang.san@example.com', level: 2 }),
    );
    const record = parseStructuredLog(out);
    const profile = JSON.parse(record.message.slice('profile: '.length)) as Record<string, unknown>;
    expect(out).toContain('[密钥]');
    expect(out).toContain('[邮箱]');
    expect(out).not.toContain('zhang.san@example.com');
    expect(profile).toEqual({ apiKey: '[密钥]', contact: '[邮箱]', level: 2 });
    // 外层结构化日志转义不影响内层对象解析，数字类型不能被改坏。
    expect(typeof profile.level).toBe('number');
  });

  it('对象里的 Date 仍然序列化成时间，不塌成 {}', () => {
    const out = captureLog(() => log.info('job:', { at: new Date('2026-08-15T00:00:00.000Z') }));
    const record = parseStructuredLog(out);
    expect(JSON.parse(record.message.slice('job: '.length))).toEqual({
      at: '2026-08-15T00:00:00.000Z',
    });
  });

  it('Error 只脱敏 message 行，堆栈帧保留', () => {
    const err = new Error('解析失败：13812345678');
    const out = captureLog(() => log.error('boom:', err));
    const record = parseStructuredLog(out);
    expect(out).toContain('[手机号]');
    expect(out).not.toContain('13812345678');
    // JSON 传输层会转义换行；解析后堆栈帧仍是可直接排障的多行文本。
    expect(record.message).toMatch(/\n\s+at /);
  });

  it('正常技术文本一字不改', () => {
    const out = captureLog(() => log.info('服务监听 127.0.0.1:8001，耗时 1234ms'));
    expect(out).toContain('服务监听 127.0.0.1:8001，耗时 1234ms');
  });
});

describe('实操指南导出接 redact', () => {
  it('画像自述里的联系方式不会被写进导出的 Markdown', () => {
    const profile = {
      role: '在职工程师 手机号 13812345678',
      domain: '汽修 联系人：张三丰',
      programming_level: 2,
    } as unknown as LearnerProfileFields;

    const summary = summarizeLearnerProfile(profile);
    expect(summary).toContain('[手机号]');
    expect(summary).toContain('[姓名]');
    expect(summary).not.toContain('13812345678');
    expect(summary).not.toContain('张三丰');
    // 有用的部分保留
    expect(summary).toContain('编程 Lv2');
  });

  it('无画像仍返回空串', () => {
    expect(summarizeLearnerProfile(null)).toBe('');
  });
});
