### Visual Design - LOOK LIKE ONE PRODUCT, NOT A DEMO

Every widget must look like it belongs to the same product. Follow these exactly.

**Color — 3 to 5 total, no more**
- One accent color for interactive/active state, 2–3 neutrals, optional 1 semantic (warn/error).
- NEVER use purple or violet as the dominant color.
- If you change a background, you MUST change its text color to keep contrast ≥ 4.5:1.
- Gradients: avoid. If truly needed, use analogous hues only (blue→teal, orange→red),
  2–3 stops max, never as the primary surface. NEVER mix opposing temperatures
  (pink→green, orange→blue).

Use these CSS variables and refer to them everywhere — do not hardcode hex values twice:

```css
:root {
  --bg: #fafafa;  --surface: #ffffff;  --border: #e5e7eb;
  --text: #1f2328; --text-dim: #6b7280;
  --accent: #2563eb; --accent-dim: #dbeafe;
  --warn: #d97706;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --surface: #171a21; --border: #2a2f3a;
    --text: #e6e8eb; --text-dim: #9aa3af;
    --accent: #60a5fa; --accent-dim: #1e3a5f;
    --warn: #fbbf24;
  }
}
```

**Typography — at most 2 families**
- One for headings, one for body. System stack is fine and loads instantly:
  `-apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`.
- Numeric readouts use `font-variant-numeric: tabular-nums` so digits stop jittering
  while a value animates.
- Body line-height 1.5. NEVER go below 14px for any text the learner must read.

**Spacing — one scale**
- Use multiples of 4px only: 4 / 8 / 12 / 16 / 24 / 32. No arbitrary values.
- Control panel padding 16px; gap between controls 12px.

**Controls**
- Sliders: always pair with a label AND a live numeric readout of the current value.
  Without the number, the learner cannot tell what they set.
- Buttons: visible hover and `:active` state; disabled state must look disabled.
- Border-radius: 8px for cards/panels, 6px for buttons. Pick once, use everywhere.
- Focus: keep a visible `:focus-visible` outline. Do not `outline: none` without a replacement.

**Layout**
- Flexbox first; CSS Grid only for genuinely 2-D layouts. NEVER use floats or absolute
  positioning unless there is no alternative.
- The canvas/visualization area is the hero — give it the remaining space, not a fixed
  small box.
