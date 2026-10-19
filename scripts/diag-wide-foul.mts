/** If we expand foul corners to true gutters (~0.56), do arrows stay ~13–14? */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { detectLaneCorners, scoreLaneGeometry } from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { pickBestCornersByProbe, scoreCornersByProbe } from "../src/lib/laneProbe.ts";

const VIDEO = "test-media/bowling-demo.mp4";
const OUT = "/tmp/bowl-wide";
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
function fullTrack(corners: any) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const pts: any[] = [];
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
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
      if (pts.length > 0 || !res.predicted) pts.push({ image: contact, lane, t: f * (1000 / FPS), predicted: res.predicted || undefined });
    }
  }
  return { pts, est: computeShotEstimate(pts) };
}

const det = detectLaneCorners(frameAt(21), W, H)!;
const c0 = det.corners;
const midB = (c0.bl.x + c0.br.x) / 2;
const midT = (c0.tl.x + c0.tr.x) / 2;

const variants: { name: string; c: typeof c0 }[] = [
  { name: "current", c: c0 },
];
for (const botF of [0.42, 0.46, 0.50, 0.54, 0.56]) {
  const half = (botF * W) / 2;
  // keep midBot, expand bot; expand top proportionally a bit
  const topF = Math.max(0.106, botF * 0.28);
  const halfT = (topF * W) / 2;
  variants.push({
    name: `bot${botF}`,
    c: {
      bl: { x: midB - half, y: c0.bl.y },
      br: { x: midB + half, y: c0.br.y },
      tl: { x: midT - halfT, y: Math.min(c0.tl.y, H * 0.11) },
      tr: { x: midT + halfT, y: Math.min(c0.tr.y, H * 0.11) },
    },
  });
}
// also: expand bot + lower pinsY (higher on screen = smaller y)
variants.push({
  name: "bot0.52+pins0.10",
  c: {
    bl: { x: midB - 0.26 * W, y: c0.bl.y },
    br: { x: midB + 0.26 * W, y: c0.br.y },
    tl: { x: midT - 0.07 * W, y: H * 0.10 },
    tr: { x: midT + 0.07 * W, y: H * 0.10 },
  },
});
// foul lower (higher yFrac)
variants.push({
  name: "bot0.52+foul0.90",
  c: {
    bl: { x: midB - 0.26 * W, y: H * 0.90 },
    br: { x: midB + 0.26 * W, y: H * 0.90 },
    tl: { x: midT - 0.06 * W, y: c0.tl.y },
    tr: { x: midT + 0.06 * W, y: c0.tr.y },
  },
});

const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });

for (const v of variants) {
  const d = scoreCornersByProbe(v.c, probeFrames, { geomRank: 100 });
  const { est, pts } = fullTrack(v.c);
  console.log(
    `${v.name}: bot=${((v.c.br.x-v.c.bl.x)/W).toFixed(3)} pinsY=${(v.c.tl.y/H).toFixed(3)} foulY=${(v.c.bl.y/H).toFixed(3)} ` +
    `probe arr=${d.arrows?.toFixed(1)??"—"} med=${d.med?.toFixed(1)??"—"} locks=${d.locks} | ` +
    `full arr=${est.arrowsBoard??"—"} bp=${est.breakpointBoard?.toFixed(1)??"—"}@${est.breakpointDistance??"—"} n=${pts.length} cov=${est.coverageFeetMin}–${est.coverageFeetMax}`
  );
}
