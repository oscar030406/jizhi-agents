import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentPromptBus } from '@/components/edit/agent-prompt-bus';

describe('agent-prompt-bus', () => {
  beforeEach(() => {
    useAgentPromptBus.getState().clear();
  });

  it('send() publishes to subscribers, clear() resets pending', () => {
    const seen: (string | null)[] = [];
    const unsub = useAgentPromptBus.subscribe((s) => seen.push(s.pending));

    useAgentPromptBus.getState().send('修复第 3 页的错误');
    expect(useAgentPromptBus.getState().pending).toBe('修复第 3 页的错误');
    expect(seen).toEqual(['修复第 3 页的错误']);

    useAgentPromptBus.getState().clear();
    expect(useAgentPromptBus.getState().pending).toBeNull();
    expect(seen).toEqual(['修复第 3 页的错误', null]);
    unsub();
  });

  it('unsubscribed listeners stop receiving', () => {
    const spy = vi.fn();
    const unsub = useAgentPromptBus.subscribe(spy);
    unsub();
    useAgentPromptBus.getState().send('x');
    expect(spy).not.toHaveBeenCalled();
  });
});
