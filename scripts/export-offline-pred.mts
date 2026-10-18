import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { detectLaneCorners, scoreLaneGeometry } from "../src/lib/laneDetect.ts";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  rgbaToGray,
  trackBallFrame,
  shouldEndShot,
  getRpmEstimate,
} from "../src/lib/tracker.ts";
import {
  imageToLane,
  buildHomography,
  defaultCorners,
} from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-export-pred";
const W = 640, H = 576, FPS = 15, N = 130;
mkdirSync(OUT, { recursive: true });
execSync(
  `ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,
  { stdio: "pipe" }
);
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;
const frames = Math.floor(raw.length / frameBytes);
function frame(f: number) {
  return new Uint8ClampedArray(raw.subarray(f * frameBytes, (f + 1) * frameBytes));
}

const cands: { det: NonNullable<ReturnType<typeof detectLaneCorners>>; geom: number; fi: number }[] = [];
for (const fi of [0, 4, 8, 12, 16, 20, 24, 30, 40]) {
  if (fi >= frames) continue;
  const det = detectLaneCorners(frame(fi), W, H);
  if (!det || det.confidence < 0.4) continue;
  cands.push({ det, geom: scoreLaneGeometry(det, W, H), fi });
}
cands.sort((a, b) => b.geom - a.geom);

function runTrack(corners: typeof cands[0]["det"]["corners"]) {
  const Hm = buildHomography(corners)!;
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const points: any[] = [];
  let shotStart = 0;
  for (let f = 0; f < frames; f++) {
    const rgba = frame(f);
    const gray = rgbaToGray(rgba, W, H);
    const res = trackBallFrame(state, gray, W, H, settings, corners, 1000 / FPS, rgba);
    const pos = res.smoothed;
    if (res.locked && pos && (res.raw || res.predicted)) {
      if (points.length === 0 && !res.predicted) shotStart = f * (1000 / FPS);
      if (points.length > 0 || !res.predicted) {
        const lane = imageToLane(Hm, pos);
        if ((lane.board >= 1.2 && lane.board <= 37.8) || lane.feet >= 45) {
          points.push({
            image: pos,
            lane: { board: lane.board, feet: lane.feet },
            t: f * (1000 / FPS) - shotStart,
            predicted: res.predicted || undefined,
          });
        }
      }
    }
    if (shouldEndShot(state, settings, points.length > 0)) break;
  }
  const q = evaluateShotQuality(points);
  const est = q.ok ? computeShotEstimate(points, getRpmEstimate(state)) : null;
  const boards = points.filter((p) => p.lane).map((p) => p.lane.board);
  const med = boards.length
    ? [...boards].sort((a, b) => a - b)[Math.floor(boards.length / 2)]
    : null;
  const feet = points.filter((p) => p.lane).map((p) => p.lane.feet);
  const minF = feet.length ? Math.min(...feet) : 99;
  const maxF = feet.length ? Math.max(...feet) : 0;
  return { points, q, est, med, minF, maxF };
}

let best: ReturnType<typeof runTrack> | null = null;
let bestScore = -1e9;
let bestFi = -1;
let bestCorners = defaultCorners(W, H);
for (const c of cands.slice(0, 6)) {
  const r = runTrack(c.det.corners);
  const pinY = (c.det.corners.tl.y + c.det.corners.tr.y) / 2;
  const medOk = r.med != null && r.med >= 10 && r.med <= 28 ? 40 : -30;
  const earlyOk = r.minF <= 18 ? 20 : r.minF <= 22 ? 10 : 0;
  const cover = Math.min(50, Math.max(0, r.maxF - r.minF));
  const pinPen = pinY < H * 0.12 ? -25 : 0;
  const arr = r.est?.arrowsBoard;
  const bp = r.est?.breakpointBoard;
  // 明顯錯 board（箭頭>26 或 BP 貼溝）重罰
  const boardPen =
    (arr != null && (arr < 5 || arr > 26) ? -60 : 0) +
    (bp != null && (bp < 6 || bp > 30) ? -40 : 0);
  const speedBonus =
    r.est?.avgSpeedMph != null &&
    r.est.avgSpeedMph >= 12 &&
    r.est.avgSpeedMph <= 20
      ? 15
      : 0;
  const sc =
    c.geom +
    medOk +
    earlyOk +
    cover +
    pinPen +
    boardPen +
    speedBonus +
    (r.q.ok ? 20 : 0);
  console.log(
    `fi=${c.fi} geom=${c.geom.toFixed(1)} med=${r.med?.toFixed(1)} ft=${r.minF.toFixed(1)}–${r.maxF.toFixed(1)} q=${r.q.ok} avg=${r.est?.avgSpeedMph} → ${sc.toFixed(1)}`
  );
  if (sc > bestScore && r.est) {
    bestScore = sc;
    best = r;
    bestFi = c.fi;
    bestCorners = c.det.corners;
  }
}

if (!best?.est) {
  console.error("no estimate");
  process.exit(1);
}
const e = best.est;
const pred = {
  videoId: "bowling-demo",
  source: "offline-export",
  detectFrame: bestFi,
  corners: bestCorners,
  shots: [
    {
      shotId: "bowling-demo-shot-1",
      estimate: {
        avgSpeedMph: e.avgSpeedMph,
        launchSpeedMph: e.launchSpeedMph,
        impactSpeedMph: e.impactSpeedMph,
        arrowsBoard: e.arrowsBoard,
        breakpointBoard: e.breakpointBoard,
        breakpointDistance: e.breakpointDistance,
        pocketBoard: e.pocketBoard,
        shotTimeSec: e.shotTimeSec,
        launchAngleDeg: e.launchAngleDeg,
        impactAngleDeg: e.impactAngleDeg,
        rpm: e.rpm,
        coverageFeetMin: e.coverageFeetMin,
        coverageFeetMax: e.coverageFeetMax,
        extrapolated: e.extrapolated,
      },
    },
  ],
};
const outPath = join(ROOT, "test-media/eval/pred-bowling-demo-offline.json");
writeFileSync(outPath, JSON.stringify(pred, null, 2));
console.log("\nWrote", outPath);
console.log(JSON.stringify(pred.shots[0].estimate, null, 2));
