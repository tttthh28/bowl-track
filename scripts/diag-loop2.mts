import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners, shouldEndShot,
} from "../src/lib/tracker.ts";
import {
  detectLaneCorners, snapCornersToTrueGutter, scoreLaneGeometry, frameHasLaneSignal,
} from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";
import { pickBestCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

const OUT = "/tmp/bowl-live5";
const W = 1060, H = 954, FPS = 15, N = 120;
const VIDEO2 = join(import.meta.dirname, "../test-media/bowling-demo.mp4");
mkdirSync(OUT, { recursive: true });
if (!existsSync(`${OUT}/seq.rgba`)) {
  execSync(`ffmpeg -y -i "${VIDEO2}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, { stdio: "pipe" });
}
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W * H * 4;
const framesN = Math.floor(raw.length / fb);
const frameAt = (i: number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + Math.min(framesN - 1, i) * fb, fb);

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

// quick corners from existing detect path via snap of detect on mid frame
const rgba0 = frameAt(30);
const det = detectLaneCorners(rgba0, W, H)!;
const corners = snapCornersToTrueGutter(det.corners, W, H);
console.log("mid", ((corners.bl.x+corners.br.x)/2).toFixed(0), "foul", (((corners.bl.y+corners.br.y)/2)/H).toFixed(3));

const Hm = buildHomography(corners)!;
const { scale, tw, th } = trackWorkSize(W, H);
const workC = scaleLaneCorners(corners, scale);
const state = new BallTrackerState();
const settings = { ...DEFAULT_TRACKER };

for (let loop = 0; loop < 3; loop++) {
  let shotPts: TrackPoint[] = [];
  let lockedN = 0, acceptN = 0, endAt = -1, unlockAt = -1;
  let maxBoard = -1, minBoard = 99, maxFt = -1;
  for (let f = 0; f < framesN; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000/FPS, work);
    if (res.locked) lockedN++;
    const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x/scale, y: res.smoothed.y/scale } : res.smoothed) : null;
    const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius/scale : res.radius) : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      const contact = ballContactPoint(pos, rFull);
      const lane = imageToLane(Hm, contact);
      let accept = true;
      if (lane && !res.predicted) {
        if ((lane.board < 2.8 || lane.board > 36.2) && lane.feet < 48) accept = false;
      }
      if (accept && lane) {
        acceptN++;
        shotPts.push({ image: contact, lane, t: f * (1000/FPS), predicted: res.predicted || undefined });
        maxBoard = Math.max(maxBoard, lane.board);
        minBoard = Math.min(minBoard, lane.board);
        maxFt = Math.max(maxFt, lane.feet);
      }
    }
    if (shouldEndShot(state, settings, shotPts.length > 0) && endAt < 0) endAt = f;
    if (!res.locked && shotPts.length > 0 && unlockAt < 0) unlockAt = f;
  }
  console.log({ loop, lockedN, acceptN, endAt, unlockAt, nPts: shotPts.length, q: evaluateShotQuality(shotPts), boards: `${minBoard.toFixed(1)}-${maxBoard.toFixed(1)}`, maxFt: maxFt.toFixed(1), locked: state.locked, lost: state.lost });
  state.beginNewShot();
}
