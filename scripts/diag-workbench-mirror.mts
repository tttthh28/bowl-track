/**
 * Headless mirror of Workbench upload path:
 * multi-seek (NO early-break) → geom rank → continuous-frame laneProbe → full track.
 * Aligns with Workbench + verify:arrows (same laneProbe).
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  ballContactPoint,
  rgbaToGray,
  trackBallFrame,
  trackWorkSize,
  scaleLaneCorners,
  getRpmEstimate,
} from "../src/lib/tracker.ts";
import {
  detectLaneCorners,
  snapCornersToTrueGutter,
  scoreLaneGeometry,
  frameHasLaneSignal,
} from "../src/lib/laneDetect.ts";
import { detectLaneCornersCorra } from "../src/lib/laneDetectCorra.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";
import { pickBestCornersByProbe, scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const VIDEO = "test-media/bowling-demo.mp4";
const OUT = "/tmp/bowl-wb-mirror";
const W = 1060,
  H = 954,
  FPS = 15,
  N = 130;
mkdirSync(OUT, { recursive: true });
execSync(
  `ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,
  { stdio: "pipe" }
);
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;
const dur = N / FPS;

function frameAt(fi: number) {
  const u8 = new Uint8ClampedArray(frameBytes);
  u8.set(raw.subarray(fi * frameBytes, (fi + 1) * frameBytes));
  return u8;
}
function fiAtTime(t: number) {
  return Math.max(0, Math.min(N - 1, Math.round(t * FPS)));
}
function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(H - 1, Math.floor((y / th) * H));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(W - 1, Math.floor((x / tw) * W));
      const si = (sy * W + sx) * 4;
      const di = (y * tw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}

// Workbench upload tryTimes — no early-break (upload needs probe diversity)
const tryTimes = Array.from(
  new Set(
    [
      0.08,
      Math.min(0.35, dur * 0.04),
      Math.min(0.8, dur * 0.1),
      Math.min(1.4, dur * 0.16),
      Math.min(dur * 0.28, dur - 0.12),
      Math.min(dur * 0.42, dur - 0.12),
      Math.min(dur * 0.58, dur - 0.12),
      Math.min(dur * 0.72, dur - 0.12),
      Math.min(dur * 0.85, dur - 0.08),
      Math.min(dur * 0.92, dur - 0.06),
      dur * 0.2,
    ].map((x) => Math.max(0, Math.min(x, Math.max(0, dur - 0.06))))
  )
);

type DetCand = {
  det: NonNullable<ReturnType<typeof detectLaneCorners>>;
  geom: number;
  t: number;
};
const detCands: DetCand[] = [];
for (const tSeek of tryTimes) {
  const fi = fiAtTime(tSeek);
  const rgba = frameAt(fi);
  if (!frameHasLaneSignal(rgba, W, H)) continue;
  const next = detectLaneCorners(rgba, W, H);
  if (next) {
    const sc = scoreLaneGeometry(next, W, H);
    detCands.push({ det: next, geom: sc, t: tSeek });
  }
  // Corra snap 易同亮段搶 topN 但 foulY 不同 → probe arr=—；只作低分候選
  const corra = detectLaneCornersCorra(rgba, W, H);
  if (corra && corra.confidence >= 0.55) {
    const snapped = {
      ...corra,
      corners: snapCornersToTrueGutter(corra.corners, W, H),
    };
    detCands.push({
      det: snapped,
      geom: scoreLaneGeometry(snapped, W, H) - 25,
      t: tSeek,
    });
  }
}
console.log("detCands", detCands.length, "(no early-break)");

const ranked = detCands
  .map((c) => {
    const corners = c.det.corners;
    const botFrac = (corners.br.x - corners.bl.x) / W;
    const midBot = (corners.bl.x + corners.br.x) / 2;
    const midFrac = Math.abs(midBot / W - 0.5);
    const widthOk =
      botFrac >= 0.5 && botFrac <= 0.54
        ? 36
        : botFrac >= 0.46 && botFrac < 0.5
          ? 28
          : botFrac >= 0.32 && botFrac <= 0.48
            ? 20
            : botFrac >= 0.28 && botFrac <= 0.55
              ? 6
              : -35;
    const midRightPen =
      midBot / W > 0.52 ? -18 : midBot / W > 0.5 ? -8 : 0;
    const midOk =
      (midFrac < 0.1 ? 22 : midFrac < 0.16 ? 6 : -30) + midRightPen;
    return { ...c, rank: c.geom + widthOk + midOk, botFrac, midBot };
  })
  .sort((a, b) => b.rank - a.rank);

console.log("geom top:");
for (const c of ranked.slice(0, 6)) {
  console.log(
    `  t=${c.t.toFixed(2)} geom=${c.geom.toFixed(1)} rank=${c.rank.toFixed(1)} bot=${c.botFrac.toFixed(3)} mid=${c.midBot.toFixed(0)}`
  );
}

// Continuous ~15fps buffer (same idea as Workbench probeN≈90)
const probeFrames: { rgba: Uint8ClampedArray; width: number; height: number }[] =
  [];
const probeN = Math.min(90, Math.max(40, Math.floor(Math.min(dur, 6.5) * FPS)));
const t0 = Math.min(0.35, Math.max(0.08, dur * 0.04));
for (let i = 0; i < probeN; i++) {
  const tP = Math.min(dur - 0.06, t0 + i / FPS);
  probeFrames.push({ rgba: frameAt(fiAtTime(tP)), width: W, height: H });
}

const picked = pickBestCornersByProbe(
  ranked.map((c) => ({ det: c.det, geomRank: c.rank })),
  probeFrames,
  10
);
if (!picked) {
  console.error("laneProbe picked nothing");
  process.exit(1);
}
console.log("laneProbe pick", {
  score: picked.detail.score.toFixed(1),
  med: picked.detail.med?.toFixed(1),
  arr: picked.detail.arrows?.toFixed(1) ?? "—",
  locks: picked.detail.locks,
  ft: `${picked.detail.minFeet.toFixed(1)}–${picked.detail.maxFeet.toFixed(1)}`,
  botFrac: (
    (picked.det.corners.br.x - picked.det.corners.bl.x) /
    W
  ).toFixed(3),
  midBot: (
    (picked.det.corners.bl.x + picked.det.corners.br.x) /
    2
  ).toFixed(0),
});

// Contrast: early-break single cand (old bug)
{
  const first = detCands[0];
  if (first) {
    const d = scoreCornersByProbe(first.det.corners, probeFrames, {
      geomRank: first.geom,
    });
    console.log("EARLY-BREAK-ONLY (bug path)", {
      t: first.t.toFixed(2),
      med: d.med?.toFixed(1),
      arr: d.arrows?.toFixed(1) ?? "—",
      locks: d.locks,
      ft: `${d.minFeet.toFixed(1)}–${d.maxFeet.toFixed(1)}`,
    });
  }
}

function fullTrackWB(corners: LaneCorners, sens: number, label: string) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = {
    ...DEFAULT_TRACKER,
    sensitivity: sens,
    minBlobPixels: sens <= 26 ? 28 : DEFAULT_TRACKER.minBlobPixels,
  };
  const pts: {
    image: { x: number; y: number };
    lane?: { board: number; feet: number };
    t: number;
    predicted?: boolean;
  }[] = [];
  for (let f = 0; f < N; f++) {
    const rgba = frameAt(f);
    const work =
      scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(
      work,
      scale < 1 ? tw : W,
      scale < 1 ? th : H
    );
    const res = trackBallFrame(
      state,
      gray,
      scale < 1 ? tw : W,
      scale < 1 ? th : H,
      settings,
      scale < 1 ? workC : corners,
      1000 / FPS,
      work
    );
    const pos = res.smoothed
      ? scale < 1
        ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale }
        : res.smoothed
      : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      const rFull =
        res.radius != null && res.radius > 0
          ? scale < 1
            ? res.radius / scale
            : res.radius
          : null;
      const contact = ballContactPoint(pos, rFull);
      const lane = imageToLane(Hm, contact);
      let accept = true;
      if (
        !res.predicted &&
        (lane.board < 1.2 || lane.board > 37.8) &&
        lane.feet < 45
      ) {
        accept = false;
      }
      if (accept && (pts.length > 0 || !res.predicted)) {
        pts.push({
          image: contact,
          lane,
          t: f * (1000 / FPS),
          predicted: res.predicted || undefined,
        });
      }
    }
  }
  const est = computeShotEstimate(pts as any, getRpmEstimate(state));
  const q = evaluateShotQuality(pts as any);
  console.log(label, {
    arrows: est.arrowsBoard,
    bp:
      est.breakpointBoard != null
        ? `${Number(est.breakpointBoard).toFixed(1)}@${est.breakpointDistance}`
        : null,
    cov: `${est.coverageFeetMin}–${est.coverageFeetMax}`,
    pocket: est.pocketBoard,
    avg: est.avgSpeedMph,
    L: est.launchSpeedMph,
    I: est.impactSpeedMph,
    n: pts.length,
    q: q.ok,
  });
  return est;
}

fullTrackWB(picked.det.corners, 26, "PROBE+sens26 (UI path)");
if (ranked[0]) {
  fullTrackWB(ranked[0].det.corners, 26, "GEOM-ONLY top1");
}
