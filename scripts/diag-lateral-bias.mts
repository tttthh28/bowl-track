/**
 * Quantify lateral bias: Corra raw / bright-band raw / current snap vs true gutters.
 * Green=left gutter, red=right gutter drawn along measured edges.
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { detectLaneCorners, snapCornersToTrueGutter } from "../src/lib/laneDetect.ts";
import { detectLaneCornersCorra } from "../src/lib/laneDetectCorra.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const ROOT = "/workspace/bowl-track";
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = join(ROOT, "tmp-reports/auto-corners-opus-2026-10-19");
const TMP = "/tmp/bowl-lateral";
const W = 1060, H = 954, FPS = 15, N = 120;
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const seqPath = `${TMP}/seq.rgba`;
if (!existsSync(seqPath)) {
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${seqPath}"`, { stdio: "pipe" });
}
const raw = readFileSync(seqPath);
const fb = W * H * 4;
const frameAt = (fi: number) => {
  const u = new Uint8ClampedArray(fb);
  u.set(raw.subarray(fi * fb, (fi + 1) * fb));
  return u;
};

function toGray(rgba: Uint8ClampedArray) {
  const g = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    g[i] = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
  }
  return g;
}

/** Multi-row gutter: prefer lane-15 by seeding mid near foul true mid then tracking up */
function measureGuttersAlong(rgba: Uint8ClampedArray, yFracs: number[]) {
  const gray = toGray(rgba);
  const results: { y: number; l: number; r: number; mid: number; frac: number }[] = [];
  let expectMid = W * 0.48; // start near foul mid of lane 15
  for (const yf of yFracs) {
    const y = Math.round(yf * H);
    const row = y * W;
    const gx = new Float64Array(W);
    for (let x = 1; x < W - 1; x++) gx[x] = Math.abs(gray[row + x + 1] - gray[row + x - 1]);
    const expectW = W * Math.min(0.58, Math.max(0.22, 0.22 + yf * 0.40));
    let best: { l: number; r: number; sc: number } | null = null;
    const xL0 = Math.max(2, Math.floor(expectMid - expectW * 0.7));
    const xL1 = Math.floor(expectMid - expectW * 0.25);
    const xR0 = Math.ceil(expectMid + expectW * 0.25);
    const xR1 = Math.min(W - 3, Math.ceil(expectMid + expectW * 0.7));
    const leftCands: { x: number; g: number; flank: number }[] = [];
    const rightCands: { x: number; g: number; flank: number }[] = [];
    for (let x = xL0; x <= xL1; x++) {
      const g = gx[x];
      if (g < 14) continue;
      let inM = 0, outM = 0, nI = 0, nO = 0;
      for (let k = 1; k <= 14; k++) {
        if (x + k < W) { inM += gray[row + x + k]; nI++; }
        if (x - k >= 0) { outM += gray[row + x - k]; nO++; }
      }
      const flank = nI && nO ? (inM / nI - outM / nO) / 40 : 0;
      if (flank < 0.15) continue;
      leftCands.push({ x, g, flank });
    }
    for (let x = xR0; x <= xR1; x++) {
      const g = gx[x];
      if (g < 14) continue;
      let inM = 0, outM = 0, nI = 0, nO = 0;
      for (let k = 1; k <= 14; k++) {
        if (x - k >= 0) { inM += gray[row + x - k]; nI++; }
        if (x + k < W) { outM += gray[row + x + k]; nO++; }
      }
      const flank = nI && nO ? (inM / nI - outM / nO) / 40 : 0;
      if (flank < 0.15) continue;
      rightCands.push({ x, g, flank });
    }
    for (const L of leftCands) {
      for (const R of rightCands) {
        const w = R.x - L.x;
        if (w < expectW * 0.7 || w > expectW * 1.35) continue;
        const mid = (L.x + R.x) / 2;
        const dist = Math.abs(mid - expectMid);
        if (dist > W * 0.08) continue;
        const sc = (L.g + R.g) * 0.08 + (L.flank + R.flank) * 20 - dist * 4 - Math.abs(w - expectW) / W * 40;
        if (!best || sc > best.sc) best = { l: L.x, r: R.x, sc };
      }
    }
    if (!best) {
      // fallback: strongest left/right near expect
      let bestL = { x: Math.floor(expectMid - expectW / 2), sc: -1e9 };
      let bestR = { x: Math.ceil(expectMid + expectW / 2), sc: -1e9 };
      for (const L of leftCands) {
        const sc = L.g * 0.1 + L.flank * 25 - Math.abs(L.x - (expectMid - expectW / 2)) * 0.05;
        if (sc > bestL.sc) bestL = { x: L.x, sc };
      }
      for (const R of rightCands) {
        const sc = R.g * 0.1 + R.flank * 25 - Math.abs(R.x - (expectMid + expectW / 2)) * 0.05;
        if (sc > bestR.sc) bestR = { x: R.x, sc };
      }
      best = { l: bestL.x, r: bestR.x, sc: bestL.sc + bestR.sc };
    }
    const mid = (best.l + best.r) / 2;
    results.push({ y, l: best.l, r: best.r, mid, frac: (best.r - best.l) / W });
    expectMid = expectMid * 0.35 + mid * 0.65;
  }
  return results;
}

function fitLine(ys: number[], xs: number[]) {
  const n = ys.length;
  let sy = 0, sx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sy += ys[i]; sx += xs[i]; syy += ys[i] * ys[i]; sxy += ys[i] * xs[i]; }
  const den = n * syy - sy * sy;
  if (Math.abs(den) < 1e-6) return null;
  const b = (n * sxy - sy * sx) / den;
  const a = (sx - b * sy) / n;
  return { a, b };
}

function xAt(fit: { a: number; b: number }, y: number) { return fit.a + fit.b * y; }

function cornersFromGutters(gs: { y: number; l: number; r: number }[], foulY: number, pinsY: number): LaneCorners | null {
  const ys = gs.map(g => g.y), ls = gs.map(g => g.l), rs = gs.map(g => g.r);
  const lf = fitLine(ys, ls), rf = fitLine(ys, rs);
  if (!lf || !rf) return null;
  return {
    tl: { x: xAt(lf, pinsY), y: pinsY },
    tr: { x: xAt(rf, pinsY), y: pinsY },
    bl: { x: xAt(lf, foulY), y: foulY },
    br: { x: xAt(rf, foulY), y: foulY },
  };
}

function writePng(rgba: Uint8ClampedArray, path: string) {
  const rawPath = path.replace(/\.png$/, ".rgba");
  writeFileSync(rawPath, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  execSync(`ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${rawPath}" -frames:v 1 "${path}"`, { stdio: "pipe" });
}

function drawCompare(
  rgba: Uint8ClampedArray,
  corners: LaneCorners,
  gutters: { y: number; l: number; r: number }[],
  label: string
) {
  const out = new Uint8ClampedArray(rgba);
  const setPx = (x: number, y: number, r: number, g: number, b: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const i = (yi * W + xi) * 4;
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
  };
  const thick = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, t = 2) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u;
      for (let dy = -t; dy <= t; dy++) for (let dx = -t; dx <= t; dx++) setPx(x + dx, y + dy, r, g, b);
    }
  };
  const marker = (x: number, y: number, r: number, g: number, b: number, rad = 9) => {
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++)
      if (dx * dx + dy * dy <= rad * rad) setPx(x + dx, y + dy, r, g, b);
  };
  // GREEN left gutter, RED right gutter (Tony true gutters)
  for (let i = 0; i < gutters.length - 1; i++) {
    thick(gutters[i].l, gutters[i].y, gutters[i + 1].l, gutters[i + 1].y, 40, 220, 60, 3);
    thick(gutters[i].r, gutters[i].y, gutters[i + 1].r, gutters[i + 1].y, 230, 50, 50, 3);
  }
  // light-blue auto corners
  const { tl, tr, br, bl } = corners;
  thick(tl.x, tl.y, tr.x, tr.y, 0, 200, 255, 3);
  thick(tr.x, tr.y, br.x, br.y, 0, 200, 255, 3);
  thick(br.x, br.y, bl.x, bl.y, 0, 200, 255, 3);
  thick(bl.x, bl.y, tl.x, tl.y, 0, 200, 255, 3);
  marker(tl.x, tl.y, 0, 200, 255); marker(tr.x, tr.y, 0, 200, 255);
  marker(bl.x, bl.y, 0, 200, 255); marker(br.x, br.y, 0, 200, 255);
  // label strip
  for (let x = 8; x < Math.min(W - 8, 8 + label.length * 8); x++)
    for (let y = 8; y < 28; y++) setPx(x, y, 0, 0, 0);
  return out;
}

function dxStats(corners: LaneCorners, gutters: { y: number; l: number; r: number }[]) {
  const ys = gutters.map(g => g.y), ls = gutters.map(g => g.l), rs = gutters.map(g => g.r);
  const lf = fitLine(ys, ls)!, rf = fitLine(ys, rs)!;
  const samples = [
    { name: "foul", y: (corners.bl.y + corners.br.y) / 2 },
    { name: "mid", y: H * 0.55 },
    { name: "pins", y: (corners.tl.y + corners.tr.y) / 2 },
  ];
  const out: Record<string, { dxL: number; dxR: number; trueL: number; trueR: number; blueL: number; blueR: number }> = {};
  for (const s of samples) {
    const t = (s.y - corners.tl.y) / Math.max(1e-6, corners.bl.y - corners.tl.y);
    const blueL = corners.tl.x + (corners.bl.x - corners.tl.x) * t;
    const blueR = corners.tr.x + (corners.br.x - corners.tr.x) * t;
    const trueL = xAt(lf, s.y), trueR = xAt(rf, s.y);
    out[s.name] = { dxL: blueL - trueL, dxR: blueR - trueR, trueL, trueR, blueL, blueR };
  }
  return out;
}

const fi = 21;
const rgba = frameAt(fi);
const yFracs = [0.88, 0.82, 0.74, 0.66, 0.58, 0.50, 0.42, 0.34, 0.26, 0.18, 0.12];
const gutters = measureGuttersAlong(rgba, yFracs);
console.log("TRUE GUTTERS (seed mid 0.48, track up):");
for (const g of gutters) console.log(`  y=${(g.y / H).toFixed(3)} L=${g.l} R=${g.r} mid=${g.mid.toFixed(1)} frac=${g.frac.toFixed(3)}`);

const foulY = gutters[0].y;
const pinsY = Math.round(H * 0.11);
const trueCorners = cornersFromGutters(gutters, foulY, pinsY)!;
console.log("\nTRUE corners from fit:", JSON.stringify(trueCorners, null, 0));
console.log("true mid foul", ((trueCorners.bl.x + trueCorners.br.x) / 2 / W).toFixed(3),
  "mid pins", ((trueCorners.tl.x + trueCorners.tr.x) / 2 / W).toFixed(3),
  "botFrac", ((trueCorners.br.x - trueCorners.bl.x) / W).toFixed(3),
  "topFrac", ((trueCorners.tr.x - trueCorners.tl.x) / W).toFixed(3));

// Current detect (with hard snap)
const det = detectLaneCorners(rgba, W, H);
console.log("\nCURRENT detect:", det?.message, "conf", det?.confidence.toFixed(2));
if (det) {
  const c = det.corners;
  console.log("  mid foul", ((c.bl.x + c.br.x) / 2 / W).toFixed(3),
    "mid pins", ((c.tl.x + c.tr.x) / 2 / W).toFixed(3),
    "botFrac", ((c.br.x - c.bl.x) / W).toFixed(3),
    "BL", c.bl.x.toFixed(0), "BR", c.br.x.toFixed(0),
    "TL", c.tl.x.toFixed(0), "TR", c.tr.x.toFixed(0));
  console.log("  dx vs true:", JSON.stringify(dxStats(c, gutters), null, 2));
}

// Corra raw (no snap)
const corra = detectLaneCornersCorra(rgba, W, H);
console.log("\nCORRA raw:", corra?.message, "conf", corra?.confidence.toFixed(2));
if (corra) {
  const c = corra.corners;
  console.log("  mid foul", ((c.bl.x + c.br.x) / 2 / W).toFixed(3),
    "mid pins", ((c.tl.x + c.tr.x) / 2 / W).toFixed(3),
    "botFrac", ((c.br.x - c.bl.x) / W).toFixed(3),
    "BL", c.bl.x.toFixed(0), "BR", c.br.x.toFixed(0),
    "TL", c.tl.x.toFixed(0), "TR", c.tr.x.toFixed(0));
  console.log("  dx vs true:", JSON.stringify(dxStats(c, gutters), null, 2));
}

// Write before (current) and true-ref overlays
writePng(drawCompare(rgba, det!.corners, gutters, "BEFORE snap mid0.470"), join(OUT, "before-fi21-current-snap.png"));
writePng(drawCompare(rgba, trueCorners, gutters, "TRUE gutter fit"), join(OUT, "ref-fi21-true-gutter-fit.png"));
if (corra) writePng(drawCompare(rgba, corra.corners, gutters, "CORRA raw"), join(OUT, "corra-raw-fi21.png"));

// probe arr for true vs current
const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });
const pCur = scoreCornersByProbe(det!.corners, probeFrames);
const pTrue = scoreCornersByProbe(trueCorners, probeFrames);
console.log("\nPROBE current arr", pCur.arrows, "med", pCur.med);
console.log("PROBE true-fit arr", pTrue.arrows, "med", pTrue.med);
writeFileSync(join(OUT, "lateral-bias.json"), JSON.stringify({
  gutters, trueCorners,
  current: det?.corners,
  corra: corra?.corners,
  dxCurrent: det ? dxStats(det.corners, gutters) : null,
  dxCorra: corra ? dxStats(corra.corners, gutters) : null,
  arrCurrent: pCur.arrows, arrTrue: pTrue.arrows,
}, null, 2));
console.log("WROTE", OUT);
