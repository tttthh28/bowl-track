/**
 * 四角短探針評分（Workbench／verify 共用邏輯）。
 * 輸入已解好嘅連續幀（唔好用過疏 seek，否則 tracker 唔 lock）。
 */
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  ballContactPoint,
  rgbaToGray,
  trackBallFrame,
  trackWorkSize,
  scaleLaneCorners,
} from "./tracker";
import { buildHomography, imageToLane, mappingCornersForTrack } from "./perspective";
import { computeShotEstimate } from "./estimates";
import type { LaneDetectResult } from "./laneDetect";
import type { LaneCorners } from "./types";

export type ProbeFrame = {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
};

export type ProbeScoreDetail = {
  score: number;
  med: number | null;
  minFeet: number;
  maxFeet: number;
  locks: number;
  arrows: number | null;
  gutterRace: boolean;
};

export function scoreCornersByProbe(
  corners: LaneCorners,
  frames: ProbeFrame[],
  opts?: { geomRank?: number; fps?: number }
): ProbeScoreDetail {
  const geomRank = opts?.geomRank ?? 0;
  const fps = opts?.fps ?? 15;
  if (frames.length < 8) {
    return {
      score: geomRank - 80,
      med: null,
      minFeet: 99,
      maxFeet: 0,
      locks: 0,
      arrows: null,
      gutterRace: false,
    };
  }
  const vw = frames[0].width;
  const vh = frames[0].height;
  // 顯示四角可全溝 skew；追蹤／H 用去 skew 映射梯形（保 arr∈[13,15]）
  const mapCorners = mappingCornersForTrack(corners);
  const Hm = buildHomography(mapCorners);
  if (!Hm) {
    return {
      score: geomRank - 100,
      med: null,
      minFeet: 99,
      maxFeet: 0,
      locks: 0,
      arrows: null,
      gutterRace: false,
    };
  }
  const { scale, tw, th } = trackWorkSize(vw, vh);
  const workCorners = scaleLaneCorners(mapCorners, scale);
  const st = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const boards: number[] = [];
  const earlyBoards: number[] = [];
  const lateBoards: number[] = [];
  const pts: {
    image: { x: number; y: number };
    lane?: { board: number; feet: number };
    t: number;
  }[] = [];
  let maxFeet = 0;
  let minFeet = 99;
  let locks = 0;

  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i];
    let trackRgba = fr.rgba;
    let trackW = fr.width;
    let trackH = fr.height;
    let useC = mapCorners;
    if (scale < 1) {
      trackRgba = downscaleNearest(fr.rgba, fr.width, fr.height, tw, th);
      trackW = tw;
      trackH = th;
      useC = workCorners;
    }
    const gray = rgbaToGray(trackRgba, trackW, trackH);
    const res = trackBallFrame(
      st,
      gray,
      trackW,
      trackH,
      settings,
      useC,
      1000 / fps,
      trackRgba
    );
    if (res.locked && res.smoothed) {
      locks++;
      const pos =
        scale < 1
          ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale }
          : res.smoothed;
      const rFull =
        res.radius != null && res.radius > 0
          ? scale < 1
            ? res.radius / scale
            : res.radius
          : null;
      const lane = imageToLane(Hm, ballContactPoint(pos, rFull));
      if (lane.board >= 1.5 && lane.board <= 37.5) {
        boards.push(lane.board);
        if (lane.feet > maxFeet) maxFeet = lane.feet;
        if (lane.feet < minFeet) minFeet = lane.feet;
        if (lane.feet <= 18) earlyBoards.push(lane.board);
        if (lane.feet >= 28) lateBoards.push(lane.board);
        pts.push({
          image: ballContactPoint(pos, rFull),
          lane,
          t: i * (1000 / fps),
        });
      }
    }
  }

  const med =
    boards.length > 0
      ? [...boards].sort((a, b) => a - b)[Math.floor(boards.length / 2)]
      : null;
  const botFrac = (corners.br.x - corners.bl.x) / Math.max(1, vw);
  const coverSpan = Math.max(0, maxFeet - minFeet);
  const medOk =
    med != null && med >= 8 && med <= 28
      ? 40
      : med != null && med >= 7 && med <= 30
        ? 18
        : med != null && med >= 5 && med <= 34
          ? -8 // 貼溝中位（如 6.7）唔好當合格
          : -50;
  // 覆蓋太短＝透視錯／鎖死 foul（常見 arr=— 但 UI 仍出假 arrows）
  const coverOk =
    coverSpan >= 20
      ? Math.min(50, coverSpan)
      : coverSpan >= 10
        ? coverSpan * 0.6
        : coverSpan >= 4
          ? -25
          : -55;
  const earlyOk =
    minFeet <= 18 ? 28 : minFeet <= 22 ? 10 : minFeet <= 28 ? -30 : -50;
  // 真溝 foul≈0.50–0.58 加分；過窄（亮帶內縮）罰
  const widePen =
    botFrac > 0.62
      ? -30
      : botFrac >= 0.50 && botFrac <= 0.58
        ? 22
        : botFrac >= 0.46 && botFrac < 0.50
          ? 10
          : botFrac >= 0.40 && botFrac < 0.46
            ? -8
            : botFrac < 0.36
              ? -16
              : 0;
  const midStickPen =
    med != null && Math.abs(med - 19.5) < 2.2 && coverSpan < 8
      ? -20
      : 0;
  const midBot = (corners.bl.x + corners.br.x) / 2;
  const midRightPen = midBot / Math.max(1, vw) > 0.54 ? -18 : midBot / Math.max(1, vw) > 0.52 ? -8 : 0;
  // 真溝 midF≈0.47–0.50
  const midFrac = midBot / Math.max(1, vw);
  const midLaneBonus =
    midFrac >= 0.46 && midFrac <= 0.50 ? 18 : midFrac >= 0.44 && midFrac < 0.52 ? 8 : 0;
  let gutterRace = false;
  let gutterRacePen = 0;
  if (earlyBoards.length >= 3) {
    const eMax = Math.max(...earlyBoards);
    const eMin = Math.min(...earlyBoards);
    if (eMax >= 32 || eMin <= 4 || eMax - eMin > 14) {
      gutterRace = true;
      gutterRacePen = -40;
    }
  }
  let deepOk = 0;
  if (lateBoards.length >= 2) {
    const lMed = [...lateBoards].sort((a, b) => a - b)[
      Math.floor(lateBoards.length / 2)
    ];
    if (lMed >= 8 && lMed <= 24) deepOk = 30;
    else if (lMed >= 5 && lMed <= 30) deepOk = 10;
  }

  let arrows: number | null = null;
  let arrowsOk = 0;
  if (pts.length >= 10) {
    const est = computeShotEstimate(
      pts.map((p) => ({
        image: p.image,
        lane: p.lane,
        t: p.t,
      }))
    );
    arrows = est.arrowsBoard;
    if (arrows == null) arrowsOk = -25;
    else if (Math.abs(arrows - 33.6) < 0.5 || arrows >= 32 || arrows <= 4)
      arrowsOk = -55;
    else if (Math.abs(arrows - 21.3) < 0.45) arrowsOk = -45;
    else if (arrows >= 26 && arrows <= 31.5) arrowsOk = -55; // ~28.5 接觸點假值
    else if (arrows >= 13 && arrows <= 15) arrowsOk = 70; // Tony 收斂帶
    else if (arrows >= 8 && arrows <= 18) arrowsOk = 55;
    else if (arrows >= 6 && arrows <= 22) arrowsOk = 30;
    else if (arrows > 22 && arrows < 26) arrowsOk = -15;
    else if (arrows > 24 && arrows < 32) arrowsOk = -45;
    else arrowsOk = -10;
  } else {
    arrowsOk = -20;
  }

  // arr=— 必須大罰：否則幾何高分壞角會贏（prod 探針 med=6.7 arr=— → UI~21）
  if (arrows == null && pts.length >= 10) arrowsOk = Math.min(arrowsOk, -60);
  if (arrows == null && coverSpan < 12) arrowsOk = Math.min(arrowsOk, -70);
  // 中位貼溝但 arrows 有值（晚鎖鄰道）→ 仍重罰
  if (med != null && (med >= 30 || med <= 6) && coverSpan > 8) {
    arrowsOk = Math.min(arrowsOk, -40);
  }
  // mid≈19.5 假常數
  if (arrows != null && Math.abs(arrows - 21.1) < 1.2) {
    arrowsOk = Math.min(arrowsOk, -50);
  }
  // ~28.5：壞角+接觸點常見；有 gutterRace 時一律重罰
  if (arrows != null && arrows >= 26 && arrows <= 31.5) {
    arrowsOk = Math.min(arrowsOk, gutterRace ? -70 : -55);
  }
  if (gutterRace && arrows != null && arrows > 22) {
    arrowsOk = Math.min(arrowsOk, -50);
  }

  const score =
    geomRank +
    medOk +
    coverOk +
    earlyOk +
    widePen +
    midStickPen +
    midRightPen +
    midLaneBonus +
    gutterRacePen +
    deepOk +
    arrowsOk +
    Math.min(18, locks * 0.12);

  return {
    score,
    med,
    minFeet: boards.length ? minFeet : 99,
    maxFeet,
    locks,
    arrows,
    gutterRace,
  };
}

/** 喺候選入面用連續幀探針揀最佳四角 */
export function pickBestCornersByProbe(
  cands: { det: LaneDetectResult; geomRank: number }[],
  frames: ProbeFrame[],
  topN = 6
): { det: LaneDetectResult; detail: ProbeScoreDetail } | null {
  if (!cands.length) return null;
  const sorted = [...cands].sort((a, b) => b.geomRank - a.geomRank);
  // 多掃幾個：避免 top 幾何全係鄰道／人影，好角排第 5+
  const slice = sorted.slice(0, Math.min(Math.max(topN, 6), sorted.length));
  let best: { det: LaneDetectResult; detail: ProbeScoreDetail } | null = null;
  let bestWithArrows: { det: LaneDetectResult; detail: ProbeScoreDetail } | null =
    null;
  for (const c of slice) {
    const detail = scoreCornersByProbe(c.det.corners, frames, {
      geomRank: c.geomRank,
    });
    if (!best || detail.score > best.detail.score) {
      best = { det: c.det, detail };
    }
    const a = detail.arrows;
    const botF =
      (c.det.corners.br.x - c.det.corners.bl.x) /
      Math.max(1, frames[0]?.width ?? 1);
    // 闊底貼溝時 med 可偏高（早段 board 散），有合格 arr 13–15 仍收
    const medOkPick =
      detail.med != null &&
      ((detail.med >= 7 && detail.med <= 28) ||
        (a != null &&
          a >= 12.5 &&
          a <= 15.5 &&
          botF >= 0.5 &&
          botF <= 0.56 &&
          detail.med >= 7 &&
          detail.med <= 37));
    // 主帶 12.5–15.5（Tony）；次帶 8–18；拒 ~21／~28.5
    if (
      a != null &&
      a >= 8 &&
      a <= 18 &&
      !(a >= 19 && a <= 22.5) &&
      medOkPick &&
      // 闊底貼溝時早段 board 易散（gutterRace）；有 Tony arr 仍收
      (!detail.gutterRace ||
        (a >= 12.5 && a <= 15.5 && botF >= 0.5 && botF <= 0.56)) &&
      detail.minFeet <= 18 &&
      detail.maxFeet - detail.minFeet >= 12
    ) {
      const midB =
        (c.det.corners.bl.x + c.det.corners.br.x) /
        2 /
        Math.max(1, frames[0]?.width ?? 1);
      let bandBonus = 0;
      if (a >= 12.5 && a <= 15.5) bandBonus += 45;
      else if (a >= 11 && a <= 16.5) bandBonus += 15;
      if (midB >= 0.415 && midB <= 0.445) bandBonus += 30;
      else if (midB >= 0.40 && midB <= 0.46) bandBonus += 10;
      if (botF >= 0.5 && botF <= 0.56) bandBonus += 25;
      const adj = { ...detail, score: detail.score + bandBonus };
      if (
        !bestWithArrows ||
        adj.score > bestWithArrows.detail.score
      ) {
        bestWithArrows = { det: c.det, detail: adj };
      }
    }
  }
  // 有 Tony 帶（12.5–15.5）候選 → 一律優先（唔好俾 arr=6.8／8.4 高分贏）
  if (bestWithArrows) {
    const ba = bestWithArrows.detail.arrows;
    const inTony = ba != null && ba >= 12.5 && ba <= 15.5;
    const bestA = best?.detail.arrows;
    const bestInTony = bestA != null && bestA >= 12.5 && bestA <= 15.5;
    if (inTony) return bestWithArrows;
    // 次選：有合格 8–18 arr 且 mid 在甜點，勝過無 arr／6.8 高分
    if (
      best == null ||
      best.detail.arrows == null ||
      bestInTony === false &&
        (bestA == null || bestA < 8 || bestA > 18) ||
      best.detail.score < bestWithArrows.detail.score + 40
    ) {
      return bestWithArrows;
    }
  }
  return best;
}

function downscaleNearest(
  rgba: Uint8ClampedArray,
  sw: number,
  sh: number,
  tw: number,
  th: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(sh - 1, Math.floor((y / th) * sh));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x / tw) * sw));
      const si = (sy * sw + sx) * 4;
      const di = (y * tw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}
