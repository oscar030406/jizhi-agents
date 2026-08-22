'use client';

import { useMemo, useState } from 'react';
import type { CurveFamily, ParameterCurveParams } from '@/lib/types/widgets';

/** 参数曲线：拖滑块改系数，曲线实时变形；开了 showTangent 还能拖 x₀ 看切线斜率。
 * 曲线族是枚举、系数是数字——LLM 写不出任意表达式，所以这里没有 eval，
 * 也不可能被生成端塞进可执行代码（这是选枚举而不是 formula 字符串的唯一原因）。 */

type Coef = { a: number; b: number; c: number };

export function evalCurve(curve: CurveFamily, k: Coef, x: number): number {
  switch (curve) {
    case 'linear':
      return k.a * x + k.b;
    case 'quadratic':
      return k.a * x * x + k.b * x + k.c;
    case 'power':
      return k.a * Math.pow(x, k.b) + k.c;
    case 'exponential':
      return k.a * Math.exp(k.b * x) + k.c;
    case 'logarithmic':
      return k.a * Math.log(x) + k.b;
    case 'logistic':
      return k.a / (1 + Math.exp(-k.b * (x - k.c)));
  }
}

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

function formulaText(curve: CurveFamily, k: Coef): string {
  switch (curve) {
    case 'linear':
      return `y = ${num(k.a)}·x + ${num(k.b)}`;
    case 'quadratic':
      return `y = ${num(k.a)}·x² + ${num(k.b)}·x + ${num(k.c)}`;
    case 'power':
      return `y = ${num(k.a)}·x^${num(k.b)} + ${num(k.c)}`;
    case 'exponential':
      return `y = ${num(k.a)}·e^(${num(k.b)}·x) + ${num(k.c)}`;
    case 'logarithmic':
      return `y = ${num(k.a)}·ln(x) + ${num(k.b)}`;
    case 'logistic':
      return `y = ${num(k.a)} / (1 + e^(-${num(k.b)}·(x − ${num(k.c)})))`;
  }
}

const W = 520;
const H = 220;
const PAD = 34;
const SAMPLES = 121;

export default function ParameterCurve({ params }: { params: ParameterCurveParams }) {
  const [coef, setCoef] = useState<Coef>(params.coefficients);
  const [x0, setX0] = useState(
    (params.xAxis.min + params.xAxis.max) / 2,
  );

  const { points, path, yMin, yMax, toPx } = useMemo(() => {
    const { min: xMin, max: xMax } = params.xAxis;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const x = xMin + ((xMax - xMin) * i) / (SAMPLES - 1);
      const y = evalCurve(params.curve, coef, x);
      // 指数族容易溢出、log/power 在边界会出 NaN——非有限点直接丢，别让整条曲线消失。
      // 还要卡一个量级上限：只判有限不够，1e300 量级的有限值会在下面算留白和
      // (y-lo)/(hi-lo) 时溢出，把 NaN / Infinity 写进 polyline 的 points 和纵轴刻度。
      // 1e15 以上的曲线在一页教具里本来就画不出形状，与 Infinity 同样丢弃。
      if (Number.isFinite(y) && Math.abs(y) < 1e15) pts.push({ x, y });
    }
    const ys = pts.map((p) => p.y);
    let lo = ys.length ? Math.min(...ys) : 0;
    let hi = ys.length ? Math.max(...ys) : 1;
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const px = (x: number) => PAD + ((x - xMin) / (xMax - xMin)) * (W - PAD * 2);
    const py = (y: number) => H - PAD - ((y - lo) / (hi - lo)) * (H - PAD * 2);
    const to = (p: { x: number; y: number }) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`;
    return {
      points: pts,
      path: pts.map(to).join(' '),
      yMin: lo,
      yMax: hi,
      toPx: { px, py },
    };
  }, [params.curve, params.xAxis, coef]);

  // 切线用中心差分：对六个曲线族都成立，比逐族手写导数少五个分支
  const tangent = useMemo(() => {
    if (!params.showTangent) return null;
    const h = (params.xAxis.max - params.xAxis.min) / 400;
    const y0 = evalCurve(params.curve, coef, x0);
    const slope =
      (evalCurve(params.curve, coef, x0 + h) - evalCurve(params.curve, coef, x0 - h)) / (2 * h);
    if (!Number.isFinite(y0) || !Number.isFinite(slope)) return null;
    const span = (params.xAxis.max - params.xAxis.min) * 0.2;
    return {
      y0,
      slope,
      x1: x0 - span,
      y1: y0 - slope * span,
      x2: x0 + span,
      y2: y0 + slope * span,
    };
  }, [params.showTangent, params.curve, params.xAxis, coef, x0]);

  return (
    <div className="space-y-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label={`${params.yAxis.label} 随 ${params.xAxis.label} 变化的曲线`}
      >
        <line
          x1={PAD}
          y1={H - PAD}
          x2={W - PAD}
          y2={H - PAD}
          className="stroke-border"
          strokeWidth={1}
        />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} className="stroke-border" strokeWidth={1} />
        {points.length > 1 && (
          <polyline
            points={path}
            fill="none"
            className="stroke-blue-deep"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        )}
        {tangent && (
          <>
            <line
              x1={toPx.px(tangent.x1)}
              y1={toPx.py(tangent.y1)}
              x2={toPx.px(tangent.x2)}
              y2={toPx.py(tangent.y2)}
              className="stroke-green-deep"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            <circle
              cx={toPx.px(x0)}
              cy={toPx.py(tangent.y0)}
              r={4}
              className="fill-green-deep"
            />
          </>
        )}
        <text x={W - PAD} y={H - 10} textAnchor="end" className="fill-current text-[10px] opacity-60">
          {params.xAxis.label}
        </text>
        <text x={PAD} y={PAD - 12} className="fill-current text-[10px] opacity-60">
          {params.yAxis.label}
        </text>
        <text x={PAD - 4} y={H - PAD} textAnchor="end" className="fill-current text-[9px] opacity-45">
          {num(yMin)}
        </text>
        <text x={PAD - 4} y={PAD + 4} textAnchor="end" className="fill-current text-[9px] opacity-45">
          {num(yMax)}
        </text>
      </svg>

      <p className="font-mono text-xs text-muted-foreground">{formulaText(params.curve, coef)}</p>

      <div className="space-y-2">
        {params.sliders.map((s) => (
          <label key={s.key} className="block text-xs text-muted-foreground">
            {s.label} = {num(coef[s.key])}
            <input
              type="range"
              min={s.min}
              max={s.max}
              step={s.step}
              value={coef[s.key]}
              onChange={(e) => setCoef((c) => ({ ...c, [s.key]: Number(e.target.value) }))}
              className="mt-1 w-full"
            />
          </label>
        ))}
        {params.showTangent && (
          <label className="block text-xs text-muted-foreground">
            切点 {params.xAxis.label} = {num(x0)}
            {tangent && (
              <span className="ml-2 font-mono text-green-deep">斜率 {tangent.slope.toFixed(3)}</span>
            )}
            <input
              type="range"
              min={params.xAxis.min}
              max={params.xAxis.max}
              step={(params.xAxis.max - params.xAxis.min) / 100}
              value={x0}
              onChange={(e) => setX0(Number(e.target.value))}
              className="mt-1 w-full"
            />
          </label>
        )}
      </div>

      <ul className="space-y-1 text-[11px] text-muted-foreground/80">
        {params.observations.map((o, i) => (
          <li key={i}>· {o}</li>
        ))}
      </ul>
    </div>
  );
}
