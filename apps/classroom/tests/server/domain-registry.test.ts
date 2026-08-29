/**
 * 域注册清单的消费路径：清单在 → 学习端认识新库；清单不在 → 全部走原有兜底。
 *
 * 用真文件（临时目录 + `ENGINE_DATA_DIR`），不 mock fs——这一层最容易坏在
 * 「跨应用路径拼错」，假 fs 正好测不出来。课程域归属那一组跑仓库里真实的
 * `data/classrooms/`，因为规则本身是对着这批课定的。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  applyDomainRegistry,
  domainRegistryEntry,
  parseDomainRegistry,
} from '@/lib/knowledge/domain-registry';
import { domainLabel, hasDomainLabel } from '@/lib/knowledge/domain-labels';
import { examplePromptsFor } from '@/lib/knowledge/example-prompts';
import { courseDomainOf, readCourseDomains } from '@/lib/server/course-domains';
import { readDomainRegistry } from '@/lib/server/domain-registry';

const ORIGINAL_ENGINE_DIR = process.env.ENGINE_DATA_DIR;

afterEach(() => {
  applyDomainRegistry(null);
  if (ORIGINAL_ENGINE_DIR === undefined) delete process.env.ENGINE_DATA_DIR;
  else process.env.ENGINE_DATA_DIR = ORIGINAL_ENGINE_DIR;
});

/**
 * 把一份清单写进临时引擎数据目录并指过去。
 * `enginePath()` 的口径是 `<ENGINE_DATA_DIR>/../<引擎相对路径>`，所以 env 指到 `data` 本身，
 * 文件落在 `data/knowledge_base/` 下——与线上目录结构一致。
 * `payload` 传字符串就原样写（用来造坏 json）。
 */
async function withRegistryFile(payload: unknown): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'domain-registry-'));
  const dataDir = path.join(root, 'data');
  await fs.mkdir(path.join(dataDir, 'knowledge_base'), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'knowledge_base', 'domain_registry.json'),
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    'utf-8',
  );
  process.env.ENGINE_DATA_DIR = dataDir;
}

describe('域注册清单：解析', () => {
  it('两种外层形状都收（数组 / 以库名为键的对象）', () => {
    const asArray = parseDomainRegistry({
      generated_at: '2026-08-21T00:00:00Z',
      source_run_id: 'run-1',
      domains: [{ corpus: 'cold-chain', label: '冷链仓储运维' }],
    });
    const asMap = parseDomainRegistry({
      generated_at: '2026-08-21T00:00:00Z',
      source_run_id: 'run-1',
      domains: { 'cold-chain': { label: '冷链仓储运维' } },
    });
    for (const r of [asArray, asMap]) {
      expect(r.entries['cold-chain']?.label).toBe('冷链仓储运维');
      expect(r.generatedAt).toBe('2026-08-21T00:00:00Z');
      expect(r.sourceRunId).toBe('run-1');
    }
  });

  it('坏数据不抛错：整个是 null、条目缺 corpus、字段类型不对', () => {
    expect(parseDomainRegistry(null).entries).toEqual({});
    expect(parseDomainRegistry({ domains: [{ label: '没有库名' }] }).entries).toEqual({});
    const r = parseDomainRegistry({ domains: [{ corpus: 'x', chunks: '很多', examples: 'abc' }] });
    expect(r.entries.x).toMatchObject({ corpus: 'x', chunks: undefined, examples: undefined });
  });
});

describe('域中文名：清单优先，硬编码表兜底，都没有返回原值', () => {
  it('清单里的新库直接上中文名', () => {
    applyDomainRegistry(parseDomainRegistry({ domains: [{ corpus: 'mfg', label: '智能制造' }] }));
    expect(domainLabel('mfg')).toBe('智能制造');
    expect(hasDomainLabel('mfg')).toBe(true);
  });

  it('清单没灌时历史库仍有名字', () => {
    expect(domainLabel('iotdb')).toBe('时序数据库 IoTDB');
  });

  it('清单里的名字压过硬编码表（改名走清单，不用改代码）', () => {
    applyDomainRegistry(parseDomainRegistry({ domains: [{ corpus: 'iotdb', label: '新名字' }] }));
    expect(domainLabel('iotdb')).toBe('新名字');
  });

  it('查不到时返回传进来的那个值本身，不兜底成别的库名', () => {
    expect(domainLabel('brand-new-lib')).toBe('brand-new-lib');
    expect(hasDomainLabel('brand-new-lib')).toBe(false);
    expect(domainLabel()).toBe('人工智能应用开发');
  });
});

describe('示例提示词', () => {
  it('清单给了就用清单的', () => {
    applyDomainRegistry(
      parseDomainRegistry({ domains: [{ corpus: 'mfg', examples: ['讲清楚数控机床坐标系'] }] }),
    );
    expect(examplePromptsFor('mfg')).toEqual(['讲清楚数控机床坐标系']);
  });

  it('清单没有 → 历史库用自己的那份，陌生库用通用示例（不拿 ai 的主题顶）', () => {
    expect(examplePromptsFor('iotdb')[1]).toContain('IoTDB');
    const generic = examplePromptsFor('brand-new-lib');
    expect(generic.length).toBeGreaterThan(0);
    expect(generic.join('')).not.toContain('RAG');
    expect(examplePromptsFor()).toEqual(examplePromptsFor('ai'));
  });

  it('清单里 examples 为空数组时回退，不返回空清单', () => {
    applyDomainRegistry(parseDomainRegistry({ domains: [{ corpus: 'iotdb', examples: [] }] }));
    expect(examplePromptsFor('iotdb')[1]).toContain('IoTDB');
  });
});

describe('读盘', () => {
  it('清单不存在时返回空视图且不抛错（引擎没跑过 ⑧ 站的环境要能启动）', async () => {
    process.env.ENGINE_DATA_DIR = path.join(os.tmpdir(), 'no-such-engine-dir', 'data');
    const r = await readDomainRegistry();
    expect(r.entries).toEqual({});
    expect(domainLabel('mfg')).toBe('mfg');
  });

  it('清单存在时读到并灌进内存视图', async () => {
    await withRegistryFile({
      domains: [{ corpus: 'mfg', label: '智能制造', examples: ['造一课'] }],
    });
    const r = await readDomainRegistry();
    expect(r.entries.mfg?.label).toBe('智能制造');
    expect(domainLabel('mfg')).toBe('智能制造');
    expect(examplePromptsFor('mfg')).toEqual(['造一课']);
  });

  it('文件坏了退回空视图，不留旧清单在内存里冒充真源', async () => {
    applyDomainRegistry(parseDomainRegistry({ domains: [{ corpus: 'mfg', label: '智能制造' }] }));
    await withRegistryFile('{ 这不是 json');
    expect((await readDomainRegistry()).entries).toEqual({});
    expect(domainLabel('mfg')).toBe('mfg');
  });
});

describe('课程域归属：单课规则', () => {
  const scenesCiting = (sid: string) =>
    [{ audit: { sources: [{ source_id: `${sid}#s3` }] } }] as unknown as Parameters<
      typeof courseDomainOf
    >[0]['scenes'];

  it('路径规则只压前缀投票，压不过课程自己记的 corpus', () => {
    // 2026-08-23 改口径。原来是「路径内一律归 ai，压过 corpus」——
    // 那让 c3HH74qwAH（自己记 rag-adv）在域视图里显示成 ai，
    // 与课程自身的出处记录给出两个答案。路径规则存在的理由只是纠正前缀投票误判。
    const withCorpus = {
      scenes: scenesCiting('em01s02'),
      generation: { profile: { corpus: 'rag-adv' } },
    } as Parameters<typeof courseDomainOf>[0];
    expect(courseDomainOf(withCorpus, true)).toBe('rag-adv');
    expect(courseDomainOf(withCorpus, false)).toBe('rag-adv');

    // em 前缀直接归主库（先导语料早已合入主索引），路径内外一致
    const noCorpus = { scenes: scenesCiting('em01s02') } as Parameters<typeof courseDomainOf>[0];
    expect(courseDomainOf(noCorpus, true)).toBe('ai');
    expect(courseDomainOf(noCorpus, false)).toBe('ai');
  });

  it('没有 corpus 字段的存量课按 source_id 前缀归位', () => {
    expect(courseDomainOf({ scenes: scenesCiting('em01s02') }, false)).toBe('ai');
    expect(courseDomainOf({ scenes: scenesCiting('iotdb-quick-start') }, false)).toBe('iotdb');
    expect(courseDomainOf({ scenes: scenesCiting('applications-sales') }, false)).toBe('odoo');
  });

  it('零引用又没有出身记录 → unknown，不冒充主域', () => {
    expect(courseDomainOf({ scenes: [] }, false)).toBe('unknown');
  });
});

describe('课程域归属：跑真实课程目录', () => {
  it('结果与 build-course-domains.mjs 的既有产物一致', async () => {
    const rows = await readCourseDomains();
    expect(Object.keys(rows).length).toBeGreaterThan(0);

    // 路径内的课（大量引具身文档）仍是 ai。
    expect(rows.ygmJ2PpCKb?.domain).toBe('ai');
    // 具身先导课 2026-08-28 已随叙事收敛归档下架，目录里不该再有。
    expect(rows['r-kOa4ogHT']).toBeUndefined();
    expect(rows.zTWuJxehpv).toBeUndefined();
    // c3HH74qwAH / sVnMPbeeXn 是引用已删库（rag-adv / vecdb）的孤儿课，
    // 2026-08-23 随垃圾域清理一并删掉——目录里不该再有它们。
    expect(rows.c3HH74qwAH).toBeUndefined();
    expect(rows.sVnMPbeeXn).toBeUndefined();
    // 标题取 stage.name，首页课程卡直接用（拿路径内在架课验，具身课已下架）。
    expect(rows.ygmJ2PpCKb?.title?.length).toBeGreaterThan(0);
  });

  it('.json.bak 之类的旁落文件不进结果', async () => {
    const rows = await readCourseDomains();
    expect(Object.keys(rows).some((id) => id.includes('.bak'))).toBe(false);
  });
});

describe('示例提示词的形状必须与引擎产物一致', () => {
  it('引擎给的 {prompt, anchor} 对象要被收下，不是静默丢弃', () => {
    // 线上实锤（2026-08-23）：/api/domains 返回 examples 空数组，而盘上有 3 条。
    // 解析器声明成 string[]、按字符串过滤，对象全被滤掉——**没有任何报错**：
    // 清单条数正常、结构正常，就是示例永远为空，查表悄悄回退硬编码。
    applyDomainRegistry(
      parseDomainRegistry({
        corpora: [
          {
            corpus: 'mfg',
            examples: [
              { prompt: '数控机床坐标系怎么定？', anchor: '第2章 2.1 坐标系' },
              { prompt: 'PLC 扫描周期是什么？' },
            ],
          },
        ],
      }),
    );
    const entry = domainRegistryEntry('mfg');
    expect(entry?.examples).toHaveLength(2);
    expect(entry?.examples?.[0]).toEqual({
      prompt: '数控机床坐标系怎么定？',
      anchor: '第2章 2.1 坐标系',
    });
    // 出处可缺省，但有就要留着——它是「这条示例出自哪一章」的唯一记录
    expect(entry?.examples?.[1]).toEqual({ prompt: 'PLC 扫描周期是什么？' });
  });

  it('裸字符串也收——手工改过的清单不该整批消失', () => {
    applyDomainRegistry(
      parseDomainRegistry({ corpora: [{ corpus: 'mfg', examples: ['讲讲伺服电机'] }] }),
    );
    expect(domainRegistryEntry('mfg')?.examples).toEqual([{ prompt: '讲讲伺服电机' }]);
  });

  it('消费方拿到的是字符串，不是 [object Object]', () => {
    // 类型上 readonly string[] 与对象数组结构兼容、tsc 不报错，
    // 直接把对象返回去渲染出来就是 [object Object]。
    applyDomainRegistry(
      parseDomainRegistry({
        corpora: [{ corpus: 'mfg', examples: [{ prompt: '讲讲伺服电机', anchor: '第3章' }] }],
      }),
    );
    const prompts = examplePromptsFor('mfg');
    expect(prompts).toEqual(['讲讲伺服电机']);
    expect(prompts.every((p) => typeof p === 'string')).toBe(true);
  });
});

describe('解析器必须吃得下自己的输出', () => {
  it('/api/domains 返回的 {entries} 形态能被解析回来', () => {
    // 链路上同一份数据有两种形态：引擎产物的 corpora 数组、读取器的 entries 字典。
    // 浏览器灌注走的是后者——解析器只认前者时，拿到满血数据也解析出空清单，
    // 所有查表静默回退兜底（2026-08-23 线上实锤，同族第九例）。
    const engineShape = parseDomainRegistry({
      corpora: [{ corpus: 'mfg', label: '智能制造', examples: [{ prompt: 'ROS2 怎么起节点' }] }],
    });
    // 把它当成 /api/domains 的响应再解析一次，结果必须等价
    const roundTrip = parseDomainRegistry(engineShape);
    expect(Object.keys(roundTrip.entries)).toEqual(['mfg']);
    expect(roundTrip.entries.mfg.label).toBe('智能制造');
    expect(roundTrip.entries.mfg.examples).toEqual([{ prompt: 'ROS2 怎么起节点' }]);
  });
});
