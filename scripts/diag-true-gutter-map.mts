/**
 * 拆指標：真溝四角 × 接觸模式 × mid 鎖定 → arr
 * 並量測畫面 foul 列真溝寬（|gx|＋暗 flank）
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import { detectLaneCornersCorra } from "../src/lib/laneDetectCorra.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";

const VIDEO = "test-media/bowling-demo.mp4";
const OUT = "/tmp/bowl-tg";
const W = 1060, H = 954, FPS = 15, N = 120;
mkdirSync(OUT, { recursive: true });
execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, { stdio: "pipe" });
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W * H * 4;
const frameAt = (fi: number) => {
  const u = new Uint8ClampedArray(fb);
  u.set(raw.subarray(fi * fb, (fi + 1) * fb));
  return u;
};
function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(H - 1, Math.floor((y / th) * H));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(W - 1, Math.floor((x / tw) * W));
      const si = (sy * W + sx) * 4, di = (y * tw + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
    }
  }
  return out;
}

/** foul 列真溝：暗 flank + 強 |gx| */
function measureGutterAt(rgba: Uint8ClampedArray, yFrac: number) {
  const gray = rgbaToGray(rgba, W, H);
  const y = Math.round(yFrac * H);
  const row = y * W;
  const gx: number[] = [];
  for (let x = 1; x < W - 1; x++) gx[x] = Math.abs(gray[row + x + 1] - gray[row + x - 1]);
  const mid = Math.round(W * 0.42); // demo 略偏左
  // 左：由中向左找「內亮外暗」強邊
  let bestL = { x: mid, sc: -1e9 };
  for (let x = Math.floor(W * 0.05); x < mid; x++) {
    const g = gx[x] || 0;
    if (g < 20) continue;
    let inM = 0, outM = 0, nI = 0, nO = 0;
    for (let k = 1; k <= 12; k++) {
      if (x + k < W) { inM += gray[row + x + k]; nI++; }
      if (x - k >= 0) { outM += gray[row + x - k]; nO++; }
    }
    const flank = nI && nO ? (inM / nI - outM / nO) / 40 : 0;
    const sc = g * 0.1 + flank * 25 - Math.abs(x - (mid - W * 0.22)) * 0.02;
    if (sc > bestL.sc) bestL = { x, sc };
  }
  let bestR = { x: mid, sc: -1e9 };
  for (let x = mid; x < Math.floor(W * 0.95); x++) {
    const g = gx[x] || 0;
    if (g < 20) continue;
    let inM = 0, outM = 0, nI = 0, nO = 0;
    for (let k = 1; k <= 12; k++) {
      if (x - k >= 0) { inM += gray[row + x - k]; nI++; }
      if (x + k < W) { outM += gray[row + x + k]; nO++; }
    }
    const flank = nI && nO ? (inM / nI - outM / nO) / 40 : 0;
    const sc = g * 0.1 + flank * 25 - Math.abs(x - (mid + W * 0.22)) * 0.02;
    if (sc > bestR.sc) bestR = { x, sc };
  }
  return { y, l: bestL.x, r: bestR.x, frac: (bestR.x - bestL.x) / W, mid: (bestL.x + bestR.x) / 2 };
}

const rgba21 = frameAt(21);
console.log("=== gutter measure fi=21 ===");
for (const yf of [0.25, 0.4, 0.55, 0.7, 0.84, 0.9]) {
  console.log(yf, measureGutterAt(rgba21, yf));
}

type Mode = "none" | "contact" | "half" | "quarter";
function track(corners: any, mode: Mode) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const pts: any[] = [];
  for (let f = 0; f < N; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000 / FPS, work);
    const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed) : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;
      let pt = pos;
      if (mode === "contact") pt = ballContactPoint(pos, rFull);
      if (mode === "half" && rFull) pt = { x: pos.x, y: pos.y + rFull * 0.5 };
      if (mode === "quarter" && rFull) pt = { x: pos.x, y: pos.y + rFull * 0.25 };
      const lane = imageToLane(Hm, pt);
      if (pts.length > 0 || !res.predicted) pts.push({ image: pt, lane, t: f * (1000 / FPS), predicted: res.predicted || undefined });
    }
  }
  return { n: pts.length, est: computeShotEstimate(pts), pts };
}

const cur = detectLaneCorners(rgba21, W, H)!.corners;
const midGood = (cur.bl.x + cur.br.x) / 2; // ~449

// Build corners from measured gutters at multiple y → fit
const samples = [0.35, 0.45, 0.55, 0.65, 0.75, 0.84].map((yf) => measureGutterAt(rgba21, yf));
console.log("\n=== build from measured gutters, mid locked to", midGood.toFixed(0), "===");

function cornersFromBotTop(botL: number, botR: number, foulY: number, topHalfFrac: number, pinsY: number, mid = midGood) {
  const halfB = (botR - botL) / 2;
  // keep measured width but center on midGood
  return {
    bl: { x: mid - halfB, y: foulY },
    br: { x: mid + halfB, y: foulY },
    tl: { x: mid - topHalfFrac * W, y: pinsY },
    tr: { x: mid + topHalfFrac * W, y: pinsY },
  };
}

const g84 = measureGutterAt(rgba21, 0.84);
const g55 = measureGutterAt(rgba21, 0.55);
const variants: { name: string; c: any }[] = [
  { name: "current", c: cur },
  { name: "gutter0.84-rawMid", c: {
    bl: { x: g84.l, y: g84.y }, br: { x: g84.r, y: g84.y },
    tl: { x: g55.l + (g55.l - g84.l) * -0.5, y: 0.12 * H }, // rough
    tr: { x: g55.r + (g55.r - g84.r) * -0.5, y: 0.12 * H },
  }},
];

// Perspective: use measured L/R at 0.55 and 0.84 to extrapolate pins
function fitExtrapolate() {
  const ptsL = samples.map((s) => ({ y: s.y, x: s.l }));
  const ptsR = samples.map((s) => ({ y: s.y, x: s.r }));
  const fit = (pts: { y: number; x: number }[]) => {
    const n = pts.length;
    let sy = 0, sx = 0, syy = 0, sxy = 0;
    for (const p of pts) { sy += p.y; sx += p.x; syy += p.y * p.y; sxy += p.y * p.x; }
    const den = n * syy - sy * sy;
    const b = (n * sxy - sy * sx) / den;
    const a = (sx - b * sy) / n;
    return { a, b };
  };
  const L = fit(ptsL), R = fit(ptsR);
  const foulY = 0.84 * H, pinsY = 0.11 * H;
  let bl = { x: L.a + L.b * foulY, y: foulY };
  let br = { x: R.a + R.b * foulY, y: foulY };
  let tl = { x: L.a + L.b * pinsY, y: pinsY };
  let tr = { x: R.a + R.b * pinsY, y: pinsY };
  // recenter to midGood keeping width
  const midB = (bl.x + br.x) / 2;
  const shift = midGood - midB;
  bl = { ...bl, x: bl.x + shift }; br = { ...br, x: br.x + shift };
  tl = { ...tl, x: tl.x + shift }; tr = { ...tr, x: tr.x + shift };
  return { bl, br, tl, tr, botFrac: (br.x - bl.x) / W, mid: (bl.x + br.x) / 2 };
}

const fitted = fitExtrapolate();
console.log("fitted gutter+recenter", { botFrac: fitted.botFrac.toFixed(3), mid: fitted.mid.toFixed(0), pinsY: (fitted.tl.y / H).toFixed(3), foulY: (fitted.bl.y / H).toFixed(3) });
variants.push({ name: "fittedGutter-mid449", c: { bl: fitted.bl, br: fitted.br, tl: fitted.tl, tr: fitted.tr } });

// Also: fitted but bot only 0.50 / 0.54
for (const bf of [0.46, 0.50, 0.54, 0.56]) {
  variants.push({
    name: `bot${bf}-mid449-pins0.11`,
    c: cornersFromBotTop(0, bf * W, 0.84 * H, 0.08, 0.11 * H, midGood),
  });
}

const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });

for (const v of variants) {
  const bot = ((v.c.br.x - v.c.bl.x) / W).toFixed(3);
  const mid = ((v.c.bl.x + v.c.br.x) / 2).toFixed(0);
  for (const mode of ["none", "contact", "half", "quarter"] as Mode[]) {
    const { n, est } = track(v.c, mode);
    if (mode === "none" || mode === "contact" || (est.arrowsBoard != null && est.arrowsBoard >= 12 && est.arrowsBoard <= 16)) {
      console.log(`${v.name} bot=${bot} mid=${mid} ${mode}: arr=${est.arrowsBoard ?? "—"} bp=${est.breakpointBoard?.toFixed(1) ?? "—"}@${est.breakpointDistance ?? "—"} n=${n} cov=${est.coverageFeetMin}–${est.coverageFeetMax}`);
    }
  }
  const d = scoreCornersByProbe(v.c, probeFrames, { geomRank: 100 });
  console.log(`  probe: arr=${d.arrows ?? "—"} med=${d.med?.toFixed(1)} locks=${d.locks} ft=${d.minFeet.toFixed(1)}–${d.maxFeet.toFixed(1)}\n`);
}
