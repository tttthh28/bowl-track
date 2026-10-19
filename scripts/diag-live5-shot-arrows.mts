/**
 * bowling-demo ×5: Workbench detect+snap, then LIVE track with DEFAULT_TRACKER
 * + jump/edge filters + shouldEndShot → Shot Arrows (= saved estimate).
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
  const tryTimes = Array.from(new Set([
    0.08, Math.min(0.35, dur * 0.04), Math.min(0.8, dur * 0.1), Math.min(1.4, dur * 0.16),
    Math.min(dur * 0.28, dur - 0.12), Math.min(dur * 0.42, dur - 0.12), Math.min(dur * 0.58, dur - 0.12),
    Math.min(dur * 0.72, dur - 0.12), Math.min(dur * 0.85, dur - 0.08), Math.min(dur * 0.92, dur - 0.06),
    dur * 0.2,
  ].map((x) => Math.max(0, Math.min(x, Math.max(0, dur - 0.06))))));
  const detCands: { det: NonNullable<ReturnType<typeof detectLaneCorners>>; geom: number }[] = [];
  for (const tSeek of tryTimes) {
    const rgba = frameAt(fiAt(tSeek));
    if (!frameHasLaneSignal(rgba, W, H)) continue;
    const next = detectLaneCorners(rgba, W, H);
    if (next) detCands.push({ det: next, geom: scoreLaneGeometry(next, W, H) });
  }
  const ranked = detCands
    .map((c) => ({ ...c, rank: c.geom }))
    .sort((a, b) => b.rank - a.rank);
  const probeN = Math.min(90, Math.max(40, Math.floor(Math.min(dur, 6.5) * 15)));
  const t0 = Math.min(0.35, Math.max(0.08, dur * 0.04));
  const frames = [];
  for (let i = 0; i < probeN; i++) {
    const tP = Math.min(dur - 0.06, t0 + i / 15);
    const rgba = frameAt(fiAt(tP));
    if (!frameHasLaneSignal(rgba, W, H)) continue;
    frames.push({ rgba, width: W, height: H });
  }
  const picked = pickBestCornersByProbe(
    ranked.map((c) => ({ det: c.det, geomRank: c.rank })),
    frames,
    10
  );
  let corners = picked?.det.corners ?? ranked[0]?.det.corners;
  if (!corners) return null;
  corners = snapCornersToTrueGutter(corners, W, H);
  // 探針數以 pickBest 為準（同 Workbench UI 探針註）；再 snap 唔改 X／bot
  return {
    corners,
    probeArr: picked?.detail.arrows ?? null,
    probeMed: picked?.detail.med ?? null,
    probeFt: picked
      ? `${picked.detail.minFeet.toFixed(1)}–${picked.detail.maxFeet.toFixed(1)}`
      : "—",
  };
}

function liveShot(corners: LaneCorners) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER }; // Workbench default
  let shotPts: TrackPoint[] = [];
  let saved: TrackPoint[] | null = null;
  let tShot0 = 0;
  for (let f = 0; f < framesN; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const res = trackBallFrame(
      state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings,
      scale < 1 ? workC : corners, 1000 / FPS, work
    );
    const pos = res.smoothed
      ? scale < 1
        ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale }
        : res.smoothed
      : null;
    const rFull =
      res.radius != null && res.radius > 0
        ? scale < 1
          ? res.radius / scale
          : res.radius
        : null;
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
            const dFeet = Math.abs(lane.feet - prev.lane.feet);
            const dBoard = Math.abs(lane.board - prev.lane.board);
            const dtPt = Math.max(1, t - prev.t) / 1000;
            if (dFeet / dtPt > 90 || dBoard > 14) accept = false;
          }
        }
        if (accept) {
          shotPts.push({
            image: contact,
            lane,
            t,
            predicted: res.predicted || undefined,
          });
        }
      }
    }
    if (shouldEndShot(state, settings, shotPts.length > 0)) {
      if (!saved && evaluateShotQuality(shotPts).ok) saved = shotPts.slice();
      shotPts = [];
      state.beginNewShot();
    } else if (!res.locked && shotPts.length > 0) {
      // upload：誤鎖解除唔存（對齊 Workbench）
      shotPts = [];
      state.beginNewShot();
    }
  }
  if (!saved && shotPts.length > 0 && evaluateShotQuality(shotPts).ok) saved = shotPts;
  if (!saved) return { est: null, n: 0, ft: "—", boards: "—" };
  const feet = saved.filter((p) => p.lane).map((p) => p.lane!.feet);
  const boards = saved.filter((p) => p.lane).map((p) => p.lane!.board);
  const est = computeShotEstimate(saved);
  return {
    est,
    n: saved.length,
    ft: feet.length ? `${Math.min(...feet).toFixed(1)}–${Math.max(...feet).toFixed(1)}` : "—",
    boards: boards.length
      ? `${Math.min(...boards).toFixed(1)}–${Math.max(...boards).toFixed(1)}`
      : "—",
  };
}

const tony = (a: number | null | undefined) =>
  a != null && a >= 12.5 && a <= 15.5;

/** 模擬瀏覽器：同角 ×5 圈 rewind，每圈最多 1 存 */
function liveShotLoops(corners: LaneCorners, loops = 5) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER };
  const perLoop: { arr: number | null; n: number; saves: number; bp: string; ft: string; boards: string }[] = [];
  for (let loop = 0; loop < loops; loop++) {
    let shotPts: TrackPoint[] = [];
    let saved: TrackPoint[] | null = null;
    let saves = 0;
    let tShot0 = 0;
    let loopSaved = false;
    for (let f = 0; f < framesN; f++) {
      const rgba = frameAt(f);
      const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
      const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
      const dt = (1000 / FPS) * (0.85 + (f % 5) * 0.06);
      const res = trackBallFrame(
        state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings,
        scale < 1 ? workC : corners, dt, work
      );
      const pos = res.smoothed
        ? scale < 1
          ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale }
          : res.smoothed
        : null;
      const rFull =
        res.radius != null && res.radius > 0
          ? scale < 1
            ? res.radius / scale
            : res.radius
          : null;
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
              const dtPt = Math.max(1, t - prev.t) / 1000;
              if (dFeet < -0.8 || (dBoard > 3.5 && dFeet < 1.0)) accept = false;
              if (Math.abs(dFeet) / dtPt > 90 || dBoard > 14) accept = false;
            }
          }
          if (accept) {
            shotPts.push({
              image: contact,
              lane,
              t,
              predicted: res.predicted || undefined,
            });
          }
        }
      }
      if (!loopSaved && shouldEndShot(state, settings, shotPts.length > 0)) {
        if (evaluateShotQuality(shotPts).ok) {
          saved = shotPts.slice();
          saves++;
          loopSaved = true;
        }
        shotPts = [];
        state.beginNewShot({ clearBg: true });
      } else if (!res.locked && shotPts.length > 0) {
        shotPts = [];
        state.beginNewShot({ clearBg: true });
      }
    }
    // rewind end-of-loop
    if (!loopSaved && shotPts.length > 0) {
      const feet = shotPts.filter((p) => p.lane).map((p) => p.lane!.feet);
      const span = feet.length >= 2 ? Math.max(...feet) - Math.min(...feet) : 0;
      if (span >= 12 && evaluateShotQuality(shotPts).ok) {
        saved = shotPts.slice();
        saves++;
        loopSaved = true;
      }
    }
    shotPts = [];
    state.beginNewShot({ clearBg: true });
    if (!saved) {
      perLoop.push({ arr: null, n: 0, saves, bp: "—", ft: "—", boards: "—" });
      continue;
    }
    const feet = saved.filter((p) => p.lane).map((p) => p.lane!.feet);
    const boards = saved.filter((p) => p.lane).map((p) => p.lane!.board);
    const est = computeShotEstimate(saved);
    perLoop.push({
      arr: est?.arrowsBoard ?? null,
      n: saved.length,
      saves,
      bp:
        est?.breakpointBoard != null
          ? `${est.breakpointBoard.toFixed(1)}@${est.breakpointDistance}`
          : "—",
      ft: feet.length ? `${Math.min(...feet).toFixed(1)}–${Math.max(...feet).toFixed(1)}` : "—",
      boards: boards.length
        ? `${Math.min(...boards).toFixed(1)}–${Math.max(...boards).toFixed(1)}`
        : "—",
    });
  }
  return perLoop;
}

const d = detect();
if (!d) {
  console.log(JSON.stringify({ err: "no detect" }));
  process.exit(1);
}
console.log("DETECT", {
  probeArr: d.probeArr,
  bot: +((d.corners.br.x - d.corners.bl.x) / W).toFixed(3),
  mid: +((d.corners.bl.x + d.corners.br.x) / 2).toFixed(0),
  foulY: +(((d.corners.bl.y + d.corners.br.y) / 2) / H).toFixed(3),
});
const loops = liveShotLoops(d.corners, 5);
loops.forEach((r, i) => console.log(JSON.stringify({ loop: i + 1, ...r })));
const nS = loops.filter((r) => tony(r.arr)).length;
const saveOk = loops.every((r) => r.saves === 1);
console.log("SUMMARY", {
  tonyProbe: tony(d.probeArr) ? "1/1" : "0/1",
  tonyShot: `${nS}/5`,
  saves1each: saveOk,
  pass: tony(d.probeArr) && nS === 5 && saveOk,
  DEFAULT: { s: DEFAULT_TRACKER.sensitivity, b: DEFAULT_TRACKER.minBlobPixels },
});
