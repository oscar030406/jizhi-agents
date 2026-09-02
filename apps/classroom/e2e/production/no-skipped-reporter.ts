import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export default class NoSkippedReporter implements Reporter {
  private readonly skipped: string[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status === 'skipped') this.skipped.push(test.titlePath().join(' > '));
  }

  onEnd(_result: FullResult) {
    if (this.skipped.length === 0) return;
    process.stderr.write(`生产验收禁止 skipped：\n${this.skipped.join('\n')}\n`);
    return { status: 'failed' as const };
  }
}
