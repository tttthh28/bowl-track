/** Foul fixed at true gutters; vary pins mid / topFrac → arr + visual dx */
import { readFileSync } from "fs";
import { join } from "path";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const TMP = "/tmp/bowl-lateral";
const W = 1060, H = 954;
const raw = readFileSync(`${TMP}/seq.rgba`);
const fb = W * H * 4;
const frameAt = (fi: number) => { const u = new Uint8ClampedArray(fb); u.set(raw.subarray(fi * fb, (fi + 1) * fb)); return u; };
const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });

const BL = 208, BR = 802, foulY = 0.86, pinsY = 0.11;
const fy = foulY * H, py = pinsY * H;

// true slopes from foul→mid tracking (y0.84→0.40):
// L: 208→422 (dy=-0.44*H≈-420, dL=+214) → slopeL ≈ 214/-420 ≈ -0.51
// R: 802→737 (dR=-65) → slopeR ≈ -65/-420 ≈ 0.155
// Full extrapolate pins: TL≈563 TR≈694 midP≈0.59 top≈0.12 — arr bad
// Try reduced skew: lerp toward vertical (less right lean)

console.log("foul fixed 208/802 @0.86; sweep pinMid × topFrac");
const rows: any[] = [];
for (const pinMid of [0.47, 0.48, 0.49, 0.50, 0.51, 0.52, 0.53, 0.54, 0.55, 0.56, 0.58, 0.60]) {
  for (const topF of [0.14, 0.16, 0.18, 0.20, 0.22, 0.24]) {
    const tl = pinMid * W - (topF * W) / 2;
    const tr = pinMid * W + (topF * W) / 2;
    const c: LaneCorners = {
      tl: { x: tl, y: py }, tr: { x: tr, y: py },
      bl: { x: BL, y: fy }, br: { x: BR, y: fy },
    };
    const d = scoreCornersByProbe(c, probeFrames);
    rows.push({ pinMid, topF, arr: d.arrows, med: d.med, tl: tl.toFixed(0), tr: tr.toFixed(0) });
  }
}
rows.sort((a, b) => {
  const sa = a.arr == null ? 99 : Math.abs(a.arr - 14.5);
  const sb = b.arr == null ? 99 : Math.abs(b.arr - 14.5);
  return sa - sb;
});
for (const r of rows.slice(0, 30)) {
  console.log(`pinMid=${r.pinMid.toFixed(2)} top=${r.topF.toFixed(2)} arr=${r.arr?.toFixed(1)??'—'} med=${r.med?.toFixed(1)??'—'} TL=${r.tl} TR=${r.tr}`);
}

// Also: foul mid shift with bot fixed 0.56, pinMid=foulMid (no skew) — current style
console.log("\nNo-skew (pinMid=foulMid), bot=0.56:");
for (const mid of [0.46, 0.47, 0.476, 0.48, 0.49, 0.50, 0.51]) {
  const half = 0.28 * W;
  const c: LaneCorners = {
    tl: { x: mid*W - 0.08*W, y: py }, tr: { x: mid*W + 0.08*W, y: py },
    bl: { x: mid*W - half, y: fy }, br: { x: mid*W + half, y: fy },
  };
  // adjust to exact bot 0.56
  const c2: LaneCorners = {
    tl: { x: mid*W - 0.08*W, y: py }, tr: { x: mid*W + 0.08*W, y: py },
    bl: { x: mid*W - 0.28*W, y: fy }, br: { x: mid*W + 0.28*W, y: fy },
  };
  const d = scoreCornersByProbe(c2, probeFrames);
  const dxL = c2.bl.x - 208, dxR = c2.br.x - 802;
  console.log(`mid=${mid.toFixed(3)} arr=${d.arrows?.toFixed(1)??'—'} med=${d.med?.toFixed(1)??'—'} dxL=${dxL.toFixed(0)} dxR=${dxR.toFixed(0)} BL=${c2.bl.x.toFixed(0)} BR=${c2.br.x.toFixed(0)}`);
}
