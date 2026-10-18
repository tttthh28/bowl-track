import type { LaneCorners, Point2D, TrackerSettings } from "./types";

export const DEFAULT_TRACKER: TrackerSettings = {
  sensitivity: 28,
  minBlobPixels: 35,
  lostFramesToEnd: 12,
  emaAlpha: 0.5,
  autoSensitivity: true,
  bgLearningRate: 0.035,
  rpmEnabled: true,
  rpmMinContrast: 18,
};

/** 可選：限制搜尋 ROI */
export type RoiRect = { x0: number; y0: number; x1: number; y1: number };

export type TrackFrameResult = {
  /** 本幀實際偵測到的質心（未含預測） */
  raw: Point2D | null;
  smoothed: Point2D | null;
  predicted: boolean;
  /** 本幀使用的有效閾值 */
  effectiveThreshold: number;
  /** 背景雜訊估計 */
  noiseLevel: number;
  /** blob 綜合分數（除錯／門檻用） */
  blobScore: number;
  /** 是否已鎖定球（通過圓形＋色＋運動門檻，或手動點選） */
  locked: boolean;
  /** 連續出 ROI／球道外幀數 */
  outOfLaneFrames: number;
  /** 是否曾進入 pin 區（影像上端／高 feet） */
  reachedPinZone: boolean;
};

type BlobCandidate = {
  cx: number;
  cy: number;
  size: number;
  w: number;
  h: number;
  aspect: number;
  fill: number;
  meanR: number;
  meanG: number;
  meanB: number;
  score: number;
};

/**
 * 追蹤狀態：背景模型 + EMA + 速度預測 + 色球偏好。
 * 在 Workbench 以 ref 持有，勿每幀新建。
 */
export class BallTrackerState {
  bg: Float32Array | null = null;
  prevGray: Uint8ClampedArray | null = null;
  ema: Point2D | null = null;
  vel: Point2D = { x: 0, y: 0 };
  lost = 0;
  noiseEma = 8;
  /** RPM：上一幀球表極座標強度條 */
  prevPolar: Float32Array | null = null;
  rpmSamples: number[] = [];
  lastRpm: number | null = null;
  lastRpmConf = 0;
  /** 手動／自動鎖定後才開始累積軌跡 */
  locked = false;
  /** 點選種子（影像座標） */
  seed: Point2D | null = null;
  outOfLaneFrames = 0;
  reachedPinZone = false;
  /** 連續高分球候選幀（自動鎖定） */
  lockStreak = 0;
  /** 候選／鎖定位置歷史（判斷是否真的在動） */
  recentCenters: Point2D[] = [];
  /** 靜止誤鎖計數 */
  staticFrames = 0;

  reset() {
    this.bg = null;
    this.prevGray = null;
    this.ema = null;
    this.vel = { x: 0, y: 0 };
    this.lost = 0;
    this.noiseEma = 8;
    this.prevPolar = null;
    this.rpmSamples = [];
    this.lastRpm = null;
    this.lastRpmConf = 0;
    this.locked = false;
    this.seed = null;
    this.outOfLaneFrames = 0;
    this.reachedPinZone = false;
    this.lockStreak = 0;
    this.recentCenters = [];
    this.staticFrames = 0;
  }

  /** 使用者點選球：立刻鎖定並以該點為種子 */
  seedAt(p: Point2D) {
    this.seed = { ...p };
    this.ema = { ...p };
    this.vel = { x: 0, y: 0 };
    this.locked = true;
    this.lost = 0;
    this.lockStreak = 3;
    this.outOfLaneFrames = 0;
    this.recentCenters = [{ ...p }];
    this.staticFrames = 0;
  }

  /** 一投結束後清軌跡狀態，保留背景以利下一投 */
  beginNewShot() {
    this.ema = null;
    this.vel = { x: 0, y: 0 };
    this.lost = 0;
    this.locked = false;
    this.seed = null;
    this.outOfLaneFrames = 0;
    this.reachedPinZone = false;
    this.lockStreak = 0;
    this.recentCenters = [];
    this.staticFrames = 0;
    this.prevPolar = null;
    this.rpmSamples = [];
    this.lastRpm = null;
    this.lastRpmConf = 0;
  }
}

export function rgbaToGray(
  data: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return gray;
}

export function cornersBBox(
  corners: LaneCorners,
  pad = 8
): RoiRect {
  const xs = [corners.tl.x, corners.tr.x, corners.br.x, corners.bl.x];
  const ys = [corners.tl.y, corners.tr.y, corners.br.y, corners.bl.y];
  return {
    x0: Math.min(...xs) - pad,
    y0: Math.min(...ys) - pad,
    x1: Math.max(...xs) + pad,
    y1: Math.max(...ys) + pad,
  };
}

/** 點是否在球道四邊形內（含邊） */
export function pointInLane(p: Point2D, corners: LaneCorners): boolean {
  const poly = [corners.tl, corners.tr, corners.br, corners.bl];
  return pointInPoly(p, poly);
}

function pointInPoly(p: Point2D, poly: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * 紫／暗色球偏好：高分＝像保齡球；導引線（純紅／綠／細長洋紅）低分。
 */
export function ballColorScore(r: number, g: number, b: number): number {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc - minc;
  const lum = (r + g + b) / 3;

  // 純綠／純紅導引線：重罰
  if (g > r * 1.25 && g > b * 1.25 && g > 80) return 0.05;
  if (r > g * 1.35 && r > b * 1.15 && r > 140 && g < 100) return 0.08;

  // 紫色／洋紅：R、B 明顯高於 G
  const purple =
    b > g + 15 && r > g + 10 && sat > 25
      ? Math.min(1.4, 0.7 + (b - g) / 80 + (r - g) / 100)
      : 0;

  // 暗色球（黑／深藍紫）：中低亮度、非高飽和黃白
  const dark =
    lum < 110 && lum > 15 && !(r > 160 && g > 140)
      ? 0.55 + (110 - lum) / 200
      : lum < 140 && sat < 50
        ? 0.35
        : 0.15;

  // 亮黃點（導引中心）：壓低
  if (r > 180 && g > 160 && b < 120) return 0.1;

  return Math.max(purple, dark);
}

/**
 * 主追蹤一步：背景差＋幀差 → ROI 內圓形／色球 blob → EMA／速度限制／預測。
 * rgba 可選：提供時做色球評分（強烈建議）。
 */
export function trackBallFrame(
  state: BallTrackerState,
  currGray: Uint8ClampedArray,
  width: number,
  height: number,
  settings: TrackerSettings,
  corners: LaneCorners,
  dtMs: number,
  rgba?: Uint8ClampedArray | null
): TrackFrameResult {
  const roi = cornersBBox(corners, 10);
  const x0 = Math.max(0, Math.floor(roi.x0));
  const y0 = Math.max(0, Math.floor(roi.y0));
  const x1 = Math.min(width, Math.ceil(roi.x1));
  const y1 = Math.min(height, Math.ceil(roi.y1));

  if (!state.bg || state.bg.length !== currGray.length) {
    state.bg = new Float32Array(currGray.length);
    for (let i = 0; i < currGray.length; i++) state.bg[i] = currGray[i];
  }

  let noiseSum = 0;
  let noiseN = 0;
  const sampleStep = Math.max(2, Math.floor((x1 - x0) / 40));
  for (let y = y0; y < y1; y += sampleStep) {
    for (let x = x0; x < x1; x += sampleStep) {
      if (!pointInLane({ x, y }, corners)) continue;
      const i = y * width + x;
      noiseSum += Math.abs(currGray[i] - state.bg[i]);
      noiseN++;
    }
  }
  const noise = noiseN > 0 ? noiseSum / noiseN : 8;
  state.noiseEma = state.noiseEma * 0.9 + noise * 0.1;

  let thr = settings.sensitivity;
  if (settings.autoSensitivity) {
    const adj = Math.round((state.noiseEma - 10) * 0.85);
    thr = Math.max(12, Math.min(70, settings.sensitivity + adj));
  }

  const prev = state.prevGray;
  const mask = new Uint8Array(width * height);
  const lr = settings.bgLearningRate;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!pointInLane({ x, y }, corners)) continue;
      const i = y * width + x;
      const bgD = Math.abs(currGray[i] - state.bg[i]);
      let frameD = 0;
      if (prev && prev.length === currGray.length) {
        frameD = Math.abs(currGray[i] - prev[i]);
      }
      const score = bgD * 0.65 + frameD * 0.35;
      if (score >= thr) mask[i] = 1;
      else {
        state.bg[i] = state.bg[i] * (1 - lr) + currGray[i] * lr;
      }
    }
  }

  const predCenter =
    state.ema != null
      ? {
          x: state.ema.x + state.vel.x,
          y: state.ema.y + state.vel.y,
        }
      : state.seed;

  const searchRadius = state.locked
    ? Math.max(70, 55 + Math.hypot(state.vel.x, state.vel.y) * 2.5)
    : state.seed
      ? 100
      : null;

  const blob = findBestBallBlob(
    mask,
    width,
    height,
    x0,
    y0,
    x1,
    y1,
    settings.minBlobPixels,
    corners,
    predCenter,
    searchRadius,
    rgba
  );

  let detected: Point2D | null = blob ? { x: blob.cx, y: blob.cy } : null;
  let predicted = false;
  const blobScore = blob?.score ?? 0;

  // 自動鎖定：高分圓形色球 + 位置有位移（避免鎖死導引線／反光）
  const LOCK_SCORE = 60;
  if (blob) {
    state.recentCenters.push({ x: blob.cx, y: blob.cy });
    if (state.recentCenters.length > 10) state.recentCenters.shift();
  }
  const motionSpan = (() => {
    const pts = state.recentCenters;
    if (pts.length < 3) return 0;
    let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return Math.hypot(maxX - minX, maxY - minY);
  })();

  if (!state.locked && blob && blob.score >= LOCK_SCORE) {
    const moving = motionSpan >= 10 || (state.seed != null);
    if (moving) {
      state.lockStreak += 1;
      if (state.lockStreak >= 2 || state.seed) {
        state.locked = true;
        state.staticFrames = 0;
      }
    } else {
      state.lockStreak = Math.max(0, state.lockStreak - 1);
    }
  } else if (!state.locked) {
    state.lockStreak = Math.max(0, state.lockStreak - 1);
  }

  // 已鎖定但幾乎靜止太久 → 視為誤鎖，解除並清軌跡訊號
  if (state.locked && blob) {
    const spd = Math.hypot(state.vel.x, state.vel.y);
    if (motionSpan < 6 && spd < 1.2) {
      state.staticFrames += 1;
    } else {
      state.staticFrames = 0;
    }
    if (state.staticFrames >= 18 && !state.seed) {
      // 誤鎖靜物：解除鎖定，由 Workbench 丟棄無位移軌跡
      state.locked = false;
      state.ema = null;
      state.vel = { x: 0, y: 0 };
      state.lockStreak = 0;
      state.staticFrames = 0;
      state.lost = 0;
      state.recentCenters = [];
    }
  }

  // 速度／加速度限制（像素／幀）
  const maxSpeed = state.locked ? 55 : 40;
  const maxAccel = 28;

  if (detected && state.locked) {
    state.lost = 0;
    if (state.ema) {
      const jump = Math.hypot(detected.x - state.ema.x, detected.y - state.ema.y);
      const expected = Math.hypot(state.vel.x, state.vel.y);
      const maxJump = Math.min(maxSpeed * 1.8, 35 + expected * 1.8 + maxAccel);
      if (jump > maxJump) {
        // 誤觸：改用預測
        detected = null;
      } else {
        const alpha = settings.emaAlpha;
        const nx = state.ema.x * (1 - alpha) + detected.x * alpha;
        const ny = state.ema.y * (1 - alpha) + detected.y * alpha;
        let vx = nx - state.ema.x;
        let vy = ny - state.ema.y;
        // 限制加速度
        const dvx = vx - state.vel.x;
        const dvy = vy - state.vel.y;
        const da = Math.hypot(dvx, dvy);
        if (da > maxAccel) {
          const s = maxAccel / da;
          vx = state.vel.x + dvx * s;
          vy = state.vel.y + dvy * s;
        }
        const spd = Math.hypot(vx, vy);
        if (spd > maxSpeed) {
          vx = (vx / spd) * maxSpeed;
          vy = (vy / spd) * maxSpeed;
        }
        state.vel.x = state.vel.x * 0.55 + vx * 0.45;
        state.vel.y = state.vel.y * 0.55 + vy * 0.45;
        state.ema = { x: nx, y: ny };
      }
    } else {
      state.ema = { ...detected };
      state.vel = { x: 0, y: 0 };
    }
  } else if (detected && !state.locked) {
    // 未鎖定：只更新候選位置，不拉長軌跡用的速度
    if (!state.ema) state.ema = { ...detected };
    else {
      state.ema = {
        x: state.ema.x * 0.7 + detected.x * 0.3,
        y: state.ema.y * 0.7 + detected.y * 0.3,
      };
    }
  }

  if (!detected && state.locked && state.ema && state.lost < settings.lostFramesToEnd) {
    state.lost += 1;
    const px = state.ema.x + state.vel.x;
    const py = state.ema.y + state.vel.y;
    if (pointInLane({ x: px, y: py }, corners)) {
      predicted = true;
      state.ema = { x: px, y: py };
      state.vel.x *= 0.9;
      state.vel.y *= 0.9;
    }
  } else if (!detected && state.locked) {
    state.lost += 1;
  }

  // 出球道／ROI
  if (state.locked && state.ema) {
    if (!pointInLane(state.ema, corners)) {
      state.outOfLaneFrames += 1;
    } else {
      state.outOfLaneFrames = 0;
    }
    // 影像上半（pins 方向）且已鎖定
    const pinY = (corners.tl.y + corners.tr.y) / 2;
    const foulY = (corners.bl.y + corners.br.y) / 2;
    const towardPins = foulY > pinY; // 後方視角：pins 在上
    if (towardPins && state.ema.y < pinY + (foulY - pinY) * 0.22) {
      state.reachedPinZone = true;
    } else if (!towardPins && state.ema.y > pinY - (pinY - foulY) * 0.22) {
      state.reachedPinZone = true;
    }
  }

  if (!blob && lr > 0) {
    const fast = Math.min(0.12, lr * 2.5);
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        if (!pointInLane({ x, y }, corners)) continue;
        const i = y * width + x;
        state.bg[i] = state.bg[i] * (1 - fast) + currGray[i] * fast;
      }
    }
  }

  state.prevGray = currGray;

  if (settings.rpmEnabled && detected && state.locked && blob) {
    updateRpm(state, currGray, width, height, detected, settings, dtMs);
  }

  void dtMs;

  return {
    raw: detected,
    smoothed: state.locked ? state.ema : null,
    predicted,
    effectiveThreshold: thr,
    noiseLevel: state.noiseEma,
    blobScore,
    locked: state.locked,
    outOfLaneFrames: state.outOfLaneFrames,
    reachedPinZone: state.reachedPinZone,
  };
}

/**
 * 找最佳「球」blob：圓形度、填滿率、色球分、ROI 內、鄰近預測。
 * 細長線狀（導引線）會被強烈懲罰或剔除。
 */
export function findBestBallBlob(
  mask: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minPixels: number,
  corners: LaneCorners,
  prefer: Point2D | null,
  preferRadius: number | null,
  rgba?: Uint8ClampedArray | null
): BlobCandidate | null {
  const visited = new Uint8Array(width * height);
  let best: BlobCandidate | null = null;

  const stackX: number[] = [];
  const stackY: number[] = [];

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const start = y * width + x;
      if (!mask[start] || visited[start]) continue;
      if (!pointInLane({ x, y }, corners)) continue;

      stackX.length = 0;
      stackY.length = 0;
      stackX.push(x);
      stackY.push(y);
      visited[start] = 1;

      let size = 0;
      let sumX = 0;
      let sumY = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;

      while (stackX.length) {
        const cx = stackX.pop()!;
        const cy = stackY.pop()!;
        size++;
        sumX += cx;
        sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (rgba) {
          const oi = (cy * width + cx) * 4;
          sumR += rgba[oi];
          sumG += rgba[oi + 1];
          sumB += rgba[oi + 2];
        }
        const neighbors = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const ni = ny * width + nx;
          if (!mask[ni] || visited[ni]) continue;
          if (!pointInLane({ x: nx, y: ny }, corners)) continue;
          visited[ni] = 1;
          stackX.push(nx);
          stackY.push(ny);
        }
      }

      if (size < minPixels) continue;

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
      const fill = size / Math.max(1, bw * bh);
      const cx = sumX / size;
      const cy = sumY / size;
      if (!pointInLane({ x: cx, y: cy }, corners)) continue;

      // 細長線狀 blob（導引線）：直接跳過
      if (aspect > 3.2) continue;
      if (aspect > 2.4 && fill < 0.4) continue;
      if (fill < 0.28) continue;
      // 太大＝人／整段晃動
      if (size > 9000) continue;
      if (bw > width * 0.35 || bh > height * 0.35) continue;

      const meanR = rgba ? sumR / size : 80;
      const meanG = rgba ? sumG / size : 80;
      const meanB = rgba ? sumB / size : 80;
      const color = rgba ? ballColorScore(meanR, meanG, meanB) : 0.5;

      // 圓形偏好：aspect→1、fill 高
      const roundness =
        (1 / aspect) * 0.55 + Math.min(1, fill / 0.65) * 0.45;

      let score = Math.sqrt(size) * 2.2;
      score *= 0.35 + roundness * 1.1;
      score *= 0.4 + color * 1.2;

      if (prefer && preferRadius != null) {
        const d = Math.hypot(cx - prefer.x, cy - prefer.y);
        if (d > preferRadius) score *= 0.15;
        else score *= 1.35 - (d / preferRadius) * 0.55;
      } else {
        // 未鎖定：略偏好球道中線與中段（減少鎖球員／邊緣）
        const midX = (corners.tl.x + corners.tr.x + corners.bl.x + corners.br.x) / 4;
        const midY = (corners.tl.y + corners.tr.y + corners.bl.y + corners.br.y) / 4;
        const dMid = Math.hypot(cx - midX, cy - midY);
        const laneW = Math.hypot(corners.tr.x - corners.tl.x, corners.tr.y - corners.tl.y);
        score *= 1.1 - Math.min(0.4, dMid / Math.max(40, laneW));
      }

      // 中等大小加分
      if (size >= 50 && size <= 2500) score *= 1.15;
      if (size > 4000) score *= 0.45;

      const cand: BlobCandidate = {
        cx,
        cy,
        size,
        w: bw,
        h: bh,
        aspect,
        fill,
        meanR,
        meanG,
        meanB,
        score,
      };
      if (!best || cand.score > best.score) best = cand;
    }
  }

  if (!best || best.size < minPixels) return null;
  return best;
}

function updateRpm(
  state: BallTrackerState,
  gray: Uint8ClampedArray,
  width: number,
  height: number,
  center: Point2D,
  settings: TrackerSettings,
  dtMs: number
) {
  const BINS = 64;
  const rMin = 4;
  const rMax = 18;
  const polar = new Float32Array(BINS);
  const counts = new Float32Array(BINS);

  const cx = Math.round(center.x);
  const cy = Math.round(center.y);
  for (let dy = -rMax; dy <= rMax; dy++) {
    for (let dx = -rMax; dx <= rMax; dx++) {
      const r = Math.hypot(dx, dy);
      if (r < rMin || r > rMax) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      let ang = Math.atan2(dy, dx);
      if (ang < 0) ang += Math.PI * 2;
      const bin = Math.min(BINS - 1, Math.floor((ang / (Math.PI * 2)) * BINS));
      polar[bin] += gray[y * width + x];
      counts[bin] += 1;
    }
  }
  for (let i = 0; i < BINS; i++) {
    polar[i] = counts[i] > 0 ? polar[i] / counts[i] : 0;
  }

  let minV = 255;
  let maxV = 0;
  for (let i = 0; i < BINS; i++) {
    if (counts[i] === 0) continue;
    minV = Math.min(minV, polar[i]);
    maxV = Math.max(maxV, polar[i]);
  }
  const contrast = maxV - minV;
  if (contrast < settings.rpmMinContrast) {
    state.prevPolar = polar;
    return;
  }

  if (state.prevPolar && state.prevPolar.length === BINS && dtMs > 0) {
    const shift = circularShift(state.prevPolar, polar);
    const deg = (shift / BINS) * 360;
    let dDeg = deg;
    if (dDeg > 180) dDeg -= 360;
    if (dDeg < -180) dDeg += 360;
    const degPerSec = (Math.abs(dDeg) / dtMs) * 1000;
    const rpm = (degPerSec / 360) * 60;
    if (rpm >= 40 && rpm <= 800) {
      state.rpmSamples.push(rpm);
      if (state.rpmSamples.length > 24) state.rpmSamples.shift();
      const med = median(state.rpmSamples);
      state.lastRpm = Math.round(med);
      const confContrast = Math.min(1, contrast / 60);
      const confN = Math.min(1, state.rpmSamples.length / 12);
      const spread = mad(state.rpmSamples, med) / Math.max(1, med);
      const confStable = Math.max(0, 1 - spread * 2);
      state.lastRpmConf = Math.max(
        0,
        Math.min(1, confContrast * 0.4 + confN * 0.3 + confStable * 0.3)
      );
    }
  }
  state.prevPolar = polar;
}

function circularShift(a: Float32Array, b: Float32Array): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let best = 0;
  let bestCorr = -Infinity;
  for (let s = 0; s < n; s++) {
    let corr = 0;
    for (let i = 0; i < n; i++) {
      corr += (a[i] - ma) * (b[(i + s) % n] - mb);
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      best = s;
    }
  }
  return best;
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mad(arr: number[], med: number): number {
  const devs = arr.map((v) => Math.abs(v - med));
  return median(devs);
}

/** 相容舊 API：單純幀差質心 */
export function findBallCentroid(
  currGray: Uint8ClampedArray,
  prevGray: Uint8ClampedArray,
  width: number,
  height: number,
  settings: TrackerSettings,
  roi?: RoiRect
): Point2D | null {
  const thr = settings.sensitivity;
  const x0 = Math.max(0, Math.floor(roi?.x0 ?? 0));
  const y0 = Math.max(0, Math.floor(roi?.y0 ?? 0));
  const x1 = Math.min(width, Math.ceil(roi?.x1 ?? width));
  const y1 = Math.min(height, Math.ceil(roi?.y1 ?? height));

  const mask = new Uint8Array(width * height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      if (Math.abs(currGray[i] - prevGray[i]) >= thr) mask[i] = 1;
    }
  }

  const dummyCorners: LaneCorners = {
    tl: { x: x0, y: y0 },
    tr: { x: x1, y: y0 },
    br: { x: x1, y: y1 },
    bl: { x: x0, y: y1 },
  };
  const b = findBestBallBlob(
    mask,
    width,
    height,
    x0,
    y0,
    x1,
    y1,
    settings.minBlobPixels,
    dummyCorners,
    null,
    null,
    null
  );
  return b ? { x: b.cx, y: b.cy } : null;
}

export function getRpmEstimate(state: BallTrackerState): {
  rpm: number | null;
  confidence: number;
} {
  return { rpm: state.lastRpm, confidence: state.lastRpmConf };
}

/**
 * 是否應結束本投（供 Workbench 判斷）。
 * - 連續丟幀達標
 * - 出球道 N 幀
 * - 到過 pin 區後再丟幀數幀
 */
export function shouldEndShot(
  state: BallTrackerState,
  settings: TrackerSettings,
  hasPoints: boolean
): boolean {
  if (!hasPoints || !state.locked) return false;
  if (state.lost >= settings.lostFramesToEnd) return true;
  if (state.outOfLaneFrames >= Math.max(8, Math.floor(settings.lostFramesToEnd * 0.75))) {
    return true;
  }
  if (state.reachedPinZone && state.lost >= Math.max(5, Math.floor(settings.lostFramesToEnd * 0.45))) {
    return true;
  }
  return false;
}
