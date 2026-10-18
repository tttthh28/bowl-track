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
  trackWorkSize,
  scaleLaneCorners,
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
// 用接近 production 嘅原生比例，追蹤時再縮到 TRACK_WORK（貼 Workbench）
const W = 1060, H = 954, FPS = 15, N = 120;
mkdirSync(OUT, { recursive: true });
execSync(
  `ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,
  { stdio: "pipe" }
);
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;
const frames = Math.floor(raw.length / frameBytes);

// 與 Workbench／offline-metrics 對齊：幾何 + 單道寬／中線 + 短探針
type DetCand = {
  det: NonNullable<ReturnType<typeof detectLaneCorners>>;
  geom: number;
  fi: number;
};
const detCands: DetCand[] = [];
for (const fi of [0, 8, 16, 24, 30, 40, 48, 60, 72]) {
  const off = fi * frameBytes;
  if (off + frameBytes > raw.length) continue;
  const slice = new Uint8ClampedArray(raw.subarray(off, off + frameBytes));
  const cand = detectLaneCorners(slice, W, H);
  if (!cand || cand.confidence < 0.4) continue;
  detCands.push({ det: cand, geom: scoreLaneGeometry(cand, W, H), fi });
}
detCands.sort((a, b) => b.geom - a.geom);
const topDet = detCands.slice(0, Math.min(10, detCands.length));

function probeCorners(c: import("../src/lib/types.ts").LaneCorners) {
  const Hm0 = buildHomography(c);
  if (!Hm0) return { med: null as number | null, maxFeet: 0, minFeet: 99, locks: 0 };
  const { scale: sc0, tw: tw0, th: th0 } = trackWorkSize(W, H);
  const workC0 = scaleLaneCorners(c, sc0);
  const st = new BallTrackerState();
  const settings0 = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const boards: number[] = [];
  let maxFeet = 0;
  let minFeet = 99;
  let locks = 0;
  const nProbe = Math.min(frames, 100);
  for (let f = 0; f < nProbe; f++) {
    const rgba = new Uint8ClampedArray(
      raw.buffer,
      raw.byteOffset + f * frameBytes,
      frameBytes
    );
    let workRgba: Uint8ClampedArray;
    let ww = W, wh = H;
    let useC = c;
    if (sc0 < 1) {
      workRgba = new Uint8ClampedArray(tw0 * th0 * 4);
      for (let y = 0; y < th0; y++) {
        const sy = Math.min(H - 1, Math.floor((y / th0) * H));
        for (let x = 0; x < tw0; x++) {
          const sx = Math.min(W - 1, Math.floor((x / tw0) * W));
          const si = (sy * W + sx) * 4;
          const di = (y * tw0 + x) * 4;
          workRgba[di] = rgba[si];
          workRgba[di + 1] = rgba[si + 1];
          workRgba[di + 2] = rgba[si + 2];
          workRgba[di + 3] = 255;
        }
      }
      ww = tw0; wh = th0; useC = workC0;
    } else {
      workRgba = new Uint8ClampedArray(rgba);
    }
    const gray = rgbaToGray(workRgba, ww, wh);
    const res = trackBallFrame(st, gray, ww, wh, settings0, useC, 1000 / FPS, workRgba);
    if (res.locked && res.smoothed) {
      locks++;
      const pos =
        sc0 < 1
          ? { x: res.smoothed.x / sc0, y: res.smoothed.y / sc0 }
          : res.smoothed;
      const lane = imageToLane(Hm0, pos);
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

let det = null as ReturnType<typeof detectLaneCorners>;
let bestScore = -1e9;
for (const c of topDet.length ? topDet : detCands) {
  const p = probeCorners(c.det.corners);
  const botFrac = (c.det.corners.br.x - c.det.corners.bl.x) / W;
  const midBot = (c.det.corners.bl.x + c.det.corners.br.x) / 2;
  const midFrac = Math.abs(midBot / W - 0.5);
  const medOk =
    p.med != null && p.med >= 8 && p.med <= 30
      ? 35
      : p.med != null && p.med >= 5 && p.med <= 34
        ? 12
        : -45;
  const coverOk = Math.min(45, Math.max(0, p.maxFeet - p.minFeet));
  const earlyOk = p.minFeet <= 18 ? 25 : p.minFeet <= 24 ? 8 : -18;
  const widthOk =
    botFrac >= 0.32 && botFrac <= 0.48 ? 20 : botFrac > 0.52 ? -30 : 0;
  const midOk = midFrac < 0.12 ? 15 : midFrac < 0.18 ? 4 : -20;
  const score =
    c.geom +
    medOk +
    coverOk +
    earlyOk +
    widthOk +
    midOk +
    Math.min(18, p.locks * 0.1);
  console.log(
    `probe fi=${c.fi} geom=${c.geom.toFixed(1)} med=${p.med?.toFixed(1) ?? "—"} ft=${p.minFeet.toFixed(1)}–${p.maxFeet.toFixed(1)} bot=${botFrac.toFixed(2)} → ${score.toFixed(1)}`
  );
  if (score > bestScore) {
    bestScore = score;
    det = c.det;
  }
}
const corners = det?.corners ?? defaultCorners(W, H);
console.log(
  "corners:",
  det
    ? `auto conf=${(det.confidence * 100).toFixed(0)}% botFrac=${(((corners.br.x - corners.bl.x) / W)).toFixed(2)}`
    : "default"
);
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

  const { scale, tw, th } = trackWorkSize(W, H);
  const workCorners = scaleLaneCorners(corners, scale);
  for (let f = 0; f < frames; f++) {
    const offset = f * frameBytes;
    const rgba = new Uint8ClampedArray(raw.buffer, raw.byteOffset + offset, frameBytes);
    // nearest downscale if needed
    let workRgba: Uint8ClampedArray;
    let ww = W, wh = H;
    let useCorners = corners;
    if (scale < 1) {
      workRgba = new Uint8ClampedArray(tw * th * 4);
      for (let y = 0; y < th; y++) {
        const sy = Math.min(H - 1, Math.floor((y / th) * H));
        for (let x = 0; x < tw; x++) {
          const sx = Math.min(W - 1, Math.floor((x / tw) * W));
          const si = (sy * W + sx) * 4;
          const di = (y * tw + x) * 4;
          workRgba[di] = rgba[si];
          workRgba[di + 1] = rgba[si + 1];
          workRgba[di + 2] = rgba[si + 2];
          workRgba[di + 3] = 255;
        }
      }
      ww = tw; wh = th; useCorners = workCorners;
    } else {
      workRgba = new Uint8ClampedArray(rgba);
    }
    const gray = rgbaToGray(workRgba, ww, wh);
    const res = trackBallFrame(state, gray, ww, wh, settings, useCorners, 1000 / FPS, workRgba);
    if (loopSaved) continue;
    const pos = res.smoothed
      ? scale < 1
        ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale }
        : res.smoothed
      : null;
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
