import type { LaneCorners, Point2D, TrackerSettings } from "./types";

export const DEFAULT_TRACKER: TrackerSettings = {
  sensitivity: 28,
  minBlobPixels: 40,
  lostFramesToEnd: 14,
  emaAlpha: 0.45,
  autoSensitivity: true,
  bgLearningRate: 0.04,
  rpmEnabled: true,
  rpmMinContrast: 18,
};

/** 可選：限制搜尋 ROI */
export type RoiRect = { x0: number; y0: number; x1: number; y1: number };

export type TrackFrameResult = {
  raw: Point2D | null;
  smoothed: Point2D | null;
  predicted: boolean;
  /** 本幀使用的有效閾值 */
  effectiveThreshold: number;
  /** 背景雜訊估計 */
  noiseLevel: number;
};

/**
 * 追蹤狀態：背景模型 + EMA + 速度預測。
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
 * 主追蹤一步：背景差（優先）＋幀差融合 → 球道內最大 blob → EMA／預測。
 */
export function trackBallFrame(
  state: BallTrackerState,
  currGray: Uint8ClampedArray,
  width: number,
  height: number,
  settings: TrackerSettings,
  corners: LaneCorners,
  dtMs: number
): TrackFrameResult {
  const roi = cornersBBox(corners, 10);
  const x0 = Math.max(0, Math.floor(roi.x0));
  const y0 = Math.max(0, Math.floor(roi.y0));
  const x1 = Math.min(width, Math.ceil(roi.x1));
  const y1 = Math.min(height, Math.ceil(roi.y1));

  // 初始化／更新背景（無球或弱運動時學得較快）
  if (!state.bg || state.bg.length !== currGray.length) {
    state.bg = new Float32Array(currGray.length);
    for (let i = 0; i < currGray.length; i++) state.bg[i] = currGray[i];
  }

  // 估計 ROI 內雜訊（相對背景）
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
    // 雜訊高 → 提高閾值；雜訊低 → 略降
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
      // 背景差為主、幀差為輔（減少慢晃背景誤觸）
      const score = bgD * 0.65 + frameD * 0.35;
      if (score >= thr) mask[i] = 1;
      else {
        // 靜態區更新背景
        state.bg[i] = state.bg[i] * (1 - lr) + currGray[i] * lr;
      }
    }
  }

  // 若有預測位置，優先在附近找 blob（減少遠處干擾）
  const predCenter =
    state.ema != null
      ? {
          x: state.ema.x + state.vel.x,
          y: state.ema.y + state.vel.y,
        }
      : null;

  const blob = findBestBlob(
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
    predCenter ? 90 : null
  );

  let raw: Point2D | null = blob;
  let predicted = false;

  if (raw) {
    state.lost = 0;
    if (state.ema) {
      const alpha = settings.emaAlpha;
      const nx = state.ema.x * (1 - alpha) + raw.x * alpha;
      const ny = state.ema.y * (1 - alpha) + raw.y * alpha;
      const dt = Math.max(1, dtMs);
      // 速度 EMA（像素／幀近似）
      const vx = nx - state.ema.x;
      const vy = ny - state.ema.y;
      state.vel.x = state.vel.x * 0.6 + vx * 0.4;
      state.vel.y = state.vel.y * 0.6 + vy * 0.4;
      // 抑制不合理跳點
      const jump = Math.hypot(raw.x - state.ema.x, raw.y - state.ema.y);
      const maxJump = 120 + Math.hypot(state.vel.x, state.vel.y) * 2;
      if (jump > maxJump && state.ema) {
        // 可能是誤觸：用預測代替
        raw = {
          x: state.ema.x + state.vel.x,
          y: state.ema.y + state.vel.y,
        };
        predicted = true;
      }
      state.ema = { x: nx, y: ny };
      void dt;
    } else {
      state.ema = { ...raw };
      state.vel = { x: 0, y: 0 };
    }
  } else if (state.ema && state.lost < settings.lostFramesToEnd) {
    // 丟幀預測
    state.lost += 1;
    const px = state.ema.x + state.vel.x;
    const py = state.ema.y + state.vel.y;
    if (pointInLane({ x: px, y: py }, corners)) {
      raw = { x: px, y: py };
      predicted = true;
      state.ema = { x: px, y: py };
      // 略衰減速度
      state.vel.x *= 0.92;
      state.vel.y *= 0.92;
    }
  } else if (!raw) {
    state.lost += 1;
  }

  // 無球時較快學背景（降低晃動殘影）
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

  // RPM（實驗）：球表極座標相關
  if (settings.rpmEnabled && raw && !predicted && blob) {
    updateRpm(state, currGray, width, height, raw, settings, dtMs);
  }

  return {
    raw: blob,
    smoothed: state.ema,
    predicted,
    effectiveThreshold: thr,
    noiseLevel: state.noiseEma,
  };
}

function findBestBlob(
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
  preferRadius: number | null
): Point2D | null {
  const visited = new Uint8Array(width * height);
  let bestScore = -1;
  let bestCx = 0;
  let bestCy = 0;
  let bestSize = 0;

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

      while (stackX.length) {
        const cx = stackX.pop()!;
        const cy = stackY.pop()!;
        size++;
        sumX += cx;
        sumY += cy;
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
      const cx = sumX / size;
      const cy = sumY / size;
      if (!pointInLane({ x: cx, y: cy }, corners)) continue;

      let score = size;
      if (prefer && preferRadius != null) {
        const d = Math.hypot(cx - prefer.x, cy - prefer.y);
        if (d > preferRadius) score *= 0.25;
        else score *= 1.2 - (d / preferRadius) * 0.5;
      }
      // 偏好中等大小（太巨大可能是人或整段晃動）
      if (size > 8000) score *= 0.3;

      if (score > bestScore) {
        bestScore = score;
        bestSize = size;
        bestCx = cx;
        bestCy = cy;
      }
    }
  }

  if (bestSize < minPixels) return null;
  return { x: bestCx, y: bestCy };
}

/**
 * 實驗性 RPM：在球質心周圍取環帶，展開為極座標強度條，
 * 與前幀做循環互相關估角速度。需球表高對比色塊／標記。
 */
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

  // 對比檢查
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
    // shift bins → 角度
    const deg = (shift / BINS) * 360;
    // 取最小角位移
    let dDeg = deg;
    if (dDeg > 180) dDeg -= 360;
    if (dDeg < -180) dDeg += 360;
    const degPerSec = (Math.abs(dDeg) / dtMs) * 1000;
    // 保齡球直徑約 8.5"；此處只估「影像角」轉速，假設看到的是球表自旋投影
    // RPM = (deg/s) / 360 * 60
    const rpm = (degPerSec / 360) * 60;
    // 合理保齡範圍約 100–600；超出當雜訊
    if (rpm >= 40 && rpm <= 800) {
      state.rpmSamples.push(rpm);
      if (state.rpmSamples.length > 24) state.rpmSamples.shift();
      const med = median(state.rpmSamples);
      state.lastRpm = Math.round(med);
      // 信心：對比 + 樣本數 + 變異小
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
  // 去均值
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
  return findBestBlob(
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
    null
  );
}

export function getRpmEstimate(state: BallTrackerState): {
  rpm: number | null;
  confidence: number;
} {
  return { rpm: state.lastRpm, confidence: state.lastRpmConf };
}
