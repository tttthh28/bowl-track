/** Sweep mid×botFrac×topFrac → full-track arr (Workbench contact path) */
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

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-live5";
const W = 1060, H = 954, FPS = 15, N = 120;
mkdirSync(OUT, { recursive: true });
if (!existsSync(`${OUT}/seq.rgba`)) {
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, { stdio: "pipe" });
}
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W*H*4;
const frameAt = (i: number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + i*fb, fb);

function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw*th*4);
  for (let y=0;y<th;y++) for (let x=0;x<tw;x++) {
    const sx=Math.min(W-1,Math.floor(x/tw*W)), sy=Math.min(H-1,Math.floor(y/th*H));
    const si=(sy*W+sx)*4, di=(y*tw+x)*4;
    out[di]=rgba[si]; out[di+1]=rgba[si+1]; out[di+2]=rgba[si+2]; out[di+3]=255;
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
    const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000/FPS, work);
    const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x/scale, y: res.smoothed.y/scale } : res.smoothed) : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius/scale : res.radius) : null;
      const contact = ballContactPoint(pos, rFull);
      const lane = imageToLane(Hm, contact);
      let accept = true;
      if (!res.predicted && (lane.board < 1.2 || lane.board > 37.8) && lane.feet < 45) accept = false;
      if (accept && (pts.length > 0 || !res.predicted)) {
        pts.push({ image: contact, lane, t: f*(1000/FPS), predicted: res.predicted || undefined });
      }
    }
  }
  return { pts, est: computeShotEstimate(pts) };
}

const probeFrames = [];
for (let i=0;i<N;i+=2) probeFrames.push({ rgba: frameAt(i), width: W, height: H });

// True gutters at foul: L=208 R=802 mid=505 bot=0.56
// Sweep around visual truth + arr-known sweet spots
const mids = [448, 470, 490, 505, 520];
const bots = [0.50, 0.52, 0.54, 0.56, 0.58];
const topFs = [0.14, 0.16, 0.18];
const pinsYs = [0.10, 0.11, 0.12];
const foulYs = [0.84, 0.86, 0.88];

type Row = { mid:number; bot:number; topF:number; pinsY:number; foulY:number; arr:number|null; probe:number|null; med:number|null; bl:number; br:number; gutterErr:number };
const hits: Row[] = [];

for (const mid of mids) {
  for (const bot of bots) {
    for (const topF of topFs) {
      for (const pinsY of pinsYs) {
        for (const foulY of foulYs) {
          const half = (bot * W) / 2;
          const topHalf = (topF * W) / 2;
          const c: LaneCorners = {
            bl: { x: mid - half, y: foulY * H },
            br: { x: mid + half, y: foulY * H },
            tl: { x: mid - topHalf, y: pinsY * H },
            tr: { x: mid + topHalf, y: pinsY * H },
          };
          const { est } = fullTrack(c);
          const detail = scoreCornersByProbe(c, probeFrames);
          const gutterErr = Math.abs((mid - half) - 208) + Math.abs((mid + half) - 802);
          const row: Row = {
            mid, bot, topF, pinsY, foulY,
            arr: est.arrowsBoard, probe: detail.arrows, med: detail.med,
            bl: mid-half, br: mid+half, gutterErr,
          };
          const tony = (a:number|null) => a!=null && a>=12.5 && a<=15.5;
          if (tony(row.arr) && tony(row.probe)) hits.push(row);
        }
      }
    }
  }
}

hits.sort((a,b) => a.gutterErr - b.gutterErr);
console.log("Tony dual hits (arr+probe 13-15), best visual first:");
for (const h of hits.slice(0, 25)) {
  console.log(
    `mid=${h.mid} bot=${h.bot} top=${h.topF} pins=${h.pinsY} foul=${h.foulY} ` +
    `arr=${h.arr} probe=${h.probe} med=${h.med?.toFixed(1)} ` +
    `bl=${h.bl.toFixed(0)} br=${h.br.toFixed(0)} gErr=${h.gutterErr.toFixed(0)}`
  );
}
console.log(`\ntotal dual hits: ${hits.length}`);
// Also show best visual even if arr only on one side
