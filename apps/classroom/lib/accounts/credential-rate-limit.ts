import { isIP } from 'node:net';

export type CredentialAttemptResult<T> =
  | { kind: 'success'; value: T }
  | { kind: 'failed' }
  | { kind: 'blocked'; retryAfterSeconds: number };

export type CredentialAdmissionResult =
  | { kind: 'allowed' }
  | { kind: 'blocked'; retryAfterSeconds: number };

interface FailureState {
  failures: number;
  expiresAt: number;
}

interface QueueEntry {
  tail: Promise<void>;
  pending: number;
}

export interface CredentialLimiterOptions {
  subjectFailureLimit: number;
  sourceFailureLimit: number;
  windowMs: number;
  maxTrackedEntries: number;
  maxQueuedPerAxis: number;
}

const DEFAULT_OPTIONS: CredentialLimiterOptions = {
  subjectFailureLimit: 5,
  sourceFailureLimit: 50,
  windowMs: 15 * 60 * 1000,
  maxTrackedEntries: 10_000,
  maxQueuedPerAxis: 32,
};

/** 只信任反向代理覆盖的单值来源头；客户端可追加的 X-Forwarded-For 不参与分桶。 */
export function trustedRequestSource(headers: Pick<Headers, 'get'>): string {
  const realIp = headers.get('x-real-ip')?.trim() ?? '';
  return isIP(realIp) ? realIp : 'unknown';
}

/**
 * 两轴失败计数：账户/敏感操作主体用于精准封禁，来源轴用于阻断换用户名撞库。
 * Map 满时只淘汰最久未更新项；队列按两个轴同时设上限，不会因键容量耗尽锁死全站。
 */
export class CredentialLimiter {
  private readonly subjectFailures = new Map<string, FailureState>();
  private readonly sourceFailures = new Map<string, FailureState>();
  private readonly queues = new Map<string, QueueEntry>();

  constructor(private readonly options: CredentialLimiterOptions = DEFAULT_OPTIONS) {}

  async attempt<T>(input: {
    namespace: 'login' | 'sensitive';
    subject: string;
    source: string;
    verify: () => Promise<T | null>;
  }): Promise<CredentialAttemptResult<T>> {
    const subjectKey = `${input.namespace}:${input.subject.trim().toLowerCase()}`;
    const sourceKey = `${input.namespace}:${input.source}`;
    const queued = await this.withAxes(
      [`subject:${subjectKey}`, `source:${sourceKey}`],
      async () => {
        const now = Date.now();
        const blocked = this.blocked(subjectKey, sourceKey, now);
        if (blocked) return blocked;

        const value = await input.verify();
        if (value !== null) {
          this.subjectFailures.delete(subjectKey);
          return { kind: 'success' as const, value };
        }

        this.record(this.subjectFailures, subjectKey, now);
        this.record(this.sourceFailures, sourceKey, now);
        return { kind: 'failed' as const };
      },
    );

    return queued ?? { kind: 'blocked', retryAfterSeconds: 1 };
  }

  /** 注册在执行密码哈希前消费额度；成功注册也计数，避免换用户名耗尽 scrypt。 */
  async consume(input: {
    namespace: 'register' | 'demo';
    subject: string;
    source: string;
  }): Promise<CredentialAdmissionResult> {
    const subjectKey = `${input.namespace}:${input.subject.trim().toLowerCase()}`;
    const sourceKey = `${input.namespace}:${input.source}`;
    const queued = await this.withAxes(
      [`subject:${subjectKey}`, `source:${sourceKey}`],
      async () => {
        const now = Date.now();
        const blocked = this.blocked(subjectKey, sourceKey, now);
        if (blocked) return blocked;
        this.record(this.subjectFailures, subjectKey, now);
        this.record(this.sourceFailures, sourceKey, now);
        return { kind: 'allowed' as const };
      },
    );
    return queued ?? { kind: 'blocked', retryAfterSeconds: 1 };
  }

  private blocked(
    subjectKey: string,
    sourceKey: string,
    now: number,
  ): Extract<CredentialAdmissionResult, { kind: 'blocked' }> | null {
    const subject = this.active(this.subjectFailures, subjectKey, now);
    const source = this.active(this.sourceFailures, sourceKey, now);
    const subjectBlocked = subject !== null && subject.failures >= this.options.subjectFailureLimit;
    const sourceBlocked = source !== null && source.failures >= this.options.sourceFailureLimit;
    if (!subjectBlocked && !sourceBlocked) return null;
    return {
      kind: 'blocked',
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (Math.max(subjectBlocked ? subject.expiresAt : 0, sourceBlocked ? source.expiresAt : 0) -
            now) /
            1000,
        ),
      ),
    };
  }

  private active(map: Map<string, FailureState>, key: string, now: number): FailureState | null {
    const state = map.get(key);
    if (!state) return null;
    if (state.expiresAt <= now) {
      map.delete(key);
      return null;
    }
    return state;
  }

  private record(map: Map<string, FailureState>, key: string, now: number): void {
    const current = this.active(map, key, now);
    if (map.has(key)) map.delete(key);
    while (map.size >= this.options.maxTrackedEntries) {
      const oldest = map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    map.set(key, {
      failures: (current?.failures ?? 0) + 1,
      expiresAt: now + this.options.windowMs,
    });
  }

  private async withAxes<T>(keys: string[], operation: () => Promise<T>): Promise<T | null> {
    const uniqueKeys = [...new Set(keys)].sort();
    if (
      uniqueKeys.some(
        (key) => (this.queues.get(key)?.pending ?? 0) >= this.options.maxQueuedPerAxis,
      )
    ) {
      return null;
    }

    const reservations: Array<{
      key: string;
      entry: QueueEntry;
      previous: Promise<void>;
      release: () => void;
    }> = [];
    for (const key of uniqueKeys) {
      const entry = this.queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
      const previous = entry.tail;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      entry.tail = previous.catch(() => undefined).then(() => gate);
      entry.pending += 1;
      this.queues.set(key, entry);
      reservations.push({ key, entry, previous, release });
    }

    await Promise.all(reservations.map(({ previous }) => previous.catch(() => undefined)));
    try {
      return await operation();
    } finally {
      for (const reservation of reservations) {
        reservation.release();
        reservation.entry.pending -= 1;
        if (
          reservation.entry.pending === 0 &&
          this.queues.get(reservation.key) === reservation.entry
        ) {
          this.queues.delete(reservation.key);
        }
      }
    }
  }
}

export const credentialLimiter = new CredentialLimiter();
