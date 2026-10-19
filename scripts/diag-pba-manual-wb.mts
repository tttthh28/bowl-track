/**
 * TesterManual-faithful PBA: manual corners + boardFromRight + Workbench PBA gates
 * (soft edge, no 15fps cap, no demo trim/gutter unlock).
 * Also reports "demoGates" regression path for contrast.
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

function ensure(out: string, video: string, fps: number, n: number) {
  mkdirSync(out, { recursive: true });
  const rgba = `${out}/seq.rgba`;
  if (!existsSync(rgba)) {
    execSync(
      `ffmpeg -y -i "${video}" -vf "fps=${fps},scale=1280:720" -frames:v ${n} -f rawvideo -pix_fmt rgba "${rgba}"`,
      { stdio: "pipe" }
    );
  }
  return rgba;
}

type Mode = "pbaWb" | "pbaWbNoEnd" | "demoGates" | "offlineSoft";

function collect(
  corners: LaneCorners,
  rgbaPath: string,
  fps: number,
  mode: Mode
): TrackPoint[] {
  const W = 1280, H = 720;
  const raw = readFileSync(rgbaPath);
  const fb = W * H * 4;
  const nFrames = Math.floor(raw.length / fb);
  const frameAt = (i: number) =>
    new Uint8ClampedArray(raw.buffer, raw.byteOffset + Math.min(nFrames - 1, i) * fb, fb);
  function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
    const out = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++) {
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
  const settings = { ...DEFAULT_TRACKER };
  const pts: TrackPoint[] = [];
  let gutterStreak = 0;
  // demoGates: subsample every other frame at 30fps ≈ 15fps
  const step = mode === "demoGates" ? Math.max(1, Math.round(fps / 15)) : 1;

  for (let f = 0; f < nFrames; f += step) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const res = trackBallFrame(
      state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings,
      scale < 1 ? workC : corners, 1000 / (fps / step), work
    );
    const pos = res.smoothed
      ? scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed
      : null;
    const rFull =
      res.radius != null && res.radius > 0
        ? scale < 1 ? res.radius / scale : res.radius
        : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      const contact = ballContactPoint(pos, rFull);
      const lane = imageToLane(Hm, contact);
      let accept = true;
      if (lane) {
        if (mode === "offlineSoft" || mode === "pbaWb" || mode === "pbaWbNoEnd") {
          if ((lane.board < 0.3 || lane.board > 38.7) && lane.feet < 50) accept = false;
          // PBA 早期假鎖（左規 10–22.5 @ <20′）
          if (
            (mode === "pbaWb" || mode === "pbaWbNoEnd") &&
            lane.feet < 25 &&
            lane.board > 14 &&
            lane.board < 23.5
          ) {
            accept = false;
          }
        } else {
          // demoGates
          if (lane.feet < 45 && (lane.board >= 28 || lane.board <= 6)) accept = false;
          if (lane.feet < 40 && (lane.board >= 30 || lane.board <= 5)) {
            gutterStreak++;
            if (gutterStreak >= 2) {
              state.beginNewShot({ clearBg: true });
              gutterStreak = 0;
            }
          } else if (lane.board > 7 && lane.board < 28) gutterStreak = 0;
        }
      }
      if (accept && pts.length && lane && !res.predicted) {
        const prev = pts[pts.length - 1];
        if (prev.lane) {
          const dFeet = lane.feet - prev.lane.feet;
          const dBoard = Math.abs(lane.board - prev.lane.board);
          const dtPt = Math.max(1, (f - (pts.length ? 0 : 0)) * (1000 / fps)) / 1000 || 1 / fps;
          if (mode === "pbaWb" || mode === "pbaWbNoEnd") {
            // PBA：同 offlineSoft 極鬆
            if (dFeet < -8.0) accept = false;
            if (dBoard > 28) accept = false;
          } else if (mode === "demoGates") {
            if (dFeet < -0.8 || (dBoard > 3.5 && dFeet < 1.0)) accept = false;
            if (lane.board > 22 && dFeet > 0.35 && dBoard / dFeet > 1.5) accept = false;
          }
        }
      }
      if (accept && lane) {
        pts.push({ image: contact, lane, t: f * (1000 / fps), predicted: res.predicted || undefined });
      }
    }
    if (mode === "pbaWb" || mode === "demoGates") {
      if (shouldEndShot(state, settings, pts.length > 0)) {
        if (evaluateShotQuality(pts).ok) break;
      }
    }
  }
  return pts;
}

function score(
  name: string,
  pts: TrackPoint[],
  gt: { speed: number; arr: number; bp: number },
  mode: Mode
) {
  let estPts = pts;
  if (mode === "demoGates") {
    const trimmed = pts.filter(
      (p) => !p.lane || p.lane.feet >= 25 || (p.lane.board > 8 && p.lane.board <= 18)
    );
    if (trimmed.filter((p) => p.lane).length >= 8) estPts = trimmed;
  }
  const est = computeShotEstimate(estPts, null, { boardFromRight: true });
  const pass = (g: number | null | undefined, t: number, tol: number) =>
    g != null && Math.abs(g - t) <= tol;
  const feet = pts.filter((p) => p.lane).map((p) => p.lane!.feet);
  const ok = {
    speed: pass(est.avgSpeedMph, gt.speed, 3),
    arr: pass(est.arrowsBoard, gt.arr, 2),
    bp: pass(est.breakpointBoard, gt.bp, 2),
  };
  const nOk = Object.values(ok).filter(Boolean).length;
  console.log(
    JSON.stringify({
      name, mode, n: pts.length,
      ft: feet.length ? `${Math.min(...feet).toFixed(1)}–${Math.max(...feet).toFixed(1)}` : "—",
      avg: est.avgSpeedMph, arr: est.arrowsBoard, bp: est.breakpointBoard, bpd: est.breakpointDistance,
      ok, primary: `${nOk}/3`, gt,
    })
  );
  return nOk;
}

const ROOT = join(import.meta.dirname, "..");
const p01 = ensure("/tmp/pba-01-60", join(ROOT, "test-media/pba-striketrack-01.mp4"), 60, 220);
const p10 = ensure("/tmp/pba-10-30", join(ROOT, "test-media/pba-striketrack-10.mp4"), 30, 140);
const c01: LaneCorners = { tl: { x: 522, y: 245 }, tr: { x: 690, y: 245 }, br: { x: 559, y: 610 }, bl: { x: 249, y: 610 } };
const c10: LaneCorners = { tl: { x: 496, y: 180 }, tr: { x: 753, y: 180 }, br: { x: 668, y: 470 }, bl: { x: 366, y: 470 } };
const gt01 = { speed: 18.3, arr: 9.3, bp: 4 };
const gt10 = { speed: 16, arr: 14.9, bp: 7.6 };

for (const mode of ["offlineSoft", "demoGates", "pbaWb", "pbaWbNoEnd"] as Mode[]) {
  console.log("===", mode, "===");
  const n1 = score("01", collect(c01, p01, 60, mode), gt01, mode);
  const n2 = score("10", collect(c10, p10, 30, mode), gt10, mode);
  console.log("SUMMARY", { mode, primaryOk: `${n1 + n2}/6`, pct: Math.round(((n1 + n2) / 6) * 100), pass80: n1 + n2 >= 5 });
}
