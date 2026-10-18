import {
  boardAtFeet,
  estimateSpeedMph,
} from "./perspective";
import type { ShotEstimate, TrackPoint } from "./types";

/** 箭頭區 ~15 ft、breakpoint ~42 ft、進袋 ~60 ft */
export function computeShotEstimate(points: TrackPoint[]): ShotEstimate {
  return {
    arrowsBoard: boardAtFeet(points, 15),
    breakpointBoard: boardAtFeet(points, 42),
    pocketBoard: boardAtFeet(points, 58),
    speedMph: estimateSpeedMph(points),
    pointCount: points.length,
  };
}

export function formatBoard(b: number | null): string {
  if (b == null || Number.isNaN(b)) return "—";
  return b.toFixed(1);
}
