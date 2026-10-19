/** Sweep mid/bot/top against measured foul gutters + probe arr */
import { execSync } from "child_process";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const TMP = "/tmp/bowl-lateral";
const W = 1060, H = 954, FPS = 15, N = 120;
const seqPath = `${TMP}/seq.rgba`;
if (!existsSync(seqPath)) {
  mkdirSync(TMP, { recursive: true });
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${seqPath}"`, { stdio: "pipe" });
}
const raw = readFileSync(seqPath);
const fb = W * H * 4;
const frameAt = (fi: number) => { const u = new Uint8ClampedArray(fb); u.set(raw.subarray(fi * fb, (fi + 1) * fb)); return u; };
const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });

// Measured true foul gutters @0.86 from prior: ~200/805 mid~502.5; @0.84: 208/802
// Pins mid from perspective: camera slightly left → pins mid can be ~0.49-0.52
// Use foul L/R as anchors; vary top mid & topFrac & foulY

const trueFoulL = 208, trueFoulR = 802; // @0.84
const foulMids = [0.475, 0.485, 0.490, 0.495, 0.500, 0.505];
const botFracs = [0.52, 0.54, 0.55, 0.56, 0.57];
const topFracs = [0.16, 0.18, 0.20, 0.22, 0.24];
const pinMids = [0.47, 0.48, 0.49, 0.50, 0.51, 0.52];
const foulYs = [0.84, 0.86, 0.88];
const pinsY = 0.11;

type Row = { midF: number; bot: number; top: number; midP: number; foulY: number; arr: number | null; med: number | null; bl: number; br: number; tl: number; tr: number; dxL: number; dxR: number };
const rows: Row[] = [];

for (const midF of foulMids)
for (const bot of botFracs)
for (const top of topFracs)
for (const midP of pinMids)
for (const foulY of foulYs) {
  const half = bot / 2;
  const bl = midF * W - half * W;
  const br = midF * W + half * W;
  // asymmetric to match true: prefer L/R from mid+bot but soft-nudge to true
  const bl2 = bl, br2 = br;
  const th = top / 2;
  const tl = midP * W - th * W;
  const tr = midP * W + th * W;
  const corners: LaneCorners = {
    tl: { x: tl, y: pinsY * H },
    tr: { x: tr, y: pinsY * H },
    bl: { x: bl2, y: foulY * H },
    br: { x: br2, y: foulY * H },
  };
  const d = scoreCornersByProbe(corners, probeFrames);
  const arr = d.arrows;
  if (arr == null || arr < 12 || arr > 16) continue;
  const dxL = bl2 - trueFoulL;
  const dxR = br2 - trueFoulR;
  rows.push({ midF, bot, top, midP, foulY, arr, med: d.med, bl: bl2, br: br2, tl, tr, dxL, dxR });
}
rows.sort((a, b) => {
  const sa = Math.abs(a.dxL) + Math.abs(a.dxR) + Math.abs((a.arr ?? 99) - 14.5) * 5;
  const sb = Math.abs(b.dxL) + Math.abs(b.dxR) + Math.abs((b.arr ?? 99) - 14.5) * 5;
  return sa - sb;
});
console.log("TOP 25 by foul-dx + arr~14.5:");
for (const r of rows.slice(0, 25)) {
  console.log(`midF=${r.midF.toFixed(3)} bot=${r.bot.toFixed(2)} top=${r.top.toFixed(2)} midP=${r.midP.toFixed(2)} foulY=${r.foulY.toFixed(2)} arr=${r.arr?.toFixed(1)} med=${r.med?.toFixed(1)} dxL=${r.dxL.toFixed(0)} dxR=${r.dxR.toFixed(0)} BL=${r.bl.toFixed(0)} BR=${r.br.toFixed(0)}`);
}
console.log("total hits", rows.length);
