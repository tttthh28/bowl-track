/**
 * Fit lane-15 gutters from foul upward (dark-flank + |gx|), build corners, probe arr, dump overlay.
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = join(ROOT, "tmp-reports/auto-corners-opus-2026-10-19");
const TMP = "/tmp/bowl-lateral";
const W = 1060, H = 954, N = 120;
mkdirSync(OUT, { recursive: true });
const seqPath = `${TMP}/seq.rgba`;
const raw = readFileSync(seqPath);
const fb = W * H * 4;
const frameAt = (fi: number) => { const u = new Uint8ClampedArray(fb); u.set(raw.subarray(fi * fb, (fi + 1) * fb)); return u; };

function toGray(rgba: Uint8ClampedArray) {
  const g = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    g[i] = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
  }
  return g;
}

function fitLine(ys: number[], xs: number[]) {
  const n = ys.length;
  let sy = 0, sx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sy += ys[i]; sx += xs[i]; syy += ys[i]*ys[i]; sxy += ys[i]*xs[i]; }
  const den = n * syy - sy * sy;
  if (Math.abs(den) < 1e-6) return null;
  const b = (n * sxy - sy * sx) / den;
  const a = (sx - b * sy) / n;
  return { a, b };
}
function xAt(f: {a:number;b:number}, y: number) { return f.a + f.b * y; }

function fitRobust(ys: number[], xs: number[]) {
  const first = fitLine(ys, xs);
  if (!first) return null;
  const res = ys.map((y, i) => Math.abs(xs[i] - (first.a + first.b * y)));
  const sorted = [...res].sort((a,b)=>a-b);
  const med = sorted[Math.floor(sorted.length/2)] || 1;
  const thr = Math.max(4, med * 2.2);
  const iy: number[] = [], ix: number[] = [];
  for (let i = 0; i < ys.length; i++) if (res[i] <= thr) { iy.push(ys[i]); ix.push(xs[i]); }
  if (iy.length < 4) return { ...first, n: iy.length };
  const second = fitLine(iy, ix);
  return second ? { ...second, n: iy.length } : { ...first, n: iy.length };
}

/** Track gutters from foul (reliable) upward; reject width jumps */
function trackGutters(gray: Uint8ClampedArray) {
  const pts: { y: number; l: number; r: number; conf: number }[] = [];
  // Seed at foul band
  let expectMid = W * 0.476;
  let expectW = W * 0.56;
  for (let yf = 0.90; yf >= 0.14; yf -= 0.02) {
    const y = Math.round(yf * H);
    const row = y * W;
    const gx = new Float64Array(W);
    for (let x = 1; x < W - 1; x++) gx[x] = Math.abs(gray[row + x + 1] - gray[row + x - 1]);
    // tighten expectW with perspective
    const targetW = W * (0.18 + yf * 0.42); // ~0.56 at 0.9, ~0.24 at 0.14
    expectW = expectW * 0.4 + targetW * 0.6;
    const half = expectW * 0.55;
    const xL0 = Math.max(2, Math.floor(expectMid - half));
    const xL1 = Math.floor(expectMid - expectW * 0.28);
    const xR0 = Math.ceil(expectMid + expectW * 0.28);
    const xR1 = Math.min(W - 3, Math.ceil(expectMid + half));

    const scoreSide = (x: number, side: -1 | 1) => {
      const g = gx[x];
      if (g < 12) return -1e9;
      let inM = 0, outM = 0, nI = 0, nO = 0;
      for (let k = 1; k <= 16; k++) {
        const xi = x + side * k; // inside toward mid
        const xo = x - side * k; // outside
        if (xi >= 0 && xi < W) { inM += gray[row + xi]; nI++; }
        if (xo >= 0 && xo < W) { outM += gray[row + xo]; nO++; }
      }
      const flank = nI && nO ? (inM / nI - outM / nO) / 40 : 0;
      if (flank < 0.12) return -1e9;
      // prefer dark outside (gutter trough)
      let trough = 0;
      for (let k = 2; k <= 8; k++) {
        const xo = x - side * k;
        if (xo >= 0 && xo < W) trough += 80 - gray[row + xo];
      }
      return g * 0.1 + flank * 28 + trough * 0.02;
    };

    let bestL = { x: Math.floor(expectMid - expectW / 2), sc: -1e9 };
    let bestR = { x: Math.ceil(expectMid + expectW / 2), sc: -1e9 };
    for (let x = xL0; x <= xL1; x++) {
      const sc = scoreSide(x, 1);
      if (sc > bestL.sc) bestL = { x, sc };
    }
    for (let x = xR0; x <= xR1; x++) {
      const sc = scoreSide(x, -1);
      if (sc > bestR.sc) bestR = { x, sc };
    }
    if (bestL.sc < 0 || bestR.sc < 0) continue;
    const w = bestR.x - bestL.x;
    const mid = (bestL.x + bestR.x) / 2;
    // reject wild jumps
    if (Math.abs(mid - expectMid) > W * 0.06) continue;
    if (w < expectW * 0.65 || w > expectW * 1.4) continue;
    const conf = (bestL.sc + bestR.sc) / 2;
    // upper rows need higher conf
    if (yf < 0.35 && conf < 8) continue;
    pts.push({ y, l: bestL.x, r: bestR.x, conf });
    expectMid = expectMid * 0.45 + mid * 0.55;
    expectW = expectW * 0.5 + w * 0.5;
  }
  return pts;
}

function writePng(rgba: Uint8ClampedArray, path: string) {
  const rawPath = path.replace(/\.png$/, ".rgba");
  writeFileSync(rawPath, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  execSync(`ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${rawPath}" -frames:v 1 "${path}"`, { stdio: "pipe" });
}

function draw(rgba: Uint8ClampedArray, corners: LaneCorners, pts: {y:number;l:number;r:number}[]) {
  const out = new Uint8ClampedArray(rgba);
  const setPx = (x: number, y: number, r: number, g: number, b: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const i = (yi * W + xi) * 4;
    out[i] = r; out[i+1] = g; out[i+2] = b; out[i+3] = 255;
  };
  const thick = (x0:number,y0:number,x1:number,y1:number,r:number,g:number,b:number,t=2) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x1-x0,y1-y0)));
    for (let s=0;s<=steps;s++) {
      const u=s/steps, x=x0+(x1-x0)*u, y=y0+(y1-y0)*u;
      for (let dy=-t;dy<=t;dy++) for (let dx=-t;dx<=t;dx++) setPx(x+dx,y+dy,r,g,b);
    }
  };
  const marker = (x:number,y:number,r:number,g:number,b:number,rad=10) => {
    for (let dy=-rad;dy<=rad;dy++) for (let dx=-rad;dx<=rad;dx++)
      if (dx*dx+dy*dy<=rad*rad) setPx(x+dx,y+dy,r,g,b);
  };
  // measured points
  for (const p of pts) {
    marker(p.l, p.y, 40, 255, 60, 4);
    marker(p.r, p.y, 255, 50, 50, 4);
  }
  // green/red fitted lines full height of corners
  const ys = pts.map(p=>p.y), ls=pts.map(p=>p.l), rs=pts.map(p=>p.r);
  const lf = fitRobust(ys, ls)!, rf = fitRobust(ys, rs)!;
  for (let y = corners.tl.y; y <= corners.bl.y; y += 2) {
    marker(xAt(lf, y), y, 40, 220, 60, 1);
    marker(xAt(rf, y), y, 230, 50, 50, 1);
  }
  const {tl,tr,br,bl} = corners;
  thick(tl.x,tl.y,tr.x,tr.y,0,200,255,3);
  thick(tr.x,tr.y,br.x,br.y,0,200,255,3);
  thick(br.x,br.y,bl.x,bl.y,0,200,255,3);
  thick(bl.x,bl.y,tl.x,tl.y,0,200,255,3);
  marker(tl.x,tl.y,0,200,255); marker(tr.x,tr.y,0,200,255);
  marker(bl.x,bl.y,0,200,255); marker(br.x,br.y,0,200,255);
  return out;
}

const fi = 21;
const rgba = frameAt(fi);
const gray = toGray(rgba);
const pts = trackGutters(gray);
console.log("tracked", pts.length, "points");
for (const p of pts) console.log(`  y=${(p.y/H).toFixed(3)} L=${p.l} R=${p.r} mid=${((p.l+p.r)/2).toFixed(1)} w=${((p.r-p.l)/W).toFixed(3)} conf=${p.conf.toFixed(1)}`);

const foulBand = pts.filter(p => p.y/H >= 0.78);
const midBand = pts.filter(p => p.y/H >= 0.40 && p.y/H <= 0.75);
const usePts = [...foulBand, ...midBand].length >= 8 ? [...foulBand, ...midBand] : pts.filter(p => p.y/H >= 0.35);
console.log("usePts", usePts.length);

const ys = usePts.map(p=>p.y), ls=usePts.map(p=>p.l), rs=usePts.map(p=>p.r);
const lf = fitRobust(ys, ls)!, rf = fitRobust(ys, rs)!;
console.log("left fit a,b", lf.a.toFixed(1), lf.b.toFixed(4), "n", lf.n);
console.log("right fit a,b", rf.a.toFixed(1), rf.b.toFixed(4), "n", rf.n);

// Try several foulY/pinsY
const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });

const candidates: {foulY:number; pinsY:number; corners:LaneCorners; arr:number|null; med:number|null; dxL:number; dxR:number}[] = [];
for (const foulY of [0.84, 0.86, 0.88]) {
  for (const pinsY of [0.10, 0.11, 0.12]) {
    const fy = foulY * H, py = pinsY * H;
    const corners: LaneCorners = {
      tl: { x: xAt(lf, py), y: py },
      tr: { x: xAt(rf, py), y: py },
      bl: { x: xAt(lf, fy), y: fy },
      br: { x: xAt(rf, fy), y: fy },
    };
    const bot = corners.br.x - corners.bl.x;
    const top = corners.tr.x - corners.tl.x;
    if (bot < W*0.45 || bot > W*0.62 || top < W*0.10 || top > W*0.35) continue;
    const d = scoreCornersByProbe(corners, probeFrames);
    const trueL = 208, trueR = 802;
    candidates.push({
      foulY, pinsY, corners, arr: d.arrows, med: d.med,
      dxL: corners.bl.x - trueL, dxR: corners.br.x - trueR,
    });
  }
}
candidates.sort((a,b) => {
  const sa = Math.abs(a.dxL)+Math.abs(a.dxR)+ (a.arr==null?100:Math.abs(a.arr-14.5)*8);
  const sb = Math.abs(b.dxL)+Math.abs(b.dxR)+ (b.arr==null?100:Math.abs(b.arr-14.5)*8);
  return sa-sb;
});
console.log("\nCandidates:");
for (const c of candidates) {
  const bot=(c.corners.br.x-c.corners.bl.x)/W;
  const top=(c.corners.tr.x-c.corners.tl.x)/W;
  const midF=(c.corners.bl.x+c.corners.br.x)/2/W;
  const midP=(c.corners.tl.x+c.corners.tr.x)/2/W;
  console.log(`foulY=${c.foulY} pinsY=${c.pinsY} arr=${c.arr?.toFixed(1)??'—'} med=${c.med?.toFixed(1)??'—'} dxL=${c.dxL.toFixed(0)} dxR=${c.dxR.toFixed(0)} bot=${bot.toFixed(3)} top=${top.toFixed(3)} midF=${midF.toFixed(3)} midP=${midP.toFixed(3)} BL=${c.corners.bl.x.toFixed(0)} BR=${c.corners.br.x.toFixed(0)} TL=${c.corners.tl.x.toFixed(0)} TR=${c.corners.tr.x.toFixed(0)}`);
}

const best = candidates[0];
if (best) {
  writePng(draw(rgba, best.corners, usePts), join(OUT, "fit-best-fi21.png"));
  console.log("WROTE fit-best-fi21.png", "arr", best.arr);
}

// Also try calibrated: BL/BR = measured foul, top from fit slope but mid nudged
{
  const foulY = 0.86, pinsY = 0.11;
  const fy = foulY*H, py = pinsY*H;
  // force foul to measured 208/802
  const bl = 208, br = 802;
  // use line slopes from fit, anchored at foul
  const slopeL = lf.b, slopeR = rf.b;
  const tl = bl + slopeL * (py - fy);
  const tr = br + slopeR * (py - fy);
  const corners: LaneCorners = {
    tl: { x: tl, y: py }, tr: { x: tr, y: py },
    bl: { x: bl, y: fy }, br: { x: br, y: fy },
  };
  const d = scoreCornersByProbe(corners, probeFrames);
  console.log("\nAnchored foul 208/802 + fit slopes:", {
    arr: d.arrows, med: d.med,
    tl: tl.toFixed(0), tr: tr.toFixed(0),
    bot: ((br-bl)/W).toFixed(3), top: ((tr-tl)/W).toFixed(3),
    midF: ((bl+br)/2/W).toFixed(3), midP: ((tl+tr)/2/W).toFixed(3),
  });
  writePng(draw(rgba, corners, usePts), join(OUT, "fit-anchored-foul-fi21.png"));
}
