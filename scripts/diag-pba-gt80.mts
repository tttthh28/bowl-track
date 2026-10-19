/**
 * PBA manual-corners offline vs GT (≥80% speed/arr/bp).
 * Uses computeShotEstimate(..., { boardFromRight: true }) + DEFAULT tracker.
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners, shouldEndShot,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

function ensure(out: string, video: string, n: number) {
  mkdirSync(out, { recursive: true });
  const rgba = `${out}/seq.rgba`;
  if (!existsSync(rgba)) {
    execSync(
      `ffmpeg -y -i "${video}" -vf "fps=30,scale=1280:720" -frames:v ${n} -f rawvideo -pix_fmt rgba "${rgba}"`,
      { stdio: "pipe" }
    );
  }
  return rgba;
}

function trackSaved(corners: LaneCorners, rgbaPath: string): TrackPoint[] {
  const W = 1280, H = 720, FPS = 30;
  const raw = readFileSync(rgbaPath);
  const fb = W * H * 4;
  const nFrames = Math.floor(raw.length / fb);
  const frameAt = (i: number) =>
    new Uint8ClampedArray(raw.buffer, raw.byteOffset + Math.min(nFrames - 1, i) * fb, fb);
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
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, boardFromRight: true };
  let shot: TrackPoint[] = [];
  let saved: TrackPoint[] | null = null;
  let t0 = 0;
  for (let f = 0; f < nFrames; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const res = trackBallFrame(
      state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings,
      scale < 1 ? workC : corners, 1000 / FPS, work
    );
    const pos = res.smoothed
      ? scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed
      : null;
    const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      if (shot.length === 0 && !res.predicted) t0 = f * (1000 / FPS);
      if (shot.length > 0 || !res.predicted) {
        const t = f * (1000 / FPS) - t0;
        const contact = ballContactPoint(pos, rFull);
        const lane = imageToLane(Hm, contact);
        let accept = true;
        if (lane && !res.predicted) {
          if ((lane.board < 0.5 || lane.board > 38.5) && lane.feet < 50) accept = false;
          if (accept && shot.length > 0) {
            const prev = shot[shot.length - 1];
            if (prev.lane) {
              const dFeet = lane.feet - prev.lane.feet;
              const dBoard = Math.abs(lane.board - prev.lane.board);
              if (dFeet < -0.8 || dBoard > 3.5) accept = false;
            }
          }
        }
        if (accept && lane) {
          shot.push({ image: contact, lane, t, predicted: res.predicted || undefined });
        }
      }
    }
    if (shouldEndShot(state, settings, shot.length > 0)) {
      if (!saved && evaluateShotQuality(shot).ok) saved = shot.slice();
      shot = [];
      state.beginNewShot();
    } else if (!res.locked && shot.length > 0) {
      if (!saved && evaluateShotQuality(shot).ok) saved = shot.slice();
      shot = [];
      state.beginNewShot();
    }
  }
  if (!saved && shot.length && evaluateShotQuality(shot).ok) saved = shot;
  return saved ?? shot;
}

function score(name: string, pts: TrackPoint[], gt: { speed: number; arr: number; bp: number }) {
  const est = computeShotEstimate(pts, null, { boardFromRight: true });
  const pass = (g: number | null | undefined, t: number, tol: number) =>
    g != null && Math.abs(g - t) <= tol;
  const feet = pts.filter((p) => p.lane).map((p) => p.lane!.feet);
  const row = {
    name,
    n: pts.length,
    ft: feet.length ? `${Math.min(...feet).toFixed(1)}–${Math.max(...feet).toFixed(1)}` : "—",
    avg: est.avgSpeedMph,
    arr: est.arrowsBoard,
    bp: est.breakpointBoard,
    bpd: est.breakpointDistance,
    gt,
    ok: {
      speed: pass(est.avgSpeedMph, gt.speed, 3),
      arr: pass(est.arrowsBoard, gt.arr, 2),
      bp: pass(est.breakpointBoard, gt.bp, 2),
    },
  };
  const nOk = Object.values(row.ok).filter(Boolean).length;
  console.log(JSON.stringify({ ...row, primary: `${nOk}/3` }));
  return nOk;
}

const ROOT = join(import.meta.dirname, "..");
const p01 = ensure("/tmp/pba-01", join(ROOT, "test-media/pba-striketrack-01.mp4"), 110);
const p10 = ensure("/tmp/pba-10", join(ROOT, "test-media/pba-striketrack-10.mp4"), 140);

const c01: LaneCorners = {
  tl: { x: 522, y: 245 }, tr: { x: 690, y: 245 },
  br: { x: 559, y: 610 }, bl: { x: 249, y: 610 },
};
const c10: LaneCorners = {
  tl: { x: 496, y: 180 }, tr: { x: 753, y: 180 },
  br: { x: 668, y: 470 }, bl: { x: 366, y: 470 },
};

const n1 = score("01", trackSaved(c01, p01), { speed: 18.3, arr: 9.3, bp: 4.0 });
const n2 = score("10", trackSaved(c10, p10), { speed: 16.0, arr: 14.9, bp: 7.6 });
const total = n1 + n2;
console.log("SUMMARY", { primaryOk: `${total}/6`, pct: Math.round((total / 6) * 100), pass80: total >= 5 });
