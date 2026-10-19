/** Sweep corner params to find probe arr≈28.5 med≈20 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";

const VIDEO = "test-media/bowling-demo.mp4";
const OUT = "/tmp/bowl-28";
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
const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });

const hits: any[] = [];
for (const botF of [0.36, 0.38, 0.40, 0.42, 0.44]) {
  for (const midOff of [-40, -20, 0, 20, 40, 60]) {
    for (const pinsY of [0.10, 0.12, 0.14, 0.16]) {
      for (const foulY of [0.80, 0.84, 0.88]) {
        const midB = (c0.bl.x + c0.br.x) / 2 + midOff;
        const midT = midB; // aligned
        const half = (botF * W) / 2;
        const topF = Math.min(0.14, Math.max(0.09, botF * 0.28));
        const halfT = (topF * W) / 2;
        const c = {
          bl: { x: midB - half, y: foulY * H },
          br: { x: midB + half, y: foulY * H },
          tl: { x: midT - halfT, y: pinsY * H },
          tr: { x: midT + halfT, y: pinsY * H },
        };
        const d = scoreCornersByProbe(c, probeFrames, { geomRank: 100 });
        if (d.arrows != null && d.arrows >= 26 && d.arrows <= 31) {
          hits.push({ botF, midOff, pinsY, foulY, arr: d.arrows, med: d.med, locks: d.locks, ft: [d.minFeet, d.maxFeet] });
        }
      }
    }
  }
}
console.log("hits near 28.5:", hits.length);
hits.sort((a,b) => Math.abs(a.arr-28.5) - Math.abs(b.arr-28.5));
console.log(hits.slice(0, 15));

// Also: current corners but ONLY contact — already 13.8
// What if foul vote shifts Y after pick?
const voted = { ...c0, bl: { ...c0.bl, y: c0.bl.y + 20 }, br: { ...c0.br, y: c0.br.y + 20 } };
const dv = scoreCornersByProbe(voted, probeFrames, { geomRank: 170 });
console.log("foul+20px probe", { arr: dv.arrows, med: dv.med });

// Shorter probe buffer like UI might get fewer frames if seeks fail
const shortProbe = [];
for (let f = 5; f < 25; f++) shortProbe.push({ rgba: frameAt(f), width: W, height: H });
const ds = scoreCornersByProbe(c0, shortProbe, { geomRank: 170 });
console.log("short 20-frame probe current", { arr: ds.arrows, med: ds.med, locks: ds.locks });

// Simulate Workbench: foul vote on result AFTER geom rank, then probe uses UNMODIFIED ranked
// But what if probe fails frames.length < 20 and uses geom result WITH foul vote?
const afterVote = { ...c0 }; // assume vote changes little
console.log("baseline", { arr: scoreCornersByProbe(c0, probeFrames, { geomRank: 170 }).arrows });

// Contact vs no-contact on CURRENT corners full track already known 13.8 both

// Check: fi=21 corners with selectClosestEdges disabled — need code flag
// Instead mutate: use pre-P2 by checking git stash... compare detect at HEAD vs working
