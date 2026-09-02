'use client';

/**
 * 高危领域的安全提示层（WO-N16 C21）。
 *
 * 涉及实操的领域——带电作业、机械装配、化学品、高温高压——课程里出现的
 * 操作步骤有可能被学习者当成作业依据。我们的生成链有出处、有判官、有复测，
 * 但**它保证的是「教材里这么写」，不是「照这么做是安全的」**：教材可能过时，
 * 现场的设备型号、国标版本、厂商手册都可能与教材不同。
 *
 * 所以挂一条常驻提示，说清两件事：这门课的操作步骤要以现行国标和厂商手册为准；
 * 涉及带电或运动部件的操作要在有资质的人在场时进行。
 *
 * ## 判据来自投料方声明，不猜
 *
 * 显示与否只看接入时管理者勾没勾「涉及实操」（`hands_on_safety`）。
 * 试过从语料里用关键词判——**全军覆没**：ROS2 语料 6 处「带电」命中全是
 * 「性价比接地气」「更直接地」「右侧接地」（电路名词不是安全警告）、
 * 「重启或断电」；主库 3 处是「高温度 Temperature」和「上下文腐蚀」。
 *
 * 关键词认字面不认语境，而安全警示恰恰是语境问题。误判的两个方向都不能接受：
 * 漏标是安全责任，误标是每门 AI 课都顶着「注意触电」——顶两次就没人看了，
 * 那条提示等于不存在（和注入扫描那条误报规则同一个道理）。
 */
import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';

import { loadLearnerProfile } from '@/components/generation/learner-profile-popover';
import { needsSafetyLayer } from '@/lib/knowledge/domain-registry';
import { useDomainRegistryVersion } from '@/lib/knowledge/use-domain-registry';

export function SafetyNotice() {
  // 清单是异步灌注的：拿版本号订阅，灌注落地后重算一次，
  // 否则首帧读到空清单就永远判 false（同族踩过四次的坑）。
  const version = useDomainRegistryVersion();
  const [corpus, setCorpus] = useState<string>('');
  useEffect(() => {
    const frame = window.requestAnimationFrame(() =>
      setCorpus(loadLearnerProfile().corpus?.trim() ?? ''),
    );
    return () => window.cancelAnimationFrame(frame);
  }, []);

  if (!needsSafetyLayer(corpus, version)) return null;

  return (
    <div
      role="note"
      className="flex items-start gap-2.5 border-b border-amber-300/60 bg-amber-50 px-4 py-2.5 text-xs leading-relaxed text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <span>
        <span className="font-medium">这个领域涉及动手操作。</span>
        课程里的操作步骤出自教材，
        <span className="font-medium">以现行国标与设备厂商手册为准</span>
        ——教材可能早于你手上的设备型号与规范版本。带电作业、运动部件调试、
        化学品与高温高压环节，请在有资质的人员在场时进行，不要照着课程内容单独上手。
      </span>
    </div>
  );
}
