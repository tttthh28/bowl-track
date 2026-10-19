/** Try start offsets + native 30fps + no edge reject to find arr~33 path */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners, shouldEndShot,
} from "../src/lib/tracker.ts";
import { detectLaneCorners, snapCornersToTrueGutter, scoreLaneGeometry, frameHasLaneSignal } from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";
import { pickBestCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

const OUT = "/tmp/bowl-live5-30";
const W = 1060, H = 954, FPS = 30, N = 200;
const VIDEO = join(import.meta.dirname, "../test-media/bowling-demo.mp4");
mkdirSync(OUT, { recursive: true });
const rgbaPath = `${OUT}/seq.rgba`;
if (!existsSync(rgbaPath)) {
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${rgbaPath}"`, { stdio: "pipe" });
}
const raw = readFileSync(rgbaPath);
const fb = W * H * 4;
const framesN = Math.floor(raw.length / fb);
const frameAt = (i: number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + Math.min(framesN - 1, i) * fb, fb);

function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const sx = Math.min(W - 1, Math.floor((x / tw) * W));
    const sy = Math.min(H - 1, Math.floor((y / th) * H));
    const si = (sy * W + sx) * 4, di = (y * tw + x) * 4;
    out[di] = rgba[si]; out[di+1]=rgba[si+1]; out[di+2]=rgba[si+2]; out[di+3]=255;
  }
  return out;
}

// corners from mid frame snap
const det = detectLaneCorners(frameAt(40), W, H)!;
const corners = snapCornersToTrueGutter(det.corners, W, H);
console.log("corners mid", ((corners.bl.x+corners.br.x)/2).toFixed(0), "bot", ((corners.br.x-corners.bl.x)/W).toFixed(3));

function run(startF: number, edge: boolean, dups: number, label: string) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER };
  let shotPts: TrackPoint[] = [];
  let saved: TrackPoint[] | null = null;
  for (let f = startF; f < framesN; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    for (let d = 0; d < dups; d++) {
      const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000/FPS, work);
      const pos = res.smoothed ? (scale < 1 ? {x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed) : null;
      const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius/scale : res.radius) : null;
      if (res.locked && pos && (res.raw != null || res.predicted)) {
        const contact = ballContactPoint(pos, rFull);
        const lane = imageToLane(Hm, contact);
        let accept = true;
        if (edge && lane && (lane.board < 2.8 || lane.board > 36.2) && lane.feet < 48) accept = false;
        if (accept) shotPts.push({ image: contact, lane, t: (f-startF)*(1000/FPS), predicted: res.predicted||undefined });
      }
      if (shouldEndShot(state, settings, shotPts.length > 0)) {
        if (!saved && evaluateShotQuality(shotPts).ok) saved = shotPts.slice();
        shotPts = []; state.beginNewShot({ clearBg: true });
      }
    }
  }
  if (!saved && shotPts.length && evaluateShotQuality(shotPts).ok) saved = shotPts;
  if (!saved) { console.log(JSON.stringify({label, arr:null,n:0,q:evaluateShotQuality(shotPts)})); return; }
  const est = computeShotEstimate(saved);
  const boards = saved.filter(p=>p.lane).map(p=>p.lane!.board);
  const med = [...boards].sort((a,b)=>a-b)[Math.floor(boards.length/2)];
  console.log(JSON.stringify({label, arr:est.arrowsBoard, bp:est.breakpointBoard, n:saved.length, med:+med.toFixed(1),
    boards:`${Math.min(...boards).toFixed(1)}-${Math.max(...boards).toFixed(1)}`}));
}

run(0, true, 1, "start0 edge 1x");
run(0, false, 1, "start0 noedge 1x");
run(0, false, 3, "start0 noedge 3x");
run(30, false, 1, "start1s noedge");
run(60, false, 1, "start2s noedge");
run(0, false, 2, "start0 noedge 2x");
// Without contact point — center only
