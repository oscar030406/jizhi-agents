// @vitest-environment jsdom
//
// 外部教具卡的两条边界：概念对不上不展示、演示站不允许内嵌就不给内嵌按钮。
// 这两条错了的后果都不是「样式难看」——前者是在讲注意力的那屏底下挂 RAG 演示，
// 后者是点开一片空白。
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ExternalAidCard,
  aidLicenseNote,
  aidsForConcept,
  demoHost,
  type ExternalAid,
} from '@/components/aids/external-aid-card';

function aid(over: Partial<ExternalAid> = {}): ExternalAid {
  return {
    id: 'poloclub-cnn-explainer',
    concept: 'deep_learning',
    name: '卷积神经网络交互讲解',
    what_it_shows: '把一张图片送进卷积网络后每一层的输出摊开显示。',
    use_in_class: ['选一张示例图片', '点开第一个卷积层', '换张图片对比激活位置'],
    duration_minutes: 10,
    level: 'starter',
    url: 'https://github.com/poloclub/cnn-explainer',
    demo_url: 'https://poloclub.github.io/cnn-explainer/',
    embeddable: true,
    provenance: { license: 'MIT', stars: 9036 },
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(node));
  return container;
}

function clickButton(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) throw new Error(`找不到按钮：${label}`);
  act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('aidsForConcept', () => {
  it('只给同概念的教具', () => {
    const list = [aid(), aid({ id: 'b', concept: 'rag' })];
    expect(aidsForConcept(list, 'deep_learning').map((a) => a.id)).toEqual([
      'poloclub-cnn-explainer',
    ]);
  });

  it('概念为空时给空数组，不退回随便几个', () => {
    expect(aidsForConcept([aid()], null)).toEqual([]);
  });

  it('概念对不上时给空数组', () => {
    expect(aidsForConcept([aid()], 'guardrails')).toEqual([]);
  });
});

describe('aidLicenseNote', () => {
  it.each([
    [{ license: 'MIT' }, '许可证 MIT'],
    [{ license: '无许可证信息' }, '仓库未标注开源许可证'],
    [{ license: 'NOASSERTION' }, '许可证未被 GitHub 识别'],
    [undefined, '仓库未标注开源许可证'],
  ])('%o → %s', (provenance, expected) => {
    expect(aidLicenseNote(aid({ provenance }))).toBe(expected);
  });
});

describe('demoHost', () => {
  it('取域名，拿不到就空字符串', () => {
    expect(demoHost('https://poloclub.github.io/cnn-explainer/')).toBe('poloclub.github.io');
    expect(demoHost(null)).toBe('');
    expect(demoHost('不是网址')).toBe('');
  });
});

describe('ExternalAidCard', () => {
  it('渲染名称、说明、操作单、许可证与星数', () => {
    const text = render(<ExternalAidCard aid={aid()} />).textContent ?? '';
    expect(text).toContain('卷积神经网络交互讲解');
    expect(text).toContain('把一张图片送进卷积网络');
    expect(text).toContain('换张图片对比激活位置');
    expect(text).toContain('许可证 MIT');
    expect(text).toContain('GitHub 9036 星');
    expect(container.querySelectorAll('ol > li')).toHaveLength(3);
  });

  it('演示站允许内嵌时才给「在这里打开」，点开后挂 iframe 并点名第三方站点', () => {
    render(<ExternalAidCard aid={aid()} />);
    expect(container.querySelector('iframe')).toBeNull();

    clickButton('在这里打开');
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('https://poloclub.github.io/cnn-explainer/');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin');
    expect(frame?.getAttribute('height')).toBe('480');
    expect(container.textContent).toContain('这是第三方站点 poloclub.github.io，内容不由本站生成');

    clickButton('收起');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('演示站不允许内嵌时只给外链，没有内嵌按钮', () => {
    render(<ExternalAidCard aid={aid({ embeddable: false })} />);
    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).not.toContain('在这里打开');
    const link = container.querySelector('a[href="https://poloclub.github.io/cnn-explainer/"]');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('没有演示站时连「打开演示」都不给', () => {
    render(<ExternalAidCard aid={aid({ demo_url: null, embeddable: false })} />);
    expect(container.textContent).not.toContain('打开演示');
    expect(container.textContent).toContain('源码仓库');
  });
});
