import type { TrackPoint } from "./types";

export type ShotQualityResult = {
  ok: boolean;
  reason: string;
  travelPx: number;
  feetSpan: number;
  durationMs: number;
  /** feet／秒（沿軌跡淨進度） */
  feetPerSec: number;
  medianBoard: number | null;
};

/**
 * 存檔合格門檻：過濾短假軌／左溝誤鎖，但唔好把真投全濾掉。
 * - 最少點數、像素位移、feet 跨度、時長
 * - 要求合理 feet 進度（誤鎖靜物／溝邊通常 feet/s 極低）
 * - 長期貼 board≈0–3 且覆蓋短 → 視為左溝誤鎖
 */
export function evaluateShotQuality(points: TrackPoint[]): ShotQualityResult {
  let travelPx = 0;
  for (let i = 1; i < points.length; i++) {
    travelPx += Math.hypot(
      points[i].image.x - points[i - 1].image.x,
      points[i].image.y - points[i - 1].image.y
    );
  }

  const lanePts = points.filter((p) => p.lane && !p.predicted);
  const feet = lanePts.map((p) => p.lane!.feet);
  const boards = lanePts.map((p) => p.lane!.board);
  const feetSpan =
    feet.length >= 2 ? Math.max(...feet) - Math.min(...feet) : 0;
  const durationMs =
    points.length >= 2
      ? points[points.length - 1].t - points[0].t
      : 0;
  const durationSec = durationMs / 1000;

  // 淨 feet 進度（允許小回跳）
  let netFeet = 0;
  for (let i = 1; i < lanePts.length; i++) {
    const df = lanePts[i].lane!.feet - lanePts[i - 1].lane!.feet;
    if (df > -0.5) netFeet += Math.max(0, df);
  }
  const feetPerSec = durationSec > 0.05 ? netFeet / durationSec : 0;

  let medianBoard: number | null = null;
  if (boards.length > 0) {
    const s = [...boards].sort((a, b) => a - b);
    medianBoard = s[Math.floor(s.length / 2)];
  }

  const MIN_POINTS = 10;
  const MIN_TRAVEL = 55;
  const MIN_FEET = 9;
  const MIN_MS = 500;
  // 真球約 12–22 mph → 17–32 ft/s；誤鎖溝邊常 <2 ft/s
  const MIN_FEET_PER_SEC = 2.2;

  if (points.length < MIN_POINTS) {
    return {
      ok: false,
      reason: `點${points.length}`,
      travelPx,
      feetSpan,
      durationMs,
      feetPerSec,
      medianBoard,
    };
  }
  if (travelPx < MIN_TRAVEL) {
    return {
      ok: false,
      reason: `位移${travelPx.toFixed(0)}px`,
      travelPx,
      feetSpan,
      durationMs,
      feetPerSec,
      medianBoard,
    };
  }
  if (feetSpan < MIN_FEET) {
    return {
      ok: false,
      reason: `${feetSpan.toFixed(1)}′`,
      travelPx,
      feetSpan,
      durationMs,
      feetPerSec,
      medianBoard,
    };
  }
  if (durationMs < MIN_MS) {
    return {
      ok: false,
      reason: `${(durationMs / 1000).toFixed(2)}s`,
      travelPx,
      feetSpan,
      durationMs,
      feetPerSec,
      medianBoard,
    };
  }
  if (feetPerSec < MIN_FEET_PER_SEC && feetSpan < 22) {
    return {
      ok: false,
      reason: `進度${feetPerSec.toFixed(1)}′/s`,
      travelPx,
      feetSpan,
      durationMs,
      feetPerSec,
      medianBoard,
    };
  }
  // 系統性左溝誤鎖：中位 board 貼 0–3 且覆蓋未過 arrows
  if (
    medianBoard != null &&
    medianBoard < 3.2 &&
    feetSpan < 18 &&
    Math.max(...feet) < 20
  ) {
    return {
      ok: false,
      reason: `疑左溝 board≈${medianBoard.toFixed(1)}`,
      travelPx,
      feetSpan,
      durationMs,
      feetPerSec,
      medianBoard,
    };
  }

  return {
    ok: true,
    reason: "ok",
    travelPx,
    feetSpan,
    durationMs,
    feetPerSec,
    medianBoard,
  };
}

/** 與上一投過近（同軌／短時間重複）→ 去重 */
export function isDuplicateOfLastShot(
  points: TrackPoint[],
  lastPoints: TrackPoint[] | null | undefined,
  lastCreatedAt: number | null | undefined,
  nowMs: number
): boolean {
  if (!lastPoints || lastPoints.length < 4) return false;
  // 牆鐘過近（上傳 loop 誤雙存）
  if (lastCreatedAt != null && nowMs - lastCreatedAt < 2500) {
    const qNew = evaluateShotQuality(points);
    const qOld = evaluateShotQuality(lastPoints);
    if (
      qNew.medianBoard != null &&
      qOld.medianBoard != null &&
      Math.abs(qNew.medianBoard - qOld.medianBoard) < 4 &&
      Math.abs(qNew.feetSpan - qOld.feetSpan) < 8
    ) {
      return true;
    }
  }
  // 軌跡起點影像距離極近且時長相近
  const a0 = points[0]?.image;
  const b0 = lastPoints[0]?.image;
  if (!a0 || !b0) return false;
  const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y);
  const dtNew =
    points.length >= 2 ? points[points.length - 1].t - points[0].t : 0;
  const dtOld =
    lastPoints.length >= 2
      ? lastPoints[lastPoints.length - 1].t - lastPoints[0].t
      : 0;
  if (d0 < 28 && Math.abs(dtNew - dtOld) < 600) return true;
  return false;
}
