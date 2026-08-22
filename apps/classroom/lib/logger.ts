import { redact, redactObject } from '@/lib/privacy/redact';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

function getMinLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return env in LOG_LEVELS ? (env as LogLevel) : 'info';
}

function isJsonFormat(): boolean {
  return process.env.LOG_FORMAT === 'json';
}

/**
 * Error 只脱敏 message 那一行，堆栈帧原样保留——帧里是代码位置不是用户数据，
 * 抹掉就没法排障。
 *
 * ponytail: 天花板是「错误对象只脱敏第一行」。如果哪天有人把用户输入拼进
 * 多行 message，那几行不会被覆盖，届时在 throw 处先 redact 再抛。
 */
function formatError(e: Error): string {
  const text = e.stack ?? e.message;
  const nl = text.indexOf('\n');
  return nl === -1 ? redact(text) : redact(text.slice(0, nl)) + text.slice(nl);
}

function formatLine(level: LogLevel, tag: string, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const upperLevel = level.toUpperCase();
  // 写日志前统一过脱敏：调用点里带着学习目标、对话内容、画像自述等学习者输入
  // （例：app/api/compare/route.ts 把 learningGoal 原样写进 info 行）。
  const msg = args
    .map((a) =>
      a instanceof Error
        ? formatError(a)
        : typeof a === 'string'
          ? redact(a)
          : JSON.stringify(redactObject(a)),
    )
    .join(' ');

  if (isJsonFormat()) {
    return JSON.stringify({ timestamp, level: upperLevel, tag, message: msg });
  }
  return `[${timestamp}] [${upperLevel}] [${tag}] ${msg}`;
}

export function createLogger(tag: string) {
  const emit = (level: LogLevel, args: unknown[]) => {
    if (LOG_LEVELS[level] < LOG_LEVELS[getMinLevel()]) return;

    const line = formatLine(level, tag, args);

    // Console output
    const fn =
      level === 'debug'
        ? console.debug
        : level === 'warn'
          ? console.warn
          : level === 'error'
            ? console.error
            : console.log;
    fn(line);
  };

  return {
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
  };
}
