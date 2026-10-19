/**
 * Prove: processing each video frame N times (RAF>fps) → arr~33 gutter lock.
 * With skip-dup (1 step per frame) → arr~14.
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
import { pickBestCornersByProbe } from "../src/lib/laneProbe.ts";
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
const framesN = Math.floor(raw.length / fb);
const dur = framesN / FPS;
const frameAt = (i: number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + Math.min(framesN - 1, i) * fb, fb);
const fiAt = (t: number) => Math.min(framesN - 1, Math.max(0, Math.round(t * FPS)));

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

function detect() {
  const tryTimes = [0.08, 0.35, 0.8, 1.4, dur * 0.28, dur * 0.42, dur * 0.58, dur * 0.72, dur * 0.85];
  const detCands: { det: NonNullable<ReturnType<typeof detectLaneCorners>>; geom: number }[] = [];
  for (const tSeek of tryTimes) {
    const rgba = frameAt(fiAt(tSeek));
    if (!frameHasLaneSignal(rgba, W, H)) continue;
    const next = detectLaneCorners(rgba, W, H);
    if (next) detCands.push({ det: next, geom: scoreLaneGeometry(next, W, H) });
  }
  const ranked = detCands.map((c) => ({ ...c, rank: c.geom })).sort((a, b) => b.rank - a.rank);
  const frames = [];
  for (let i = 0; i < 60; i++) {
    const rgba = frameAt(fiAt(Math.min(dur - 0.06, 0.2 + i / 15)));
    if (frameHasLaneSignal(rgba, W, H)) frames.push({ rgba, width: W, height: H });
  }
  const picked = pickBestCornersByProbe(ranked.map((c) => ({ det: c.det, geomRank: c.rank })), frames, 10);
  let corners = picked?.det.corners ?? ranked[0]?.det.corners;
  if (!corners) throw new Error("no corners");
  corners = snapCornersToTrueGutter(corners, W, H);
  return { corners, probeArr: picked?.detail.arrows ?? null };
}

function run(corners: LaneCorners, dupsPerFrame: number, label: string) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER };
  let shotPts: TrackPoint[] = [];
  let saved: TrackPoint[] | null = null;
  let tShot0 = 0;
  for (let f = 0; f < framesN; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    for (let d = 0; d < dupsPerFrame; d++) {
      const res = trackBallFrame(
        state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings,
        scale < 1 ? workC : corners, 1000 / FPS / Math.max(1, dupsPerFrame), work
      );
      const pos = res.smoothed
        ? scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed
        : null;
      const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;
      if (res.locked && pos && (res.raw != null || res.predicted)) {
        if (shotPts.length === 0 && !res.predicted) tShot0 = f * (1000 / FPS);
        if (shotPts.length > 0 || !res.predicted) {
          const t = f * (1000 / FPS) - tShot0;
          const contact = ballContactPoint(pos, rFull);
          const lane = imageToLane(Hm, contact);
          let accept = true;
          if (lane) {
            if ((lane.board < 2.8 || lane.board > 36.2) && lane.feet < 48) accept = false;
          }
          if (accept && shotPts.length > 0 && lane && !res.predicted) {
            const prev = shotPts[shotPts.length - 1];
            if (prev.lane) {
              const dFeet = lane.feet - prev.lane.feet;
              const dBoard = Math.abs(lane.board - prev.lane.board);
              if (dFeet < -0.8 || (dBoard > 3.5 && dFeet < 1.0)) accept = false;
            }
          }
          if (accept) {
            shotPts.push({ image: contact, lane, t, predicted: res.predicted || undefined });
          }
        }
      }
      if (shouldEndShot(state, settings, shotPts.length > 0)) {
        if (!saved && evaluateShotQuality(shotPts).ok) saved = shotPts.slice();
        shotPts = [];
        state.beginNewShot({ clearBg: true });
      } else if (!res.locked && shotPts.length > 0) {
        shotPts = [];
        state.beginNewShot({ clearBg: true });
      }
    }
  }
  if (!saved && shotPts.length > 0 && evaluateShotQuality(shotPts).ok) saved = shotPts;
  if (!saved) {
    console.log(JSON.stringify({ label, dupsPerFrame, arr: null, n: 0 }));
    return;
  }
  const boards = saved.filter((p) => p.lane).map((p) => p.lane!.board);
  const feet = saved.filter((p) => p.lane).map((p) => p.lane!.feet);
  const est = computeShotEstimate(saved);
  const med = [...boards].sort((a,b)=>a-b)[Math.floor(boards.length/2)];
  console.log(JSON.stringify({
    label, dupsPerFrame,
    arr: est.arrowsBoard, bp: est.breakpointBoard, bpd: est.breakpointDistance,
    n: saved.length, medBoard: +med.toFixed(1),
    boards: `${Math.min(...boards).toFixed(1)}–${Math.max(...boards).toFixed(1)}`,
    ft: `${Math.min(...feet).toFixed(1)}–${Math.max(...feet).toFixed(1)}`,
  }));
}

const d = detect();
console.log("probe", d.probeArr, "mid", ((d.corners.bl.x+d.corners.br.x)/2).toFixed(0));
run(d.corners, 1, "1x (script-like)");
run(d.corners, 3, "3x RAF dup (browser-like)");
run(d.corners, 4, "4x RAF dup");
