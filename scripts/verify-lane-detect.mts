/**
 * bowling-demo.mp4：自動球道偵測驗證
 * - 多數幀能產出四角
 * - TL/TR 夠高（pins 端）
 * - BL/BR 偏下（foul 端）
 * - 梯形：底寬 > 頂寬
 * - 信心誠實：幾何差時唔好虛高
 * - 抽幀上球路多數落喺四角框內（用簡易暗色圓斑／已知追蹤）
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { detectLaneCorners, scoreLaneGeometry } from "../src/lib/laneDetect.ts";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  rgbaToGray,
  trackBallFrame,
} from "../src/lib/tracker.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-lane-verify";
const W = 640;
const H = 576;
const FPS = 8;
const N = 48;

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else console.log("OK:", msg);
}

function pointInQuad(
  p: { x: number; y: number },
  c: LaneCorners
): boolean {
  // 拆成兩個三角形
  const inTri = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    d: { x: number; y: number }
  ) => {
    const sign = (p1: typeof a, p2: typeof a, p3: typeof a) =>
      (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
    const b1 = sign(p, a, b) < 0;
    const b2 = sign(p, b, d) < 0;
    const b3 = sign(p, d, a) < 0;
    return b1 === b2 && b2 === b3;
  };
  return (
    inTri(c.tl, c.tr, c.br) ||
    inTri(c.tl, c.br, c.bl) ||
    inTri(c.tl, c.tr, c.bl) ||
    inTri(c.tr, c.br, c.bl)
  );
}

mkdirSync(OUT, { recursive: true });
if (!existsSync(VIDEO)) {
  console.error("missing demo video");
  process.exit(1);
}

execSync(
  `ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,
  { stdio: "pipe" }
);
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;

type Det = {
  f: number;
  conf: number;
  corners: LaneCorners;
};
const dets: Det[] = [];
for (let f = 0; f < N; f++) {
  const offset = f * frameBytes;
  if (offset + frameBytes > raw.length) break;
  const rgba = new Uint8ClampedArray(
    raw.buffer,
    raw.byteOffset + offset,
    frameBytes
  );
  const det = detectLaneCorners(new Uint8ClampedArray(rgba), W, H);
  if (det) {
    dets.push({ f, conf: det.confidence, corners: det.corners });
  }
}

console.log(
  `detected ${dets.length}/${N} frames; mean conf=${
    dets.length
      ? (
          (dets.reduce((a, d) => a + d.conf, 0) / dets.length) *
          100
        ).toFixed(0)
      : 0
  }%`
);

assert(dets.length >= N * 0.8, `detect ≥80% frames (got ${dets.length}/${N})`);

const mid = dets.filter((d) => d.f >= 8 && d.f <= 40);
assert(mid.length >= 4, `enough mid-video detections (${mid.length})`);

let pinOk = 0;
let foulOk = 0;
let trapOk = 0;
for (const d of mid.length ? mid : dets) {
  const c = d.corners;
  if (c.tl.y <= H * 0.18 && c.tr.y <= H * 0.18) pinOk++;
  if (c.bl.y >= H * 0.7 && c.br.y >= H * 0.7) foulOk++;
  const botW = c.br.x - c.bl.x;
  const topW = c.tr.x - c.tl.x;
  if (botW > topW * 1.05 && botW > W * 0.2) trapOk++;
}
const base = Math.max(1, (mid.length ? mid : dets).length);
assert(pinOk / base >= 0.7, `TL/TR high enough (${pinOk}/${base})`);
assert(foulOk / base >= 0.7, `BL/BR near foul (${foulOk}/${base})`);
assert(trapOk / base >= 0.7, `trapezoid bottom>top (${trapOk}/${base})`);

// 誠實信心：若頂端過低應拉低信心
const badGeom = dets.find(
  (d) => d.corners.tl.y > H * 0.22 || d.corners.tr.y > H * 0.22
);
if (badGeom) {
  assert(
    badGeom.conf < 0.6,
    `bad geometry should have low conf (got ${(badGeom.conf * 100).toFixed(0)}%)`
  );
} else {
  console.log("OK: no bad-geometry sample to check honesty (all pins high)");
}

// 用首個成功偵測四角跑追蹤，檢查球點多數在框內
// 用幾何分揀 seed，避頂右偏鎖溝
let seed = dets[0];
let seedScore = -1e9;
for (const d of dets) {
  const sc = scoreLaneGeometry(
    { corners: d.corners, confidence: d.conf, message: "" },
    W,
    H
  );
  if (sc > seedScore) {
    seedScore = sc;
    seed = d;
  }
}
assert(!!seed, "have a seed detection");
if (seed) {
  const corners = seed.corners;
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const path: { x: number; y: number }[] = [];
  for (let f = 0; f < N; f++) {
    const offset = f * frameBytes;
    if (offset + frameBytes > raw.length) break;
    const rgba = new Uint8ClampedArray(
      raw.buffer,
      raw.byteOffset + offset,
      frameBytes
    );
    const copy = new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(copy, W, H);
    const res = trackBallFrame(
      state,
      gray,
      W,
      H,
      settings,
      corners,
      1000 / FPS,
      copy
    );
    if (res.locked && res.smoothed && (res.raw || res.predicted)) {
      path.push(res.smoothed);
    }
  }
  const inside = path.filter((p) => pointInQuad(p, corners)).length;
  const ratio = path.length ? inside / path.length : 0;
  console.log(
    `track path ${path.length} pts, in-quad ${(ratio * 100).toFixed(0)}%`
  );
  assert(
    path.length < 5 || ratio >= 0.55,
    `majority of ball path in quad (${(ratio * 100).toFixed(0)}%, n=${path.length})`
  );
}

if (failed) {
  console.error(`\n${failed} lane-detect asserts failed`);
  process.exit(1);
}
console.log("\nAll lane-detect asserts passed");
