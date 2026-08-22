import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { recordUsage, readUsageRecords, type UsageRecordInput } from '@/lib/server/usage-storage';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const llmInput: UsageRecordInput = {
  kind: 'llm',
  source: 'scene-content',
  providerId: 'openai',
  modelId: 'claude-sonnet-4-6',
  modelString: 'openai:claude-sonnet-4-6',
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  },
};

describe('recordUsage — LLM', () => {
  it('appends a jsonl line with token counts and no cost fields', async () => {
    await recordUsage(llmInput, { baseDir: tmpDir });
    const records = await readUsageRecords({ baseDir: tmpDir });
    expect(records).toHaveLength(1);
    expect(records[0].kind).toBe('llm');
    expect(records[0].modelId).toBe('claude-sonnet-4-6');
    expect(records[0].inputTokens).toBe(100);
    expect(records[0].outputTokens).toBe(50);
    // No cost fields exist anymore.
    expect(records[0]).not.toHaveProperty('totalCostUsd');
    expect(records[0]).not.toHaveProperty('costNull');
    expect(records[0].id).toBeTruthy();
    expect(records[0].createdAt).toBeGreaterThan(0);
  });

  it('defaults kind to llm when omitted', async () => {
    const { kind: _omit, ...noKind } = llmInput;
    await recordUsage(noKind, { baseDir: tmpDir });
    const records = await readUsageRecords({ baseDir: tmpDir });
    expect(records[0].kind).toBe('llm');
  });

  it('skips writing when there are no billable tokens', async () => {
    await recordUsage(
      {
        ...llmInput,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          reasoningTokens: 0,
        },
      },
      { baseDir: tmpDir },
    );
    expect(await readUsageRecords({ baseDir: tmpDir })).toHaveLength(0);
  });
});

describe('recordUsage — multimodal (non-token)', () => {
  it('records TTS characters', async () => {
    await recordUsage(
      {
        kind: 'tts',
        unit: 'character',
        source: 'tts',
        providerId: 'minimax-tts',
        modelId: 'speech-2.8-hd',
        modelString: 'minimax-tts:speech-2.8-hd',
        quantity: 1234,
      },
      { baseDir: tmpDir },
    );
    const [r] = await readUsageRecords({ baseDir: tmpDir });
    expect(r.kind).toBe('tts');
    expect(r.quantity).toBe(1234);
    expect(r.unit).toBe('character');
    expect(r.inputTokens).toBe(0);
  });

  it('records image count and video seconds', async () => {
    await recordUsage(
      {
        kind: 'image',
        unit: 'image',
        source: 'image',
        providerId: 'minimax-image',
        modelId: 'image-01',
        modelString: 'minimax-image:image-01',
        quantity: 1,
      },
      { baseDir: tmpDir },
    );
    await recordUsage(
      {
        kind: 'video',
        unit: 'second',
        source: 'video',
        providerId: 'minimax-video',
        modelId: 'MiniMax-Hailuo-2.3',
        modelString: 'minimax-video:MiniMax-Hailuo-2.3',
        quantity: 6,
      },
      { baseDir: tmpDir },
    );
    const records = await readUsageRecords({ baseDir: tmpDir });
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.kind === 'image')?.quantity).toBe(1);
    expect(records.find((r) => r.kind === 'video')?.quantity).toBe(6);
  });

  it('skips non-token usage with quantity <= 0', async () => {
    await recordUsage(
      {
        kind: 'image',
        unit: 'image',
        source: 'image',
        providerId: 'minimax-image',
        modelId: 'image-01',
        modelString: 'minimax-image:image-01',
        quantity: 0,
      },
      { baseDir: tmpDir },
    );
    expect(await readUsageRecords({ baseDir: tmpDir })).toHaveLength(0);
  });

  it('never throws on a write failure (fire-and-forget)', async () => {
    const filePath = path.join(tmpDir, 'not-a-dir');
    await fs.writeFile(filePath, 'x');
    await expect(recordUsage(llmInput, { baseDir: filePath })).resolves.toBeUndefined();
  });

  // WO-N10：vitest 里 mock 的是模型层，记账层照旧真写，本月账本因此混进 4487 行
  // mock-model-id。守住「测试跑不进生产账本」这条——断言的就是真实生产文件没长。
  it('测试环境下不写生产账本（未指定 baseDir）', async () => {
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const prodFile = path.join(process.cwd(), 'data', 'usage', `${month}.jsonl`);
    const sizeOf = () =>
      fs
        .stat(prodFile)
        .then((s) => s.size)
        .catch(() => -1);

    const before = await sizeOf();
    await recordUsage(llmInput);
    expect(await sizeOf()).toBe(before);
  });
});

describe('readUsageRecords', () => {
  it('returns empty array when no usage dir exists', async () => {
    expect(await readUsageRecords({ baseDir: path.join(tmpDir, 'nope') })).toEqual([]);
  });

  it('treats a legacy row without kind as llm and ignores legacy cost fields', async () => {
    const dir = tmpDir;
    const legacy = {
      id: 'x',
      createdAt: 1,
      source: 'scene-content',
      providerId: 'openai',
      modelId: 'm',
      modelString: 'openai:m',
      inputTokens: 5,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      totalCostUsd: 0.01, // legacy field, must be ignored
    };
    await fs.writeFile(path.join(dir, '2026-01.jsonl'), JSON.stringify(legacy) + '\n');
    const [r] = await readUsageRecords({ baseDir: dir });
    expect(r.kind).toBe('llm');
    expect(r.inputTokens).toBe(5);
  });
});
