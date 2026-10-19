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

  // 略放寬：漏存真投優先；左溝仍靠 board／feetPerSec 擋
  // 原生高解析度／中段起鎖時 feetSpan 可 ~5–6′ 但仍係真投（travel 大）
  const MIN_POINTS = 8;
  const MIN_TRAVEL = 42;
  const MIN_FEET = 5;
  const MIN_MS = 380;
  // 真球約 12–22 mph → 17–32 ft/s；誤鎖溝邊常 <2 ft/s
  const MIN_FEET_PER_SEC = 1.5;

  // 淨進度明顯倒退（鎖錯／預測回彈）→ 拒
  if (lanePts.length >= 6 && netFeet < feetSpan * 0.35 && feetSpan >= 3) {
    return {
      ok: false,
      reason: `倒退淨${netFeet.toFixed(1)}′`,
      travelPx,
      feetSpan,
      durationMs,
      feetPerSec,
      medianBoard,
    };
  }

  // densify predicted knots must NOT inflate past MIN_POINTS
  // (TesterManual r6: 6 raw @18–35′ → smoothDemoPath ~18 pts → false ok)
  // Sparse foul→pins (unseeded ~5 raw / 50′+) still allowed.
  const minPts = feetSpan >= 40 ? 5 : MIN_POINTS;
  if (lanePts.length < minPts) {
    return {
      ok: false,
      reason: `點${lanePts.length}`,
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
  // feet 短但影像位移＋時長夠：中段起鎖真投（唔好用 0.2′／4′ 假軌）
  const shortButReal =
    feetSpan >= 3.5 &&
    travelPx >= 120 &&
    durationMs >= 700 &&
    feetPerSec >= 1.2 &&
    (medianBoard == null || (medianBoard >= 4 && medianBoard <= 36));
  if (feetSpan < MIN_FEET && !shortButReal) {
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
  if (feetPerSec < MIN_FEET_PER_SEC && feetSpan < 18 && !shortButReal) {
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

/** 抽樣比較兩條影像軌跡相似度（1＝幾乎相同，0＝差很遠） */
export function pathImageSimilarity(
  a: TrackPoint[],
  b: TrackPoint[],
  samples = 8
): number {
  if (a.length < 2 || b.length < 2) return 0;
  const n = Math.max(3, samples);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const ta = a[Math.min(a.length - 1, Math.round((i / (n - 1)) * (a.length - 1)))];
    const tb = b[Math.min(b.length - 1, Math.round((i / (n - 1)) * (b.length - 1)))];
    sum += Math.hypot(ta.image.x - tb.image.x, ta.image.y - tb.image.y);
  }
  const avg = sum / n;
  // ~40px 平均偏差仍視為高度相似（同片重播）
  return Math.max(0, Math.min(1, 1 - avg / 55));
}

/** 與上一投過近（同軌／短時間重複）→ 去重 */
export function isDuplicateOfLastShot(
  points: TrackPoint[],
  lastPoints: TrackPoint[] | null | undefined,
  lastCreatedAt: number | null | undefined,
  nowMs: number
): boolean {
  if (!lastPoints || lastPoints.length < 4) return false;

  const sim = pathImageSimilarity(points, lastPoints);
  const ageMs =
    lastCreatedAt != null ? nowMs - lastCreatedAt : Number.POSITIVE_INFINITY;

  // Strict Mode／同圈雙 flush：高相似只喺短時窗去重。
  // 唔好永遠擋——demo loop ~8.5s 下一圈軌跡幾乎一樣，要准存。
  if (sim >= 0.82 && ageMs < 3800) return true;

  const qNew = evaluateShotQuality(points);
  const qOld = evaluateShotQuality(lastPoints);
  const boardClose =
    qNew.medianBoard != null &&
    qOld.medianBoard != null &&
    Math.abs(qNew.medianBoard - qOld.medianBoard) < 4;
  const spanClose = Math.abs(qNew.feetSpan - qOld.feetSpan) < 8;

  // 中時窗：捕捉同圈誤觸第二次存（冷卻 2.2s + 餘裕）；唔蓋過一圈
  if (ageMs < 5200) {
    if (sim >= 0.72 && boardClose && spanClose) return true;
    if (boardClose && spanClose && sim >= 0.62) return true;
  }

  // 軌跡起點影像距離極近且時長相近（僅短時）
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
  if (
    ageMs < 3800 &&
    d0 < 36 &&
    Math.abs(dtNew - dtOld) < 800 &&
    sim >= 0.5
  ) {
    return true;
  }
  return false;
}
