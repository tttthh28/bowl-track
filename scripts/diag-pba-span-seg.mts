import { readFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

function ensure(path: string, video: string, n: number) {
  if (existsSync(path)) return;
  mkdirSync(path.replace(/\/seq\.rgba$/, ""), { recursive: true });
  execSync(`ffmpeg -y -i "${video}" -vf "fps=30,scale=1280:720" -frames:v ${n} -f rawvideo -pix_fmt rgba "${path}"`, { stdio: "pipe" });
}

function segmentPath(rawPts: TrackPoint[]): TrackPoint[] {
  const segments: TrackPoint[][] = [];
  let cur: TrackPoint[] = [];
  for (const p of rawPts) {
    if (!p.lane) continue;
    if (cur.length === 0) { cur.push(p); continue; }
    const prev = cur[cur.length - 1].lane!;
    const df = p.lane.feet - prev.feet;
    const db = Math.abs(p.lane.board - prev.board);
    if (df < -0.8 || db > 3.5) {
      if (cur.length >= 4) segments.push(cur);
      cur = [p];
    } else cur.push(p);
  }
  if (cur.length >= 4) segments.push(cur);
  // Prefer max feet span, then length, require span≥8 when possible
  segments.sort((a, b) => {
    const span = (s: TrackPoint[]) => {
      const f = s.map((p) => p.lane!.feet);
      return Math.max(...f) - Math.min(...f);
    };
    const sa = span(a), sb = span(b);
    if (Math.abs(sa - sb) > 2) return sb - sa;
    return b.length - a.length;
  });
  return segments[0] ?? rawPts;
}

function run(name: string, corners: LaneCorners, path: string, gt: { speed: number; arr: number; bp: number }) {
  const W = 1280, H = 720, FPS = 30;
  const raw = readFileSync(path);
  const fb = W * H * 4, nFrames = Math.floor(raw.length / fb);
  const frameAt = (i: number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + Math.min(nFrames - 1, i) * fb, fb);
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
  const settings = { ...DEFAULT_TRACKER };
  const rawPts: TrackPoint[] = [];
  for (let f = 0; f < nFrames; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000 / FPS, work);
    const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed) : null;
    const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      const contact = ballContactPoint(pos, rFull);
      const lane = imageToLane(Hm, contact);
      if (!lane) continue;
      if ((lane.board < 0.3 || lane.board > 38.7) && lane.feet < 50) continue;
      rawPts.push({ image: contact, lane, t: f * (1000 / FPS) });
    }
  }
  const best = segmentPath(rawPts);
  const toRight = (pts: TrackPoint[]) =>
    pts.map((p) => ({ ...p, lane: p.lane ? { feet: p.lane.feet, board: 39 - p.lane.board } : undefined }));
  const right = toRight(best);
  const e = computeShotEstimate(right);
  // Soft BP: if null, try without gutter reject by taking feetAtMaxHook board directly
  const band = right.filter((p) => p.lane && p.lane.feet >= 13 && p.lane.feet <= 18).map((p) => p.lane!.board);
  const medArr = band.length ? [...band].sort((a, b) => a - b)[Math.floor(band.length / 2)] : null;
  const arr = e.arrowsBoard ?? medArr;
  const pass = (g: number | null | undefined, t: number, tol: number) => g != null && Math.abs(g - t) <= tol;
  const ft = best.map((p) => p.lane!.feet);
  console.log(name, {
    n: best.length,
    ft: ft.length ? `${Math.min(...ft).toFixed(1)}–${Math.max(...ft).toFixed(1)}` : "—",
    arr, bp: e.breakpointBoard, bpd: e.breakpointDistance, avg: e.avgSpeedMph,
    pass: {
      speed: pass(e.avgSpeedMph, gt.speed, 3),
      arr: pass(arr, gt.arr, 2),
      bp: pass(e.breakpointBoard, gt.bp, 2),
    },
    gt,
  });
}

ensure("/tmp/pba-01/seq.rgba", "test-media/pba-striketrack-01.mp4", 110);
ensure("/tmp/pba-10/seq.rgba", "test-media/pba-striketrack-10.mp4", 140);
run("01", { tl:{x:522,y:245}, tr:{x:690,y:245}, br:{x:559,y:610}, bl:{x:249,y:610} }, "/tmp/pba-01/seq.rgba", { speed:18.3, arr:9.3, bp:4 });
run("10", { tl:{x:496,y:180}, tr:{x:753,y:180}, br:{x:668,y:470}, bl:{x:366,y:470} }, "/tmp/pba-10/seq.rgba", { speed:16, arr:14.9, bp:7.6 });
