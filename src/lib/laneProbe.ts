/**
 * 四角短探針評分（Workbench／verify 共用邏輯）。
 * 輸入已解好嘅連續幀（唔好用過疏 seek，否則 tracker 唔 lock）。
 */
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  rgbaToGray,
  trackBallFrame,
  trackWorkSize,
  scaleLaneCorners,
} from "./tracker";
import { buildHomography, imageToLane } from "./perspective";
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
  const Hm = buildHomography(corners);
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
  const workCorners = scaleLaneCorners(corners, scale);
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
    let useC = corners;
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
      const lane = imageToLane(Hm, pos);
      if (lane.board >= 1.5 && lane.board <= 37.5) {
        boards.push(lane.board);
        if (lane.feet > maxFeet) maxFeet = lane.feet;
        if (lane.feet < minFeet) minFeet = lane.feet;
        if (lane.feet <= 18) earlyBoards.push(lane.board);
        if (lane.feet >= 28) lateBoards.push(lane.board);
        pts.push({
          image: pos,
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
  const medOk =
    med != null && med >= 8 && med <= 30
      ? 35
      : med != null && med >= 5 && med <= 34
        ? 12
        : -45;
  const coverOk = Math.min(45, Math.max(0, maxFeet - minFeet));
  const earlyOk = minFeet <= 18 ? 25 : minFeet <= 24 ? 8 : -18;
  const widePen = botFrac > 0.5 ? -25 : 0;
  const midStickPen =
    med != null && Math.abs(med - 19.5) < 2.2 && maxFeet - minFeet < 8
      ? -20
      : 0;
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
    else if (arrows >= 8 && arrows <= 18) arrowsOk = 55;
    else if (arrows >= 6 && arrows <= 24) arrowsOk = 30;
    else if (arrows > 24 && arrows < 32) arrowsOk = -25;
    else arrowsOk = -10;
  } else {
    arrowsOk = -20;
  }

  const score =
    geomRank +
    medOk +
    coverOk +
    earlyOk +
    widePen +
    midStickPen +
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
  topN = 4
): { det: LaneDetectResult; detail: ProbeScoreDetail } | null {
  if (!cands.length) return null;
  const sorted = [...cands].sort((a, b) => b.geomRank - a.geomRank);
  const slice = sorted.slice(0, Math.min(topN, sorted.length));
  let best: { det: LaneDetectResult; detail: ProbeScoreDetail } | null = null;
  for (const c of slice) {
    const detail = scoreCornersByProbe(c.det.corners, frames, {
      geomRank: c.geomRank,
    });
    if (!best || detail.score > best.detail.score) {
      best = { det: c.det, detail };
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
