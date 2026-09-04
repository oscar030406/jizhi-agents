/**
 * three 0.185 不再自带 .d.ts，而这个仓库只在知识宇宙那一处用到它的四个符号
 * （CanvasTexture / SpriteMaterial / Sprite / AdditiveBlending）。
 *
 * 只声明用到的这些，不装 `@types/three`：那一包体积不小，还多一条要跟着 three
 * 一起升的版本线，而三维渲染在这个产品里就这一处。**哪天 three 被第二个地方用到，
 * 就换成 `@types/three` 并删掉本文件**——继续往这里加符号只会攒出一份跟不上游的假类型。
 */
declare module 'three' {
  export const AdditiveBlending: number;
  export class CanvasTexture {
    constructor(canvas: HTMLCanvasElement);
  }
  export class SpriteMaterial {
    constructor(parameters: {
      map?: CanvasTexture;
      color?: string;
      blending?: number;
      depthWrite?: boolean;
      transparent?: boolean;
    });
  }
  export class Sprite {
    constructor(material: SpriteMaterial);
    scale: { set(x: number, y: number, z: number): void };
  }
}
