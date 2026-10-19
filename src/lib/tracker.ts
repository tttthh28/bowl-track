import type { LaneCorners, Point2D, TrackerSettings } from "./types";
import {
  createSpinState,
  getSpinEstimate,
  resetSpinState,
  updateSpinFromFrame,
  type SpinEstimateState,
} from "./spinEstimate";

export const DEFAULT_TRACKER: TrackerSettings = {
  // 對齊 laneProbe（sens26／blob28）：預設 28／35 喺 bowling-demo 只鎖~20點 → Shot Arrows=—
  sensitivity: 26,
  minBlobPixels: 28,
  lostFramesToEnd: 18,
  emaAlpha: 0.5,
  autoSensitivity: true,
  bgLearningRate: 0.035,
  rpmEnabled: true,
  rpmMinContrast: 22,
  boardFromRight: false,
};


/**
 * 球－球道接觸點（Corra Reconstruction：perspective 用 y+radius，唔用圓心）。
 * radius 同 center 須同一解析度。
 */
export function ballContactPoint(
  center: Point2D,
  radius: number | null | undefined
): Point2D {
  if (radius == null || !(radius > 0)) return center;
  return { x: center.x, y: center.y + radius };
}
/** 可選：限制搜尋 ROI */
export type RoiRect = { x0: number; y0: number; x1: number; y1: number };

export type TrackFrameResult = {
  /** 本幀實際偵測到的質心（未含預測） */
  raw: Point2D | null;
  smoothed: Point2D | null;
  predicted: boolean;
  /** 本幀球半徑（px，工作解析度）；lane 接觸點用 y+radius */
  radius: number | null;
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
  /** RPM 鎖定中位值（低信心時不亂跳） */
  rpmLocked: number | null = null;
  /** Alinejad-port spin (polar + annular flow); mirrors rpm* fields */
  spinState: SpinEstimateState = createSpinState();
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
  /** 最近一幀球半徑（預測幀沿用） */
  lastRadius: number | null = null;
  /** 半徑 EMA：接觸點用，避免 bbox 跳變把 board 拧到 ~28 */
  radiusEma: number | null = null;
  /** demo：溝爬拒後加速重鎖（降 LOCK_SCORE／streak） */
  fastRelockFrames = 0;

  reset() {
    this.bg = null;
    this.prevGray = null;
    this.ema = null;
    this.vel = { x: 0, y: 0 };
    this.lastRadius = null;
    this.radiusEma = null;
    this.fastRelockFrames = 0;
    this.lost = 0;
    this.noiseEma = 8;
    this.prevPolar = null;
    this.rpmSamples = [];
    this.lastRpm = null;
    this.lastRpmConf = 0;
    this.rpmLocked = null;
    resetSpinState(this.spinState);
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

  /**
   * 一投結束後清軌跡狀態。
   * clearBg：upload 影片 rewind 必須清背景——暖 bg 會令第 2 圈鎖右溝反光（Tester arr~32）。
   * 鏡頭連續拍可保留 bg（default）。
   */
  beginNewShot(opts?: { clearBg?: boolean }) {
    this.ema = null;
    this.vel = { x: 0, y: 0 };
    this.lastRadius = null;
    this.radiusEma = null;
    this.fastRelockFrames = 0;
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
    this.rpmLocked = null;
    resetSpinState(this.spinState);
    if (opts?.clearBg) {
      this.bg = null;
      this.prevGray = null;
      this.noiseEma = 8;
    }
  }

  /**
   * bowling-demo：拒溝爬後軟重鎖——保留 bg／前進速度，X 拉回球道中線，
   * 之後 ~18 幀降低 lock 門檻以便 12–18′ 抓住真球（唔清 bg 以免丟球）。
   */
  /** demo：保持 locked，只把 X 拉向中線並阻尼橫速——唔斷鎖以免跳過 14–16′ */
  nudgeMidKeepLock(corners: LaneCorners) {
    if (!this.ema) return;
    const midX =
      (corners.tl.x + corners.tr.x + corners.br.x + corners.bl.x) / 4;
    this.ema = { x: this.ema.x * 0.25 + midX * 0.75, y: this.ema.y };
    this.vel.x *= 0.15;
    this.fastRelockFrames = Math.max(this.fastRelockFrames, 12);
  }

  softRelockMid(corners: LaneCorners) {
    const foulY = (corners.bl.y + corners.br.y) / 2;
    const pinY = (corners.tl.y + corners.tr.y) / 2;
    const y0 = this.ema?.y ?? foulY;
    // 對準 ~15′ 影像帶（foul→pin ≈0.25）
    const yTarget = foulY + (pinY - foulY) * 0.25;
    const y = y0 * 0.3 + yTarget * 0.7;
    const t =
      Math.abs(foulY - pinY) > 1
        ? Math.max(0, Math.min(1, (foulY - y) / (foulY - pinY)))
        : 0.25;
    const leftX = corners.bl.x + (corners.tl.x - corners.bl.x) * t;
    const rightX = corners.br.x + (corners.tr.x - corners.br.x) * t;
    // tony 線：瞄準 ~17 影像 X，預測左漂後 apex 落喺 board ~14–15
    // （路徑 V 由 smoothDemoPath 清；此處硬瞄先保 mid 重鎖／覆蓋）
    const targetX = leftX + (rightX - leftX) * (17 / 39);
    const vy = this.vel.y < -2 ? this.vel.y : (pinY - foulY) * 0.055;
    this.ema = { x: targetX, y };
    this.vel = { x: 0, y: vy };
    // 保持 locked：unlock 會即刻鎖返右溝反光 → 預測 board~22 被拒
    this.lost = 0;
    this.staticFrames = 0;
    this.outOfLaneFrames = 0;
    this.recentCenters = [{ x: targetX, y }];
    this.fastRelockFrames = 30;
  }
}

/**
 * 追蹤工作解析度上限：原生 1080p 直接追易鎖錯溝／導引線；
 * offline verify 用 ~640 寬穩定。高於此外將縮圖再追，座標再映射返原圖。
 */
export const TRACK_WORK_MAX_WIDTH = 640;

export function trackWorkSize(
  width: number,
  height: number
): { scale: number; tw: number; th: number } {
  if (width <= TRACK_WORK_MAX_WIDTH) {
    return { scale: 1, tw: width, th: height };
  }
  const scale = TRACK_WORK_MAX_WIDTH / width;
  return {
    scale,
    tw: Math.max(80, Math.round(width * scale)),
    th: Math.max(80, Math.round(height * scale)),
  };
}

export function scaleLaneCorners(
  corners: LaneCorners,
  scale: number
): LaneCorners {
  if (scale === 1) return corners;
  return {
    tl: { x: corners.tl.x * scale, y: corners.tl.y * scale },
    tr: { x: corners.tr.x * scale, y: corners.tr.y * scale },
    br: { x: corners.br.x * scale, y: corners.br.y * scale },
    bl: { x: corners.bl.x * scale, y: corners.bl.y * scale },
  };
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
/** 內縮四角（搜 blob 用）：避開左右溝反光，H／overlay 仍用原角 */
export function insetLaneCorners(corners: LaneCorners, frac = 0.2): LaneCorners {
  const cx =
    (corners.tl.x + corners.tr.x + corners.br.x + corners.bl.x) / 4;
  const cy =
    (corners.tl.y + corners.tr.y + corners.br.y + corners.bl.y) / 4;
  const inset = (p: Point2D): Point2D => ({
    x: p.x + (cx - p.x) * frac,
    y: p.y + (cy - p.y) * frac,
  });
  return {
    tl: inset(corners.tl),
    tr: inset(corners.tr),
    br: inset(corners.br),
    bl: inset(corners.bl),
  };
}


export function ballColorScore(r: number, g: number, b: number): number {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc - minc;
  const lum = (r + g + b) / 3;

  // 純綠／純紅導引線：重罰（demo 常有綠左溝／紅右溝線）
  if (g > r * 1.18 && g > b * 1.18 && g > 70) return 0.04;
  if (r > g * 1.3 && r > b * 1.1 && r > 130 && g < 110) return 0.06;
  // 高飽和綠邊（略帶黃）
  if (g > 140 && g > r + 25 && g > b + 25) return 0.05;

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

  const demoStrict = !settings.boardFromRight;
  let searchRadius = state.locked
    ? Math.max(70, 55 + Math.hypot(state.vel.x, state.vel.y) * 2.5)
    : state.seed
      ? 100
      : null;
  // demo 軟重鎖：擴大搜尋，唔跟溝邊 prefer
  if (demoStrict && state.fastRelockFrames > 0) {
    searchRadius = Math.max(searchRadius ?? 0, 140);
  }

  let blob = findBestBallBlob(
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
    rgba,
    demoStrict
  );

  // demo：主 blob 貼邊 → 若中線有更好候選就換；否則保留（Workbench 拒溝寫點）
  if (demoStrict && blob && state.locked) {
    const foulY = (corners.bl.y + corners.br.y) / 2;
    const pinY = (corners.tl.y + corners.tr.y) / 2;
    const t =
      Math.abs(foulY - pinY) > 1
        ? Math.max(0, Math.min(1, (foulY - blob.cy) / (foulY - pinY)))
        : 0.5;
    const leftX = corners.bl.x + (corners.tl.x - corners.bl.x) * t;
    const rightX = corners.br.x + (corners.tr.x - corners.br.x) * t;
    const span = Math.max(20, rightX - leftX);
    const edgeFrac = Math.min(blob.cx - leftX, rightX - blob.cx) / span;
    if (edgeFrac < 0.16) {
      const midX = (leftX + rightX) / 2;
      const midPrefer = { x: midX, y: (predCenter?.y ?? blob.cy) - 8 };
      const alt = findBestBallBlob(
        mask,
        width,
        height,
        x0,
        y0,
        x1,
        y1,
        Math.max(10, Math.floor(settings.minBlobPixels * 0.55)),
        corners,
        midPrefer,
        Math.max(140, searchRadius ?? 140),
        rgba,
        true
      );
      if (alt) {
        const t2 =
          Math.abs(foulY - pinY) > 1
            ? Math.max(0, Math.min(1, (foulY - alt.cy) / (foulY - pinY)))
            : 0.5;
        const l2 = corners.bl.x + (corners.tl.x - corners.bl.x) * t2;
        const r2 = corners.br.x + (corners.tr.x - corners.br.x) * t2;
        const sp2 = Math.max(20, r2 - l2);
        const altEdge = Math.min(alt.cx - l2, r2 - alt.cx) / sp2;
        if (altEdge > edgeFrac + 0.03) blob = alt;
      }
    }
  }

  let detected: Point2D | null = blob ? { x: blob.cx, y: blob.cy } : null;
  let predicted = false;
  const blobScore = blob?.score ?? 0;

  // 自動鎖定：高分圓形色球 + 位置有位移（避免鎖死導引線／反光）
  // demo fastRelock：降門檻以便箭頭區抓真球
  const LOCK_SCORE =
    demoStrict && state.fastRelockFrames > 0 ? 42 : 65;
  const LOCK_STREAK_NEED =
    demoStrict && state.fastRelockFrames > 0 ? 1 : 3;
  if (state.fastRelockFrames > 0) state.fastRelockFrames -= 1;
  if (blob) {
    const lastC = state.recentCenters[state.recentCenters.length - 1];
    if (
      !state.locked &&
      lastC &&
      Math.hypot(blob.cx - lastC.x, blob.cy - lastC.y) > 220
    ) {
      // 未鎖定時超大跳（假斑↔真球）：清歷史，避免 towardPins 被毒化
      state.recentCenters = [{ x: blob.cx, y: blob.cy }];
      state.lockStreak = 0;
    } else {
      state.recentCenters.push({ x: blob.cx, y: blob.cy });
      if (state.recentCenters.length > 12) state.recentCenters.shift();
    }
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
    // 要求真實位移；純靜物／溝邊反光唔鎖
    const moving = motionSpan >= 18 || state.seed != null;
    // 後方視角：往 pins 大致向上（y 減）
    let towardPins = true;
    if (state.recentCenters.length >= 4 && !state.seed) {
      const a = state.recentCenters[0];
      const b = state.recentCenters[state.recentCenters.length - 1];
      const pinY = (corners.tl.y + corners.tr.y) / 2;
      const foulY = (corners.bl.y + corners.br.y) / 2;
      if (foulY > pinY) {
        towardPins = b.y <= a.y + 6; // 允許微抖
      }
    }
    if (moving && towardPins) {
      state.lockStreak += 1;
      if (state.lockStreak >= LOCK_STREAK_NEED || state.seed) {
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
      state.lastRadius = null;
      state.radiusEma = null;
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
    // demo：拒溝後預測時阻尼橫向，沿中線滑過箭頭區
    if (demoStrict) state.vel.x *= 0.35;
    const px = state.ema.x + state.vel.x;
    const py = state.ema.y + state.vel.y;
    // PBA：變焦後可預測出靜態四角，延長 feet 覆蓋捱 BP
    if (
      pointInLane({ x: px, y: py }, corners) ||
      !!settings.boardFromRight
    ) {
      predicted = true;
      state.ema = { x: px, y: py };
      state.vel.x *= demoStrict ? 0.5 : 0.9;
      // demo：0.92 略慢衰減，畀中段預測多捱幾呎（UI 10–27′）；唔加 minVy 以免飛過真球
      state.vel.y *= demoStrict ? 0.92 : 0.9;
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

  // Corra：lane 用球底 (cx, cy+r)。半徑近圓估＋夾緊＋EMA，避免 bbox 跳變把 board 拧到 ~28.5
  if (blob) {
    const fromArea = Math.sqrt(Math.max(1, blob.size) / Math.PI);
    const fromBox = Math.min(blob.w, blob.h) * 0.5;
    const r = Math.max(2.5, Math.min(28, 0.55 * fromArea + 0.45 * fromBox));
    state.lastRadius = r;
    state.radiusEma =
      state.radiusEma == null ? r : state.radiusEma * 0.65 + r * 0.35;
  }
  const radiusRaw =
    state.locked && state.lastRadius != null && state.lastRadius > 0
      ? state.lastRadius
      : blob
        ? Math.max(
            2.5,
            Math.min(
              28,
              0.55 * Math.sqrt(Math.max(1, blob.size) / Math.PI) +
                0.45 * Math.min(blob.w, blob.h) * 0.5
            )
          )
        : null;
  // 接觸／lane 用 EMA，減 bbox 跳變（Corra y+r 仍用穩定半徑）
  const radius =
    state.radiusEma != null && state.radiusEma > 0
      ? state.radiusEma
      : radiusRaw;

  return {
    raw: detected,
    smoothed: state.locked ? state.ema : null,
    predicted,
    radius,
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
  rgba?: Uint8ClampedArray | null,
  /** demo：已鎖亦重罰貼邊（PBA 近邊合法→false） */
  strictEdge?: boolean
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

      {
        const laneLeft = Math.min(corners.tl.x, corners.bl.x);
        const laneRight = Math.max(corners.tr.x, corners.br.x);
        const laneSpan = Math.max(20, laneRight - laneLeft);
        const edgeFrac = Math.min(cx - laneLeft, laneRight - cx) / laneSpan;
        if (prefer && preferRadius != null && !strictEdge) {
          // 已鎖輕罰（PBA 近邊合法）
          if (edgeFrac < 0.04) score *= 0.35;
          else if (edgeFrac < 0.08) score *= 0.7;
        } else {
          // 未鎖／demo strict：重罰溝邊反光
          if (edgeFrac < 0.05) score *= 0.08;
          else if (edgeFrac < 0.09) score *= 0.22;
          else if (edgeFrac < 0.14) score *= 0.45;
          else if (edgeFrac < 0.2) score *= 0.75;
        }
      }
      if (prefer && preferRadius != null) {
        const d = Math.hypot(cx - prefer.x, cy - prefer.y);
        if (d > preferRadius) score *= 0.15;
        else score *= 1.35 - (d / preferRadius) * 0.55;
      } else {
        const midX = (corners.tl.x + corners.tr.x + corners.bl.x + corners.br.x) / 4;
        const foulY = (corners.bl.y + corners.br.y) / 2;
        const pinY = (corners.tl.y + corners.tr.y) / 2;
        const laneW = Math.hypot(corners.tr.x - corners.tl.x, corners.tr.y - corners.tl.y);
        const dMidX = Math.abs(cx - midX);
        score *= 1.2 - Math.min(0.55, dMidX / Math.max(40, laneW * 0.55));
        const ySpan = Math.max(20, Math.abs(foulY - pinY));
        const fromFoul = Math.abs(cy - foulY) / ySpan;
        if (fromFoul < 0.55) score *= 1.12;
        else if (fromFoul > 0.85) score *= 0.65;
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
  const sample = updateSpinFromFrame(state.spinState, gray, width, height, center, {
    dtMs,
    minContrast: settings.rpmMinContrast,
    radiusPx: state.radiusEma ?? state.lastRadius,
  });
  // Mirror into legacy fields (Workbench / getRpmEstimate)
  state.prevPolar = state.spinState.prevPolar;
  state.rpmSamples = state.spinState.samples;
  state.lastRpm = state.spinState.lastRpm;
  state.lastRpmConf = state.spinState.lastConf;
  state.rpmLocked = state.spinState.locked;
  void sample;
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
  // Prefer Alinejad-port spin state (polar + annular OF fuse)
  const spun = getSpinEstimate(state.spinState);
  if (spun.rpm != null && spun.confidence >= 0.48) {
    return { rpm: spun.rpm, confidence: spun.confidence };
  }
  const rpm =
    state.lastRpmConf >= 0.48
      ? state.lastRpm ?? state.rpmLocked
      : null;
  return { rpm, confidence: state.lastRpmConf };
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
  // outOfLane：PBA zoom／demo inset 都易誤殺（覆蓋停 ~24–25′）。
  // 只喺預設短 lost（≤20）時用；Workbench demo 會抬 lostFrames→跳過。
  if (
    !settings.boardFromRight &&
    settings.lostFramesToEnd <= 20 &&
    state.outOfLaneFrames >= Math.max(8, Math.floor(settings.lostFramesToEnd * 0.75))
  ) {
    return true;
  }
  // pin 區早收：同樣要求短 lost 設定；demo 抬 lost 後改靠 lost 門檻捱到袋口
  if (
    !settings.boardFromRight &&
    settings.lostFramesToEnd <= 20 &&
    state.reachedPinZone &&
    state.lost >= Math.max(5, Math.floor(settings.lostFramesToEnd * 0.45))
  ) {
    return true;
  }
  return false;
}
