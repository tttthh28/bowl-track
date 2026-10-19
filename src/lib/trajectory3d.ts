/**
 * Plane-constrained trajectory rebuild (Alinejad / IACV bowling port).
 *
 * Source method (ariaalinejad report §2.5): collect 2D ball centers, apply a
 * projective homography so the path is seen from above with correct ratios.
 * Bowl-track already has a 4-corner → board/feet H (manual corners); here we
 * treat the lane as the Z=0 plane and rebuild a coherent world path from
 * image track points + that H (contact point preferred over center).
 *
 * Does NOT replace auto-corner / Hough detectors — call only from manual-
 * corner / estimate paths.
 */
import {
  applyHomography,
  imageToLane,
  LANE_L,
  LANE_W,
  type Homography,
} from "./perspective";
import type { LanePoint, Point2D, TrackPoint } from "./types";

/** Bowling ball diameter ≈ 8.5″ → radius ≈ 0.354 ft */
export const BALL_RADIUS_FT = 8.5 / 12 / 2;
/** Official lane: 39 boards ≈ 41.5″ */
export const BOARD_WIDTH_FT = 41.5 / 12 / LANE_W;

export type WorldPoint3D = {
  /** Cross-lane feet from left gutter (board 0) */
  xFt: number;
  /** Down-lane feet from foul line */
  yFt: number;
  /** Lane plane */
  zFt: 0;
  board: number;
  feet: number;
};

export type PlanePathMetrics = {
  /** Non-predicted coverage */
  minFeet: number;
  maxFeet: number;
  spanFeet: number;
  /** Polyline length in lane plane (feet) */
  pathLengthFt: number;
  /** Chord foul→last */
  chordFt: number;
  pointCount: number;
  /** Fraction of steps with feet advancing */
  forwardFrac: number;
  /** Max |Δboard| per foot (jagged lateral) */
  maxLateralPerFt: number;
  /** True if span ≥ 45′ and forwardFrac ≥ 0.7 — “sensible” top-down path */
  coherent: boolean;
};

export type PlanePathResult = {
  points: TrackPoint[];
  world: WorldPoint3D[];
  metrics: PlanePathMetrics;
};

/** Lane board/feet → world feet on Z=0 plane (Alinejad top-down proportions). */
export function laneToWorld(p: LanePoint): WorldPoint3D {
  return {
    xFt: p.board * BOARD_WIDTH_FT,
    yFt: p.feet,
    zFt: 0,
    board: p.board,
    feet: p.feet,
  };
}

/**
 * Image pixel → lane via H. Prefer contact = center + (0, radius) when radius
 * known (Corra / TrueLine style), else use the image point as-is.
 */
export function imageToPlaneLane(
  H: Homography,
  image: Point2D,
  radiusPx?: number | null
): LanePoint {
  const contact =
    radiusPx != null && radiusPx > 0
      ? { x: image.x, y: image.y + radiusPx }
      : image;
  return imageToLane(H, contact);
}

/**
 * Rebuild plane path from 2D track points + existing manual-corner H.
 * Lightweight: re-project image→lane, drop absurd outliers, keep time order.
 */
export function rebuildPlaneConstrainedPath(
  input: TrackPoint[],
  H: Homography,
  opts?: {
    /** Re-project from image (default true). If false, keep existing lane. */
    reproject?: boolean;
    /** Drop points with |board| jump > this vs previous kept point */
    maxBoardJump?: number;
    /** Allow feet back-step up to this (zoom / noise) */
    maxFeetBack?: number;
  }
): PlanePathResult {
  const reproject = opts?.reproject !== false;
  const maxBoardJump = opts?.maxBoardJump ?? 8;
  const maxFeetBack = opts?.maxFeetBack ?? 2.5;

  const rebuilt: TrackPoint[] = [];
  for (const p of input) {
    let lane = p.lane;
    if (reproject && p.image) {
      lane = imageToLane(H, p.image);
    }
    if (!lane) continue;
    if (
      lane.board < -3 ||
      lane.board > LANE_W + 3 ||
      lane.feet < -4 ||
      lane.feet > LANE_L + 4
    ) {
      continue;
    }
    if (rebuilt.length > 0) {
      const prev = rebuilt[rebuilt.length - 1].lane!;
      if (Math.abs(lane.board - prev.board) > maxBoardJump && !p.predicted) {
        // keep if feet advanced a lot (real hook), else skip spike
        if (lane.feet - prev.feet < 1.5) continue;
      }
      if (lane.feet < prev.feet - maxFeetBack && !p.predicted) continue;
    }
    rebuilt.push({
      image: p.image,
      lane: { board: lane.board, feet: lane.feet },
      t: p.t,
      predicted: p.predicted,
    });
  }

  const world = rebuilt
    .filter((p) => p.lane)
    .map((p) => laneToWorld(p.lane!));
  const metrics = computePlanePathMetrics(rebuilt);
  return { points: rebuilt, world, metrics };
}

/** Homography warp of a single image point into “top-down” board/feet. */
export function projectImageThroughH(H: Homography, p: Point2D): Point2D {
  return applyHomography(H, p);
}

export function computePlanePathMetrics(
  points: { lane?: LanePoint; predicted?: boolean }[]
): PlanePathMetrics {
  const real = points.filter((p) => p.lane && !p.predicted).map((p) => p.lane!);
  const use = real.length >= 2 ? real : points.filter((p) => p.lane).map((p) => p.lane!);
  if (use.length < 2) {
    return {
      minFeet: 0,
      maxFeet: 0,
      spanFeet: 0,
      pathLengthFt: 0,
      chordFt: 0,
      pointCount: use.length,
      forwardFrac: 0,
      maxLateralPerFt: 0,
      coherent: false,
    };
  }
  let minFeet = use[0].feet;
  let maxFeet = use[0].feet;
  let path = 0;
  let forward = 0;
  let steps = 0;
  let maxLat = 0;
  for (let i = 1; i < use.length; i++) {
    const a = use[i - 1];
    const b = use[i];
    minFeet = Math.min(minFeet, b.feet);
    maxFeet = Math.max(maxFeet, b.feet);
    const df = b.feet - a.feet;
    const db = (b.board - a.board) * BOARD_WIDTH_FT;
    path += Math.hypot(Math.max(0, df), db);
    steps++;
    if (df >= -0.15) forward++;
    if (df > 0.2) maxLat = Math.max(maxLat, Math.abs(b.board - a.board) / df);
  }
  const spanFeet = maxFeet - minFeet;
  const chordFt = Math.hypot(
    spanFeet,
    (use[use.length - 1].board - use[0].board) * BOARD_WIDTH_FT
  );
  const forwardFrac = steps ? forward / steps : 0;
  const coherent =
    spanFeet >= 45 &&
    forwardFrac >= 0.7 &&
    use.length >= 8 &&
    maxLat < 2.5;
  return {
    minFeet: Math.round(minFeet * 10) / 10,
    maxFeet: Math.round(maxFeet * 10) / 10,
    spanFeet: Math.round(spanFeet * 10) / 10,
    pathLengthFt: Math.round(path * 10) / 10,
    chordFt: Math.round(chordFt * 10) / 10,
    pointCount: use.length,
    forwardFrac: Math.round(forwardFrac * 100) / 100,
    maxLateralPerFt: Math.round(maxLat * 100) / 100,
    coherent,
  };
}
