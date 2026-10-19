/** Offline track PBA clips with TesterManual corners; try board mirror */
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

function runClip(opts: {
  name: string; video: string; W: number; H: number; fps: number; n: number;
  corners: LaneCorners; gt: { speed: number; arr: number; bp: number; rpm: number };
}) {
  const OUT = `/tmp/pba-${opts.name}`;
  mkdirSync(OUT, { recursive: true });
  const rgbaPath = `${OUT}/seq.rgba`;
  if (!existsSync(rgbaPath)) {
    execSync(
      `ffmpeg -y -i "${opts.video}" -vf "fps=${opts.fps},scale=${opts.W}:${opts.H}" -frames:v ${opts.n} -f rawvideo -pix_fmt rgba "${rgbaPath}"`,
      { stdio: "pipe" }
    );
  }
  const raw = readFileSync(rgbaPath);
  const fb = opts.W * opts.H * 4;
  const N = Math.floor(raw.length / fb);
  const frameAt = (i: number) =>
    new Uint8ClampedArray(raw.buffer, raw.byteOffset + Math.min(N - 1, i) * fb, fb);
  function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
    const out = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const sx = Math.min(opts.W - 1, Math.floor((x / tw) * opts.W));
      const sy = Math.min(opts.H - 1, Math.floor((y / th) * opts.H));
      const si = (sy * opts.W + sx) * 4, di = (y * tw + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
    }
    return out;
  }
  const Hm = buildHomography(opts.corners)!;
  const { scale, tw, th } = trackWorkSize(opts.W, opts.H);
  const workC = scaleLaneCorners(opts.corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER };
  let shot: TrackPoint[] = [];
  let saved: TrackPoint[] | null = null;
  let t0 = 0;
  for (let f = 0; f < N; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : opts.W, scale < 1 ? th : opts.H);
    const res = trackBallFrame(
      state, gray, scale < 1 ? tw : opts.W, scale < 1 ? th : opts.H, settings,
      scale < 1 ? workC : opts.corners, 1000 / opts.fps, work
    );
    const pos = res.smoothed
      ? scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed
      : null;
    const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      if (shot.length === 0 && !res.predicted) t0 = f * (1000 / opts.fps);
      if (shot.length > 0 || !res.predicted) {
        const contact = ballContactPoint(pos, rFull);
        const lane = imageToLane(Hm, contact);
        let accept = true;
        if (lane && !res.predicted && (lane.board < 1.2 || lane.board > 37.8) && lane.feet < 45)
          accept = false;
        if (accept) {
          shot.push({ image: contact, lane, t: f * (1000 / opts.fps) - t0, predicted: res.predicted || undefined });
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
  const pts = saved ?? shot;
  const est = computeShotEstimate(pts);
  const feet = pts.filter((p) => p.lane).map((p) => p.lane!.feet);
  const mirror = (b: number | null | undefined) =>
    b == null ? null : Math.round((39 - b) * 10) / 10;
  console.log(opts.name, {
    n: pts.length,
    ft: feet.length ? `${Math.min(...feet).toFixed(1)}–${Math.max(...feet).toFixed(1)}` : "—",
    arr: est.arrowsBoard,
    arrMirror: mirror(est.arrowsBoard),
    bp: est.breakpointBoard,
    bpMirror: mirror(est.breakpointBoard),
    bpDist: est.breakpointDistance,
    avgMph: est.avgSpeedMph,
    rpm: est.rpm,
    gt: opts.gt,
    q: evaluateShotQuality(pts).ok,
  });
}

const ROOT = join(import.meta.dirname, "..");
runClip({
  name: "01",
  video: join(ROOT, "test-media/pba-striketrack-01.mp4"),
  W: 1280, H: 720, fps: 30, n: 110,
  corners: {
    tl: { x: 522, y: 245 }, tr: { x: 690, y: 245 },
    br: { x: 559, y: 610 }, bl: { x: 249, y: 610 },
  },
  gt: { speed: 18.3, arr: 9.3, bp: 4.0, rpm: 488 },
});
runClip({
  name: "10",
  video: join(ROOT, "test-media/pba-striketrack-10.mp4"),
  W: 1280, H: 720, fps: 30, n: 140,
  corners: {
    tl: { x: 496, y: 180 }, tr: { x: 753, y: 180 },
    br: { x: 668, y: 470 }, bl: { x: 366, y: 470 },
  },
  gt: { speed: 16.0, arr: 14.9, bp: 7.6, rpm: 305 },
});
