import type { CSSProperties } from 'react';

const CHANGE_SATURATION_CAP = 3;

export function marketChangeHeatStyle(pct: number | undefined): CSSProperties {
  if (pct == null) return {};
  const intensity = Math.min(Math.abs(pct) / CHANGE_SATURATION_CAP, 1);
  const alpha = 0.14 + intensity * 0.52;
  const colorToken = pct >= 0 ? '--gain' : '--loss';
  return {
    backgroundImage: `linear-gradient(135deg, hsl(var(${colorToken}) / ${alpha}) 0%, hsl(var(${colorToken}) / ${alpha * 0.45}) 100%)`,
  };
}

export function correlationHeatStyle(value: number | null): CSSProperties {
  if (value == null) return {};
  const clamped = Math.max(-1, Math.min(1, value));
  const alpha = Math.abs(clamped) * 0.32;
  const colorToken = clamped >= 0 ? '--gain' : '--loss';
  return { backgroundColor: `hsl(var(${colorToken}) / ${alpha})` };
}
