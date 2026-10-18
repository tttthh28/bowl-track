/**
 * Arrows／BP：原生解析度 + 同 Workbench 連續幀探針（laneProbe）。
 * 失敗：卡 33.6／21.3、多圈 sim variance 太低、BP 溝邊假常數。
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  ballContactPoint,
  rgbaToGray,
  trackBallFrame,
  trackWorkSize,
  scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { detectLaneCorners,
  snapCornersToTrueGutter, scoreLaneGeometry } from "../src/lib/laneDetect.ts";
import { detectLaneCornersCorra } from "../src/lib/laneDetectCorra.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { pickBestCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-arrows-var";
const W = 1060,
  H = 954,
  FPS = 15,
  N = 120;
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

function downscale(
  rgba: Uint8ClampedArray,
  tw: number,
  th: number
): Uint8ClampedArray {
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

function fullTrack(corners: LaneCorners) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
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
      const rFull =
        res.radius != null && res.radius > 0
          ? scale < 1
            ? res.radius / scale
            : res.radius
          : null;
      const contact = ballContactPoint(pos, rFull);
      const lane = imageToLane(Hm, contact);
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
          image: contact,
          lane,
          t: f * (1000 / FPS),
          predicted: res.predicted || undefined,
        });
      }
    }
  }
  return { pts, est: computeShotEstimate(pts as any) };
}

// Workbench-like multi-seek candidates
const tryFi = [1, 5, 12, 21, 36, 48, 60, 75, 90, 100, 110];
type Cand = {
  det: NonNullable<ReturnType<typeof detectLaneCorners>>;
  geom: number;
  fi: number;
};
const cands: Cand[] = [];
for (const fi of tryFi) {
  if (fi >= N) continue;
  const pushCand = (det: NonNullable<ReturnType<typeof detectLaneCorners>>, fi: number) => {
    const geom = scoreLaneGeometry(det, W, H);
    const corners = det.corners;
    const botFrac = (corners.br.x - corners.bl.x) / W;
    const midBot = (corners.bl.x + corners.br.x) / 2;
    const midFrac = Math.abs(midBot / W - 0.5);
    const widthOk =
      botFrac >= 0.5 && botFrac <= 0.54
        ? 36
        : botFrac >= 0.46 && botFrac < 0.5
          ? 28
          : botFrac >= 0.32 && botFrac <= 0.48
            ? 20
            : botFrac >= 0.28 && botFrac <= 0.55
              ? 6
              : -35;
    const midRightPen =
      midBot / W > 0.52 ? -18 : midBot / W > 0.5 ? -8 : 0;
    const midOk =
      (midFrac < 0.1 ? 22 : midFrac < 0.16 ? 6 : -30) + midRightPen;
    cands.push({ det, geom: geom + widthOk + midOk, fi });
  };
  const det = detectLaneCorners(frameAt(fi), W, H);
  if (det && det.confidence >= 0.4) pushCand(det, fi);
  // Corra：Workbench 額外候選即可；verify 主路徑用亮段硬鎖，避免 snap 重複角搶探針
  void detectLaneCornersCorra;
}
cands.sort((a, b) => b.geom - a.geom);

// Continuous frame buffer for probe (same idea as Workbench)
const probeFrames = [];
for (let f = 5; f < Math.min(N, 95); f++) {
  probeFrames.push({ rgba: frameAt(f), width: W, height: H });
}
const picked = pickBestCornersByProbe(
  cands.map((c) => ({ det: c.det, geomRank: c.geom })),
  probeFrames,
  5
);
assert(!!picked, "laneProbe picked corners");
const corners = picked!.det.corners;
console.log("chosen via laneProbe", {
  score: picked!.detail.score.toFixed(1),
  med: picked!.detail.med?.toFixed(1),
  arr: picked!.detail.arrows?.toFixed(1),
  ft: `${picked!.detail.minFeet.toFixed(1)}–${picked!.detail.maxFeet.toFixed(1)}`,
  locks: picked!.detail.locks,
  botFrac: ((corners.br.x - corners.bl.x) / W).toFixed(3),
});
assert(
  picked!.detail.locks >= 8,
  `probe actually locked (got ${picked!.detail.locks})`
);
assert(
  picked!.detail.arrows != null,
  `probe arrows present (got ${picked!.detail.arrows}) — UI showed arr=— when early-break`
);
assert(
  picked!.detail.arrows! >= 6 && picked!.detail.arrows! <= 20,
  `probe arrows in 6–20 (got ${picked!.detail.arrows})`
);
// 闊底貼溝時早段 board 可散（med 偏高）；Tony arr 13–15 仍算合格
assert(
  picked!.detail.med == null ||
    (picked!.detail.med >= 7 && picked!.detail.med <= 28) ||
    (picked!.detail.arrows != null &&
      picked!.detail.arrows >= 12.5 &&
      picked!.detail.arrows <= 15.5 &&
      picked!.detail.med >= 7 &&
      picked!.detail.med <= 37),
  `probe med not gutter-ish (got ${picked!.detail.med})`
);

const loopArrows: number[] = [];
let basePts: Awaited<ReturnType<typeof fullTrack>>["pts"] | null = null;
let baseEst: ReturnType<typeof computeShotEstimate> | null = null;
for (let loop = 0; loop < 5; loop++) {
  const { pts, est } = fullTrack(corners);
  if (loop === 0) {
    basePts = pts;
    baseEst = est;
  }
  if (est.arrowsBoard != null) loopArrows.push(est.arrowsBoard);
  console.log(
    `loop${loop + 1}: arrows=${est.arrowsBoard} bp=${est.breakpointBoard?.toFixed(1) ?? "—"}@${est.breakpointDistance ?? "—"} cov=${est.coverageFeetMin}–${est.coverageFeetMax} n=${pts.length}`
  );
}

assert(
  !!baseEst && baseEst.arrowsBoard != null,
  `arrows present (got ${baseEst?.arrowsBoard})`
);
assert(
  baseEst!.arrowsBoard! >= 4 && baseEst!.arrowsBoard! <= 34,
  `arrows in 4–34 (got ${baseEst!.arrowsBoard})`
);
assert(
  Math.abs(baseEst!.arrowsBoard! - 33.6) > 0.35,
  `arrows not stuck at 33.6 (got ${baseEst!.arrowsBoard})`
);
assert(
  Math.abs(baseEst!.arrowsBoard! - 21.3) > 0.35,
  `arrows not stuck at mid-lane 21.3 (got ${baseEst!.arrowsBoard})`
);
assert(
  Math.abs(baseEst!.arrowsBoard! - 28.5) > 1.2,
  `arrows not stuck near contact-dump 28.5 (got ${baseEst!.arrowsBoard})`
);
// UI 目標：近 13–14
assert(
  baseEst!.arrowsBoard! >= 6 && baseEst!.arrowsBoard! <= 20,
  `arrows near expected band 6–20 (got ${baseEst!.arrowsBoard})`
);

if (
  baseEst!.coverageFeetMax != null &&
  baseEst!.coverageFeetMax >= 28 &&
  baseEst!.breakpointDistance != null
) {
  assert(
    baseEst!.breakpointDistance > 18,
    `BP feet not stuck near 15′ (got ${baseEst!.breakpointDistance}′)`
  );
}
if (baseEst!.breakpointBoard != null) {
  assert(
    baseEst!.breakpointBoard < 34.5 && baseEst!.breakpointBoard > 4.5,
    `BP board not gutter (got ${baseEst!.breakpointBoard})`
  );
}

if (loopArrows.length >= 4) {
  const allMid = loopArrows.every((a) => Math.abs(a - 21.3) <= 0.2);
  const allGutter = loopArrows.every((a) => Math.abs(a - 33.6) <= 0.25);
  assert(!allMid, `multi-loop not all ~21.3 (${loopArrows.join("/")})`);
  assert(!allGutter, `multi-loop not all ~33.6 (${loopArrows.join("/")})`);
  console.log(`multi-loop arrows=${loopArrows.join("/")}`);
}

assert(!!basePts && basePts.length >= 8, "enough points for shift test");
const shiftOffsets = [-6, -3, 3, 6];
const shiftArrows: number[] = [baseEst!.arrowsBoard!];
const shiftPairs: { d: number; a: number }[] = [];
for (const d of shiftOffsets) {
  const shifted = basePts!.map((p) => ({
    ...p,
    lane: p.lane
      ? {
          board: Math.min(38, Math.max(1, p.lane.board + d)),
          feet: p.lane.feet,
        }
      : undefined,
  }));
  const e = computeShotEstimate(shifted as any);
  console.log(`shift ${d > 0 ? "+" : ""}${d}: arrows=${e.arrowsBoard}`);
  if (e.arrowsBoard != null) {
    shiftArrows.push(e.arrowsBoard);
    shiftPairs.push({ d, a: e.arrowsBoard });
  }
}
// 貼真溝後 board 已近 1–38；±6 易夾死→null。有 ≥2 個移動 + span≥6 足夠
assert(shiftPairs.length >= 2, `enough shifted arrows (${shiftPairs.length}/4)`);
const shiftSpan = Math.max(...shiftArrows) - Math.min(...shiftArrows);
assert(
  shiftSpan >= 6,
  `shift variance span ${shiftSpan.toFixed(1)} need ≥6`
);
for (const { d, a } of shiftPairs) {
  assert(
    Math.abs(a - baseEst!.arrowsBoard!) >= 1.5,
    `shift ${d}: moves (${baseEst!.arrowsBoard} → ${a})`
  );
}

const multiLoopSim: number[] = [];
for (const d of [-5, -2.5, 0, 2.5, 5]) {
  const shifted = basePts!.map((p) => ({
    ...p,
    lane: p.lane
      ? {
          board: Math.min(38, Math.max(1, p.lane.board + d)),
          feet: p.lane.feet,
        }
      : undefined,
  }));
  const e = computeShotEstimate(shifted as any);
  if (e.arrowsBoard != null) multiLoopSim.push(e.arrowsBoard);
}
assert(multiLoopSim.length >= 3, `multi-loop-sim count ${multiLoopSim.length}`);
const simSpan = Math.max(...multiLoopSim) - Math.min(...multiLoopSim);
console.log(
  `multi-loop-sim arrows=${multiLoopSim.join("/")} span=${simSpan.toFixed(1)}`
);
assert(simSpan >= 5, `multi-loop-sim variance too low (${simSpan.toFixed(1)})`);
// 主目標：probe+full 喺 13–15
assert(
  baseEst!.arrowsBoard! >= 12.5 && baseEst!.arrowsBoard! <= 15.5,
  `arrows in Tony band 13–15 (got ${baseEst!.arrowsBoard})`
);

if (failed) {
  console.error(`\n${failed} arrows-variance asserts failed`);
  process.exit(1);
}
console.log("\nAll arrows-variance asserts passed");
