import {
  boardAtFeet,
  boardAtFeetDetailed,
  estimateSegmentSpeedMph,
  estimateSpeedMph,
  feetAtMaxHook,
  findActiveRollSpan,
  trajectoryCoverage,
} from "./perspective";
import type { EstimateExtrapolated, ShotEstimate, TrackPoint } from "./types";

/** RPM 顯示門檻：低於此信心顯示 —（不硬填） */
const RPM_CONF_SHOW = 0.55;

/** LaneTrax 風格粗估（瀏覽器軌跡推導，非雷達／官方量測） */
export function computeShotEstimate(
  points: TrackPoint[],
  rpm?: { rpm: number | null; confidence: number } | null
): ShotEstimate {
  const cov = trajectoryCoverage(points);
  const extrapolated: EstimateExtrapolated = {};

  const foulBoard = boardAtFeet(points, 1);
  const arrowsBoard = boardAtFeet(points, 15);
  const entryBoard = arrowsBoard;

  // Breakpoint：只在覆蓋內找曲率；不足則 —（不預設 42′）
  const bpFeet = feetAtMaxHook(points);
  let breakpointBoard: number | null = null;
  let breakpointDistance: number | null = null;
  if (bpFeet != null && cov) {
    const bp = boardAtFeetDetailed(points, bpFeet, {
      allowExtrapolate: false,
      maxGap: 3,
    });
    if (bp) {
      breakpointBoard = bp.board;
      breakpointDistance = Math.round(bpFeet * 10) / 10;
    }
  }

  // 袋口 58′：覆蓋足夠才插值；否則短距外推並標「外推」，太遠則 —
  let pocketBoard: number | null = null;
  if (cov) {
    const pocket = boardAtFeetDetailed(points, 58, {
      allowExtrapolate: cov.maxFeet >= 28,
      maxGap: 4,
    });
    if (pocket) {
      pocketBoard = pocket.board;
      if (pocket.extrapolated) extrapolated.pocket = true;
    }
  }

  const launchAngleDeg = pathAngleDeg(points, 2, 12, cov);
  let impactAngleDeg: number | null = null;
  if (cov && cov.maxFeet >= 35) {
    const lo = Math.max(40, cov.maxFeet - 12);
    const hi = Math.min(58, cov.maxFeet);
    if (hi - lo >= 4) {
      impactAngleDeg = pathAngleDeg(points, lo, hi, cov);
      if (hi < 50) extrapolated.impactAngle = true;
    }
  } else if (cov && cov.maxFeet >= 20) {
    // 覆蓋不足 35′：用覆蓋末段估角並標外推
    const lo = Math.max(cov.minFeet, cov.maxFeet - 8);
    impactAngleDeg = pathAngleDeg(points, lo, cov.maxFeet, cov);
    if (impactAngleDeg != null) extrapolated.impactAngle = true;
  }

  // 球速：優先固定 feet 窗；若軌跡從中段開始則改用覆蓋相對區段
  // 活躍滾動段（剪瓶口怠速）優先用於 launch／impact 邊界
  const activeEarly = findActiveRollSpan(points);
  let launchSpeedMph = estimateSegmentSpeedMph(
    points,
    cov ? cov.minFeet : 0,
    cov ? Math.min(20, cov.maxFeet) : 20
  );
  if (launchSpeedMph == null && cov && cov.span >= 6) {
    const hi = cov.minFeet + Math.min(12, cov.span * 0.4);
    launchSpeedMph = estimateSegmentSpeedMph(points, cov.minFeet, hi);
  }
  if (
    launchSpeedMph == null &&
    activeEarly &&
    activeEarly.maxFeet - activeEarly.minFeet >= 6
  ) {
    const hi =
      activeEarly.minFeet + (activeEarly.maxFeet - activeEarly.minFeet) * 0.4;
    launchSpeedMph = estimateSegmentSpeedMph(
      points,
      activeEarly.minFeet,
      hi
    );
  }
  let impactSpeedMph: number | null = null;
  if (cov) {
    // 優先：活躍段後 45%（避開瓶口怠速），其次固定 40′+
    if (activeEarly && activeEarly.maxFeet - activeEarly.minFeet >= 8) {
      const lo =
        activeEarly.minFeet +
        (activeEarly.maxFeet - activeEarly.minFeet) * 0.55;
      impactSpeedMph = estimateSegmentSpeedMph(
        points,
        lo,
        activeEarly.maxFeet
      );
      if (
        impactSpeedMph != null &&
        activeEarly.maxFeet < 50
      ) {
        extrapolated.impactSpeed = true;
      }
    }
    if (impactSpeedMph == null && cov.maxFeet >= 40) {
      impactSpeedMph = estimateSegmentSpeedMph(
        points,
        40,
        Math.min(58, cov.maxFeet)
      );
    }
    if (impactSpeedMph == null && cov.span >= 8 && cov.maxFeet >= 14) {
      const lo = cov.minFeet + cov.span * 0.55;
      impactSpeedMph = estimateSegmentSpeedMph(points, lo, cov.maxFeet);
      if (impactSpeedMph != null) extrapolated.impactSpeed = true;
    }
  }
  let avgSpeedMph = estimateSpeedMph(points);
  const active = activeEarly;
  // 後備：活躍滾動段 chord（唔用整段 lock→end，避免瓶口怠速拉低）
  if (avgSpeedMph == null && active && active.dtSec >= 0.25) {
    const mph = 0.65 * active.chordMph + 0.35 * active.pathMph;
    if (mph >= 5 && mph <= 28) avgSpeedMph = Math.round(mph * 10) / 10;
  }

  // Impact：若後段估速明顯低於活躍平均（瓶口怠速），用活躍段後 40% chord 校正
  if (
    avgSpeedMph != null &&
    active &&
    active.dtSec >= 0.3 &&
    cov &&
    cov.span >= 8 &&
    impactSpeedMph != null &&
    impactSpeedMph < avgSpeedMph * 0.72
  ) {
    // 活躍段後段 feet 帶（避開瓶口怠速）
    const lo = active.minFeet + (active.maxFeet - active.minFeet) * 0.55;
    const hi = active.maxFeet;
    const late = estimateSegmentSpeedMph(points, lo, hi);
    if (late != null && late > impactSpeedMph) {
      impactSpeedMph = late;
      if (hi < 50) extrapolated.impactSpeed = true;
    } else if (impactSpeedMph < avgSpeedMph * 0.65) {
      // 仍然過低：用 avg 合理衰減（屋油常見），標區段——唔發明無依據高速
      impactSpeedMph = Math.round(avgSpeedMph * 0.88 * 10) / 10;
      extrapolated.impactSpeed = true;
    }
  }

  // 區段估速失敗時，用平均速填充（覆蓋足夠先）
  if (launchSpeedMph == null && avgSpeedMph != null && cov && cov.span >= 6) {
    launchSpeedMph = avgSpeedMph;
  }
  if (impactSpeedMph == null && avgSpeedMph != null && cov && cov.span >= 8) {
    impactSpeedMph = avgSpeedMph;
    if (cov.maxFeet < 40) extrapolated.impactSpeed = true;
  }

  let hookBoards: number | null = null;
  if (foulBoard != null && breakpointBoard != null) {
    hookBoards = Math.round((foulBoard - breakpointBoard) * 10) / 10;
  } else if (arrowsBoard != null && breakpointBoard != null) {
    hookBoards = Math.round((arrowsBoard - breakpointBoard) * 10) / 10;
  }

  let hookFactor: number | null = null;
  if (
    hookBoards != null &&
    bpFeet != null &&
    bpFeet > 15 &&
    breakpointBoard != null
  ) {
    hookFactor = Math.round((Math.abs(hookBoards) / (bpFeet - 15)) * 100) / 100;
  }

  // Shot time：鎖定至結束（含短預測尾巴），不以「僅非預測」縮短
  let shotTimeSec: number | null = null;
  if (points.length >= 2) {
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const dt = (t1 - t0) / 1000;
    if (dt >= 0.25 && dt <= 12) shotTimeSec = Math.round(dt * 100) / 100;
  }

  let rpmVal: number | null = null;
  let rpmConfidence: number | null = null;
  if (rpm && rpm.rpm != null && rpm.confidence >= RPM_CONF_SHOW) {
    rpmVal = rpm.rpm;
    rpmConfidence = Math.round(rpm.confidence * 100) / 100;
  }

  return {
    foulBoard,
    arrowsBoard,
    entryBoard,
    breakpointBoard,
    breakpointDistance,
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
    coverageFeetMin: cov ? Math.round(cov.minFeet * 10) / 10 : null,
    coverageFeetMax: cov ? Math.round(cov.maxFeet * 10) / 10 : null,
    extrapolated,
  };
}

/**
 * 路徑相對「往 pins 直進」（board 不變）的角度（度）。
 * 正值＝往右偏（board 增加）。
 */
function pathAngleDeg(
  points: TrackPoint[],
  feetA: number,
  feetB: number,
  cov: { minFeet: number; maxFeet: number } | null
): number | null {
  if (cov) {
    // 兩端都要落在覆蓋附近
    if (feetA < cov.minFeet - 4 || feetB > cov.maxFeet + 4) return null;
  }
  const a = sampleNearFeet(points, feetA, 5);
  const b = sampleNearFeet(points, feetB, 5);
  if (!a || !b) return null;
  const dBoard = b.board - a.board;
  const dFeet = b.feet - a.feet;
  if (Math.abs(dFeet) < 1) return null;
  const boardInches = dBoard * (41.5 / 39);
  const feetInches = dFeet * 12;
  const deg = (Math.atan2(boardInches, feetInches) * 180) / Math.PI;
  if (Math.abs(deg) > 45) return null;
  return Math.round(deg * 10) / 10;
}

function sampleNearFeet(
  points: TrackPoint[],
  target: number,
  maxGap: number
): { board: number; feet: number } | null {
  const withLane = points
    .filter((p) => p.lane && !p.predicted)
    .map((p) => p.lane!);
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
  if (bestD > maxGap) return null;
  return best;
}

export function formatBoard(
  b: number | null,
  extrapolated?: boolean
): string {
  if (b == null || Number.isNaN(b)) return "—";
  const s = b.toFixed(1);
  return extrapolated ? `${s}（外推）` : s;
}

export function formatDeg(d: number | null, extrapolated?: boolean): string {
  if (d == null || Number.isNaN(d)) return "—";
  const sign = d > 0 ? "+" : "";
  const s = `${sign}${d.toFixed(1)}°`;
  return extrapolated ? `${s}（外推）` : s;
}

export function formatMph(v: number | null, extrapolated?: boolean): string {
  if (v == null || Number.isNaN(v)) return "—";
  const s = `${v.toFixed(1)} mph`;
  return extrapolated ? `${s}（區段）` : s;
}

export function formatRpm(rpm: number | null, conf: number | null): string {
  if (rpm == null || conf == null || conf < RPM_CONF_SHOW) return "—";
  const tag = conf < 0.55 ? "（低信心）" : conf < 0.75 ? "（中）" : "";
  return `${rpm}${tag}`;
}
