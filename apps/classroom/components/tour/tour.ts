'use client';

/**
 * 引导引擎：driver.js 之上薄薄一层。
 * - 完成状态记 localStorage `jizhi.tour.<id>.v1`，`?tour=<id>` 强制重放。
 * - 开跑前先等锚点出现（课程墙、课堂场景都是异步渲染的），超时丢掉可选步。
 * - 需要亲手点的步：隐藏「下一步」，在被高亮元素上挂一次性捕获监听，点了才前进。
 */

import { driver, type DriveStep, type Driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import './tour.css';

import { AGENT_ART, AGENT_PERSONAS } from '@/components/agents/agent-avatar';
import { TOURS, type TourId, type TourStep } from './tour-steps';

export const tourStorageKey = (id: TourId) => `jizhi.tour.${id}.v1`;

export function isTourDone(id: TourId): boolean {
  try {
    return !!localStorage.getItem(tourStorageKey(id));
  } catch {
    return false;
  }
}

export function markTourDone(id: TourId): void {
  try {
    localStorage.setItem(tourStorageKey(id), new Date().toISOString());
  } catch {
    /* 隐私模式写不进去：下次再进会再引导一遍，不算错 */
  }
}

/** URL 上 `?tour=<id>` 点名要重放哪条。 */
export function requestedTour(): TourId | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('tour');
  return value && value in TOURS ? (value as TourId) : null;
}

function resolveAnchor(step: TourStep): Element | null {
  for (const selector of step.anchor) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** 等所有必需锚点出现；到期后仍缺的可选步丢掉，必需步也只能放弃（不撑一个空引导）。 */
async function waitForSteps(spec: (typeof TOURS)[TourId]): Promise<TourStep[]> {
  const deadline = Date.now() + spec.waitMs;
  for (;;) {
    const missing = spec.steps.filter((s) => !resolveAnchor(s));
    if (missing.length === 0) return spec.steps;
    if (Date.now() > deadline) {
      return spec.steps.filter((s) => resolveAnchor(s));
    }
    await sleep(200);
  }
}

let active: { id: TourId; driver: Driver } | null = null;

export function activeTour(): TourId | null {
  return active?.id ?? null;
}

export function stopTour(): void {
  active?.driver.destroy();
  active = null;
}

function agentHeader(step: TourStep): HTMLElement {
  const persona = AGENT_PERSONAS[step.agent];
  const head = document.createElement('div');
  head.className = 'jz-tour-agent';
  const img = document.createElement('img');
  img.src = AGENT_ART[step.agent].bust;
  img.alt = '';
  const caption = document.createElement('span');
  caption.textContent = `${persona.name} · ${persona.role}`;
  head.append(img, caption);
  return head;
}

/**
 * 启动一条引导。返回是否真的跑起来了（已完成且未强制、或锚点全缺时为 false）。
 */
export async function startTour(id: TourId, opts: { force?: boolean } = {}): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!opts.force && isTourDone(id)) return false;
  if (active) return false;
  const spec = TOURS[id];
  spec.before?.();
  const steps = await waitForSteps(spec);
  if (steps.length === 0 || active) return false;

  // 每步的一次性点击监听：前进 / 完成；退回上一步时摘掉。
  const listeners = new Map<TourStep, { el: Element; fn: (e: Event) => void }>();
  const detach = (step: TourStep) => {
    const rec = listeners.get(step);
    if (rec) rec.el.removeEventListener('click', rec.fn, true);
    listeners.delete(step);
  };

  const finish = () => {
    markTourDone(id);
    for (const step of listeners.keys()) detach(step);
    active = null;
  };

  const driveSteps: DriveStep[] = steps.map((step) => ({
    element: () => resolveAnchor(step) ?? document.body,
    data: { step },
    popover: {
      title: step.title,
      description: step.click ? `${step.text}<span class="jz-tour-hint">点一下它</span>` : step.text,
      side: step.side,
      align: step.align,
      ...(step.click ? { showButtons: ['previous'] as const } : {}),
    },
    onHighlighted: (el) => {
      if (!el || (!step.click && !step.doneOnClick)) return;
      detach(step);
      const fn = (e: Event) => {
        if (step.preventDefault) e.preventDefault();
        if (step.doneOnClick) {
          finish();
          instance.destroy();
          return;
        }
        // 让本次点击先走完（徽标要展开自己的弹层），下一帧再翻页
        setTimeout(() => {
          if (active?.driver === instance) instance.moveNext();
        }, 0);
      };
      el.addEventListener('click', fn, { capture: true, once: true });
      listeners.set(step, { el, fn });
    },
    onDeselected: () => detach(step),
  }));

  const instance = driver({
    steps: driveSteps,
    allowClose: false,
    showProgress: true,
    progressText: '第 {{current}} / {{total}} 步',
    nextBtnText: '下一步',
    prevBtnText: '上一步',
    doneBtnText: '开始自由探索',
    popoverClass: 'jz-tour',
    stagePadding: 6,
    stageRadius: 8,
    overlayOpacity: 0.55,
    // 每步的弹层都是新建的 DOM：把角色胸像与名字插在标题前面
    onPopoverRender: (popover, { state }) => {
      const step = (state.activeStep?.data as { step?: TourStep } | undefined)?.step;
      if (step) popover.wrapper.insertBefore(agentHeader(step), popover.title);
    },
    onDoneClick: () => {
      finish();
      instance.destroy();
    },
  });
  active = { id, driver: instance };
  instance.drive();
  return true;
}
