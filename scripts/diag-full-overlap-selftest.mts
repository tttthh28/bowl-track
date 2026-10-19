/**
 * FULL green/red overlap self-test after TL/TR gutter snap.
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const OUT = join(import.meta.dirname, "../tmp-reports/auto-corners-opus-2026-10-19");
const TMP = "/tmp/bowl-lateral";
const W = 1060, H = 954;
mkdirSync(OUT, { recursive: true });
const raw = readFileSync(`${TMP}/seq.rgba`);
const fb = W * H * 4;
const frameAt = (fi: number) => {
  const u = new Uint8ClampedArray(fb);
  u.set(raw.subarray(fi * fb, (fi + 1) * fb));
  return u;
};

const L15 = { foulL: 208, foulR: 802, foulY: 0.86, pinsL: 562, pinsR: 694, pinsY: 0.11 };
const gL = (yf: number) =>
  L15.foulL + ((L15.pinsL - L15.foulL) * (L15.foulY - yf)) / (L15.foulY - L15.pinsY);
const gR = (yf: number) =>
  L15.foulR + ((L15.pinsR - L15.foulR) * (L15.foulY - yf)) / (L15.foulY - L15.pinsY);

function writePng(rgba: Uint8ClampedArray, path: string) {
  const rawPath = path.replace(/\.png$/, ".rgba");
  writeFileSync(rawPath, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  execSync(`ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${rawPath}" -frames:v 1 "${path}"`, { stdio: "pipe" });
}

function draw(rgba: Uint8ClampedArray, corners: LaneCorners) {
  const out = new Uint8ClampedArray(rgba);
  const setPx = (x: number, y: number, r: number, g: number, b: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const i = (yi * W + xi) * 4;
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = 255;
  };
  const thick = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, t = 3) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const x = x0 + (x1 - x0) * u, y = y0 + (y1 - y0) * u;
      for (let dy = -t; dy <= t; dy++) for (let dx = -t; dx <= t; dx++) setPx(x + dx, y + dy, r, g, b);
    }
  };
  const marker = (x: number, y: number, r: number, g: number, b: number, rad = 11) => {
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++)
      if (dx * dx + dy * dy <= rad * rad) setPx(x + dx, y + dy, r, g, b);
  };
  // green/red full L15 gutters
  thick(gL(L15.pinsY), L15.pinsY * H, gL(L15.foulY), L15.foulY * H, 40, 220, 60, 4);
  thick(gR(L15.pinsY), L15.pinsY * H, gR(L15.foulY), L15.foulY * H, 230, 50, 50, 4);
  marker(L15.foulL, L15.foulY * H, 40, 255, 60, 8);
  marker(L15.foulR, L15.foulY * H, 255, 50, 50, 8);
  marker(L15.pinsL, L15.pinsY * H, 40, 255, 60, 8);
  marker(L15.pinsR, L15.pinsY * H, 255, 50, 50, 8);
  const { tl, tr, br, bl } = corners;
  thick(tl.x, tl.y, tr.x, tr.y, 0, 200, 255, 3);
  thick(tr.x, tr.y, br.x, br.y, 0, 200, 255, 3);
  thick(br.x, br.y, bl.x, bl.y, 0, 200, 255, 3);
  thick(bl.x, bl.y, tl.x, tl.y, 0, 200, 255, 3);
  marker(tl.x, tl.y, 0, 200, 255, 10);
  marker(tr.x, tr.y, 0, 200, 255, 10);
  marker(bl.x, bl.y, 0, 200, 255, 10);
  marker(br.x, br.y, 0, 200, 255, 10);
  return out;
}

function dxAt(c: LaneCorners, yf: number) {
  const y = yf * H;
  const t = (y - c.tl.y) / Math.max(1e-6, c.bl.y - c.tl.y);
  const bL = c.tl.x + (c.bl.x - c.tl.x) * t;
  const bR = c.tr.x + (c.br.x - c.tr.x) * t;
  return { dL: bL - gL(yf), dR: bR - gR(yf), bL, bR };
}

const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });

const runs: any[] = [];
const vis = [21, 36, 48, 12, 60];
let allCornersOk = true;
for (let run = 1; run <= 5; run++) {
  const fi = vis[run - 1];
  const det = detectLaneCorners(frameAt(fi), W, H);
  if (!det) { console.log(`RUN${run} no detect`); allCornersOk = false; continue; }
  const c = det.corners;
  const probe = scoreCornersByProbe(c, probeFrames);
  const foul = dxAt(c, ((c.bl.y + c.br.y) / 2) / H);
  const pins = dxAt(c, ((c.tl.y + c.tr.y) / 2) / H);
  const mid = dxAt(c, 0.55);
  const meanAbs =
    (Math.abs(foul.dL) + Math.abs(foul.dR) + Math.abs(mid.dL) + Math.abs(mid.dR) +
      Math.abs(pins.dL) + Math.abs(pins.dR)) / 6;
  // PASS threshold: each corner within 15px of green/red
  const cornerOk =
    Math.abs(foul.dL) <= 15 && Math.abs(foul.dR) <= 15 &&
    Math.abs(pins.dL) <= 15 && Math.abs(pins.dR) <= 15;
  if (!cornerOk) allCornersOk = false;
  const bot = (c.br.x - c.bl.x) / W;
  const midF = (c.bl.x + c.br.x) / 2 / W;
  const midP = (c.tl.x + c.tr.x) / 2 / W;
  const top = (c.tr.x - c.tl.x) / W;
  const png = join(OUT, `full-run${run}-fi${fi}-arr${probe.arrows != null ? probe.arrows.toFixed(1) : "na"}.png`);
  writePng(draw(frameAt(fi), c), png);
  const row = {
    run, fi, bot, midF, midP, top, arr: probe.arrows, med: probe.med,
    BL: c.bl.x, BR: c.br.x, TL: c.tl.x, TR: c.tr.x,
    foul, mid, pins, meanAbs, cornerOk, png,
  };
  runs.push(row);
  console.log(
    `RUN${run} fi=${fi} bot=${bot.toFixed(3)} midF=${midF.toFixed(3)} midP=${midP.toFixed(3)} top=${top.toFixed(3)} ` +
    `arr=${probe.arrows?.toFixed(1) ?? "—"} ` +
    `foulDx=${foul.dL.toFixed(0)}/${foul.dR.toFixed(0)} midDx=${mid.dL.toFixed(0)}/${mid.dR.toFixed(0)} ` +
    `pinsDx=${pins.dL.toFixed(0)}/${pins.dR.toFixed(0)} mean|dx|=${meanAbs.toFixed(1)} ` +
    `cornersOk=${cornerOk} → ${png}`
  );
}

writeFileSync(join(OUT, "full-overlap-selftest.json"), JSON.stringify({ L15, runs, allCornersOk }, null, 2));
const arrVals = runs.map((r) => r.arr).filter((a) => a != null);
const arrInBand = arrVals.filter((a: number) => a >= 13 && a <= 15.5).length;
console.log(`\nVERDICT cornersOnGutter=${allCornersOk ? "PASS" : "FAIL"} (${runs.filter(r=>r.cornerOk).length}/5)`);
console.log(`arr in [13,15]: ${arrInBand}/${arrVals.length} (honest: ${arrVals.map((a:number)=>a.toFixed(1)).join(", ") || "none"})`);
console.log("Tony PASS only if cornersOnGutter PASS");
