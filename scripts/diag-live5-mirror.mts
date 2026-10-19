/**
 * Workbench upload×5 faithful: tryTimes → rank → probe → snap → full track (contact).
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import {
  detectLaneCorners, snapCornersToTrueGutter, scoreLaneGeometry, frameHasLaneSignal,
} from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { pickBestCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

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

const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };

function fullTrack(corners: LaneCorners) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const pts: any[] = [];
  for (let f = 0; f < framesN; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000 / FPS, work);
    const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed) : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;
      const contact = ballContactPoint(pos, rFull);
      const lane = imageToLane(Hm, contact);
      let accept = true;
      if (!res.predicted && (lane.board < 1.2 || lane.board > 37.8) && lane.feet < 45) accept = false;
      if (accept && (pts.length > 0 || !res.predicted)) {
        pts.push({ image: contact, lane, t: f * (1000 / FPS), predicted: res.predicted || undefined });
      }
    }
  }
  return { est: computeShotEstimate(pts), n: pts.length };
}

function workbenchDetect() {
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
  const ranked = detCands.map((c) => {
    const corners = c.det.corners;
    const botFrac = (corners.br.x - corners.bl.x) / W;
    const midBot = (corners.bl.x + corners.br.x) / 2;
    const midFrac = Math.abs(midBot / W - 0.5);
    const widthOk = botFrac >= 0.5 && botFrac <= 0.54 ? 36 : botFrac >= 0.46 && botFrac < 0.5 ? 28 : 8;
    const midOk = (midFrac < 0.1 ? 22 : midFrac < 0.16 ? 6 : -30) + (midBot / W > 0.52 ? -18 : 0);
    return { ...c, rank: c.geom + widthOk + midOk };
  }).sort((a, b) => b.rank - a.rank);

  const probeN = Math.min(90, Math.max(40, Math.floor(Math.min(dur, 6.5) * 15)));
  const t0 = Math.min(0.35, Math.max(0.08, dur * 0.04));
  const frames: { rgba: Uint8ClampedArray; width: number; height: number }[] = [];
  for (let i = 0; i < probeN; i++) {
    const tP = Math.min(dur - 0.06, t0 + i / 15);
    const rgba = frameAt(fiAt(tP));
    if (!frameHasLaneSignal(rgba, W, H)) continue;
    frames.push({ rgba, width: W, height: H });
  }
  const picked = pickBestCornersByProbe(ranked.map((c) => ({ det: c.det, geomRank: c.rank })), frames, 10);
  let corners = picked?.det.corners ?? ranked[0]?.det.corners;
  if (!corners) return null;
  corners = snapCornersToTrueGutter(corners, W, H);
  return { corners, probeArr: picked?.detail.arrows ?? null, med: picked?.detail.med ?? null };
}

const tony = (a: number | null) => a != null && a >= 12.5 && a <= 15.5;
const rows = [];
for (let run = 1; run <= 5; run++) {
  const d = workbenchDetect();
  if (!d) { console.log(JSON.stringify({ run, err: "no detect" })); continue; }
  const { corners, probeArr, med } = d;
  const tr = fullTrack(corners);
  const botFrac = (corners.br.x - corners.bl.x) / W;
  const mid = (corners.bl.x + corners.br.x) / 2;
  const row = {
    run,
    probeArr,
    arrows: tr.est.arrowsBoard,
    bp: tr.est.breakpointBoard != null ? `${tr.est.breakpointBoard.toFixed(1)}@${tr.est.breakpointDistance}` : "—",
    avg: tr.est.averageBoard ?? null,
    pocket: tr.est.pocketBoard ?? null,
    botFrac: +botFrac.toFixed(3),
    mid: +mid.toFixed(0),
    bl: +corners.bl.x.toFixed(0),
    br: +corners.br.x.toFixed(0),
    med,
    n: tr.n,
    tonyProbe: tony(probeArr),
    tonyArr: tony(tr.est.arrowsBoard),
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const nP = rows.filter((r) => r.tonyProbe).length;
const nA = rows.filter((r) => r.tonyArr).length;
console.log("SUMMARY", { tonyProbe: `${nP}/5`, tonyArrows: `${nA}/5`, pass: nP === 5 && nA === 5 });
