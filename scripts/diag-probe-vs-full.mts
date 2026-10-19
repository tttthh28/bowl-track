/** Why probe arr≠full arr at bot=0.42 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";

const VIDEO = "test-media/bowling-demo.mp4";
const OUT = "/tmp/bowl-pvf";
const W = 1060, H = 954, FPS = 15, N = 120;
mkdirSync(OUT, { recursive: true });
execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, { stdio: "pipe" });
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;
function frameAt(fi: number) {
  const u8 = new Uint8ClampedArray(frameBytes);
  u8.set(raw.subarray(fi * frameBytes, (fi + 1) * frameBytes));
  return u8;
}
function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(H - 1, Math.floor((y / th) * H));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(W - 1, Math.floor((x / tw) * W));
      const si = (sy * W + sx) * 4, di = (y * tw + x) * 4;
      out[di] = rgba[si]; out[di+1] = rgba[si+1]; out[di+2] = rgba[si+2]; out[di+3] = 255;
    }
  }
  return out;
}

const det = detectLaneCorners(frameAt(21), W, H)!;
const c0 = det.corners;
const midB = (c0.bl.x + c0.br.x) / 2;
const midT = (c0.tl.x + c0.tr.x) / 2;
const half = (0.42 * W) / 2;
const halfT = (0.12 * W) / 2;
const corners = {
  bl: { x: midB - half, y: c0.bl.y },
  br: { x: midB + half, y: c0.br.y },
  tl: { x: midT - halfT, y: c0.tl.y },
  tr: { x: midT + halfT, y: c0.tr.y },
};

// Full track all points boards/feet
const Hm = buildHomography(corners)!;
const { scale, tw, th } = trackWorkSize(W, H);
const workC = scaleLaneCorners(corners, scale);
const state = new BallTrackerState();
const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
const pts: any[] = [];
for (let f = 0; f < N; f++) {
  const rgba = frameAt(f);
  const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
  const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
  const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000 / FPS, work);
  const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed) : null;
  if (res.locked && pos && (res.raw != null || res.predicted)) {
    const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;
    const contact = ballContactPoint(pos, rFull);
    const lane = imageToLane(Hm, contact);
    pts.push({ f, board: lane.board, feet: lane.feet, pred: !!res.predicted, r: rFull, cx: contact.x, cy: contact.y, px: pos.x, py: pos.y });
  }
}
console.log("n pts", pts.length);
console.log("first 15:", pts.slice(0, 15).map(p => `f${p.f} b=${p.board.toFixed(1)} ft=${p.feet.toFixed(1)}${p.pred?"P":""}`).join(" | "));
console.log("around arrows (12-20ft):", pts.filter(p => p.feet >= 12 && p.feet <= 20).map(p => `f${p.f} b=${p.board.toFixed(1)} ft=${p.feet.toFixed(1)}`).join(" | "));
console.log("deep 25-40:", pts.filter(p => p.feet >= 25 && p.feet <= 40).map(p => `f${p.f} b=${p.board.toFixed(1)} ft=${p.feet.toFixed(1)}`).join(" | "));
const est = computeShotEstimate(pts.map(p => ({ image: { x: p.cx, y: p.cy }, lane: { board: p.board, feet: p.feet }, t: p.f * (1000/FPS), predicted: p.pred || undefined })) as any);
console.log("est", { arrows: est.arrowsBoard, bp: est.breakpointBoard, bpFt: est.breakpointDistance, cov: [est.coverageFeetMin, est.coverageFeetMax], avg: est.averageBoard });

// Compare WITHOUT contact point
const state2 = new BallTrackerState();
const pts2: any[] = [];
for (let f = 0; f < N; f++) {
  const rgba = frameAt(f);
  const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
  const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
  const res = trackBallFrame(state2, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000 / FPS, work);
  const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed) : null;
  if (res.locked && pos && (res.raw != null || res.predicted)) {
    const lane = imageToLane(Hm, pos);
    pts2.push({ image: pos, lane, t: f * (1000/FPS), predicted: res.predicted || undefined });
  }
}
const est2 = computeShotEstimate(pts2 as any);
console.log("NO contact arr", est2.arrowsBoard, "med-ish", est2.averageBoard, "cov", est2.coverageFeetMin, est2.coverageFeetMax);

// probe detail
const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });
const d = scoreCornersByProbe(corners, probeFrames, { geomRank: 100 });
console.log("probe", d);

// current narrow corners for comparison
const d0 = scoreCornersByProbe(c0, probeFrames, { geomRank: 100 });
console.log("probe current", { arr: d0.arrows, med: d0.med });
const Hm0 = buildHomography(c0)!;
const state3 = new BallTrackerState();
const pts3: any[] = [];
const workC0 = scaleLaneCorners(c0, scale);
for (let f = 0; f < N; f++) {
  const rgba = frameAt(f);
  const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
  const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
  const res = trackBallFrame(state3, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC0 : c0, 1000 / FPS, work);
  const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed) : null;
  if (res.locked && pos && (res.raw != null || res.predicted)) {
    const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;
    const contact = ballContactPoint(pos, rFull);
    const lane = imageToLane(Hm0, contact);
    pts3.push({ image: contact, lane, t: f * (1000/FPS), predicted: res.predicted || undefined });
  }
}
const est3 = computeShotEstimate(pts3 as any);
console.log("full current", { arr: est3.arrowsBoard, n: pts3.length, around15: pts3.filter((p:any)=>p.lane.feet>=12&&p.lane.feet<=18).map((p:any)=>p.lane.board.toFixed(1)) });
