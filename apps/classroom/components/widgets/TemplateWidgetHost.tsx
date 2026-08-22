'use client';

import type { TemplateWidgetConfig } from '@/lib/types/widgets';
import AttentionPlayground from './AttentionPlayground';
import BpeMergeStepper from './BpeMergeStepper';
import LayeredGraph from './LayeredGraph';
import ParameterCurve from './ParameterCurve';
import ProcessStepper from './ProcessStepper';
import RagRetrievalPlayground from './RagRetrievalPlayground';
import TemperatureSampler from './TemperatureSampler';
import TradeoffMatrix from './TradeoffMatrix';

/** 模板教具宿主：按 templateId 分发到对应参数化组件（模板池打法：
 * LLM 只填参数，排版与交互数学由组件确定性负责，参数可审计、断网可用）。 */

function body(config: TemplateWidgetConfig) {
  switch (config.templateId) {
    case 'attention_playground':
      return <AttentionPlayground params={config.params} />;
    case 'bpe_merge_stepper':
      return <BpeMergeStepper params={config.params} />;
    case 'temperature_sampler':
      return <TemperatureSampler params={config.params} />;
    case 'rag_retrieval_playground':
      return <RagRetrievalPlayground params={config.params} />;
    case 'parameter_curve':
      return <ParameterCurve params={config.params} />;
    case 'process_stepper':
      return <ProcessStepper params={config.params} />;
    case 'tradeoff_matrix':
      return <TradeoffMatrix params={config.params} />;
    case 'layered_graph':
      return <LayeredGraph params={config.params} />;
  }
}

export default function TemplateWidgetHost({ config }: { config: TemplateWidgetConfig }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <span className="rounded bg-blue-deep/10 px-2 py-0.5 text-xs font-medium text-blue-deep">
          交互教具
        </span>
        <p className="text-sm font-medium">{config.name}</p>
        <span className="ml-auto text-[10px] text-muted-foreground/70">
          参数预制 · 断网可用 · 可审计
        </span>
      </div>
      {config.guide && (
        <p className="border-b border-border bg-muted px-5 py-2.5 text-xs text-muted-foreground">
          试一试：{config.guide}
        </p>
      )}
      <div className="p-5">{body(config)}</div>
    </div>
  );
}
