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
  return {
    board: Math.max(0, Math.min(LANE_W, q.x)),
    feet: Math.max(0, Math.min(LANE_L, q.y)),
  };
}

/** 在軌跡上找最接近目標 feet 的 board（線性插值） */
export function boardAtFeet(
  points: { lane?: LanePoint }[],
  targetFeet: number
): number | null {
  const withLane = points.filter((p) => p.lane) as {
    lane: LanePoint;
  }[];
  if (withLane.length < 2) return null;

  for (let i = 0; i < withLane.length - 1; i++) {
    const a = withLane[i].lane;
    const b = withLane[i + 1].lane;
    const lo = Math.min(a.feet, b.feet);
    const hi = Math.max(a.feet, b.feet);
    if (targetFeet >= lo && targetFeet <= hi) {
      const t =
        Math.abs(b.feet - a.feet) < 1e-6
          ? 0
          : (targetFeet - a.feet) / (b.feet - a.feet);
      return a.board + t * (b.board - a.board);
    }
  }

  let best = withLane[0];
  let bestD = Math.abs(best.lane.feet - targetFeet);
  for (const p of withLane) {
    const d = Math.abs(p.lane.feet - targetFeet);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best.lane.board;
}

/**
 * 粗估球速：球道 feet 差／時間。
 * 1 mph ≈ 1.4667 ft/s。
 */
export function estimateSpeedMph(
  points: { lane?: LanePoint; t: number }[]
): number | null {
  const usable = points.filter((p) => p.lane && p.t >= 0);
  if (usable.length < 4) return null;
  const first = usable[0];
  const last = usable[usable.length - 1];
  const dt = (last.t - first.t) / 1000;
  if (dt < 0.15) return null;
  const df = Math.abs(last.lane!.feet - first.lane!.feet);
  if (df < 5) return null;
  const ftPerSec = df / dt;
  const mph = ftPerSec / 1.4667;
  if (mph < 3 || mph > 40) return null;
  return Math.round(mph * 10) / 10;
}

/** 後方視角預設四角：上窄（遠／pins）、下寬（近／foul） */
export function defaultCorners(
  width: number,
  height: number
): LaneCorners {
  const topM = width * 0.28;
  const botM = width * 0.08;
  const topY = height * 0.14;
  const botY = height * 0.88;
  return {
    tl: { x: topM, y: topY },
    tr: { x: width - topM, y: topY },
    br: { x: width - botM, y: botY },
    bl: { x: botM, y: botY },
  };
}
