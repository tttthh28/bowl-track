/**
 * Post-fix self-test: detectLaneCorners → snap → dx vs L15 gutters + probe arr + overlays
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { detectLaneCorners, snapCornersToTrueGutter } from "../src/lib/laneDetect.ts";
import { scoreCornersByProbe, pickBestCornersByProbe } from "../src/lib/laneProbe.ts";
import { scoreLaneGeometry } from "../src/lib/laneDetect.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "tmp-reports/auto-corners-opus-2026-10-19");
const TMP = "/tmp/bowl-lateral";
const W = 1060, H = 954, N = 120;
mkdirSync(OUT, { recursive: true });
const raw = readFileSync(`${TMP}/seq.rgba`);
const fb = W * H * 4;
const frameAt = (fi: number) => {
  const u = new Uint8ClampedArray(fb);
  u.set(raw.subarray(fi * fb, (fi + 1) * fb));
  return u;
};

// L15 measured gutters (pinSign track)
const L15 = {
  foulL: 360, foulR: 805, foulY: 0.86,
  pinsL: 511, pinsR: 693, pinsY: 0.11,
};
function gL(yf: number) {
  return L15.foulL + (L15.pinsL - L15.foulL) * (L15.foulY - yf) / (L15.foulY - L15.pinsY);
}
function gR(yf: number) {
  return L15.foulR + (L15.pinsR - L15.foulR) * (L15.foulY - yf) / (L15.foulY - L15.pinsY);
}

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
  const marker = (x: number, y: number, r: number, g: number, b: number, rad = 10) => {
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++)
      if (dx * dx + dy * dy <= rad * rad) setPx(x + dx, y + dy, r, g, b);
  };
  // green left / red right true L15 gutters
  const y0 = L15.pinsY * H, y1 = L15.foulY * H;
  thick(gL(L15.pinsY), y0, gL(L15.foulY), y1, 40, 220, 60, 3);
  thick(gR(L15.pinsY), y0, gR(L15.foulY), y1, 230, 50, 50, 3);
  marker(L15.foulL, y1, 40, 255, 60, 7);
  marker(L15.foulR, y1, 255, 50, 50, 7);
  const { tl, tr, br, bl } = corners;
  thick(tl.x, tl.y, tr.x, tr.y, 0, 200, 255, 3);
  thick(tr.x, tr.y, br.x, br.y, 0, 200, 255, 3);
  thick(br.x, br.y, bl.x, bl.y, 0, 200, 255, 3);
  thick(bl.x, bl.y, tl.x, tl.y, 0, 200, 255, 3);
  marker(tl.x, tl.y, 0, 200, 255);
  marker(tr.x, tr.y, 0, 200, 255);
  marker(bl.x, bl.y, 0, 200, 255);
  marker(br.x, br.y, 0, 200, 255);
  return out;
}

function dxReport(c: LaneCorners) {
  const ys = [0.86, 0.70, 0.55, 0.40, 0.25, 0.11];
  const rows: any[] = [];
  let sum = 0;
  for (const yf of ys) {
    const y = yf * H;
    const t = (y - c.tl.y) / Math.max(1e-6, c.bl.y - c.tl.y);
    const bL = c.tl.x + (c.bl.x - c.tl.x) * t;
    const bR = c.tr.x + (c.br.x - c.tr.x) * t;
    const dL = bL - gL(yf), dR = bR - gR(yf);
    sum += Math.abs(dL) + Math.abs(dR);
    rows.push({ yf, dL, dR, bL, bR, tL: gL(yf), tR: gR(yf) });
  }
  return { meanAbs: sum / (ys.length * 2), foul: rows[0], pins: rows[5], mid: rows[2], rows };
}

const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });

const runs: any[] = [];
const visFrames = [21, 36, 48, 12, 60];
for (let run = 1; run <= 5; run++) {
  const fi = visFrames[run - 1];
  const rgba = frameAt(fi);
  const det = detectLaneCorners(rgba, W, H);
  if (!det) {
    console.log(`RUN${run} FAIL no detect`);
    continue;
  }
  const c = det.corners;
  const probe = scoreCornersByProbe(c, probeFrames);
  const dx = dxReport(c);
  const bot = (c.br.x - c.bl.x) / W;
  const midF = (c.bl.x + c.br.x) / 2 / W;
  const midP = (c.tl.x + c.tr.x) / 2 / W;
  const foulY = ((c.bl.y + c.br.y) / 2) / H;
  const pinsY = ((c.tl.y + c.tr.y) / 2) / H;
  const png = join(OUT, `after-run${run}-fi${fi}-arr${probe.arrows?.toFixed(1) ?? "na"}.png`);
  writePng(draw(rgba, c), png);
  const foulOk = Math.abs(dx.foul.dL) <= 20 && Math.abs(dx.foul.dR) <= 20;
  const arrOk = probe.arrows != null && probe.arrows >= 13 && probe.arrows <= 15.5;
  const row = {
    run, fi, bot, midF, midP, foulY, pinsY,
    arr: probe.arrows, med: probe.med, conf: det.confidence,
    BL: c.bl.x, BR: c.br.x, TL: c.tl.x, TR: c.tr.x,
    dxFoulL: dx.foul.dL, dxFoulR: dx.foul.dR,
    dxMidL: dx.mid.dL, dxMidR: dx.mid.dR,
    dxPinsL: dx.pins.dL, dxPinsR: dx.pins.dR,
    meanAbsDx: dx.meanAbs, foulOk, arrOk, png,
  };
  runs.push(row);
  console.log(
    `RUN${run} fi=${fi} bot=${bot.toFixed(3)} midF=${midF.toFixed(3)} midP=${midP.toFixed(3)} ` +
    `arr=${probe.arrows?.toFixed(1) ?? "—"} foulDx=${dx.foul.dL.toFixed(0)}/${dx.foul.dR.toFixed(0)} ` +
    `midDx=${dx.mid.dL.toFixed(0)}/${dx.mid.dR.toFixed(0)} pinsDx=${dx.pins.dL.toFixed(0)}/${dx.pins.dR.toFixed(0)} ` +
    `mean|dx|=${dx.meanAbs.toFixed(1)} foulOk=${foulOk} arrOk=${arrOk} → ${png}`
  );
}

// before reference (old hard lock numbers for report)
const before = {
  midF: 0.475, bot: 0.55, BL: 212, BR: 795, TL: 413, TR: 583,
  dxFoulL: 212 - 360, dxFoulR: 795 - 805, arr: 14.8,
};
writeFileSync(join(OUT, "selftest.json"), JSON.stringify({ before, runs, L15 }, null, 2));

const foulPass = runs.filter((r) => r.foulOk).length;
const arrPass = runs.filter((r) => r.arrOk).length;
console.log(`\nSUMMARY foul-on-gutter ${foulPass}/5  arr-band ${arrPass}/5`);
console.log("BEFORE foulDx", before.dxFoulL, before.dxFoulR);
if (runs[0]) console.log("AFTER  foulDx", runs[0].dxFoulL.toFixed(0), runs[0].dxFoulR.toFixed(0));
