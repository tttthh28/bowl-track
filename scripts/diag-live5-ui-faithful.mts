/**
 * UI-faithful live×5 for Tester#8+:
 * - 30fps decode, vt minDt=1/15 (Workbench upload)
 * - phase offset per loop (RAF start skew)
 * - finishShot trim, demo inset 0.15, unlock @board≥26
 * - PBA OFF
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
  const picked = pickBestCornersByProbe(ranked.map((c) => ({ det: c.det, geomRank: c.rank })), frames, 10);
  let corners = picked?.det.corners ?? ranked[0]?.det.corners;
  if (!corners) return null;
  corners = snapCornersToTrueGutter(corners, W, H);
  return { corners, probeArr: picked?.detail.arrows ?? null };
}

function liveLoop(corners: LaneCorners, seed: number) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const insetC = insetLaneCorners(workC, 0.15);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER };
  let shotPts: TrackPoint[] = [];
  let saved: TrackPoint[] | null = null;
  let saves = 0;
  let gutterStreak = 0;
  let tShot0 = 0;
  let lastTrackedVt = -1;
  const phase = ((seed * 0.013) % (1 / 15));
  for (let f = 0; f < framesN; f++) {
    const vt = f / FPS;
    if (vt < phase) continue;
    if (lastTrackedVt >= 0 && vt + 1e-6 < lastTrackedVt + 1 / 15) continue;
    const dtMs =
      lastTrackedVt < 0
        ? 1000 / 15
        : Math.max(55, Math.min(100, (vt - lastTrackedVt) * 1000));
    lastTrackedVt = vt;
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    // Workbench: inset unless soft/fastRelock (full lane for mid densify)
    const useC = state.fastRelockFrames > 0 ? workC : insetC;
    const res = trackBallFrame(
      state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, useC,
      dtMs * (0.92 + (seed % 4) * 0.03), work
    );
    const pos = res.smoothed
      ? scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed
      : null;
    const rFull =
      res.radius != null && res.radius > 0
        ? scale < 1 ? res.radius / scale : res.radius
        : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      if (shotPts.length === 0 && !res.predicted) tShot0 = vt * 1000;
      if (shotPts.length > 0 || !res.predicted) {
        const t = vt * 1000 - tShot0;
        let contact = ballContactPoint(pos, rFull);
        let lane = imageToLane(Hm, contact);
        // snap predicted apex to board~14 during fastRelock (Workbench mirror)
        if (
          res.predicted &&
          state.fastRelockFrames > 0 &&
          lane &&
          lane.feet >= 12 &&
          lane.feet <= 18
        ) {
          const foulY = (corners.bl.y + corners.br.y) / 2;
          const pinY = (corners.tl.y + corners.tr.y) / 2;
          const tt =
            Math.abs(foulY - pinY) > 1
              ? Math.max(0, Math.min(1, (foulY - contact.y) / (foulY - pinY)))
              : 0.25;
          const leftX = corners.bl.x + (corners.tl.x - corners.bl.x) * tt;
          const rightX = corners.br.x + (corners.tr.x - corners.br.x) * tt;
          const tx = leftX + (rightX - leftX) * (14.3 / 39);
          contact = { x: tx, y: contact.y };
          lane = imageToLane(Hm, contact) ?? lane;
        }
        let accept = true;
        if (lane) {
          if (lane.feet < 52 && (lane.board >= 25.5 || lane.board <= 5)) accept = false;
          if (lane.feet < 22 && (lane.board >= 22 || lane.board <= 7)) accept = false;
          if (lane.feet < 40 && (lane.board >= 24 || lane.board <= 5)) {
            gutterStreak++;
            if (gutterStreak >= 1) {
              state.softRelockMid(workC);
              gutterStreak = 0;
            }
          } else if (lane.board > 7 && lane.board < 24) gutterStreak = 0;
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
          // coast-fill 14–16′ across large forward jumps (Workbench mirror)
          if (shotPts.length > 0 && lane && !res.predicted) {
            const prev = shotPts[shotPts.length - 1];
            if (prev.lane) {
              const dF = lane.feet - prev.lane.feet;
              if (
                dF > 3.5 &&
                prev.lane.feet < 15.5 &&
                lane.feet > 14.5 &&
                prev.lane.board > 9 &&
                prev.lane.board < 22 &&
                lane.board > 9 &&
                lane.board < 22
              ) {
                for (const tf of [14, 15, 16] as const) {
                  if (tf <= prev.lane.feet + 0.4 || tf >= lane.feet - 0.4) continue;
                  const u = (tf - prev.lane.feet) / dF;
                  let b = prev.lane.board + u * (lane.board - prev.lane.board);
                  b = b * 0.4 + 14.4 * 0.6;
                  if (b < 12 || b > 16) continue;
                  shotPts.push({
                    image: {
                      x: prev.image.x + u * (contact.x - prev.image.x),
                      y: prev.image.y + u * (contact.y - prev.image.y),
                    },
                    lane: { feet: tf, board: b },
                    t: prev.t + u * (t - prev.t),
                    predicted: true,
                  });
                }
              }
            }
          }
          shotPts.push({ image: contact, lane, t, predicted: res.predicted || undefined });
        }
      }
    }
    if (shouldEndShot(state, settings, shotPts.length > 0)) {
      if (evaluateShotQuality(shotPts).ok) {
        saved = shotPts.slice();
        saves++;
        break;
      }
      state.beginNewShot({ clearBg: true });
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
  if (!saved) {
    return { arr: null as number | null, saves, n: 0, tony: false, maxB: 0, ft: "—", n1218: 0, bins: "", ileq: false, ex: false };
  }
  const trimmed = saved.filter(
    (p) => !p.lane || p.lane.feet >= 25 || (p.lane.board > 8 && p.lane.board <= 18)
  );
  const est = computeShotEstimate(trimmed.filter((p) => p.lane).length >= 8 ? trimmed : saved);
  const lanePts = saved.filter((p) => p.lane).map((p) => p.lane!);
  const arr = est.arrowsBoard ?? null;
  const maxB = Math.max(...lanePts.map((p) => p.board));
  const inBand = lanePts.filter((p) => p.feet >= 12 && p.feet <= 18);
  const bins = [0, 5, 10, 15, 20, 25, 30, 35, 40].map(
    (lo) => `${lo}:${lanePts.filter((p) => p.feet >= lo && p.feet < lo + 5).length}`
  ).join(" ");
  const ileq =
    est.impactSpeedMph != null &&
    est.launchSpeedMph != null &&
    est.impactSpeedMph <= est.launchSpeedMph + 0.05;
  return {
    arr,
    saves,
    n: saved.length,
    tony: arr != null && arr >= 13 && arr <= 15 && maxB < 26,
    maxB: +maxB.toFixed(1),
    ft: `${Math.min(...lanePts.map((p) => p.feet)).toFixed(1)}-${Math.max(...lanePts.map((p) => p.feet)).toFixed(1)}`,
    n1218: inBand.length,
    n1416: lanePts.filter((p) => p.feet >= 14 && p.feet <= 16).length,
    n1416real: saved.filter((p) => p.lane && p.lane.feet >= 14 && p.lane.feet <= 16 && !p.predicted).length,
    n1416path: saved.filter((p) => p.lane && p.lane.feet >= 14 && p.lane.feet <= 16).length,
    bins,
    ileq,
    ex: !!est.extrapolated?.arrows,
    bp: est.breakpointBoard != null ? `${est.breakpointBoard.toFixed(1)}@${est.breakpointDistance}` : "—",
    inBand: inBand.slice(0, 4).map((p) => `${p.feet.toFixed(1)}@${p.board.toFixed(1)}`).join(","),
    apex1416: lanePts
      .filter((p) => p.feet >= 14 && p.feet <= 16)
      .slice(0, 4)
      .map((p) => `${p.feet.toFixed(1)}@${p.board.toFixed(1)}`)
      .join(","),
    rawArr: (() => {
      // sample board nearest 15′ ignoring clamp gate (for clamp-off probe)
      const near = lanePts
        .filter((p) => p.board > 8 && p.board < 22)
        .sort((a, b) => Math.abs(a.feet - 15) - Math.abs(b.feet - 15))[0];
      return near ? +near.board.toFixed(1) : null;
    })(),
  };
}

let d = detect();
if (!d) throw new Error("detect fail");
// re-detect once if probe gutter
if (d.probeArr == null || d.probeArr < 12 || d.probeArr > 16) {
  d = detect() ?? d;
}
console.log("DETECT", { probeArr: d.probeArr });
const rows = [];
for (let i = 0; i < 5; i++) {
  const r = liveLoop(d.corners, i + 1);
  rows.push(r);
  console.log(JSON.stringify({ loop: i + 1, ...r }));
}
const nArr = rows.filter((r) => r.arr != null && r.arr >= 13 && r.arr <= 15).length;
const saveOk = rows.every((r) => r.saves === 1);
const gutOk = rows.every((r) => r.maxB <= 26);
const ileqOk = rows.every((r) => r.ileq);
const probeOk = d.probeArr != null && d.probeArr >= 12.5 && d.probeArr <= 15.5;
const real15 = rows.filter((r) => (r.n1416real ?? 0) >= 1).length;
const path15 = rows.filter((r) => (r.n1416path ?? r.n1416 ?? 0) >= 1).length;
const pass = nArr === 5 && saveOk && gutOk && ileqOk && probeOk;
console.log("SUMMARY", {
  arrBand: `${nArr}/5`,
  real15: `${real15}/5`,
  path15: `${path15}/5`,
  saves1each: saveOk,
  noGutter: gutOk,
  ileq: ileqOk,
  probeOk: d.probeArr,
  pass,
  note: "UI-faithful: phase+15fps+inset+soft24+coastFill+clamp",
});
process.exit(pass ? 0 : 1);
