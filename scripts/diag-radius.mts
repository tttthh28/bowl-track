import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import {
  BallTrackerState, DEFAULT_TRACKER, rgbaToGray, trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";

const VIDEO = "test-media/bowling-demo.mp4";
const OUT = "/tmp/bowl-r";
const W = 1060, H = 954, FPS = 15, N = 80;
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
const corners = detectLaneCorners(frameAt(21), W, H)!.corners;
const { scale, tw, th } = trackWorkSize(W, H);
const workC = scaleLaneCorners(corners, scale);
const state = new BallTrackerState();
const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
const rs: number[] = [];
for (let f = 0; f < N; f++) {
  const rgba = frameAt(f);
  const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
  const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
  const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000 / FPS, work);
  if (res.locked && res.radius) {
    const rFull = scale < 1 ? res.radius / scale : res.radius;
    rs.push(rFull);
    if (rs.length <= 12) console.log(`f${f} rWork=${res.radius.toFixed(1)} rFull=${rFull.toFixed(1)} y=${res.smoothed?.y.toFixed(0)}`);
  }
}
rs.sort((a,b)=>a-b);
console.log("radius full px: n", rs.length, "med", rs[Math.floor(rs.length/2)]?.toFixed(1), "min", rs[0]?.toFixed(1), "max", rs[rs.length-1]?.toFixed(1), "scale", scale);
