/** Coarse sweep: mid×bot at fixed pins/foul/top — full+probe arr + gutter error */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const OUT = "/tmp/bowl-live5";
const W = 1060, H = 954, FPS = 15, N = 120;
mkdirSync(OUT, { recursive: true });
const VIDEO = join(import.meta.dirname, "../test-media/bowling-demo.mp4");
if (!existsSync(`${OUT}/seq.rgba`)) {
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, { stdio: "pipe" });
}
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W * H * 4;
const frameAt = (i: number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + i * fb, fb);
function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const sx = Math.min(W - 1, Math.floor((x / tw) * W));
    const sy = Math.min(H - 1, Math.floor((y / th) * H));
    const si = (sy * W + sx) * 4, di = (y * tw + x) * 4;
    out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
  }
  return out;
}
const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
function fullTrack(corners: LaneCorners) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
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
      let accept = true;
      if (!res.predicted && (lane.board < 1.2 || lane.board > 37.8) && lane.feet < 45) accept = false;
      if (accept && (pts.length > 0 || !res.predicted)) pts.push({ image: contact, lane, t: f * (1000 / FPS), predicted: res.predicted || undefined });
    }
  }
  return computeShotEstimate(pts);
}
const probeFrames = [];
for (let i = 0; i < N; i += 2) probeFrames.push({ rgba: frameAt(i), width: W, height: H });

const TRUE_L = 208, TRUE_R = 802;
const pinsY = 0.11, foulY = 0.84, topF = 0.16;
const mids = [448, 460, 475, 490, 505, 520];
const bots = [0.50, 0.52, 0.54, 0.56, 0.58];

console.log("mid bot arr probe med bl br gErr(L+R) pocket?bp");
for (const mid of mids) {
  for (const bot of bots) {
    const half = (bot * W) / 2;
    const topHalf = (topF * W) / 2;
    const c: LaneCorners = {
      bl: { x: mid - half, y: foulY * H },
      br: { x: mid + half, y: foulY * H },
      tl: { x: mid - topHalf, y: pinsY * H },
      tr: { x: mid + topHalf, y: pinsY * H },
    };
    const est = fullTrack(c);
    const d = scoreCornersByProbe(c, probeFrames);
    const gErr = Math.abs(mid - half - TRUE_L) + Math.abs(mid + half - TRUE_R);
    const tonyA = est.arrowsBoard != null && est.arrowsBoard >= 12.5 && est.arrowsBoard <= 15.5;
    const tonyP = d.arrows != null && d.arrows >= 12.5 && d.arrows <= 15.5;
    const mark = tonyA && tonyP ? "★" : tonyA || tonyP ? "·" : " ";
    console.log(
      `${mark} mid=${mid} bot=${bot.toFixed(2)} arr=${est.arrowsBoard ?? "—"} probe=${d.arrows ?? "—"} med=${d.med?.toFixed(0) ?? "—"} ` +
      `bl=${(mid-half).toFixed(0)} br=${(mid+half).toFixed(0)} gErr=${gErr.toFixed(0)} ` +
      `bp=${est.breakpointBoard?.toFixed(1) ?? "—"}@${est.breakpointDistance ?? "—"} pocket=${est.pocketBoard?.toFixed(1) ?? "—"}`
    );
  }
}
