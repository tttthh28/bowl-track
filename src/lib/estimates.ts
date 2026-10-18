import {
  boardAtFeet,
  estimateSegmentSpeedMph,
  estimateSpeedMph,
  feetAtMaxHook,
} from "./perspective";
import type { ShotEstimate, TrackPoint } from "./types";

/** LaneTrax 風格粗估（瀏覽器軌跡推導，非雷達／官方量測） */
export function computeShotEstimate(
  points: TrackPoint[],
  rpm?: { rpm: number | null; confidence: number } | null
): ShotEstimate {
  const foulBoard = boardAtFeet(points, 1);
  const arrowsBoard = boardAtFeet(points, 15);
  const entryBoard = arrowsBoard;
  const bpFeet = feetAtMaxHook(points) ?? 42;
  const breakpointBoard = boardAtFeet(points, bpFeet);
  const pocketBoard = boardAtFeet(points, 58);

  const launchAngleDeg = pathAngleDeg(points, 2, 12);
  const impactAngleDeg = pathAngleDeg(points, 48, 58);

  const launchSpeedMph = estimateSegmentSpeedMph(points, 0, 20);
  const impactSpeedMph = estimateSegmentSpeedMph(points, 40, 58);
  const avgSpeedMph = estimateSpeedMph(points);

  let hookBoards: number | null = null;
  if (foulBoard != null && breakpointBoard != null) {
    hookBoards = Math.round((foulBoard - breakpointBoard) * 10) / 10;
  } else if (arrowsBoard != null && breakpointBoard != null) {
    hookBoards = Math.round((arrowsBoard - breakpointBoard) * 10) / 10;
  }

  let hookFactor: number | null = null;
  if (hookBoards != null && bpFeet > 15) {
    // 簡化：每英尺橫移 board 數 ×10，約 0–3 量級
    hookFactor = Math.round((Math.abs(hookBoards) / (bpFeet - 15)) * 100) / 100;
  }

  const usable = points.filter((p) => p.lane && !p.predicted);
  let shotTimeSec: number | null = null;
  if (usable.length >= 2) {
    const dt = (usable[usable.length - 1].t - usable[0].t) / 1000;
    if (dt >= 0.2 && dt <= 8) shotTimeSec = Math.round(dt * 100) / 100;
  }

  let rpmVal: number | null = null;
  let rpmConfidence: number | null = null;
  if (rpm && rpm.rpm != null && rpm.confidence >= 0.25) {
    rpmVal = rpm.rpm;
    rpmConfidence = Math.round(rpm.confidence * 100) / 100;
  }

  return {
    foulBoard,
    arrowsBoard,
    entryBoard,
    breakpointBoard,
    breakpointDistance:
      breakpointBoard != null ? Math.round(bpFeet * 10) / 10 : null,
    pocketBoard,
    launchAngleDeg,
    impactAngleDeg,
    launchSpeedMph,
    impactSpeedMph,
    avgSpeedMph,
    speedMph: avgSpeedMph,
    hookBoards,
    hookFactor,
    shotTimeSec,
    rpm: rpmVal,
    rpmConfidence,
    pointCount: points.length,
  };
}

/**
 * 路徑相對「往 pins 直進」（board 不變）的角度（度）。
 * 正值＝往右偏（board 增加）。
 */
function pathAngleDeg(
  points: TrackPoint[],
  feetA: number,
  feetB: number
): number | null {
  const a = sampleNearFeet(points, feetA);
  const b = sampleNearFeet(points, feetB);
  if (!a || !b) return null;
  const dBoard = b.board - a.board;
  const dFeet = b.feet - a.feet;
  if (Math.abs(dFeet) < 1) return null;
  // board 寬約 41" / 39 ≈ 1.05"/board；feet 以 12" 計
  // 用 board 與 feet 的近似正交比：39 boards ≈ 41.5" 寬、60' 長
  const boardInches = dBoard * (41.5 / 39);
  const feetInches = dFeet * 12;
  const deg = (Math.atan2(boardInches, feetInches) * 180) / Math.PI;
  if (Math.abs(deg) > 45) return null;
  return Math.round(deg * 10) / 10;
}

function sampleNearFeet(
  points: TrackPoint[],
  target: number
): { board: number; feet: number } | null {
  const withLane = points.filter((p) => p.lane).map((p) => p.lane!);
  if (withLane.length < 2) return null;
  let best = withLane[0];
  let bestD = Math.abs(best.feet - target);
  for (const p of withLane) {
    const d = Math.abs(p.feet - target);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  if (bestD > 8) return null;
  return best;
}

export function formatBoard(b: number | null): string {
  if (b == null || Number.isNaN(b)) return "—";
  return b.toFixed(1);
}

export function formatDeg(d: number | null): string {
  if (d == null || Number.isNaN(d)) return "—";
  const sign = d > 0 ? "+" : "";
  return `${sign}${d.toFixed(1)}°`;
}

export function formatMph(v: number | null): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v.toFixed(1)} mph`;
}

export function formatRpm(rpm: number | null, conf: number | null): string {
  if (rpm == null) return "—";
  const tag =
    conf == null || conf < 0.45 ? "（低信心）" : conf < 0.7 ? "（中）" : "";
  return `${rpm}${tag}`;
}
