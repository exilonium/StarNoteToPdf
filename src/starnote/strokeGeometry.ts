import type { Rect, StarNotePage, StarNoteShape, StrokePoint } from './types';

export function getPageBounds(page: StarNotePage, includeMargins: boolean): Rect {
  if (includeMargins && page.fullRect && page.fullRect.right > page.fullRect.left) {
    return page.fullRect;
  }
  return page.contentRect;
}

export interface RgbaColor {
  r: number; // 0..1
  g: number; // 0..1
  b: number; // 0..1
  a: number; // 0..1
}

export function argbToRgba(argb: number): RgbaColor {
  const u = argb >>> 0;
  return {
    a: ((u >>> 24) & 0xff) / 255,
    r: ((u >>> 16) & 0xff) / 255,
    g: ((u >>> 8) & 0xff) / 255,
    b: (u & 0xff) / 255,
  };
}

export function rgbaToCss(c: RgbaColor, overrideAlpha?: number): string {
  const a = overrideAlpha !== undefined ? overrideAlpha : c.a;
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${a.toFixed(4)})`;
}

export function multiplyMatrix(m1: number[], m2: number[]): number[] {
  // Both 3x3 row-major arrays: [a, b, tx, c, d, ty, 0, 0, 1]
  return [
    m1[0] * m2[0] + m1[1] * m2[3],
    m1[0] * m2[1] + m1[1] * m2[4],
    m1[0] * m2[2] + m1[1] * m2[5] + m1[2],
    m1[3] * m2[0] + m1[4] * m2[3],
    m1[3] * m2[1] + m1[4] * m2[4],
    m1[3] * m2[2] + m1[4] * m2[5] + m1[5],
    0,
    0,
    1,
  ];
}

export function applyMatrix(m: number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]];
}

export function matrixScale(m: number[]): number {
  const sx = Math.hypot(m[0], m[3]);
  const sy = Math.hypot(m[1], m[4]);
  return (sx + sy) / 2 || 1;
}

export interface TransformedPoint {
  x: number;
  y: number;
  pressure: number;
}

export function transformPoints(points: StrokePoint[], matrix: number[]): TransformedPoint[] {
  return points.map((pt) => {
    const [x, y] = applyMatrix(matrix, pt.x, pt.y);
    return { x, y, pressure: pt.pressure };
  });
}

/**
 * Deduplicate nearly identical consecutive points (e.g. stationary pen down samples).
 */
export function simplifyConsecutive(pts: TransformedPoint[], minDist = 0.35): TransformedPoint[] {
  if (pts.length <= 2) return pts;
  const out: TransformedPoint[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    const cur = pts[i];
    const d = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    if (d >= minDist || i === pts.length - 1) {
      if (d < 0.01 && cur.pressure > prev.pressure) {
        prev.pressure = cur.pressure;
      } else if (d >= minDist || out.length === 1) {
        out.push(cur);
      }
    }
  }
  return out;
}

export function computePointRadius(
  shape: StarNoteShape,
  pressure: number,
  scaleFactor: number
): number {
  const baseWidth = Math.max(0.5, shape.thickness * scaleFactor);
  const brush = shape.brush;
  const hasPressure =
    brush &&
    (brush.brushShape ?? 1) > 0 &&
    (brush.pressureSensitivity ?? 0) > 0 &&
    shape.shapeType !== 15;

  if (!hasPressure) {
    return baseWidth * 0.5;
  }

  const maxP = brush.maxPressure && brush.maxPressure > 0 ? brush.maxPressure : 32767;
  const pNorm = Math.max(0, Math.min(1, pressure / maxP));
  // Centered around median tablet pressure (~0.44) -> 1.0x thickness
  const factor = Math.max(0.32, Math.min(1.35, 0.625 + 0.85 * pNorm));
  return baseWidth * factor * 0.5;
}

/**
 * Build a closed polygon outline (in page coordinates) for a variable-width stroke
 * so both Canvas and vector PDF can fill a smooth pressure-sensitive stroke.
 */
export function buildVariableWidthOutline(
  rawPts: TransformedPoint[],
  shape: StarNoteShape,
  scaleFactor: number
): [number, number][] {
  const pts = simplifyConsecutive(rawPts);
  if (pts.length === 0) return [];
  if (pts.length === 1) {
    const r = computePointRadius(shape, pts[0].pressure, scaleFactor);
    return buildCircle(pts[0].x, pts[0].y, r, 12);
  }
  if (pts.length === 2 && Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) < 0.25) {
    const r = computePointRadius(shape, Math.max(pts[0].pressure, pts[1].pressure), scaleFactor);
    return buildCircle(pts[0].x, pts[0].y, r, 12);
  }

  const n = pts.length;
  const left: [number, number][] = [];
  const right: [number, number][] = [];

  for (let i = 0; i < n; i++) {
    let dx = 0;
    let dy = 0;
    if (i === 0) {
      dx = pts[1].x - pts[0].x;
      dy = pts[1].y - pts[0].y;
    } else if (i === n - 1) {
      dx = pts[n - 1].x - pts[n - 2].x;
      dy = pts[n - 1].y - pts[n - 2].y;
    } else {
      dx = pts[i + 1].x - pts[i - 1].x;
      dy = pts[i + 1].y - pts[i - 1].y;
    }
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const r = computePointRadius(shape, pts[i].pressure, scaleFactor);
    left.push([pts[i].x + nx * r, pts[i].y + ny * r]);
    right.push([pts[i].x - nx * r, pts[i].y - ny * r]);
  }

  // Round endcaps
  const startCap = buildArcCap(
    pts[0].x,
    pts[0].y,
    computePointRadius(shape, pts[0].pressure, scaleFactor),
    Math.atan2(right[0][1] - pts[0].y, right[0][0] - pts[0].x),
    Math.atan2(left[0][1] - pts[0].y, left[0][0] - pts[0].x),
    6
  );

  const endIdx = n - 1;
  const endCap = buildArcCap(
    pts[endIdx].x,
    pts[endIdx].y,
    computePointRadius(shape, pts[endIdx].pressure, scaleFactor),
    Math.atan2(left[endIdx][1] - pts[endIdx].y, left[endIdx][0] - pts[endIdx].x),
    Math.atan2(right[endIdx][1] - pts[endIdx].y, right[endIdx][0] - pts[endIdx].x),
    6
  );

  const outline: [number, number][] = [];
  outline.push(...startCap);
  outline.push(...left);
  outline.push(...endCap);
  for (let i = right.length - 1; i >= 0; i--) {
    outline.push(right[i]);
  }
  return outline;
}

function buildCircle(cx: number, cy: number, r: number, steps: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

function buildArcCap(
  cx: number,
  cy: number,
  r: number,
  fromAngle: number,
  toAngle: number,
  steps: number
): [number, number][] {
  let diff = toAngle - fromAngle;
  while (diff < 0) diff += Math.PI * 2;
  while (diff > Math.PI * 2) diff -= Math.PI * 2;
  if (diff > Math.PI + 0.05) {
    diff = diff - Math.PI * 2;
  }
  const out: [number, number][] = [];
  for (let i = 1; i < steps; i++) {
    const a = fromAngle + (diff * i) / steps;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}
