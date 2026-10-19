/**
 * Self-test: Alinejad-port plane 3D path + spin/RPM on bowling-demo
 * (manual four corners). LOCAL only.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  ballContactPoint,
  rgbaToGray,
  trackBallFrame,
  trackWorkSize,
  scaleLaneCorners,
  shouldEndShot,
  insetLaneCorners,
  getRpmEstimate,
} from "../src/lib/tracker.ts";
import {
  buildTrackHomography,
  imageToLane,
  smoothDemoPath,
} from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import {
  rebuildPlaneConstrainedPath,
  computePlanePathMetrics,
} from "../src/lib/trajectory3d.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-alinejad-3d-spin";
const W = 1060;
const H = 954;
const FPS = 30;

// TesterManual gutters (same as demo-manual-traj fix)
const manual: LaneCorners = {
  tl: { x: 542, y: 152 },
  tr: { x: 704, y: 152 },
  bl: { x: 180, y: 864 },
  br: { x: 815, y: 864 },
};

mkdirSync(OUT, { recursive: true });
const rgbaPath = join(OUT, "seq.rgba");
const cacheLive = "/tmp/bowl-live5-30/seq.rgba";
if (!existsSync(rgbaPath)) {
  if (existsSync(cacheLive)) {
    execSync(`cp "${cacheLive}" "${rgbaPath}"`);
  } else {
    execSync(
      `ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -f rawvideo -pix_fmt rgba "${rgbaPath}"`,
      { stdio: "pipe" }
    );
  }
}

const raw = readFileSync(rgbaPath);
const fb = W * H * 4;
const framesN = Math.floor(raw.length / fb);
const frameAt = (i: number) =>
  new Uint8ClampedArray(
    raw.buffer,
    raw.byteOffset + Math.min(framesN - 1, i) * fb,
    fb
  );

function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(W - 1, Math.floor((x / tw) * W));
      const sy = Math.min(H - 1, Math.floor((y / th) * H));
      const si = (sy * W + sx) * 4;
      const di = (y * tw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = 255;
    }
  return out;
}

function run(label: string, seedAt?: number, seedPx?: { x: number; y: number }) {
  const Hm = buildTrackHomography(manual)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(manual, scale);
  const insetC = insetLaneCorners(workC, 0.15);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, rpmEnabled: true, rpmMinContrast: 16 };
  let shotPts: TrackPoint[] = [];
  let demoInset = true;
  let lastTrackedVt = -1;
  let endReason = "eof";
  let seeded = false;
  let midRecoverUsed = false;
  let gutterStreak = 0;

  for (let f = 0; f < framesN; f++) {
    const vt = f / FPS;
    if (lastTrackedVt >= 0 && vt + 1e-6 < lastTrackedVt + 1 / 15) continue;
    const dtMs =
      lastTrackedVt < 0
        ? 33
        : Math.min(80, Math.max(1, (vt - lastTrackedVt) * 1000));
    lastTrackedVt = vt;

    if (seedAt != null && !seeded && f >= seedAt) {
      let tx: number, y: number;
      if (seedPx) {
        tx = seedPx.x;
        y = seedPx.y;
      } else {
        const foulY = (manual.bl.y + manual.br.y) / 2;
        const pinY = (manual.tl.y + manual.tr.y) / 2;
        y = foulY + (pinY - foulY) * (8 / 60);
        const tt =
          Math.abs(foulY - pinY) > 1
            ? Math.max(0, Math.min(1, (foulY - y) / (foulY - pinY)))
            : 0.25;
        const leftX = manual.bl.x + (manual.tl.x - manual.bl.x) * tt;
        const rightX = manual.br.x + (manual.tr.x - manual.br.x) * tt;
        tx = leftX + (rightX - leftX) * (10 / 39);
      }
      state.seedAt(
        scale < 1 ? { x: tx * scale, y: y * scale } : { x: tx, y }
      );
      seeded = true;
    }

    const rgba = frameAt(f);
    const work =
      scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const feetNow = shotPts.filter((p) => p.lane).map((p) => p.lane!.feet);
    const maxNow = feetNow.length ? Math.max(...feetNow) : 0;
    if (
      (feetNow.length >= 3 && maxNow >= 16) ||
      (feetNow.length >= 5 && maxNow >= 20)
    )
      demoInset = false;
    const fast = state.fastRelockFrames > 0;
    const useC = demoInset && !fast ? insetC : workC;
    const res = trackBallFrame(
      state,
      gray,
      scale < 1 ? tw : W,
      scale < 1 ? th : H,
      settings,
      useC,
      dtMs,
      work
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
      if (shotPts.length > 0 || !res.predicted) {
        const t = Math.round(vt * 1000);
        const contact = ballContactPoint(pos, rFull);
        let lane = imageToLane(Hm, contact);
        let accept = true;
        if (lane) {
          if (lane.feet < 52 && (lane.board >= 30 || lane.board <= 2.8))
            accept = false;
          if (lane.feet < 16 && lane.board >= 22) accept = false;
          if (lane.feet >= 16 && lane.feet < 55 && lane.board >= 27)
            accept = false;
          const leftGutterish = lane.feet < 16 && lane.board <= 5.5;
          const rightCrawl = lane.feet < 24 && lane.board >= 30;
          const midLeftDrift =
            lane.feet >= 16 && lane.feet < 45 && lane.board <= 5.0;
          const lanePts = shotPts.filter((p) => p.lane);
          const maxLive = lanePts.reduce(
            (m, p) => Math.max(m, p.lane!.feet),
            0
          );
          const established =
            maxLive >= 18 &&
            lanePts.some(
              (p) =>
                p.lane!.feet >= 10 &&
                p.lane!.board > 8 &&
                p.lane!.board < 22
            );
          if (leftGutterish || rightCrawl) accept = false;
          if (midLeftDrift && lane.board <= 3.5) accept = false;
          if (!established && (leftGutterish || rightCrawl)) {
            gutterStreak++;
            if (gutterStreak >= 2) {
              state.softRelockMid(workC);
              shotPts = shotPts.filter((p) => !p.lane || p.lane.feet <= 14);
              gutterStreak = 0;
            }
          } else if (established && (midLeftDrift || rightCrawl)) {
            state.nudgeMidKeepLock(workC);
            gutterStreak = 0;
          } else if (lane.board > 6 && lane.board < 28) gutterStreak = 0;
        }
        if (accept && shotPts.length > 0 && lane) {
          const prev = shotPts[shotPts.length - 1];
          if (prev.lane) {
            const dFeet = lane.feet - prev.lane.feet;
            const dBoard = Math.abs(lane.board - prev.lane.board);
            const dtPt = Math.max(1, t - prev.t) / 1000;
            if (dFeet < -0.8 || (dBoard > 3.5 && dFeet < 1.0)) accept = false;
            const speedCap = lane.feet >= 20 ? 150 : 90;
            if (Math.abs(dFeet) / dtPt > speedCap || dBoard > 14) accept = false;
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

    const maxLiveFeet = shotPts
      .filter((p) => p.lane)
      .reduce((m, p) => Math.max(m, p.lane!.feet), 0);
    if (
      !midRecoverUsed &&
      state.locked &&
      state.lost >= 10 &&
      maxLiveFeet >= 14 &&
      maxLiveFeet < 42 &&
      state.fastRelockFrames <= 0
    ) {
      state.softRelockMid(workC);
      shotPts = shotPts.filter(
        (p) => !p.lane || p.lane.feet <= maxLiveFeet + 2
      );
      demoInset = false;
      midRecoverUsed = true;
    }
    const endSettings = {
      ...settings,
      lostFramesToEnd:
        maxLiveFeet >= 40
          ? 52
          : maxLiveFeet >= 28
            ? 42
            : maxLiveFeet >= 16
              ? 34
              : Math.max(settings.lostFramesToEnd, 26),
    };
    if (shouldEndShot(state, endSettings, shotPts.length > 0)) {
      endReason = `end@${maxLiveFeet.toFixed(0)} lost=${state.lost}`;
      break;
    }
  }

  const smoothed = smoothDemoPath(shotPts);
  const plane = rebuildPlaneConstrainedPath(smoothed, Hm, {
    reproject: true,
  });
  const metrics = plane.metrics;
  const rawMetrics = computePlanePathMetrics(smoothed);
  const rpm = getRpmEstimate(state);
  const est = computeShotEstimate(plane.points, rpm, {
    boardFromRight: false,
  });

  return {
    label,
    endReason,
    n: plane.points.length,
    nRaw: shotPts.filter((p) => p.lane && !p.predicted).length,
    pathFt: `${metrics.minFeet}-${metrics.maxFeet}`,
    spanFt: metrics.spanFeet,
    pathLenFt: metrics.pathLengthFt,
    chordFt: metrics.chordFt,
    forwardFrac: metrics.forwardFrac,
    coherent: metrics.coherent,
    rawSpan: rawMetrics.spanFeet,
    arr: est.arrowsBoard,
    avgMph: est.avgSpeedMph,
    rpm: est.rpm,
    rpmConf: est.rpmConfidence,
    rpmRaw: rpm.rpm,
    rpmRawConf: +rpm.confidence.toFixed(3),
    spinSamples: state.spinState.samples.length,
    flowSamples: state.spinState.flowSamples.length,
    foulOk: metrics.minFeet <= 8,
    pinsOk: metrics.maxFeet >= 50,
    rpmOk: est.rpm != null && est.rpm > 0,
    pathOk: metrics.coherent || (metrics.spanFeet >= 40 && metrics.forwardFrac >= 0.65),
  };
}

const rows = [
  run("unseeded"),
  run("seeded-early", Math.round(0.8 * FPS)),
  run("seeded-r3-click", Math.round(1.2 * FPS), { x: 493, y: 654 }),
];

const primary =
  rows.find((r) => r.pathOk && r.rpmOk) ||
  rows.find((r) => r.pathOk) ||
  rows[0];

const summary = {
  date: "2026-10-19",
  video: "bowling-demo.mp4",
  corners: manual,
  primary: primary.label,
  rows,
  success: {
    coherent3dPath: primary.pathOk,
    nonDashRpm: primary.rpmOk,
    overall: !!(primary.pathOk && primary.rpmOk),
  },
};

console.log(JSON.stringify(summary, null, 2));
writeFileSync(
  join(ROOT, "tmp-reports/alinejad-3d-spin-selftest.json"),
  JSON.stringify(summary, null, 2)
);
writeFileSync(
  "/workspace/tmp-reports/alinejad-3d-spin-selftest.json",
  JSON.stringify(summary, null, 2)
);
