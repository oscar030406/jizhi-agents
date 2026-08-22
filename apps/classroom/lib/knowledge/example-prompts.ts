/**
 * 造课卡示例提示词的读取层。与 `domain-labels.ts` 同一套查表顺序：
 * **域注册清单 → 历史库硬编码表 → 通用示例**。
 *
 * 为什么示例要跟着知识库走：示例是一键填进需求框的，点了就生成。示例主题必须是当前库里
 * 真讲得动的，否则生成出来是「资料不足」——示例本身要诚实。
 *
 * 新库的示例由引擎在建库时写进 `domain_registry.json` 的 `examples`。下面这张表是
 * 2026-08-21 之前四个库的原文（从 `app/page.tsx` 平移过来），留作历史兜底；
 * 新加库不要往这张表里加行，那等于把「加库要改前端代码」又请回来。
 */

import { domainRegistryEntry } from '@/lib/knowledge/domain-registry';

/** 历史库示例（清单出现之前就在页面上的四份）。 */
const LEGACY_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  ai: [
    '给零基础转行学员讲清楚 RAG 检索增强生成，配可运行示例',
    '为后端工程师设计一节 Agent 工具调用实战课',
    '零基础的 Python 第一课，用生活类比讲清变量与循环',
  ],
  iotdb: [
    '给运维新人讲清楚时序数据库的核心概念与典型场景',
    '设计一节 IoTDB 数据写入与查询入门课，配语句示例',
    '面向工程师讲解时序数据的存储模型与压缩机制',
  ],
  odoo: [
    '给转岗学员讲清楚企业管理系统里的库存与调拨流程',
    '设计一节 Odoo 销售到开票的业务流程入门课',
    '面向实施顾问讲解制造模块的物料清单与生产工单',
  ],
  embodied: [
    '给零基础学员讲清楚 ROS2 的节点与话题通信',
    '设计一节 VLA 视觉-语言-动作模型的入门课',
    '面向工程师讲解机器人系统的感知与控制闭环',
  ],
};

/**
 * 通用示例：清单没给、历史表也没有的库走这里。
 *
 * 不能拿 ai 那三条顶——它们点名讲 RAG / Agent / Python，在一个冷链仓储库里点下去
 * 就是生成一门查无此料的课。所以通用示例只描述**教学要求**，主题留空让人自己填：
 * 换任何库都不会说谎。
 */
const GENERIC_EXAMPLES: readonly string[] = [
  '从这个知识库里挑一个入门主题，给零基础学员讲清楚，配可操作的例子',
  '面向有一年经验的从业者，设计一节讲透核心概念与常见误区的课',
  '用生活类比讲清这个领域里最容易被讲糊的那个概念',
];

/**
 * 某个知识库的造课示例提示词。
 *
 * `corpus` 没传（画像「跟随培训领域」）时按 ai 处理——那是生成入口的既有默认。
 * 返回的数组永远非空。
 */
export function examplePromptsFor(corpus?: string): readonly string[] {
  const name = corpus?.trim() || 'ai';
  const fromRegistry = domainRegistryEntry(name)?.examples;
  if (fromRegistry && fromRegistry.length > 0) return fromRegistry;
  return LEGACY_EXAMPLES[name] ?? GENERIC_EXAMPLES;
}
