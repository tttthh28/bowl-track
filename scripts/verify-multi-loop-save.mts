/**
 * 模擬多圈 loop：每圈應約存 1 投；去重唔好跨圈永遠擋。
 * 用 concat 影片幀重複跑 6 圈（同一段 rgba 重播）。
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  rgbaToGray,
  trackBallFrame,
  shouldEndShot,
  getRpmEstimate,
} from "../src/lib/tracker.ts";
import { detectLaneCorners, scoreLaneGeometry } from "../src/lib/laneDetect.ts";
import { defaultCorners, imageToLane, buildHomography } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import {
  evaluateShotQuality,
  isDuplicateOfLastShot,
} from "../src/lib/shotQuality.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-multiloop";
const W = 640, H = 576, FPS = 15, N = 120;
mkdirSync(OUT, { recursive: true });
execSync(
  `ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,
  { stdio: "pipe" }
);
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;
const frames = Math.floor(raw.length / frameBytes);

let det = null as ReturnType<typeof detectLaneCorners>;
let bestG = -1e9;
for (const fi of [0, 8, 16, 24, 30, 40]) {
  const off = fi * frameBytes;
  if (off + frameBytes > raw.length) continue;
  const slice = new Uint8ClampedArray(raw.subarray(off, off + frameBytes));
  const cand = detectLaneCorners(slice, W, H);
  if (!cand || cand.confidence < 0.4) continue;
  const g = scoreLaneGeometry(cand, W, H);
  if (g > bestG) {
    bestG = g;
    det = cand;
  }
}
const corners = det?.corners ?? defaultCorners(W, H);
const Hm = buildHomography(corners)!;
const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };

const LOOPS = 6;
type Pt = {
  image: { x: number; y: number };
  lane?: { board: number; feet: number };
  t: number;
  predicted?: boolean;
};

let saved = 0;
let discardedQual = 0;
let discardedDedup = 0;
let lastSaved: { points: Pt[]; createdAt: number } | null = null;
// wall clock: each loop ~ N/FPS sec; advance synthetic now
let nowMs = 1_700_000_000_000;

for (let loop = 0; loop < LOOPS; loop++) {
  const state = new BallTrackerState();
  let points: Pt[] = [];
  let shotStart = 0;
  let loopSaved = false;
  const tryFinish = (pts: Pt[]) => {
    if (loopSaved) return [];
    const q = evaluateShotQuality(pts as any);
    if (!q.ok) {
      discardedQual++;
      state.beginNewShot();
      return [];
    }
    if (
      isDuplicateOfLastShot(
        pts as any,
        lastSaved?.points as any,
        lastSaved?.createdAt,
        nowMs
      )
    ) {
      discardedDedup++;
      state.beginNewShot();
      return [];
    }
    const est = computeShotEstimate(pts as any, getRpmEstimate(state));
    saved++;
    loopSaved = true;
    lastSaved = { points: pts, createdAt: nowMs };
    console.log(
      `loop ${loop + 1}: saved avg=${est.avgSpeedMph} L=${est.launchSpeedMph} I=${est.impactSpeedMph} bp=${est.breakpointBoard?.toFixed(1)}@${est.breakpointDistance} pocket=${est.pocketBoard?.toFixed(1)} t=${est.shotTimeSec}`
    );
    state.beginNewShot();
    return [];
  };

  for (let f = 0; f < frames; f++) {
    const offset = f * frameBytes;
    const rgba = new Uint8ClampedArray(raw.buffer, raw.byteOffset + offset, frameBytes);
    const copy = new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(copy, W, H);
    const res = trackBallFrame(state, gray, W, H, settings, corners, 1000 / FPS, copy);
    if (loopSaved) continue;
    const pos = res.smoothed;
    if (res.locked && pos && (res.raw || res.predicted)) {
      if (points.length === 0 && !res.predicted) shotStart = f * (1000 / FPS);
      if (points.length > 0 || !res.predicted) {
        const t = f * (1000 / FPS) - shotStart;
        const lane = imageToLane(Hm, pos);
        let accept = true;
        if (lane.board < 1.2 || lane.board > 37.8) {
          if (lane.feet < 45) accept = false;
        }
        if (accept) {
          points.push({
            image: pos,
            lane: { board: lane.board, feet: lane.feet },
            t,
            predicted: res.predicted || undefined,
          });
        }
      }
    }
    if (shouldEndShot(state, settings, points.length > 0)) {
      points = tryFinish(points);
    } else if (!res.locked && points.length > 0) {
      points = tryFinish(points);
    }
  }
  if (points.length > 0) points = tryFinish(points);
  // 模擬真實時間：一圈片長
  nowMs += Math.round((frames / FPS) * 1000);
}

console.log(`\nSummary: loops=${LOOPS} saved=${saved} qualDiscard=${discardedQual} dedupDiscard=${discardedDedup}`);
let failed = 0;
function assert(c: boolean, m: string) {
  if (!c) { console.error("FAIL:", m); failed++; }
  else console.log("OK:", m);
}
assert(saved >= Math.floor(LOOPS * 0.8), `save ≥80% of loops (got ${saved}/${LOOPS})`);
assert(saved <= LOOPS, `no more than 1 per loop average ceiling (${saved})`);
// 唔好成串去重
assert(discardedDedup <= LOOPS * 0.5, `dedup not blocking most loops (${discardedDedup})`);
if (failed) process.exit(1);
console.log("\nAll multi-loop save asserts passed");
