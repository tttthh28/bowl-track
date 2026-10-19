/**
 * Same snapped corners: probe estimate vs Workbench-live track (DEFAULT settings,
 * jump/edge filters, shouldEndShot → finishShot estimate).
 */
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
import { pickBestCornersByProbe, scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

const OUT = "/tmp/bowl-live5";
const W = 1060, H = 954, FPS = 15, N = 120;
const VIDEO = join(import.meta.dirname, "../test-media/bowling-demo.mp4");
mkdirSync(OUT, { recursive: true });
if (!existsSync(`${OUT}/seq.rgba`)) {
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, { stdio: "pipe" });
}
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W * H * 4;
const frameAt = (i: number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + Math.min(N - 1, i) * fb, fb);

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

function getCorners(): LaneCorners {
  const cands = [];
  for (const fi of [1, 5, 12, 21, 36, 48, 60, 75, 90]) {
    const rgba = frameAt(fi);
    if (!frameHasLaneSignal(rgba, W, H)) continue;
    const det = detectLaneCorners(rgba, W, H);
    if (det) cands.push({ det, geomRank: scoreLaneGeometry(det, W, H) });
  }
  const frames = [];
  for (let i = 0; i < N; i += 2) frames.push({ rgba: frameAt(i), width: W, height: H });
  const picked = pickBestCornersByProbe(cands, frames, 10);
  const c = snapCornersToTrueGutter((picked?.det ?? cands[0].det).corners, W, H);
  return c;
}

function summarize(label: string, pts: TrackPoint[]) {
  const est = computeShotEstimate(pts as any);
  const q = evaluateShotQuality(pts);
  const boards = pts.filter((p) => p.lane).map((p) => p.lane!.board);
  const feet = pts.filter((p) => p.lane).map((p) => p.lane!.feet);
  const med = boards.length ? [...boards].sort((a, b) => a - b)[Math.floor(boards.length / 2)] : null;
  console.log(label, {
    n: pts.length,
    arr: est.arrowsBoard,
    bp: est.breakpointBoard != null ? `${est.breakpointBoard.toFixed(1)}@${est.breakpointDistance}` : "—",
    avg: est.averageBoard?.toFixed?.(1) ?? est.averageBoard,
    med: med?.toFixed(1),
    ft: feet.length ? `${Math.min(...feet).toFixed(1)}–${Math.max(...feet).toFixed(1)}` : "—",
    boardRange: boards.length ? `${Math.min(...boards).toFixed(1)}–${Math.max(...boards).toFixed(1)}` : "—",
    q: q.ok,
    qReason: q.reason,
  });
  return est;
}

const corners = getCorners();
console.log("corners", {
  bot: ((corners.br.x - corners.bl.x) / W).toFixed(3),
  mid: ((corners.bl.x + corners.br.x) / 2).toFixed(0),
  bl: corners.bl.x.toFixed(0), br: corners.br.x.toFixed(0),
});

const probeFrames = [];
for (let i = 0; i < N; i++) probeFrames.push({ rgba: frameAt(i), width: W, height: H });
const probeDetail = scoreCornersByProbe(corners, probeFrames);
console.log("probeDetail", { arr: probeDetail.arrows, med: probeDetail.med?.toFixed(1), ft: `${probeDetail.minFeet.toFixed(1)}–${probeDetail.maxFeet.toFixed(1)}`, locks: probeDetail.locks });

// A) probe-like: sens26, no jump filter, no shouldEnd, contact image
function trackVariant(opts: {
  sens: number; minBlob: number; jumpFilter: boolean; edgeBoard: number; endShot: boolean; label: string;
}) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: opts.sens, minBlobPixels: opts.minBlob };
  const pts: TrackPoint[] = [];
  let shotPts: TrackPoint[] = [];
  let saved: TrackPoint[] | null = null;
  let t0 = 0;
  for (let f = 0; f < N; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000 / FPS, work);
    const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed) : null;
    const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      if (shotPts.length === 0 && !res.predicted) t0 = f * (1000 / FPS);
      if (shotPts.length > 0 || !res.predicted) {
        const t = f * (1000 / FPS) - t0;
        const contact = ballContactPoint(pos, rFull);
        const lane = imageToLane(Hm, contact);
        let accept = true;
        if (lane && !res.predicted) {
          if ((lane.board < opts.edgeBoard || lane.board > 39 - opts.edgeBoard) && lane.feet < 45) accept = false;
        }
        if (opts.jumpFilter && accept && shotPts.length > 0 && lane && !res.predicted) {
          const prev = shotPts[shotPts.length - 1];
          if (prev.lane) {
            const dFeet = Math.abs(lane.feet - prev.lane.feet);
            const dBoard = Math.abs(lane.board - prev.lane.board);
            const dtPt = Math.max(1, t - prev.t) / 1000;
            if (dFeet / dtPt > 80 || dBoard > 10) accept = false;
          }
        }
        if (accept) {
          const tp: TrackPoint = { image: contact, lane, t, predicted: res.predicted || undefined };
          shotPts.push(tp);
          pts.push(tp);
        }
      }
    }
    if (opts.endShot && shouldEndShot(state, settings, shotPts.length > 0)) {
      if (!saved && evaluateShotQuality(shotPts).ok) saved = shotPts.slice();
      shotPts = [];
      state.beginNewShot();
    } else if (opts.endShot && !res.locked && shotPts.length > 0) {
      if (!saved && evaluateShotQuality(shotPts).ok) saved = shotPts.slice();
      shotPts = [];
      state.beginNewShot();
    }
  }
  if (!saved && shotPts.length > 0 && evaluateShotQuality(shotPts).ok) saved = shotPts;
  summarize(opts.label + " FULL", pts);
  if (saved) summarize(opts.label + " SAVED", saved);
  else console.log(opts.label + " SAVED", { none: true, lastN: shotPts.length });
}

trackVariant({ sens: 26, minBlob: 28, jumpFilter: false, edgeBoard: 1.5, endShot: false, label: "PROBE-LIKE" });
trackVariant({ sens: 28, minBlob: 35, jumpFilter: true, edgeBoard: 1.2, endShot: true, label: "LIVE-WB" });
trackVariant({ sens: 26, minBlob: 28, jumpFilter: true, edgeBoard: 1.2, endShot: true, label: "LIVE-sens26" });
trackVariant({ sens: 26, minBlob: 28, jumpFilter: false, edgeBoard: 1.2, endShot: true, label: "LIVE-noJump" });
trackVariant({ sens: 26, minBlob: 28, jumpFilter: true, edgeBoard: 0.5, endShot: true, label: "LIVE-softEdge" });
