/**
 * Arrows：用幾何＋短探針揀角（貼 offline-metrics／Workbench 多幀），
 * 確認 arrowsBoard 有值、唔卡死常數、隨軌跡落喺合理 board。
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  rgbaToGray,
  trackBallFrame,
} from "../src/lib/tracker.ts";
import { detectLaneCorners, scoreLaneGeometry } from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-arrows-var";
const W = 640, H = 576, FPS = 15, N = 130;
mkdirSync(OUT, { recursive: true });
execSync(
  `ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,
  { stdio: "pipe" }
);
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;
const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else console.log("OK:", msg);
}

function frameAt(fi: number) {
  const u8 = new Uint8ClampedArray(frameBytes);
  u8.set(raw.subarray(fi * frameBytes, (fi + 1) * frameBytes));
  return u8;
}

function probeTrack(corners: LaneCorners) {
  const Hm = buildHomography(corners);
  if (!Hm) return { med: null as number | null, maxFeet: 0, minFeet: 99, locks: 0 };
  const state = new BallTrackerState();
  const boards: number[] = [];
  let maxFeet = 0;
  let minFeet = 99;
  let locks = 0;
  const nProbe = Math.min(Math.floor(raw.length / frameBytes), 110);
  for (let f = 0; f < nProbe; f++) {
    const rgba = frameAt(f);
    const copy = new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(copy, W, H);
    const res = trackBallFrame(state, gray, W, H, settings, corners, 1000 / FPS, copy);
    if (res.locked && res.smoothed) {
      locks++;
      const lane = imageToLane(Hm, res.smoothed);
      if (lane.board >= 1.5 && lane.board <= 37.5) {
        boards.push(lane.board);
        if (lane.feet > maxFeet) maxFeet = lane.feet;
        if (lane.feet < minFeet) minFeet = lane.feet;
      }
    }
  }
  const med =
    boards.length > 0
      ? [...boards].sort((a, b) => a - b)[Math.floor(boards.length / 2)]
      : null;
  return { med, maxFeet, minFeet: boards.length ? minFeet : 99, locks };
}

type Cand = { det: NonNullable<ReturnType<typeof detectLaneCorners>>; geom: number; fi: number };
const cands: Cand[] = [];
for (const fi of [0, 4, 8, 12, 16, 20, 24, 30, 40, 48]) {
  const det = detectLaneCorners(frameAt(fi), W, H);
  if (!det || det.confidence < 0.4) continue;
  cands.push({ det, geom: scoreLaneGeometry(det, W, H), fi });
}
cands.sort((a, b) => b.geom - a.geom);
const top = cands.slice(0, Math.min(5, cands.length));

let bestDet = top[0]?.det ?? null;
let bestScore = -1e9;
for (const c of top) {
  const p = probeTrack(c.det.corners);
  const botFrac = (c.det.corners.br.x - c.det.corners.bl.x) / W;
  const medOk =
    p.med != null && p.med >= 8 && p.med <= 30
      ? 30
      : p.med != null && p.med >= 5 && p.med <= 34
        ? 10
        : -40;
  const coverOk = Math.min(40, Math.max(0, p.maxFeet - p.minFeet));
  const earlyOk = p.minFeet <= 18 ? 25 : p.minFeet <= 24 ? 8 : -20;
  const widePen = botFrac > 0.48 ? -25 : botFrac < 0.3 ? -10 : 0;
  const score = c.geom + medOk + coverOk + earlyOk + widePen + Math.min(15, p.locks * 0.1);
  console.log(
    `probe fi=${c.fi} geom=${c.geom.toFixed(1)} med=${p.med?.toFixed(1) ?? "—"} ft=${p.minFeet.toFixed(1)}–${p.maxFeet.toFixed(1)} bot=${botFrac.toFixed(2)} → ${score.toFixed(1)}`
  );
  if (score > bestScore) {
    bestScore = score;
    bestDet = c.det;
  }
}

assert(!!bestDet, "have probed lane corners");
const corners = bestDet!.corners;
const botFrac = (corners.br.x - corners.bl.x) / W;
const midBot = (corners.bl.x + corners.br.x) / 2;
console.log("chosen corners", {
  conf: (bestDet!.confidence * 100).toFixed(0) + "%",
  botFrac: botFrac.toFixed(3),
  midBot: midBot.toFixed(0),
  TL: { x: Math.round(corners.tl.x), y: Math.round(corners.tl.y) },
  TR: { x: Math.round(corners.tr.x), y: Math.round(corners.tr.y) },
  BL: { x: Math.round(corners.bl.x), y: Math.round(corners.bl.y) },
  BR: { x: Math.round(corners.br.x), y: Math.round(corners.br.y) },
});
assert(botFrac <= 0.5, `botFrac≤0.50 (got ${botFrac.toFixed(3)})`);
assert(botFrac >= 0.3, `botFrac≥0.30 (got ${botFrac.toFixed(3)})`);
assert(Math.abs(midBot - W * 0.5) / W < 0.16, `midBot near center (got ${midBot.toFixed(0)})`);

// 完整追蹤 → arrows
const Hm = buildHomography(corners)!;
const state = new BallTrackerState();
const pts: {
  image: { x: number; y: number };
  lane?: { board: number; feet: number };
  t: number;
}[] = [];
for (let f = 0; f < N; f++) {
  const rgba = frameAt(f);
  const copy = new Uint8ClampedArray(rgba);
  const gray = rgbaToGray(copy, W, H);
  const res = trackBallFrame(state, gray, W, H, settings, corners, 1000 / FPS, copy);
  if (res.locked && res.smoothed) {
    const lane = imageToLane(Hm, res.smoothed);
    if (lane.board >= 1 && lane.board <= 38) {
      pts.push({ image: res.smoothed, lane, t: f * (1000 / FPS) });
    }
  }
}
const est = computeShotEstimate(pts as any);
console.log("estimate", {
  arrows: est.arrowsBoard,
  foul: est.foulBoard,
  cov: `${est.coverageFeetMin}–${est.coverageFeetMax}`,
  bp: est.breakpointBoard,
  avg: est.avgSpeedMph,
  n: pts.length,
});

assert(est.arrowsBoard != null, `arrows present (got ${est.arrowsBoard})`);
assert(
  est.arrowsBoard! >= 4 && est.arrowsBoard! <= 34,
  `arrows in 4–34 (got ${est.arrowsBoard})`
);
// 唔好卡死舊 bug 常數 33.6
assert(
  Math.abs(est.arrowsBoard! - 33.6) > 0.2,
  `arrows not stuck at 33.6 (got ${est.arrowsBoard})`
);

// 合成第二軌：把 board 平移，arrows 應跟住變
const shifted = pts.map((p) => ({
  ...p,
  lane: p.lane
    ? { board: Math.min(38, Math.max(1, p.lane.board + 4.5)), feet: p.lane.feet }
    : undefined,
}));
const est2 = computeShotEstimate(shifted as any);
console.log("shifted arrows", est2.arrowsBoard);
assert(est2.arrowsBoard != null, "shifted arrows present");
assert(
  Math.abs(est2.arrowsBoard! - est.arrowsBoard!) > 2,
  `arrows varies with board shift (${est.arrowsBoard} → ${est2.arrowsBoard})`
);

if (failed) {
  console.error(`\n${failed} arrows-variance asserts failed`);
  process.exit(1);
}
console.log("\nAll arrows-variance asserts passed");
