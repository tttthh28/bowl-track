/**
 * CorraPiano lane core（無 OpenCV）：
 * - select_closest_lines → 多列 |gx| 邊對（溝側優先）
 * - foul／pins 水平邊投票
 * - 交點成四角（唔做 idealBot 強收窄）
 * - Reconstruction 用球底接觸點（見 tracker.ballContactPoint）
 */
import type { LaneCorners, Point2D } from "./types";
import type { LaneDetectResult } from "./laneDetect";

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function clampPt(p: Point2D, w: number, h: number): Point2D {
  return { x: clamp(p.x, 0, w - 1), y: clamp(p.y, 0, h - 1) };
}

function downscaleGray(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  sw: number,
  sh: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(sw * sh);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(height - 1, Math.floor((y / sh) * height));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(width - 1, Math.floor((x / sw) * width));
      const i = (sy * width + sx) * 4;
      out[y * sw + x] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    }
  }
  return out;
}

function gutterFlank(
  gray: Uint8ClampedArray,
  sw: number,
  y: number,
  l: number,
  r: number
): number {
  const row = y * sw;
  const nIn = Math.max(1, r - l - 1);
  let inside = 0;
  for (let x = l + 1; x < r; x++) inside += gray[row + x];
  const flank = Math.max(4, Math.round(sw * 0.04));
  let leftDark = 0;
  let nL = 0;
  for (let x = Math.max(0, l - flank); x < l; x++) {
    leftDark += gray[row + x];
    nL++;
  }
  let rightDark = 0;
  let nR = 0;
  for (let x = r + 1; x <= Math.min(sw - 1, r + flank); x++) {
    rightDark += gray[row + x];
    nR++;
  }
  if (!nL || !nR) return 0;
  return (inside / nIn - leftDark / nL) / 40 + (inside / nIn - rightDark / nR) / 40;
}

/** Corra select_closest + 溝側：允許透視加寬，優先 gutter flank */
function selectClosestGutterPair(
  gray: Uint8ClampedArray,
  sw: number,
  y: number,
  mid: number,
  yFrac: number
): { l: number; r: number; strength: number } | null {
  if (y < 1 || y >= gray.length / sw - 1) return null;
  // 透視：上窄下寬；foul 端可到 ~0.58
  const expectW =
    sw *
    clamp(0.22 + yFrac * 0.22, 0.22, 0.45);
  const maxHalf = expectW * 0.62;
  const minHalf = expectW * 0.32;
  const x0 = Math.max(2, Math.floor(mid - maxHalf));
  const x1 = Math.min(sw - 3, Math.ceil(mid + maxHalf));
  let meanG = 0;
  let nG = 0;
  for (let x = x0; x <= x1; x++) {
    meanG += Math.abs(gray[y * sw + x + 1] - gray[y * sw + x - 1]);
    nG++;
  }
  const thrG = Math.max(12, (nG > 0 ? meanG / nG : 0) * 1.25);
  const leftPeaks: { x: number; g: number }[] = [];
  const rightPeaks: { x: number; g: number }[] = [];
  for (let x = x0; x <= x1; x++) {
    const g = Math.abs(gray[y * sw + x + 1] - gray[y * sw + x - 1]);
    if (g < thrG) continue;
    const gL = Math.abs(gray[y * sw + x] - gray[y * sw + x - 2]);
    const gR = Math.abs(gray[y * sw + x + 2] - gray[y * sw + x]);
    if (g < gL || g < gR) continue;
    if (x < mid) leftPeaks.push({ x, g });
    else rightPeaks.push({ x, g });
  }
  if (!leftPeaks.length || !rightPeaks.length) return null;
  // Corra：近中線優先，但保留較遠強溝峰
  leftPeaks.sort((a, b) => mid - a.x - (mid - b.x) || b.g - a.g);
  rightPeaks.sort((a, b) => a.x - mid - (b.x - mid) || b.g - a.g);
  const Lcand = leftPeaks.slice(0, Math.min(7, leftPeaks.length));
  const Rcand = rightPeaks.slice(0, Math.min(7, rightPeaks.length));
  let bestL: { x: number; g: number } | null = null;
  let bestR: { x: number; g: number } | null = null;
  let bestScore = -1e9;
  for (const L of Lcand) {
    for (const R of Rcand) {
      const w = R.x - L.x;
      if (w < minHalf * 2 || w > maxHalf * 2.1) continue;
      const midPair = (L.x + R.x) / 2;
      const dist = Math.abs(midPair - mid);
      if (dist > sw * 0.12) continue;
      const gutter = gutterFlank(gray, sw, y, L.x, R.x);
      if (gutter < 0.15) continue; // 要有溝暗
      const asym = Math.abs(mid - L.x - (R.x - mid)) / sw;
      const wPen = Math.abs(w - expectW) / sw;
      // 近中線 + 強邊 + 溝暗 − 寬度偏離透視期望
      const score =
        -dist * 5 +
        (L.g + R.g) * 0.08 +
        gutter * 28 -
        asym * 40 -
        wPen * 35;
      if (score > bestScore) {
        bestScore = score;
        bestL = L;
        bestR = R;
      }
    }
  }
  if (!bestL || !bestR) return null;
  const snap = (x0s: number, side: -1 | 1) => {
    let bx = x0s;
    let bg = -1;
    for (let dx = -4; dx <= 4; dx++) {
      const x = x0s + dx;
      if (x < 1 || x >= sw - 1) continue;
      const g = Math.abs(gray[y * sw + x + 1] - gray[y * sw + x - 1]);
      const bias = side < 0 ? -dx * 0.35 : dx * 0.35;
      if (g + bias > bg) {
        bg = g + bias;
        bx = x;
      }
    }
    return bx;
  };
  const l = snap(bestL.x, -1);
  const r = snap(bestR.x, 1);
  if (r - l < minHalf * 2) return null;
  return { l, r, strength: (bestL.g + bestR.g) / 80 };
}

function fitLine(
  ys: number[],
  xs: number[]
): { a: number; b: number } | null {
  const n = ys.length;
  if (n < 2) return null;
  let sy = 0,
    sx = 0,
    syy = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sy += ys[i];
    sx += xs[i];
    syy += ys[i] * ys[i];
    sxy += ys[i] * xs[i];
  }
  const den = n * syy - sy * sy;
  if (Math.abs(den) < 1e-6) return null;
  const b = (n * sxy - sy * sx) / den;
  const a = (sx - b * sy) / n;
  return { a, b };
}

function fitLineRobust(
  ys: number[],
  xs: number[]
): { a: number; b: number; inlierRatio: number } | null {
  const first = fitLine(ys, xs);
  if (!first) return null;
  const res = ys.map((y, i) => Math.abs(xs[i] - (first.a + first.b * y)));
  const sorted = [...res].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 1;
  const thr = Math.max(2.5, med * 2.5);
  const iy: number[] = [];
  const ix: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    if (res[i] <= thr) {
      iy.push(ys[i]);
      ix.push(xs[i]);
    }
  }
  if (iy.length < 3) return { ...first, inlierRatio: iy.length / ys.length };
  const second = fitLine(iy, ix);
  if (!second) return { ...first, inlierRatio: iy.length / ys.length };
  return { ...second, inlierRatio: iy.length / ys.length };
}

/** Black-Lights／Corra：foul 帶水平邊 1D 投票 */
function voteFoulY(gray: Uint8ClampedArray, sw: number, sh: number): number {
  const y0 = Math.floor(sh * 0.72);
  const y1 = Math.floor(sh * 0.94);
  const binH = Math.max(2, Math.round(sh * 0.012));
  const nBins = Math.max(1, Math.ceil((y1 - y0 + 1) / binH));
  const votes = new Float64Array(nBins);
  for (let y = y0; y <= y1; y++) {
    let edge = 0;
    let n = 0;
    const x0 = Math.floor(sw * 0.2);
    const x1 = Math.floor(sw * 0.8);
    for (let x = x0; x < x1; x++) {
      if (y <= 0 || y >= sh - 1) continue;
      edge += Math.abs(gray[(y + 1) * sw + x] - gray[(y - 1) * sw + x]);
      n++;
    }
    const avg = n > 0 ? edge / n : 0;
    const bi = Math.min(nBins - 1, Math.floor((y - y0) / binH));
    votes[bi] += avg;
  }
  let best = 0;
  for (let i = 1; i < nBins; i++) if (votes[i] > votes[best]) best = i;
  return y0 + best * binH + binH / 2;
}

function votePinsY(gray: Uint8ClampedArray, sw: number, sh: number): number {
  const y0 = Math.floor(sh * 0.06);
  const y1 = Math.floor(sh * 0.18);
  let bestY = sh * 0.11;
  let best = -1;
  for (let y = y0; y <= y1; y++) {
    let edge = 0;
    let hi = 0;
    for (let x = Math.floor(sw * 0.3); x < Math.floor(sw * 0.7); x++) {
      if (y > 0 && y < sh - 1) {
        edge += Math.abs(gray[(y + 1) * sw + x] - gray[(y - 1) * sw + x]);
      }
      if (gray[y * sw + x] > 195) hi++;
    }
    const score = edge * 0.02 + hi;
    if (score > best) {
      best = score;
      bestY = y;
    }
  }
  return bestY;
}

/**
 * Corra 風格單幀四角：溝邊對擬合 + foul／pins 交點。
 * 失敗時回 null（交畀亮段路徑）。
 */
export function detectLaneCornersCorra(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): LaneDetectResult | null {
  if (width < 80 || height < 80) return null;
  const scale = Math.min(1, 360 / width);
  const sw = Math.max(48, Math.round(width * scale));
  const sh = Math.max(48, Math.round(height * scale));
  const gray = downscaleGray(rgba, width, height, sw, sh);

  const ys: number[] = [];
  const ls: number[] = [];
  const rs: number[] = [];
  let expectMid = sw * 0.55; // bowling-demo lane15 單道（唔好 0.42→鎖 14）
  for (let y = Math.floor(sh * 0.2); y <= Math.floor(sh * 0.88); y += Math.max(1, Math.round(sh * 0.012))) {
    const yFrac = y / sh;
    const ep = selectClosestGutterPair(gray, sw, y, expectMid, yFrac);
    if (!ep) continue;
    const mid = (ep.l + ep.r) / 2;
    if (Math.abs(mid - expectMid) > sw * 0.07) continue;
    if (mid / sw > 0.62 || mid / sw < 0.45) continue;
    ys.push(y);
    ls.push(ep.l);
    rs.push(ep.r);
    expectMid = expectMid * 0.6 + mid * 0.4;
  }
  if (ys.length < 10) return null;

  const leftFit = fitLineRobust(ys, ls);
  const rightFit = fitLineRobust(ys, rs);
  if (!leftFit || !rightFit) return null;
  if (leftFit.inlierRatio < 0.5 || rightFit.inlierRatio < 0.5) return null;

  let yFoul = voteFoulY(gray, sw, sh);
  let yPins = votePinsY(gray, sw, sh);
  yFoul = clamp(yFoul, sh * 0.74, sh * 0.94);
  yPins = clamp(yPins, sh * 0.07, sh * 0.16);

  const xAt = (fit: { a: number; b: number }, y: number) => fit.a + fit.b * y;
  const bl: Point2D = { x: xAt(leftFit, yFoul), y: yFoul };
  const br: Point2D = { x: xAt(rightFit, yFoul), y: yFoul };
  let tl: Point2D = { x: xAt(leftFit, yPins), y: yPins };
  let tr: Point2D = { x: xAt(rightFit, yPins), y: yPins };

  const botW = br.x - bl.x;
  let topW = tr.x - tl.x;
  if (botW < sw * 0.28 || botW > sw * 0.50 || topW < sw * 0.07 || tl.x >= tr.x) {
    return null;
  }
  // 頂過窄：對稱擴
  if (topW < botW * 0.18) {
    const mid = (tl.x + tr.x) / 2;
    const half = Math.max(topW / 2, botW * 0.12);
    tl = { ...tl, x: mid - half };
    tr = { ...tr, x: mid + half };
    topW = tr.x - tl.x;
  }

  const midBot = (bl.x + br.x) / 2;
  // 單道 mid≈0.50–0.58；太左＝14、太右＝16
  if (midBot / sw > 0.62 || midBot / sw < 0.45) return null;

  const inv = 1 / scale;
  const corners: LaneCorners = {
    tl: clampPt({ x: tl.x * inv, y: tl.y * inv }, width, height),
    tr: clampPt({ x: tr.x * inv, y: tr.y * inv }, width, height),
    br: clampPt({ x: br.x * inv, y: br.y * inv }, width, height),
    bl: clampPt({ x: bl.x * inv, y: bl.y * inv }, width, height),
  };

  const finalBot = corners.br.x - corners.bl.x;
  const finalTop = corners.tr.x - corners.tl.x;
  const ratio = finalTop / Math.max(1, finalBot);
  let confidence = 0.45;
  confidence += 0.2 * Math.min(1, leftFit.inlierRatio);
  confidence += 0.2 * Math.min(1, rightFit.inlierRatio);
  confidence += finalBot / width > 0.4 ? 0.12 : finalBot / width > 0.35 ? 0.06 : 0;
  if (ratio < 0.12 || ratio > 0.55) confidence -= 0.1;
  confidence = clamp(confidence, 0.35, 0.88);

  return {
    corners,
    confidence,
    message: `Corra邊線四角（底寬${((finalBot / width) * 100).toFixed(0)}%）`,
  };
}
