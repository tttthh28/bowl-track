import type { LaneCorners, LanePoint, Point2D } from "./types";

/**
 * 簡化球道：寬 39 boards、長 60 feet。
 *
 * 四角以「畫面位置」命名（TL/TR/BR/BL）。
 * 預設假設從投手後方拍攝：畫面上方＝pin deck、下方＝foul line。
 *   TL → board=0, feet=60
 *   TR → board=39, feet=60
 *   BR → board=39, feet=0
 *   BL → board=0, feet=0
 *
 * 若相機角度不同，仍可拖曳四角對準實際 foul／pins 端點。
 */

export const LANE_W = 39;
export const LANE_L = 60;

/** 解 8x8 線性系統（高斯消去）求透視矩陣 */
function solveHomography(
  src: Point2D[],
  dst: Point2D[]
): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const M = A.map((row, i) => [...row, b[i]]);
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

export type Homography = {
  h: number[];
};

export function buildHomography(corners: LaneCorners): Homography | null {
  const src: Point2D[] = [corners.tl, corners.tr, corners.br, corners.bl];
  // 後方視角預設：上=pins(60)、下=foul(0)
  const dst: Point2D[] = [
    { x: 0, y: LANE_L },
    { x: LANE_W, y: LANE_L },
    { x: LANE_W, y: 0 },
    { x: 0, y: 0 },
  ];
  const h = solveHomography(src, dst);
  if (!h) return null;
  return { h };
}

export function applyHomography(H: Homography, p: Point2D): Point2D {
  const [a, b, c, d, e, f, g, hh] = H.h;
  const w = g * p.x + hh * p.y + 1;
  if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
  return {
    x: (a * p.x + b * p.y + c) / w,
    y: (d * p.x + e * p.y + f) / w,
  };
}

export function imageToLane(H: Homography, p: Point2D): LanePoint {
  const q = applyHomography(H, p);
  // 輕微容差外不硬夾到溝邊（避免誤追左溝永遠變成 board=0）
  return {
    board: Math.max(-2, Math.min(LANE_W + 2, q.x)),
    feet: Math.max(-2, Math.min(LANE_L + 2, q.y)),
  };
}

export type BoardAtFeetResult = {
  board: number;
  /** true＝目標 feet 超出軌跡覆蓋，以端點斜率外推 */
  extrapolated: boolean;
};

export type TrajectoryCoverage = {
  minFeet: number;
  maxFeet: number;
  span: number;
  count: number;
};

/** 非預測軌跡的 feet 覆蓋範圍 */
export function trajectoryCoverage(
  points: { lane?: LanePoint; predicted?: boolean }[]
): TrajectoryCoverage | null {
  const feet = points
    .filter((p) => p.lane && !p.predicted)
    .map((p) => p.lane!.feet)
    .filter((f) => f >= -1 && f <= LANE_L + 1);
  if (feet.length < 2) return null;
  const minFeet = Math.min(...feet);
  const maxFeet = Math.max(...feet);
  return {
    minFeet,
    maxFeet,
    span: maxFeet - minFeet,
    count: feet.length,
  };
}

/**
 * 在軌跡上取目標 feet 的 board。
 * - 預設只在實際覆蓋區間內插值；超出則回 null（除非 allowExtrapolate）。
 * - allowExtrapolate：以覆蓋端點附近斜率短距外推，並標 extrapolated。
 * - maxGap：端點／最近點距離超過此值視為不足。
 */
export function boardAtFeetDetailed(
  points: { lane?: LanePoint; predicted?: boolean }[],
  targetFeet: number,
  opts?: {
    allowExtrapolate?: boolean;
    /** 允許端點外推／最近點的最大 feet 差距（預設 3） */
    maxGap?: number;
  }
): BoardAtFeetResult | null {
  const allowExtrapolate = opts?.allowExtrapolate ?? false;
  const maxGap = opts?.maxGap ?? 3;
  const withLane = points.filter(
    (p): p is { lane: LanePoint; predicted?: boolean } =>
      !!p.lane && !p.predicted
  );
  if (withLane.length < 2) return null;

  const cov = trajectoryCoverage(points);
  if (!cov) return null;

  // 區段內線性插值
  for (let i = 0; i < withLane.length - 1; i++) {
    const a = withLane[i].lane;
    const b = withLane[i + 1].lane;
    const lo = Math.min(a.feet, b.feet);
    const hi = Math.max(a.feet, b.feet);
    if (targetFeet >= lo && targetFeet <= hi && hi - lo > 1e-6) {
      const t = (targetFeet - a.feet) / (b.feet - a.feet);
      return {
        board: a.board + t * (b.board - a.board),
        extrapolated: false,
      };
    }
  }

  // 覆蓋範圍內但相鄰段未夾住（例如稀疏）：取最近點，距離要夠近
  if (targetFeet >= cov.minFeet - 0.5 && targetFeet <= cov.maxFeet + 0.5) {
    let best = withLane[0];
    let bestD = Math.abs(best.lane.feet - targetFeet);
    for (const p of withLane) {
      const d = Math.abs(p.lane.feet - targetFeet);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (bestD <= maxGap) {
      return { board: best.lane.board, extrapolated: false };
    }
    return null;
  }

  if (!allowExtrapolate) return null;

  // 短距外推：用靠近該端的兩點斜率
  const sorted = [...withLane].sort((a, b) => a.lane.feet - b.lane.feet);
  if (targetFeet > cov.maxFeet) {
    const gap = targetFeet - cov.maxFeet;
    if (gap > maxGap * 4) return null; // 太遠不外推
    const n = sorted.length;
    const a = sorted[Math.max(0, n - 3)].lane;
    const b = sorted[n - 1].lane;
    const df = b.feet - a.feet;
    if (Math.abs(df) < 0.8) {
      return { board: b.board, extrapolated: true };
    }
    const slope = (b.board - a.board) / df;
    const board = b.board + slope * gap;
    if (board < -5 || board > LANE_W + 5) return null;
    return { board, extrapolated: true };
  }
  if (targetFeet < cov.minFeet) {
    const gap = cov.minFeet - targetFeet;
    if (gap > maxGap * 4) return null;
    const a = sorted[0].lane;
    const b = sorted[Math.min(sorted.length - 1, 2)].lane;
    const df = b.feet - a.feet;
    if (Math.abs(df) < 0.8) {
      return { board: a.board, extrapolated: true };
    }
    const slope = (b.board - a.board) / df;
    const board = a.board - slope * gap;
    if (board < -5 || board > LANE_W + 5) return null;
    return { board, extrapolated: true };
  }
  return null;
}

/** 相容舊 API：覆蓋內插值；超出不回最近點（避免假 BP／袋口） */
export function boardAtFeet(
  points: { lane?: LanePoint; predicted?: boolean }[],
  targetFeet: number
): number | null {
  const r = boardAtFeetDetailed(points, targetFeet, {
    allowExtrapolate: false,
    maxGap: 3,
  });
  return r ? r.board : null;
}

type TimedLane = { lane: LanePoint; t: number; predicted?: boolean };

function usableLanePoints(
  points: { lane?: LanePoint; t: number; predicted?: boolean }[]
): TimedLane[] {
  return points.filter(
    (p): p is TimedLane =>
      !!p.lane &&
      p.t >= 0 &&
      !p.predicted &&
      p.lane.board >= -1 &&
      p.lane.board <= LANE_W + 1 &&
      p.lane.feet >= -1 &&
      p.lane.feet <= LANE_L + 1
  );
}

/**
 * 粗估球速：沿軌跡找「feet 進度最陡」的子窗／滑窗中位。
 * 1 mph ≈ 1.4667 ft/s。過濾預測點、回跳與鎖定前後靜止段。
 */
export function estimateSpeedMph(
  points: { lane?: LanePoint; t: number; predicted?: boolean }[]
): number | null {
  const usable = usableLanePoints(points);
  if (usable.length < 3) return null;

  const windows: number[] = [];
  // 多種窗長：捕捉真實滾動段，避開鎖定前後慢漂
  const spans = [
    Math.max(2, Math.floor(usable.length / 8)),
    Math.max(3, Math.floor(usable.length / 5)),
    Math.max(4, Math.floor(usable.length / 3)),
  ];
  for (const span of spans) {
    for (let i = 0; i + span < usable.length; i++) {
      const j = i + span;
      const a = usable[i];
      const b = usable[j];
      const dt = (b.t - a.t) / 1000;
      if (dt < 0.05 || dt > 4) continue;
      let path = 0;
      for (let k = i + 1; k <= j; k++) {
        const df = usable[k].lane.feet - usable[k - 1].lane.feet;
        if (df > -0.4) path += Math.max(0, df);
      }
      if (path < 0.5) continue;
      const mph = path / dt / 1.4667;
      // 真球常見 10–22；允許 6–32，濾極端慢漂／噪聲跳點
      if (mph >= 5 && mph <= 32) windows.push(mph);
    }
  }

  if (windows.length >= 1) {
    windows.sort((a, b) => a - b);
    // 取較高分位，偏向真實滾動而非慢漂中位
    const idx = Math.min(
      windows.length - 1,
      Math.max(0, Math.floor(windows.length * 0.7))
    );
    return Math.round(windows[idx] * 10) / 10;
  }

  // 後備：只取 feet 單調上升最快的連續段
  let bestMph: number | null = null;
  let i = 0;
  while (i < usable.length - 2) {
    let j = i + 1;
    let path = 0;
    while (j < usable.length) {
      const df = usable[j].lane.feet - usable[j - 1].lane.feet;
      if (df < -0.3) break;
      path += Math.max(0, df);
      j++;
      if (path >= 3) {
        const dt = (usable[j - 1].t - usable[i].t) / 1000;
        if (dt >= 0.08) {
          const mph = path / dt / 1.4667;
          if (mph >= 5 && mph <= 32) {
            if (bestMph == null || mph > bestMph) bestMph = mph;
          }
        }
      }
    }
    i = Math.max(i + 1, j);
  }
  return bestMph != null ? Math.round(bestMph * 10) / 10 : null;
}

/** 後方視角預設四角：上窄（遠／pins）、下寬（近／foul） */
export function defaultCorners(
  width: number,
  height: number
): LaneCorners {
  // 頂端靠近 pins（略高），減少球未到瓶口已出框；頂寬略收
  const topM = width * 0.3;
  const botM = width * 0.1;
  const topY = height * 0.08;
  const botY = height * 0.9;
  return {
    tl: { x: topM, y: topY },
    tr: { x: width - topM, y: topY },
    br: { x: width - botM, y: botY },
    bl: { x: botM, y: botY },
  };
}

/**
 * 區段球速：只取 feet 落在 [feetLo, feetHi] 的點。
 * 覆蓋不足時回 null（不硬填）。
 */
export function estimateSegmentSpeedMph(
  points: { lane?: LanePoint; t: number; predicted?: boolean }[],
  feetLo: number,
  feetHi: number
): number | null {
  const cov = trajectoryCoverage(points);
  if (!cov) return null;
  // 區段與覆蓋要有足夠重疊
  const overlapLo = Math.max(feetLo, cov.minFeet);
  const overlapHi = Math.min(feetHi, cov.maxFeet);
  if (overlapHi - overlapLo < 1.5) return null;

  const usable = usableLanePoints(points).filter(
    (p) => p.lane.feet >= overlapLo && p.lane.feet <= overlapHi
  );
  if (usable.length < 2) return null;

  // 優先：區段內最陡子窗
  const segWindows: number[] = [];
  const span = Math.max(1, Math.floor(usable.length / 4));
  for (let i = 0; i + span < usable.length; i++) {
    const j = Math.min(usable.length - 1, i + span);
    const dt = (usable[j].t - usable[i].t) / 1000;
    if (dt < 0.04 || dt > 3) continue;
    let path = 0;
    for (let k = i + 1; k <= j; k++) {
      const df = usable[k].lane.feet - usable[k - 1].lane.feet;
      if (df > -0.4) path += Math.max(0, df);
    }
    if (path < 0.5) continue;
    const mph = path / dt / 1.4667;
    if (mph >= 5 && mph <= 32) segWindows.push(mph);
  }
  if (segWindows.length >= 1) {
    segWindows.sort((a, b) => a - b);
    const idx = Math.min(
      segWindows.length - 1,
      Math.floor(segWindows.length * 0.7)
    );
    return Math.round(segWindows[idx] * 10) / 10;
  }

  // 後備：同 estimateSpeedMph，取區段內最陡子窗而非整段平均（整段常被慢頭尾拉低）
  let bestMph: number | null = null;
  for (let i = 0; i < usable.length - 2; i++) {
    for (let j = i + 2; j < usable.length; j++) {
      const dt2 = (usable[j].t - usable[i].t) / 1000;
      if (dt2 < 0.06 || dt2 > 2.5) continue;
      let path2 = 0;
      for (let k = i + 1; k <= j; k++) {
        const df = usable[k].lane.feet - usable[k - 1].lane.feet;
        if (df > -0.4) path2 += Math.max(0, df);
      }
      if (path2 < 1.2) continue;
      const mph2 = path2 / dt2 / 1.4667;
      if (mph2 >= 5 && mph2 <= 32) {
        if (bestMph == null || mph2 > bestMph) bestMph = mph2;
      }
    }
  }
  return bestMph != null ? Math.round(bestMph * 10) / 10 : null;
}

/**
 * 找 hook 最大處（board 變化相對 feet 的轉折）。
 * 只在實際覆蓋內搜尋；覆蓋不足回 null（不再預設 42）。
 */
export function feetAtMaxHook(
  points: { lane?: LanePoint; predicted?: boolean }[]
): number | null {
  const cov = trajectoryCoverage(points);
  if (!cov || cov.span < 6) return null;

  const searchLo = Math.max(12, Math.ceil(cov.minFeet));
  const searchHi = Math.min(52, Math.floor(cov.maxFeet));
  if (searchHi - searchLo < 5) return null;

  const samples: { feet: number; board: number }[] = [];
  for (let f = searchLo; f <= searchHi; f += 2) {
    const b = boardAtFeet(points, f);
    if (b != null) samples.push({ feet: f, board: b });
  }
  if (samples.length < 4) return null;

  let bestFeet = samples[Math.floor(samples.length / 2)].feet;
  let bestCurv = -1;
  for (let i = 1; i < samples.length - 1; i++) {
    const d1 = samples[i].board - samples[i - 1].board;
    const d2 = samples[i + 1].board - samples[i].board;
    const curv = Math.abs(d2 - d1);
    if (curv > bestCurv) {
      bestCurv = curv;
      bestFeet = samples[i].feet;
    }
  }
  // 曲率過平：取覆蓋中段而非虛構 42′
  if (bestCurv < 0.05) {
    return Math.round(((cov.minFeet + cov.maxFeet) / 2) * 10) / 10;
  }
  return bestFeet;
}
