/**
 * Domain SSOT 的三件新工具：学习者可见性（双保险）、一次性库约定、展示名截断。
 * 钉住的是两次真事故：fullpath-probe 漏进学习者下拉；正经库名被模糊匹配误伤。
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyDomainRegistry,
  isLearnerVisible,
  isScratchCorpus,
  parseDomainRegistry,
  truncateLabel,
} from '@/lib/knowledge/domain-registry';

afterEach(() => applyDomainRegistry(null));

describe('isScratchCorpus', () => {
  it('约定命中：probe/test/tmp/scratch 前后缀', () => {
    for (const n of ['fullpath-probe', 'x-test', 'tmp-abc', 'scratch-1', 'probe-x']) {
      expect(isScratchCorpus(n)).toBe(true);
    }
  });
  it('不误伤正经库名（protein-design、smart-manufacturing、latest）', () => {
    for (const n of ['protein-design', 'smart-manufacturing', 'latest', 'contest-prep']) {
      expect(isScratchCorpus(n)).toBe(false);
    }
  });
});

describe('isLearnerVisible', () => {
  it('eligible 且非一次性库才可见；未登记不可见', () => {
    applyDomainRegistry(
      parseDomainRegistry({
        domains: {
          'smart-manufacturing': { label: '智能制造技能培训', eligible: true },
          'fullpath-probe': { eligible: true },
          'cold-chain': { eligible: false },
        },
      }),
    );
    expect(isLearnerVisible('smart-manufacturing')).toBe(true);
    expect(isLearnerVisible('fullpath-probe')).toBe(false);
    expect(isLearnerVisible('cold-chain')).toBe(false);
    expect(isLearnerVisible('never-registered')).toBe(false);
  });
});

describe('truncateLabel', () => {
  it('CJK 按全角计，超限加省略号，不超原样', () => {
    expect(truncateLabel('智能制造技能培训：PLC 编程与机器人操作', 8)).toBe('智能制造技能培训…');
    expect(truncateLabel('时序数据库 IoTDB', 16)).toBe('时序数据库 IoTDB');
  });
});
