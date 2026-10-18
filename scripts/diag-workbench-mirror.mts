/**
 * Headless mirror of Workbench upload detect → geom rank → short probe → track → estimate
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  rgbaToGray,
  trackBallFrame,
  trackWorkSize,
  scaleLaneCorners,
  shouldEndShot,
  getRpmEstimate,
} from "../src/lib/tracker.ts";
import {
  detectLaneCorners,
  scoreLaneGeometry,
  frameHasLaneSignal,
} from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const VIDEO = "test-media/bowling-demo.mp4";
const OUT = "/tmp/bowl-wb-mirror";
const W = 1060,
  H = 954,
  FPS = 15,
  N = 130;
mkdirSync(OUT, { recursive: true });
execSync(
  `ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,
  { stdio: "pipe" }
);
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;
const dur = N / FPS;

function frameAt(fi: number) {
  const u8 = new Uint8ClampedArray(frameBytes);
  u8.set(raw.subarray(fi * frameBytes, (fi + 1) * frameBytes));
  return u8;
}
function fiAtTime(t: number) {
  return Math.max(0, Math.min(N - 1, Math.round(t * FPS)));
}
function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(H - 1, Math.floor((y / th) * H));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(W - 1, Math.floor((x / tw) * W));
      const si = (sy * W + sx) * 4;
      const di = (y * tw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}

const tryTimes = Array.from(
  new Set(
    [
      0.08,
      Math.min(0.35, dur * 0.04),
      Math.min(0.8, dur * 0.1),
      Math.min(1.4, dur * 0.16),
      Math.min(dur * 0.28, dur - 0.12),
      Math.min(dur * 0.42, dur - 0.12),
      Math.min(dur * 0.58, dur - 0.12),
      Math.min(dur * 0.72, dur - 0.12),
      Math.min(dur * 0.85, dur - 0.08),
      Math.min(dur * 0.92, dur - 0.06),
      dur * 0.2,
    ].map((x) => Math.max(0, Math.min(x, Math.max(0, dur - 0.06))))
  )
);

type DetCand = {
  det: NonNullable<ReturnType<typeof detectLaneCorners>>;
  geom: number;
  t: number;
};
const detCands: DetCand[] = [];
for (const tSeek of tryTimes) {
  const fi = fiAtTime(tSeek);
  const rgba = frameAt(fi);
  if (!frameHasLaneSignal(rgba, W, H)) continue;
  const next = detectLaneCorners(rgba, W, H);
  if (!next) continue;
  const sc = scoreLaneGeometry(next, W, H);
  detCands.push({ det: next, geom: sc, t: tSeek });
}
console.log("detCands", detCands.length);

const ranked = detCands
  .map((c) => {
    const corners = c.det.corners;
    const botFrac = (corners.br.x - corners.bl.x) / W;
    const midBot = (corners.bl.x + corners.br.x) / 2;
    const midFrac = Math.abs(midBot / W - 0.5);
    const widthOk =
      botFrac >= 0.32 && botFrac <= 0.48
        ? 28
        : botFrac >= 0.28 && botFrac <= 0.52
          ? 8
          : -35;
    const midOk = midFrac < 0.1 ? 22 : midFrac < 0.16 ? 6 : -30;
    return { ...c, rank: c.geom + widthOk + midOk, botFrac, midBot };
  })
  .sort((a, b) => b.rank - a.rank);

console.log("geom top:");
for (const c of ranked.slice(0, 6)) {
  console.log(
    `  t=${c.t.toFixed(2)} geom=${c.geom.toFixed(1)} rank=${c.rank.toFixed(1)} bot=${c.botFrac.toFixed(3)} mid=${c.midBot.toFixed(0)}`
  );
}

const probeTimes: number[] = [];
for (let i = 0; i < 28; i++) {
  probeTimes.push(Math.min(dur - 0.08, 0.15 + i * (Math.min(dur, 7.5) / 28)));
}
const topN = ranked.slice(0, Math.min(4, ranked.length));
let best: (typeof ranked)[0] | null = ranked[0] ?? null;
let bestProbe = -1e9;

for (const c of topN) {
  const corners = c.det.corners;
  const Hm = buildHomography(corners);
  if (!Hm) continue;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workCorners = scaleLaneCorners(corners, scale);
  const st = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const boards: number[] = [];
  const earlyBoards: number[] = [];
  const lateBoards: number[] = [];
  let maxFeet = 0,
    minFeet = 99,
    locks = 0;
  for (const tP of probeTimes) {
    const rgba = frameAt(fiAtTime(tP));
    const work =
      scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(
      work,
      scale < 1 ? tw : W,
      scale < 1 ? th : H
    );
    const res = trackBallFrame(
      st,
      gray,
      scale < 1 ? tw : W,
      scale < 1 ? th : H,
      settings,
      scale < 1 ? workCorners : corners,
      1000 / 15,
      work
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
      }
    }
  }
  const med =
    boards.length > 0
      ? [...boards].sort((a, b) => a - b)[Math.floor(boards.length / 2)]
      : null;
  const botFrac = (corners.br.x - corners.bl.x) / W;
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
  let gutterRacePen = 0;
  if (earlyBoards.length >= 3) {
    const eMax = Math.max(...earlyBoards);
    const eMin = Math.min(...earlyBoards);
    if (eMax >= 32 || eMin <= 4 || eMax - eMin > 14) gutterRacePen = -40;
  }
  let deepOk = 0;
  if (lateBoards.length >= 2) {
    const lMed = [...lateBoards].sort((a, b) => a - b)[
      Math.floor(lateBoards.length / 2)
    ];
    if (lMed >= 8 && lMed <= 24) deepOk = 30;
    else if (lMed >= 5 && lMed <= 30) deepOk = 10;
  }
  const probeScore =
    c.rank +
    medOk +
    coverOk +
    earlyOk +
    widePen +
    midStickPen +
    gutterRacePen +
    deepOk +
    Math.min(18, locks * 0.12);
  console.log(
    `probe t=${c.t.toFixed(2)} med=${med?.toFixed(1) ?? "—"} ft=${minFeet.toFixed(1)}-${maxFeet.toFixed(1)} gutterPen=${gutterRacePen} deep=${deepOk} → ${probeScore.toFixed(1)}`
  );
  if (probeScore > bestProbe) {
    bestProbe = probeScore;
    best = c;
  }
}

console.log(
  "\nCHOSEN Workbench probe:",
  best
    ? `t=${best.t.toFixed(2)} conf=${(best.det.confidence * 100).toFixed(0)}% probe=${bestProbe.toFixed(1)}`
    : "none"
);

function fullTrackWB(corners: LaneCorners, sens: number, label: string) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = {
    ...DEFAULT_TRACKER,
    sensitivity: sens,
    minBlobPixels: sens <= 26 ? 28 : DEFAULT_TRACKER.minBlobPixels,
  };
  const pts: {
    image: { x: number; y: number };
    lane?: { board: number; feet: number };
    t: number;
    predicted?: boolean;
  }[] = [];
  for (let f = 0; f < N; f++) {
    const rgba = frameAt(f);
    const work =
      scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(
      work,
      scale < 1 ? tw : W,
      scale < 1 ? th : H
    );
    const res = trackBallFrame(
      state,
      gray,
      scale < 1 ? tw : W,
      scale < 1 ? th : H,
      settings,
      scale < 1 ? workC : corners,
      1000 / FPS,
      work
    );
    const pos = res.smoothed
      ? scale < 1
        ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale }
        : res.smoothed
      : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      const lane = imageToLane(Hm, pos);
      let accept = true;
      if (
        !res.predicted &&
        (lane.board < 1.2 || lane.board > 37.8) &&
        lane.feet < 45
      ) {
        accept = false;
      }
      if (accept && (pts.length > 0 || !res.predicted)) {
        pts.push({
          image: pos,
          lane,
          t: f * (1000 / FPS),
          predicted: res.predicted || undefined,
        });
      }
    }
  }
  const est = computeShotEstimate(pts as any, getRpmEstimate(state));
  const q = evaluateShotQuality(pts as any);
  console.log(label, {
    arrows: est.arrowsBoard,
    bp:
      est.breakpointBoard != null
        ? `${Number(est.breakpointBoard).toFixed(1)}@${est.breakpointDistance}`
        : null,
    cov: `${est.coverageFeetMin}–${est.coverageFeetMax}`,
    pocket: est.pocketBoard,
    avg: est.avgSpeedMph,
    L: est.launchSpeedMph,
    I: est.impactSpeedMph,
    n: pts.length,
    q: q.ok,
  });
  return est;
}

if (best) {
  fullTrackWB(best.det.corners, 28, "PROBE+DEFAULT sens28");
  fullTrackWB(best.det.corners, 26, "PROBE+sens26");
}
if (ranked[0]) {
  fullTrackWB(ranked[0].det.corners, 28, "GEOM-ONLY sens28 (probe skipped)");
}
