/**
 * CorraPiano-style Hough L/R gutter detection (no OpenCV).
 * Geometry + gradient edges only — does NOT key off green/red UI paint.
 *
 * Pipeline:
 *  1. grayscale + |gx|/|gy| edges (soft wood boost; reject neon green/red overlays)
 *  2. Classical steep Hough (x = a + b*y) + Probabilistic segments
 *  3. select_closest pair to lane center (Corra)
 *  4. multi-row gutter-flank refine
 *  5. foul / pins Y votes → intersect → four corners
 */
import type { LaneCorners, Point2D } from "./types";

/** Local result shape (avoid circular import with laneDetect.ts). */
export type HoughLaneDetectResult = {
  corners: LaneCorners;
  confidence: number;
  message: string;
  broadcastHud?: boolean;
};

export type HoughSeg = { x1: number; y1: number; x2: number; y2: number };
type HoughLine = { a: number; b: number; votes: number }; // x = a + b*y

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function clampPt(p: Point2D, w: number, h: number): Point2D {
  return { x: clamp(p.x, 0, w - 1), y: clamp(p.y, 0, h - 1) };
}

function grayFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    g[i] = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
  }
  return g;
}

/** Soft wood-lane boost — NOT green/red marker keys. */
function woodBoostMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const m = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const r = rgba[o];
    const g = rgba[o + 1];
    const b = rgba[o + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const warm = r >= g - 8 && r >= b && g >= b - 20;
    const mid = max >= 55 && max <= 245;
    const neonGreen = g > 160 && g > r + 40 && g > b + 40;
    const neonRed = r > 180 && r > g + 50 && r > b + 50 && sat > 0.45;
    if (neonGreen || neonRed) {
      m[i] = 0;
      continue;
    }
    m[i] = warm && mid && sat >= 0.05 && sat <= 0.85 ? 255 : max > 40 ? 120 : 40;
  }
  return m;
}

function buildEdgeMap(
  gray: Uint8ClampedArray,
  boost: Uint8ClampedArray,
  width: number,
  height: number,
  maskRight: number
): Uint8ClampedArray {
  const edges = new Uint8ClampedArray(width * height);
  const mag = new Float32Array(width * height);
  let sum = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < Math.min(width - 1, maskRight); x++) {
      const gx =
        -gray[(y - 1) * width + (x - 1)] +
        gray[(y - 1) * width + (x + 1)] -
        2 * gray[y * width + (x - 1)] +
        2 * gray[y * width + (x + 1)] -
        gray[(y + 1) * width + (x - 1)] +
        gray[(y + 1) * width + (x + 1)];
      const gy =
        -gray[(y - 1) * width + (x - 1)] -
        2 * gray[(y - 1) * width + x] -
        gray[(y - 1) * width + (x + 1)] +
        gray[(y + 1) * width + (x - 1)] +
        2 * gray[(y + 1) * width + x] +
        gray[(y + 1) * width + (x + 1)];
      // Prefer vertical structure (gutters): weight |gx|
      const m =
        (Math.abs(gx) * 1.35 + Math.abs(gy) * 0.55) *
        (0.5 + (boost[y * width + x] / 255) * 0.75);
      mag[y * width + x] = m;
      sum += m;
      n++;
    }
  }
  const mean = n > 0 ? sum / n : 0;
  const thr = Math.max(22, mean * 1.15);
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < Math.min(width - 2, maskRight); x++) {
      const m = mag[y * width + x];
      if (m < thr) continue;
      const left = mag[y * width + (x - 1)];
      const right = mag[y * width + (x + 1)];
      if (m >= left && m >= right) edges[y * width + x] = 255;
    }
  }
  return edges;
}

function segAngleDeg(s: HoughSeg): number {
  return (Math.atan2(s.y2 - s.y1, s.x2 - s.x1) * 180) / Math.PI;
}

function segLen(s: HoughSeg): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

function lineFromSeg(s: HoughSeg): { a: number; b: number } | null {
  const dy = s.y2 - s.y1;
  if (Math.abs(dy) < 1e-3) return null;
  const b = (s.x2 - s.x1) / dy;
  const a = s.x1 - b * s.y1;
  return { a, b };
}

export function probabilisticHough(
  edges: Uint8ClampedArray,
  width: number,
  height: number,
  opts?: {
    minLen?: number;
    maxGap?: number;
    sampleStep?: number;
    maskRight?: number;
  }
): HoughSeg[] {
  const minLen = opts?.minLen ?? Math.max(28, Math.round(height * 0.06));
  const maxGap = opts?.maxGap ?? 6;
  const step = opts?.sampleStep ?? 2;
  const maskRight = opts?.maskRight ?? width;
  const used = new Uint8Array(width * height);
  const segs: HoughSeg[] = [];

  const isEdge = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < maskRight &&
    y < height &&
    edges[y * width + x] > 0 &&
    !used[y * width + x];

  const mark = (x: number, y: number) => {
    used[y * width + x] = 1;
  };

  const localDir = (x: number, y: number): { dx: number; dy: number } => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= maskRight || yy >= height) continue;
        if (edges[yy * width + xx] > 0) {
          sx += dx;
          sy += dy;
          n++;
        }
      }
    }
    if (n < 2) return { dx: 0, dy: 1 };
    const len = Math.hypot(sx, sy) || 1;
    return { dx: sx / len, dy: sy / len };
  };

  const grow = (
    x0: number,
    y0: number,
    dx: number,
    dy: number
  ): { x: number; y: number } => {
    let x = x0;
    let y = y0;
    let gap = 0;
    let lastX = x0;
    let lastY = y0;
    for (let i = 0; i < Math.max(width, height); i++) {
      const nx = Math.round(x + dx);
      const ny = Math.round(y + dy);
      if (nx < 0 || ny < 0 || nx >= maskRight || ny >= height) break;
      let found = false;
      for (const oy of [-1, 0, 1]) {
        for (const ox of [-1, 0, 1]) {
          const xx = nx + ox;
          const yy = ny + oy;
          if (isEdge(xx, yy)) {
            mark(xx, yy);
            x = xx;
            y = yy;
            lastX = xx;
            lastY = yy;
            found = true;
            gap = 0;
            break;
          }
        }
        if (found) break;
      }
      if (!found) {
        gap++;
        if (gap > maxGap) break;
        x = nx;
        y = ny;
      }
    }
    return { x: lastX, y: lastY };
  };

  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < maskRight - 1; x += step) {
      if (!isEdge(x, y)) continue;
      mark(x, y);
      const { dx, dy } = localDir(x, y);
      const a = grow(x, y, dx, dy);
      const b = grow(x, y, -dx, -dy);
      const seg: HoughSeg = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      if (segLen(seg) >= minLen) segs.push(seg);
    }
  }
  return segs;
}

/** Classical Hough for steep lines: x = a + b*y */
function classicalSteepHough(
  edges: Uint8ClampedArray,
  width: number,
  height: number,
  maskRight: number,
  opts?: { maxTiltDeg?: number; thresh?: number }
): HoughLine[] {
  const maxTilt = opts?.maxTiltDeg ?? 42;
  const bMin = Math.tan((-maxTilt * Math.PI) / 180);
  const bMax = Math.tan((maxTilt * Math.PI) / 180);
  const nB = 91;
  const aMin = -width * 0.25;
  const aMax = width * 1.25;
  const nA = Math.max(100, Math.round(width * 0.65));
  const acc = new Float32Array(nA * nB);
  const bStep = (bMax - bMin) / (nB - 1);
  const aStep = (aMax - aMin) / (nA - 1);

  const y0 = Math.floor(height * 0.14);
  const y1 = Math.floor(height * 0.92);
  for (let y = y0; y < y1; y += 1) {
    for (let x = 1; x < maskRight - 1; x++) {
      if (!edges[y * width + x]) continue;
      for (let ib = 0; ib < nB; ib++) {
        const b = bMin + ib * bStep;
        const a = x - b * y;
        const ia = Math.round((a - aMin) / aStep);
        if (ia < 0 || ia >= nA) continue;
        acc[ia * nB + ib] += 1;
      }
    }
  }

  const flat: { ia: number; ib: number; v: number }[] = [];
  for (let ia = 0; ia < nA; ia++) {
    for (let ib = 0; ib < nB; ib++) {
      const v = acc[ia * nB + ib];
      if (v > 0) flat.push({ ia, ib, v });
    }
  }
  flat.sort((p, q) => q.v - p.v);
  const thr = opts?.thresh ?? Math.max(16, height * 0.04);
  const lines: HoughLine[] = [];
  const used = new Uint8Array(nA * nB);
  for (const p of flat) {
    if (p.v < thr) break;
    if (used[p.ia * nB + p.ib]) continue;
    for (let da = -4; da <= 4; da++) {
      for (let db = -3; db <= 3; db++) {
        const ia = p.ia + da;
        const ib = p.ib + db;
        if (ia >= 0 && ia < nA && ib >= 0 && ib < nB) used[ia * nB + ib] = 1;
      }
    }
    lines.push({
      a: aMin + p.ia * aStep,
      b: bMin + p.ib * bStep,
      votes: p.v,
    });
    if (lines.length >= 48) break;
  }
  return lines;
}

function pickClosestPair(
  lines: HoughLine[],
  refY: number,
  centerX: number,
  width: number,
  broadcast: boolean
): { left: HoughLine; right: HoughLine; sc: number } | null {
  const xs = lines
    .map((L) => ({ L, x: L.a + L.b * refY }))
    .filter((p) => Number.isFinite(p.x) && p.x > -width * 0.05 && p.x < width * 1.05);
  const leftsAll = xs.filter((p) => p.x < centerX - 8);
  const rightsAll = xs.filter((p) => p.x > centerX + 8);
  // Mix closest-to-center (Corra) + strongest votes + outer (true gutters)
  const byCloseL = [...leftsAll].sort((a, b) => b.x - a.x);
  const byVoteL = [...leftsAll].sort((a, b) => b.L.votes - a.L.votes);
  const byOuterL = [...leftsAll].sort((a, b) => a.x - b.x); // farthest left
  const byCloseR = [...rightsAll].sort((a, b) => a.x - b.x);
  const byVoteR = [...rightsAll].sort((a, b) => b.L.votes - a.L.votes);
  const byOuterR = [...rightsAll].sort((a, b) => b.x - a.x);
  const take = (arr: typeof xs, n: number) => arr.slice(0, n);
  const uniq = (arr: typeof xs) => {
    const out: typeof xs = [];
    const seen = new Set<string>();
    for (const p of arr) {
      const k = `${Math.round(p.x)}:${p.L.votes}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    return out;
  };
  const Lcand = uniq([
    ...take(byCloseL, 10),
    ...take(byVoteL, 10),
    ...take(byOuterL, 8),
  ]);
  const Rcand = uniq([
    ...take(byCloseR, 10),
    ...take(byVoteR, 10),
    ...take(byOuterR, 8),
  ]);
  let best: { left: HoughLine; right: HoughLine; sc: number } | null = null;
  const expectW = width * (broadcast ? 0.3 : 0.56);
  for (const L of Lcand) {
    for (const R of Rcand) {
      const w = R.x - L.x;
      if (broadcast) {
        if (w / width < 0.18 || w / width > 0.42) continue;
      } else {
        // rear-view single lane foul often 0.48–0.64 (true gutters, not inset oil)
        if (w / width < 0.42 || w / width > 0.7) continue;
      }
      const m = (L.x + R.x) / 2;
      if (Math.abs(m - centerX) > width * 0.18) continue;
      // Prefer true-gutter width over tiny near-center pairs
      const wTarget = broadcast ? 0.3 : 0.56;
      const wFrac = w / width;
      const wScore =
        Math.abs(wFrac - wTarget) < 0.04
          ? 120
          : Math.abs(wFrac - wTarget) < 0.08
            ? 70
            : Math.abs(wFrac - wTarget) < 0.14
              ? 25
              : wFrac > wTarget + 0.14
                ? -50
                : -15;
      const midScore =
        Math.abs(m / width - (broadcast ? 0.36 : 0.48)) < 0.04
          ? 40
          : Math.abs(m / width - (broadcast ? 0.36 : 0.48)) < 0.08
            ? 15
            : -20;
      // Mild outer bonus — prefer true gutters over oil lines, not channel wall
      const outerBonus = broadcast
        ? 0
        : Math.min(45, (centerX - L.x) * 0.045 + (R.x - centerX) * 0.045);
      const sc =
        L.L.votes * 0.2 +
        R.L.votes * 0.2 +
        wScore +
        midScore +
        outerBonus -
        Math.abs(m - centerX) * 0.35 -
        Math.abs(w - expectW) * 0.04;
      if (!best || sc > best.sc) best = { left: L.L, right: R.L, sc };
    }
  }
  return best;
}

function xAtY(s: HoughSeg, y: number): number | null {
  const dy = s.y2 - s.y1;
  if (Math.abs(dy) < 1e-6) return (s.x1 + s.x2) / 2;
  const t = (y - s.y1) / dy;
  return s.x1 + t * (s.x2 - s.x1);
}

export function selectClosestLateral(
  segs: HoughSeg[],
  refY: number,
  centerX: number,
  height: number,
  toleranceAngle = 18
): { left: HoughSeg | null; right: HoughSeg | null } {
  const laterals = segs.filter((s) => {
    const ang = Math.abs(segAngleDeg(s));
    const fromHoriz = Math.min(ang, Math.abs(180 - ang), Math.abs(ang - 360));
    const steep = Math.abs(s.x2 - s.x1) < Math.abs(s.y2 - s.y1) * 1.8;
    const yMax = Math.max(s.y1, s.y2);
    const yMin = Math.min(s.y1, s.y2);
    if (yMin > height * 0.92) return false;
    if (yMax < height * 0.18) return false;
    return (fromHoriz > toleranceAngle || steep) && segLen(s) >= height * 0.05;
  });

  let left: HoughSeg | null = null;
  let right: HoughSeg | null = null;
  let leftDist = 1e9;
  let rightDist = 1e9;
  for (const s of laterals) {
    const x = xAtY(s, refY);
    if (x == null || !Number.isFinite(x)) continue;
    if (x < centerX) {
      const d = centerX - x;
      if (d < leftDist && d > 4) {
        leftDist = d;
        left = s;
      }
    } else {
      const d = x - centerX;
      if (d < rightDist && d > 4) {
        rightDist = d;
        right = s;
      }
    }
  }
  return { left, right };
}

function voteHorizontalY(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  y0f: number,
  y1f: number,
  x0f: number,
  x1f: number,
  maskRight: number
): number {
  const y0 = Math.floor(height * y0f);
  const y1 = Math.floor(height * y1f);
  const x0 = Math.floor(width * x0f);
  const x1 = Math.min(maskRight - 1, Math.floor(width * x1f));
  let bestY = (y0 + y1) / 2;
  let best = -1;
  for (let y = y0; y <= y1; y++) {
    let edge = 0;
    let n = 0;
    for (let x = x0; x < x1; x++) {
      if (y <= 0 || y >= height - 1) continue;
      edge += Math.abs(gray[(y + 1) * width + x] - gray[(y - 1) * width + x]);
      n++;
    }
    const avg = n > 0 ? edge / n : 0;
    if (avg > best) {
      best = avg;
      bestY = y;
    }
  }
  return bestY;
}

function refineGutterFit(
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  left0: { a: number; b: number },
  right0: { a: number; b: number },
  maskRight: number,
  expectMid: number
): { left: { a: number; b: number }; right: { a: number; b: number }; n: number } | null {
  const ys: number[] = [];
  const ls: number[] = [];
  const rs: number[] = [];
  let mid = expectMid;
  for (let yf = 0.86; yf >= 0.22; yf -= 0.018) {
    const y = Math.round(yf * height);
    const seedL = left0.a + left0.b * y;
    const seedR = right0.a + right0.b * y;
    const expectW = seedR - seedL;
    if (expectW < width * 0.1 || expectW > width * 0.75) continue;
    const search = Math.max(8, Math.round(width * 0.04));
    const snap = (seed: number, side: -1 | 1) => {
      let bestX = seed;
      let bestSc = -1e9;
      // Bias toward lane center = inner gutter lip (not outer channel wall)
      for (let dx = -search; dx <= search; dx++) {
        const x = Math.round(seed + dx);
        if (x < 2 || x >= maskRight - 2) continue;
        const g = Math.abs(gray[y * width + x + 1] - gray[y * width + x - 1]);
        let out = 0;
        let inn = 0;
        let no = 0;
        let ni = 0;
        for (let k = 2; k <= 16; k++) {
          // side=-1 left / +1 right: outside = further from mid = x + side*k
          const xo = x + side * k;
          const xi = x - side * k;
          if (xo >= 0 && xo < width) {
            out += gray[y * width + xo];
            no++;
          }
          if (xi >= 0 && xi < width) {
            inn += gray[y * width + xi];
            ni++;
          }
        }
        const flank = (ni ? inn / ni : 0) - (no ? out / no : 0);
        if (flank < 8) continue;
        // Score true gutter LIP (max dark-out / bright-in flank). Mild outer
        // tie-break only — do not walk past the lip into the channel.
        const outward = side < 0 ? -dx : dx;
        const sc =
          g * 0.35 +
          flank * 1.8 +
          Math.max(0, outward) * 0.25 -
          Math.max(0, -outward) * 0.45 -
          Math.abs(dx) * 0.12;
        if (sc > bestSc) {
          bestSc = sc;
          bestX = x;
        }
      }
      return bestSc > -1e8 ? bestX : null;
    };
    const L = snap(seedL, -1);
    const R = snap(seedR, 1);
    if (L == null || R == null) continue;
    const w = R - L;
    const m = (L + R) / 2;
    if (w < expectW * 0.65 || w > expectW * 1.4) continue;
    if (Math.abs(m - mid) > width * 0.12) continue;
    if (R >= maskRight - 4) continue;
    ys.push(y);
    ls.push(L);
    rs.push(R);
    mid = mid * 0.5 + m * 0.5;
  }
  if (ys.length < 5) return null;
  const fit = (xs: number[]) => {
    const n = ys.length;
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
  };
  const robust = (xs: number[]) => {
    const first = fit(xs);
    if (!first) return null;
    const res = ys.map((y, i) => Math.abs(xs[i] - (first.a + first.b * y)));
    const sorted = [...res].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 1;
    const thr = Math.max(3, med * 2.4);
    const iy: number[] = [];
    const ix: number[] = [];
    for (let i = 0; i < ys.length; i++) {
      if (res[i] <= thr) {
        iy.push(ys[i]);
        ix.push(xs[i]);
      }
    }
    if (iy.length < 4) return first;
    const n = iy.length;
    let sy = 0,
      sx = 0,
      syy = 0,
      sxy = 0;
    for (let i = 0; i < n; i++) {
      sy += iy[i];
      sx += ix[i];
      syy += iy[i] * iy[i];
      sxy += iy[i] * ix[i];
    }
    const den = n * syy - sy * sy;
    if (Math.abs(den) < 1e-6) return first;
    const b = (n * sxy - sy * sx) / den;
    const a = (sx - b * sy) / n;
    return { a, b };
  };
  const lf = robust(ls);
  const rf = robust(rs);
  if (!lf || !rf) return null;
  return { left: lf, right: rf, n: ys.length };
}

function validateTrapezoid(
  corners: LaneCorners,
  width: number,
  height: number,
  broadcast: boolean
): boolean {
  const botW = corners.br.x - corners.bl.x;
  const topW = corners.tr.x - corners.tl.x;
  const midBot = (corners.bl.x + corners.br.x) / 2 / width;
  const pinY = (corners.tl.y + corners.tr.y) / 2 / height;
  const foulY = (corners.bl.y + corners.br.y) / 2 / height;
  if (corners.tl.x >= corners.tr.x) return false;
  if (botW <= topW * 1.02) return false;
  if (broadcast) {
    if (foulY < 0.55 || foulY > 0.92) return false;
    if (pinY < 0.14 || pinY > 0.36) return false; // reject scoreboard tops
    if (botW / width < 0.18 || botW / width > 0.42) return false;
    if (midBot < 0.22 || midBot > 0.5) return false;
    if (corners.br.x / width > 0.72) return false;
    if (topW / width < 0.1 || topW / botW > 0.98 || topW / botW < 0.4) return false;
    // Reject floating mid-wedge / narrow mid-lane lock (even if not classic mask)
    const extent = foulY - pinY;
    const taper = topW / Math.max(1e-3, botW);
    const leftFrac = corners.bl.x / width;
    if (extent < 0.34 && taper > 0.68 && botW / width < 0.32) return false;
    // Left not on outer lip + mid bot → mid-wedge through bowler
    if (botW / width < 0.38 && leftFrac > 0.24 && midBot > 0.38) return false;
    if (botW / width < 0.36 && midBot > 0.42) return false;
    // Top short of pin deck while bot mid-lane
    if (pinY > 0.24 && extent < 0.5 && botW / width < 0.36 && leftFrac > 0.22) return false;
  } else {
    if (foulY < 0.72 || foulY > 0.96) return false;
    // Pin HEADS (r4): AMF~0.063, dark~0.075–0.086, heads~0.093–0.098, necks~0.105+
    if (pinY < 0.088 || pinY > 0.115) return false;
    // True single-lane gutters often 0.50–0.64 (not inset 0.36–0.45)
    if (botW / width < 0.5 || botW / width > 0.64) return false;
    if (midBot < 0.42 || midBot > 0.56) return false;
    // taper ~0.30 covers full pin row at foul-anchored lips (was 0.222 → TR inset)
    if (topW / width < 0.08 || topW / botW > 0.38 || topW / botW < 0.18) return false;
  }
  return true;
}

/**
 * Primary auto path: Hough L/R + geometric constraints.
 */
export function detectLaneCornersHough(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  maskRight: number = width,
  opts?: { broadcastHint?: boolean }
): HoughLaneDetectResult | null {
  if (width < 80 || height < 80) return null;
  const broadcast =
    !!opts?.broadcastHint || maskRight < width * 0.92;

  const scale = Math.min(1, 520 / width);
  const sw = Math.max(64, Math.round(width * scale));
  const sh = Math.max(64, Math.round(height * scale));
  const mr = Math.round(maskRight * scale);

  const small = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(height - 1, Math.floor((y / sh) * height));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(width - 1, Math.floor((x / sw) * width));
      const si = (sy * width + sx) * 4;
      const di = (y * sw + x) * 4;
      small[di] = rgba[si];
      small[di + 1] = rgba[si + 1];
      small[di + 2] = rgba[si + 2];
      small[di + 3] = 255;
    }
  }

  const gray = grayFromRgba(small, sw, sh);
  const boost = woodBoostMask(small, sw, sh);
  const edges = buildEdgeMap(gray, boost, sw, sh, mr);

  let yFoul = voteHorizontalY(
    gray,
    sw,
    sh,
    broadcast ? 0.58 : 0.8,
    broadcast ? 0.82 : 0.9,
    broadcast ? 0.18 : 0.22,
    broadcast ? 0.7 : 0.78,
    mr
  );
  // Demo: foul line ~0.84–0.88 (0.91+ is approach and false-outer gutters)
  yFoul = broadcast
    ? clamp(yFoul, sh * 0.58, sh * 0.82)
    : clamp(yFoul, sh * 0.82, sh * 0.88);

  let centerX = sw * (broadcast ? 0.36 : 0.5);
  {
    const y = Math.floor(sh * 0.72);
    let best = centerX;
    let bestSc = -1e9;
    const x0 = Math.floor(sw * (broadcast ? 0.16 : 0.25));
    const x1 = Math.min(mr - 8, Math.floor(sw * (broadcast ? 0.55 : 0.75)));
    const half = Math.floor(sw * (broadcast ? 0.1 : 0.24));
    for (let x = x0; x < x1; x += 2) {
      let wood = 0;
      let nw = 0;
      for (let dx = -half + 4; dx <= half - 4; dx += 2) {
        const xx = x + dx;
        if (xx >= 0 && xx < mr) {
          wood += gray[y * sw + xx];
          nw++;
        }
      }
      const woodM = nw ? wood / nw : 0;
      let dL = 0,
        dR = 0,
        nL = 0,
        nR = 0;
      for (let k = 3; k <= Math.floor(sw * 0.045); k++) {
        if (x - half - k >= 0) {
          dL += gray[y * sw + (x - half - k)];
          nL++;
        }
        if (x + half + k < mr) {
          dR += gray[y * sw + (x + half + k)];
          nR++;
        }
      }
      const darkL = nL ? dL / nL : 99;
      const darkR = nR ? dR / nR : 99;
      if (woodM < 40) continue;
      if (woodM - darkL < 8 || woodM - darkR < 6) continue;
      const sc =
        woodM +
        Math.min(50, woodM - darkL) * 0.9 +
        Math.min(45, woodM - darkR) * 0.8;
      if (sc > bestSc) {
        bestSc = sc;
        best = x;
      }
    }
    if (bestSc > 0) centerX = best;
  }

  const houghLines = classicalSteepHough(edges, sw, sh, mr, {
    maxTiltDeg: 44,
    thresh: Math.max(12, sh * 0.028),
  });

  // Supplement with long PHough segments
  const segs = probabilisticHough(edges, sw, sh, {
    minLen: Math.max(18, Math.round(sh * 0.045)),
    maxGap: 9,
    sampleStep: 2,
    maskRight: mr,
  });
  for (const s of segs) {
    const ang = Math.abs(segAngleDeg(s));
    const fromHoriz = Math.min(ang, Math.abs(180 - ang));
    const steep = Math.abs(s.x2 - s.x1) < Math.abs(s.y2 - s.y1) * 2.5;
    if ((fromHoriz > 18 || steep) && segLen(s) >= sh * 0.07) {
      const ln = lineFromSeg(s);
      if (ln) houghLines.push({ ...ln, votes: segLen(s) * 0.4 });
    }
  }
  // Multi-row |gx| gutter peaks → synthetic Hough lines (Corra hybrid)
  {
    const ys: number[] = [];
    const ls: number[] = [];
    const rs: number[] = [];
    let mid = centerX;
    for (let yf = 0.84; yf >= 0.28; yf -= 0.03) {
      const y = Math.round(yf * sh);
      const expectW = sw * (broadcast ? clamp(0.16 + yf * 0.22, 0.2, 0.36) : clamp(0.36 + yf * 0.28, 0.42, 0.62));
      const thrG = 12;
      const Lpeaks: { x: number; g: number }[] = [];
      const Rpeaks: { x: number; g: number }[] = [];
      const x0 = Math.max(2, Math.floor(mid - expectW * 0.85));
      const x1 = Math.min(mr - 3, Math.ceil(mid + expectW * 0.85));
      for (let x = x0; x <= x1; x++) {
        const g = Math.abs(gray[y * sw + x + 1] - gray[y * sw + x - 1]);
        if (g < thrG) continue;
        if (g < Math.abs(gray[y * sw + x] - gray[y * sw + x - 2])) continue;
        if (g < Math.abs(gray[y * sw + x + 2] - gray[y * sw + x])) continue;
        let out = 0, inn = 0, no = 0, ni = 0;
        const side = x < mid ? -1 : 1;
        for (let k = 2; k <= 14; k++) {
          const xo = x + side * k; // outside
          const xi = x - side * k; // inside
          if (xo >= 0 && xo < sw) { out += gray[y * sw + xo]; no++; }
          if (xi >= 0 && xi < sw) { inn += gray[y * sw + xi]; ni++; }
        }
        const flank = (ni ? inn / ni : 0) - (no ? out / no : 0);
        if (flank < 8) continue;
        if (x < mid) Lpeaks.push({ x, g: g + flank });
        else Rpeaks.push({ x, g: g + flank });
      }
      if (!Lpeaks.length || !Rpeaks.length) continue;
      Lpeaks.sort((a, b) => b.g - a.g);
      Rpeaks.sort((a, b) => b.g - a.g);
      let bestL = Lpeaks[0], bestR = Rpeaks[0], bs = -1e9;
      const wLo = broadcast ? expectW * 0.7 : expectW * 0.85;
      const wHi = broadcast ? expectW * 1.45 : expectW * 1.35;
      for (const L of Lpeaks.slice(0, 10)) {
        for (const R of Rpeaks.slice(0, 10)) {
          const w = R.x - L.x;
          if (w < wLo || w > wHi) continue;
          const m = (L.x + R.x) / 2;
          if (Math.abs(m - mid) > sw * 0.12) continue;
          // Prefer outer gutters (wider within band) over inset oil lines
          const outer = broadcast ? 0 : (w / sw) * 40;
          const sc = L.g + R.g - Math.abs(w - expectW) * 0.15 + outer;
          if (sc > bs) { bs = sc; bestL = L; bestR = R; }
        }
      }
      if (bs < 0) continue;
      ys.push(y); ls.push(bestL.x); rs.push(bestR.x);
      mid = mid * 0.55 + ((bestL.x + bestR.x) / 2) * 0.45;
    }
    if (ys.length >= 5) {
      const fit = (xs: number[]) => {
        const n = ys.length;
        let sy=0,sx=0,syy=0,sxy=0;
        for (let i=0;i<n;i++){sy+=ys[i];sx+=xs[i];syy+=ys[i]*ys[i];sxy+=ys[i]*xs[i];}
        const den=n*syy-sy*sy; if(Math.abs(den)<1e-6) return null;
        const b=(n*sxy-sy*sx)/den; const a=(sx-b*sy)/n; return {a,b};
      };
      const lf = fit(ls); const rf = fit(rs);
      if (lf && rf) {
        houghLines.push({ ...lf, votes: 400 + ys.length * 8 });
        houghLines.push({ ...rf, votes: 400 + ys.length * 8 });
      }
    }
  }

  if (houghLines.length < 2) return null;

  let bestPair: { left: HoughLine; right: HoughLine; sc: number } | null = null;
  for (const ry of [yFoul, sh * 0.75, sh * 0.6, sh * 0.48, sh * 0.36]) {
    const pair = pickClosestPair(houghLines, ry, centerX, sw, broadcast);
    if (pair && (!bestPair || pair.sc > bestPair.sc)) bestPair = pair;
  }
  // Also try PHough select_closest as fallback seed
  if (!bestPair) {
    for (const ry of [yFoul, sh * 0.7, sh * 0.5]) {
      const { left, right } = selectClosestLateral(segs, ry, centerX, sh, 15);
      if (!left || !right) continue;
      const l0 = lineFromSeg(left);
      const r0 = lineFromSeg(right);
      if (!l0 || !r0) continue;
      const xL = l0.a + l0.b * ry;
      const xR = r0.a + r0.b * ry;
      const w = xR - xL;
      if (w < sw * 0.2 || w > sw * 0.75) continue;
      bestPair = {
        left: { ...l0, votes: segLen(left) },
        right: { ...r0, votes: segLen(right) },
        sc: segLen(left) + segLen(right),
      };
      break;
    }
  }
  if (!bestPair) return null;

  const refined = refineGutterFit(
    gray,
    sw,
    sh,
    bestPair.left,
    bestPair.right,
    mr,
    centerX
  );
  let left = refined?.left ?? bestPair.left;
  let right = refined?.right ?? bestPair.right;

  // Foul-row joint lip snap: max flank L/R with width ≈0.56 (true single lane)
  if (!broadcast) {
    const y = Math.round(yFoul);
    const mid0 = centerX;
    const lLo = mid0 - sw * 0.34;
    const lHi = mid0 - sw * 0.22;
    const rLo = mid0 + sw * 0.22;
    const rHi = mid0 + sw * 0.34;
    const flankAt = (x: number, side: -1 | 1) => {
      if (x < 3 || x >= mr - 3) return -1e9;
      const g = Math.abs(gray[y * sw + x + 1] - gray[y * sw + x - 1]);
      let out = 0,
        inn = 0,
        no = 0,
        ni = 0;
      for (let k = 2; k <= 18; k++) {
        const xo = x + side * k; // outside (away from mid)
        const xi = x - side * k; // inside (toward mid)
        if (xo >= 0 && xo < sw) {
          out += gray[y * sw + xo];
          no++;
        }
        if (xi >= 0 && xi < sw) {
          inn += gray[y * sw + xi];
          ni++;
        }
      }
      const flank = (ni ? inn / ni : 0) - (no ? out / no : 0);
      if (flank < 12) return -1e9;
      return flank * 2.2 + g * 0.25;
    };
    const Lpeaks: { x: number; sc: number }[] = [];
    const Rpeaks: { x: number; sc: number }[] = [];
    for (let x = Math.floor(lLo); x <= Math.ceil(lHi); x++) {
      const sc = flankAt(x, -1);
      if (sc > -1e8) Lpeaks.push({ x, sc });
    }
    for (let x = Math.floor(rLo); x <= Math.ceil(rHi); x++) {
      const sc = flankAt(x, 1);
      if (sc > -1e8) Rpeaks.push({ x, sc });
    }
    Lpeaks.sort((a, b) => b.sc - a.sc);
    Rpeaks.sort((a, b) => b.sc - a.sc);
    let bestL = left.a + left.b * y;
    let bestR = right.a + right.b * y;
    let bestSc = -1e9;
    for (const L of Lpeaks.slice(0, 14)) {
      for (const R of Rpeaks.slice(0, 14)) {
        const w = R.x - L.x;
        if (w < sw * 0.5 || w > sw * 0.62) continue;
        const m = (L.x + R.x) / 2;
        if (Math.abs(m - mid0) > sw * 0.08) continue;
        const wTarget = sw * 0.56;
        const sc =
          L.sc +
          R.sc -
          Math.abs(w - wTarget) * 0.35 -
          Math.abs(m - mid0) * 0.2;
        if (sc > bestSc) {
          bestSc = sc;
          bestL = L.x;
          bestR = R.x;
        }
      }
    }
    if (bestSc > -1e8) {
      left = { a: bestL - left.b * y, b: left.b };
      right = { a: bestR - right.b * y, b: right.b };
    }
  }

  // Only shrink clearly two-lane locks (>0.68). Keep true single-lane gutters ~0.50–0.64.
  if (!broadcast) {
    const yMid = sh * 0.78;
    const xL = left.a + left.b * yMid;
    const xR = right.a + right.b * yMid;
    const w = xR - xL;
    const m = (xL + xR) / 2;
    if (w > sw * 0.68) {
      const target = sw * 0.56;
      const shrink = (w - target) * 0.45;
      const l2 = { a: left.a + shrink / 2, b: left.b };
      const r2 = { a: right.a - shrink / 2, b: right.b };
      const m2 = ((l2.a + l2.b * yMid) + (r2.a + r2.b * yMid)) / 2;
      if (Math.abs(m2 - m) < sw * 0.025) {
        left = l2;
        right = r2;
      }
    }
  }

  const xAt = (fit: { a: number; b: number }, y: number) => fit.a + fit.b * y;

  // Pin / far-deck Y
  // rear-view demo: pin HEADS ~0.065–0.085 (0.10–0.12 cuts necks — Tester FAIL)
  // broadcast PBA: wood onset often ~0.18–0.28 — NOT scoreboard (~0.05–0.12)
  let yPins: number;
  if (broadcast) {
    // Find wood onset along lane mid corridor (skip dark scoreboard above)
    let woodOnset = sh * 0.26;
    {
      const x0 = Math.floor(sw * 0.28);
      const x1 = Math.min(mr - 4, Math.floor(sw * 0.52));
      let bestY = woodOnset;
      let bestJump = -1;
      for (let y = Math.floor(sh * 0.12); y < Math.floor(sh * 0.4); y++) {
        let above = 0,
          na = 0,
          here = 0,
          nh = 0;
        const yA = Math.max(2, y - Math.floor(sh * 0.04));
        for (let x = x0; x < x1; x += 2) {
          above += gray[yA * sw + x];
          na++;
          here += gray[y * sw + x];
          nh++;
        }
        const aM = na ? above / na : 0;
        const hM = nh ? here / nh : 0;
        const jump = hM - aM;
        if (hM > 70 && jump > bestJump) {
          bestJump = jump;
          bestY = y;
        }
      }
      if (bestJump > 12) woodOnset = bestY;
    }
    // Pin heads sit slightly above wood onset; clamp away from scoreboard
    yPins = voteHorizontalY(gray, sw, sh, 0.18, 0.34, 0.22, 0.55, mr);
    yPins = clamp(yPins, sh * 0.18, sh * 0.34);
    // Prefer near wood onset (covers pin row, not banner)
    if (Math.abs(woodOnset - yPins) > sh * 0.04) {
      yPins = clamp(woodOnset - sh * 0.02, sh * 0.18, sh * 0.32);
    }
  } else {
    // Pin HEADS (Tester r4): AMF~0.063; dark/masking~0.075–0.086; heads~0.093–0.098; necks~0.105+.
    // Prior 0.086–0.092 still read as AMF-band in UI — sit on heads.
    yPins = voteHorizontalY(gray, sw, sh, 0.090, 0.102, 0.4, 0.7, mr);
    yPins = clamp(yPins, sh * 0.092, sh * 0.100);
  }
  {
    const xL = xAt(left, yPins);
    const xR = xAt(right, yPins);
    if (!broadcast && xR - xL < sw * 0.08) {
      yPins = clamp(yPins + sh * 0.004, sh * 0.094, sh * 0.102);
    }
  }

  const bl: Point2D = { x: xAt(left, yFoul), y: yFoul };
  const br: Point2D = { x: xAt(right, yFoul), y: yFoul };
  const botW = br.x - bl.x;
  if (botW < sw * (broadcast ? 0.16 : 0.4)) return null;

  // Far corners: prefer L/R line extrapolation so TL/TR land on true gutters
  // covering the full pin row; fall back to foul-anchored taper if wild.
  const midFoul = (bl.x + br.x) / 2;
  let xLp = xAt(left, yPins);
  let xRp = xAt(right, yPins);
  let midPins = (xLp + xRp) / 2;
  let topW = xRp - xLp;
  const taperLo = broadcast ? 0.45 : 0.20;
  const taperHi = broadcast ? 0.95 : 0.36;
  const extOk =
    Number.isFinite(topW) &&
    topW > botW * taperLo &&
    topW < botW * taperHi &&
    xLp > sw * (broadcast ? 0.08 : 0.2) &&
    xRp < sw * (broadcast ? 0.85 : 0.92) &&
    xLp < xRp;

  if (!extOk) {
    const yM = sh * (broadcast ? 0.55 : 0.48);
    const xLm = xAt(left, yM);
    const xRm = xAt(right, yM);
    const midM = (xLm + xRm) / 2;
    const frac = clamp((yFoul - yPins) / Math.max(1e-3, yFoul - yM), 0.5, 2.2);
    midPins = midFoul + (midM - midFoul) * frac;
    if (!broadcast) {
      // Rear-view pin mid right of foul mid (≈+0.14×W — measured lips @pinY)
      const skewTarget = midFoul + sw * 0.14;
      midPins = midPins * 0.25 + skewTarget * 0.75;
      midPins = clamp(midPins, sw * 0.50, sw * 0.68);
    } else {
      midPins = clamp(midPins, sw * 0.22, sw * 0.5);
    }
    const taper = broadcast ? 0.72 : 0.30;
    topW = botW * taper;
  } else if (!broadcast) {
    // Soft pull pin mid toward measured rear-view skew without collapsing width
    const skewTarget = midFoul + sw * 0.14;
    midPins = midPins * 0.45 + skewTarget * 0.55;
    midPins = clamp(midPins, sw * 0.50, sw * 0.68);
    // Keep extrapolated width (covers full pin row); only clamp extremes
    topW = clamp(topW, botW * 0.24, botW * 0.34);
    xLp = midPins - topW / 2;
    xRp = midPins + topW / 2;
  } else {
    // broadcast: keep extrapolated L/R width (cover full pin row)
    midPins = clamp(midPins, sw * 0.18, sw * 0.55);
    topW = clamp(topW, botW * 0.55, botW * 0.95);
    xLp = midPins - topW / 2;
    xRp = midPins + topW / 2;
  }

  // Demo rear-view: foul-anchored lips at pinY (r4: taper~0.30, skew~0.14×W).
  // Never let TL drift left into adjacent lane-number masking.
  if (!broadcast) {
    const skewTarget = midFoul + sw * 0.14;
    midPins = clamp(skewTarget, sw * 0.52, sw * 0.68);
    topW = botW * 0.30;
    // Pin-head band (r4 screenshots): heads ~0.093–0.098, not AMF dark ~0.086
    yPins = clamp(Math.max(yPins, sh * 0.094), sh * 0.094, sh * 0.100);
    // Clamp to foul-extrapolated lips (exact)
    xLp = midPins - topW / 2;
    xRp = midPins + topW / 2;
  }

  const tl: Point2D = { x: midPins - topW / 2, y: yPins };
  const tr: Point2D = { x: midPins + topW / 2, y: yPins };
  if (tl.x >= tr.x) return null;

  const inv = 1 / scale;
  let corners: LaneCorners = {
    tl: clampPt({ x: tl.x * inv, y: tl.y * inv }, width, height),
    tr: clampPt({ x: tr.x * inv, y: tr.y * inv }, width, height),
    br: clampPt({ x: br.x * inv, y: br.y * inv }, width, height),
    bl: clampPt({ x: bl.x * inv, y: bl.y * inv }, width, height),
  };

  // Full-res foul lip refine (demo): downscale can erase true left gutter lip
  if (!broadcast) {
    const fullGray = grayFromRgba(rgba, width, height);
    // Prefer classic foul band (~0.85–0.87); approach (>0.90) yields false-outer left
    const fy = Math.round(
      clamp((corners.bl.y + corners.br.y) / 2, height * 0.84, height * 0.88)
    );
    const midF = width * 0.48; // seed near lane center, not skewed mid
    const flankFull = (x: number, side: -1 | 1) => {
      if (x < 4 || x >= width - 4) return -1e9;
      const g = Math.abs(
        fullGray[fy * width + x + 1] - fullGray[fy * width + x - 1]
      );
      let out = 0,
        inn = 0,
        no = 0,
        ni = 0;
      for (let k = 3; k <= 22; k++) {
        const xo = x + side * k;
        const xi = x - side * k;
        if (xo >= 0 && xo < width) {
          out += fullGray[fy * width + xo];
          no++;
        }
        if (xi >= 0 && xi < width) {
          inn += fullGray[fy * width + xi];
          ni++;
        }
      }
      const flank = (ni ? inn / ni : 0) - (no ? out / no : 0);
      if (flank < 20) return -1e9;
      return flank * 2.2 + g * 0.3;
    };
    const Lpeaks: { x: number; sc: number }[] = [];
    const Rpeaks: { x: number; sc: number }[] = [];
    const l0 = Math.floor(midF - width * 0.32);
    const l1 = Math.ceil(midF - width * 0.24);
    const r0 = Math.floor(midF + width * 0.24);
    const r1 = Math.ceil(midF + width * 0.32);
    for (let x = l0; x <= l1; x++) {
      const sc = flankFull(x, -1);
      if (sc > -1e8) Lpeaks.push({ x, sc });
    }
    for (let x = r0; x <= r1; x++) {
      const sc = flankFull(x, 1);
      if (sc > -1e8) Rpeaks.push({ x, sc });
    }
    Lpeaks.sort((a, b) => b.sc - a.sc);
    Rpeaks.sort((a, b) => b.sc - a.sc);
    let bestL = corners.bl.x;
    let bestR = corners.br.x;
    let bestSc = -1e9;
    for (const L of Lpeaks.slice(0, 16)) {
      for (const R of Rpeaks.slice(0, 16)) {
        const w = R.x - L.x;
        if (w < width * 0.52 || w > width * 0.6) continue;
        const m = (L.x + R.x) / 2;
        if (Math.abs(m - midF) > width * 0.06) continue;
        const sc =
          L.sc +
          R.sc -
          Math.abs(w - width * 0.56) * 1.2 -
          Math.abs(m - width * 0.476) * 0.5;
        if (sc > bestSc) {
          bestSc = sc;
          bestL = L.x;
          bestR = R.x;
        }
      }
    }
    if (bestSc > -1e8) {
      const botW2 = bestR - bestL;
      const midF2 = (bestL + bestR) / 2;
      // Foul-anchored lips @ pinY (r4-measured taper/skew) — clamp TL/TR to these
      const topW2 = botW2 * 0.30;
      const midP2 = clamp(midF2 + width * 0.14, width * 0.52, width * 0.68);
      const py = clamp(
        Math.max((corners.tl.y + corners.tr.y) / 2, height * 0.094),
        height * 0.094,
        height * 0.100
      );
      const tlX = midP2 - topW2 / 2;
      const trX = midP2 + topW2 / 2;
      corners = {
        tl: clampPt({ x: tlX, y: py }, width, height),
        tr: clampPt({ x: trX, y: py }, width, height),
        br: clampPt({ x: bestR, y: fy }, width, height),
        bl: clampPt({ x: bestL, y: fy }, width, height),
      };
    }
  }

  if (!validateTrapezoid(corners, width, height, broadcast)) {
    if (broadcast) return null;
    const botFrac = (corners.br.x - corners.bl.x) / width;
    const midBot = (corners.bl.x + corners.br.x) / 2 / width;
    const pinYf = (corners.tl.y + corners.tr.y) / 2 / height;
    if (
      botFrac < 0.48 ||
      botFrac > 0.64 ||
      midBot < 0.42 ||
      midBot > 0.55 ||
      pinYf < 0.088 ||
      pinYf > 0.115
    ) {
      return null;
    }
  }

  const finalBot = corners.br.x - corners.bl.x;
  const finalTop = corners.tr.x - corners.tl.x;
  const ratio = finalTop / Math.max(1, finalBot);
  let confidence = 0.44;
  confidence += refined && refined.n >= 8 ? 0.2 : refined ? 0.1 : 0.04;
  confidence += bestPair.sc > 40 ? 0.1 : 0.04;
  confidence += finalBot / width > (broadcast ? 0.16 : 0.4) ? 0.1 : 0.03;
  if (ratio < 0.1 || ratio > 0.55) confidence -= 0.08;
  confidence = clamp(confidence, 0.3, 0.92);

  return {
    corners,
    confidence,
    message: `Hough溝邊四角（底寬${((finalBot / width) * 100).toFixed(0)}%）`,
    broadcastHud: broadcast || undefined,
  };
}
