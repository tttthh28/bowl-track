/**
 * Tester-faithful live×5: 30fps decode + Workbench 15fps subsample + clearBg + 1 save/loop
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners, shouldEndShot, insetLaneCorners,
} from "../src/lib/tracker.ts";
import {
  detectLaneCorners, snapCornersToTrueGutter, scoreLaneGeometry, frameHasLaneSignal,
} from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";
import { pickBestCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

const OUT = "/tmp/bowl-live5-30";
const W = 1060, H = 954, FPS = 30, N = 200;
const VIDEO = join(import.meta.dirname, "../test-media/bowling-demo.mp4");
mkdirSync(OUT, { recursive: true });
if (!existsSync(`${OUT}/seq.rgba`)) {
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, { stdio: "pipe" });
}
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W * H * 4;
const framesN = Math.floor(raw.length / fb);
const frameAt = (i: number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + Math.min(framesN - 1, i) * fb, fb);
const step = Math.max(1, Math.round(FPS / 15)); // Workbench minDt=1/15

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
  const dur = framesN / FPS;
  const tryTimes = [0.08, 0.35, 0.8, 1.4, dur * 0.28, dur * 0.42, dur * 0.58, dur * 0.72, dur * 0.85];
  const detCands: { det: NonNullable<ReturnType<typeof detectLaneCorners>>; geom: number }[] = [];
  for (const tSeek of tryTimes) {
    const rgba = frameAt(Math.min(framesN - 1, Math.round(tSeek * FPS)));
    if (!frameHasLaneSignal(rgba, W, H)) continue;
    const next = detectLaneCorners(rgba, W, H);
    if (next) detCands.push({ det: next, geom: scoreLaneGeometry(next, W, H) });
  }
  const ranked = detCands.map((c) => ({ ...c, rank: c.geom })).sort((a, b) => b.rank - a.rank);
  const frames = [];
  for (let i = 0; i < 90; i++) {
    const tP = Math.min(dur - 0.06, 0.2 + i / 15);
    const rgba = frameAt(Math.min(framesN - 1, Math.round(tP * FPS)));
    if (frameHasLaneSignal(rgba, W, H)) frames.push({ rgba, width: W, height: H });
  }
  const picked = pickBestCornersByProbe(
    ranked.map((c) => ({ det: c.det, geomRank: c.rank })),
    frames,
    10
  );
  let corners = picked?.det.corners ?? ranked[0]?.det.corners;
  if (!corners) return null;
  corners = snapCornersToTrueGutter(corners, W, H);
  return { corners, probeArr: picked?.detail.arrows ?? null };
}

function liveLoops(corners: LaneCorners, loops = 5) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const insetC = insetLaneCorners(workC, 0.15);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER };
  const tony = (a: number | null | undefined) => a != null && a >= 12.5 && a <= 15.5;
  const rows = [];
  for (let loop = 0; loop < loops; loop++) {
    let shotPts: TrackPoint[] = [];
    let saved: TrackPoint[] | null = null;
    let saves = 0;
    let gutterStreak = 0;
    let tShot0 = 0;
    for (let f = 0; f < framesN; f += step) {
      const rgba = frameAt(f);
      const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
      const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
      const res = trackBallFrame(
        state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings,
        scale < 1 ? insetC : insetLaneCorners(corners, 0.15), 1000 / 15, work
      );
      const pos = res.smoothed
        ? scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed
        : null;
      const rFull =
        res.radius != null && res.radius > 0
          ? scale < 1 ? res.radius / scale : res.radius
          : null;
      if (res.locked && pos && (res.raw != null || res.predicted)) {
        if (shotPts.length === 0 && !res.predicted) tShot0 = f * (1000 / FPS);
        if (shotPts.length > 0 || !res.predicted) {
          const t = f * (1000 / FPS) - tShot0;
          const contact = ballContactPoint(pos, rFull);
          const lane = imageToLane(Hm, contact);
          let accept = true;
          if (lane) {
            if (lane.feet < 45 && (lane.board >= 28 || lane.board <= 6)) {
              accept = false;
            }
            if (lane.feet < 22 && (lane.board >= 22 || lane.board <= 7)) {
              accept = false;
            }
            if (lane.feet < 40 && (lane.board >= 24 || lane.board <= 5)) {
              gutterStreak++;
              if (gutterStreak >= 1) {
                state.beginNewShot({ clearBg: true });
                gutterStreak = 0;
              }
            } else if (lane.board > 7 && lane.board < 24) {
              gutterStreak = 0;
            }
          }
          if (accept && shotPts.length > 0 && lane) {
            const prev = shotPts[shotPts.length - 1];
            if (prev.lane) {
              const dFeet = lane.feet - prev.lane.feet;
              const dBoard = Math.abs(lane.board - prev.lane.board);
              if (dFeet < -0.8 || (dBoard > 3.5 && dFeet < 1.0)) accept = false;
              if (lane.board > 22 && dFeet > 0.35 && dBoard / dFeet > 1.5) accept = false;
            }
          }
          if (accept) {
            shotPts.push({ image: contact, lane, t, predicted: res.predicted || undefined });
          }
        }
      }
      if (shouldEndShot(state, settings, shotPts.length > 0)) {
        if (evaluateShotQuality(shotPts).ok) {
          saved = shotPts.slice();
          saves++;
          shotPts = [];
          state.beginNewShot({ clearBg: true });
          break;
        }
        // quality 唔夠：解鎖續追，唔 break
        state.beginNewShot({ clearBg: true });
      } else if (!res.locked && shotPts.length > 0) {
        // keep shotPts for re-lock after gutter unlock
      }
    }
    if (!saved && shotPts.length > 0) {
      const feet = shotPts.filter((p) => p.lane).map((p) => p.lane!.feet);
      const span = feet.length >= 2 ? Math.max(...feet) - Math.min(...feet) : 0;
      if (span >= 12 && evaluateShotQuality(shotPts).ok) {
        saved = shotPts;
        saves++;
      }
    }
    state.beginNewShot({ clearBg: true });
    if (!saved) {
      rows.push({ loop: loop + 1, arr: null, saves, n: 0, tony: false });
      continue;
    }
    let estPts = saved;
    const trimmed = saved.filter(
      (p) =>
        !p.lane ||
        p.lane.feet >= 25 ||
        (p.lane.board > 8 && p.lane.board <= 18)
    );
    if (trimmed.filter((p) => p.lane).length >= 8) estPts = trimmed;
    const est = computeShotEstimate(estPts);
    const arr = est.arrowsBoard ?? null;
    const boards = saved.filter((p) => p.lane).map((p) => p.lane!.board);
    const feet = saved.filter((p) => p.lane).map((p) => p.lane!.feet);
    const at15 = saved
      .filter((p) => p.lane && p.lane.feet >= 13 && p.lane.feet <= 17)
      .map((p) => p.lane!.board);
    const b15 = at15.length
      ? +[...at15].sort((a, b) => a - b)[Math.floor(at15.length / 2)].toFixed(1)
      : null;
    rows.push({
      loop: loop + 1,
      arr,
      b15,
      saves,
      n: saved.length,
      tony: tony(arr) && Math.max(...boards) < 26,
      bp: est.breakpointBoard != null ? `${est.breakpointBoard.toFixed(1)}@${est.breakpointDistance}` : "—",
      boards: `${Math.min(...boards).toFixed(1)}–${Math.max(...boards).toFixed(1)}`,
      ft: `${Math.min(...feet).toFixed(1)}–${Math.max(...feet).toFixed(1)}`,
    });
  }
  return rows;
}

const d = detect();
if (!d) throw new Error("detect fail");
console.log("DETECT", { probeArr: d.probeArr, mid: +((d.corners.bl.x + d.corners.br.x) / 2).toFixed(0), bot: +((d.corners.br.x - d.corners.bl.x) / W).toFixed(3) });
const rows = liveLoops(d.corners, 5);
rows.forEach((r) => console.log(JSON.stringify(r)));
const nTony = rows.filter((r) => r.tony).length;
const nArr = rows.filter((r) => r.arr != null && r.arr >= 12.5 && r.arr <= 15.5).length;
const saveOk = rows.every((r) => r.saves === 1);
const pass = nTony === 5 && nArr === 5 && saveOk && d.probeArr != null && d.probeArr >= 12.5 && d.probeArr <= 15.5;
console.log("SUMMARY", { tonyShot: `${nTony}/5`, arrBand: `${nArr}/5`, saves1each: saveOk, probeOk: d.probeArr, pass, note: "30fps+15sub; tony=arr∈13–15 ∧ maxBoard<26 (no gutter)" });
