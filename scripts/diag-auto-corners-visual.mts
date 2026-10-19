/**
 * Auto-corners visual self-test: real video frame + corner overlay + probe arr.
 * Writes PNGs under tmp-reports/auto-corners-visual-2026-10-19/
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { createRequire } from "module";
import {
  detectLaneCorners,
  snapCornersToTrueGutter,
  scoreLaneGeometry,
} from "../src/lib/laneDetect.ts";
import { pickBestCornersByProbe, scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const REPORT = join(ROOT, "tmp-reports/auto-corners-visual-2026-10-19");
const TMP = "/tmp/bowl-auto-vis";
const W = 1060, H = 954, FPS = 15, N = 120;

mkdirSync(REPORT, { recursive: true });
mkdirSync(TMP, { recursive: true });

const seqPath = `${TMP}/seq.rgba`;
if (!existsSync(seqPath)) {
  execSync(
    `ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${seqPath}"`,
    { stdio: "pipe" }
  );
}
const raw = readFileSync(seqPath);
const fb = W * H * 4;
function frameAt(fi: number) {
  const u = new Uint8ClampedArray(fb);
  u.set(raw.subarray(fi * fb, (fi + 1) * fb));
  return u;
}

/** Write RGBA → PNG via ffmpeg */
function writePng(rgba: Uint8ClampedArray, path: string) {
  const rawPath = path.replace(/\.png$/, ".rgba");
  writeFileSync(rawPath, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  execSync(
    `ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${rawPath}" -frames:v 1 "${path}"`,
    { stdio: "pipe" }
  );
}

function drawOverlay(
  rgba: Uint8ClampedArray,
  corners: LaneCorners,
  extras?: { trueG?: { l: number; r: number; y: number }; label?: string }
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const setPx = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const i = (yi * W + xi) * 4;
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
  };
  const thickLine = (
    x0: number, y0: number, x1: number, y1: number,
    r: number, g: number, b: number, thick = 3
  ) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      for (let dy = -thick; dy <= thick; dy++)
        for (let dx = -thick; dx <= thick; dx++)
          setPx(x + dx, y + dy, r, g, b);
    }
  };
  const marker = (x: number, y: number, r: number, g: number, b: number, rad = 10) => {
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++)
        if (dx * dx + dy * dy <= rad * rad) setPx(x + dx, y + dy, r, g, b);
  };
  // Detected quad (cyan)
  const { tl, tr, br, bl } = corners;
  thickLine(tl.x, tl.y, tr.x, tr.y, 0, 220, 255, 3);
  thickLine(tr.x, tr.y, br.x, br.y, 0, 220, 255, 3);
  thickLine(br.x, br.y, bl.x, bl.y, 0, 220, 255, 3);
  thickLine(bl.x, bl.y, tl.x, tl.y, 0, 220, 255, 3);
  marker(tl.x, tl.y, 255, 60, 60, 12);   // TL red
  marker(tr.x, tr.y, 255, 180, 40, 12);  // TR orange
  marker(bl.x, bl.y, 80, 255, 80, 12);   // BL green
  marker(br.x, br.y, 80, 120, 255, 12);  // BR blue

  // True gutter marks at foul (magenta)
  if (extras?.trueG) {
    const { l, r, y } = extras.trueG;
    marker(l, y, 255, 0, 255, 8);
    marker(r, y, 255, 0, 255, 8);
    thickLine(l, y, r, y, 255, 0, 255, 2);
  }
  return out;
}

/** Measure true foul gutters via |gx| + dark flank */
function measureTrueGutter(rgba: Uint8ClampedArray, yFrac: number) {
  const y = Math.round(yFrac * H);
  const gray = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    gray[i] = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
  }
  const row = y * W;
  const gx: number[] = [];
  for (let x = 1; x < W - 1; x++) gx[x] = Math.abs(gray[row + x + 1] - gray[row + x - 1]);
  const mid = Math.round(W * 0.42);
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

const probeFrames: { rgba: Uint8ClampedArray; width: number; height: number }[] = [];
for (let f = 5; f < Math.min(N, 95); f++) {
  probeFrames.push({ rgba: frameAt(f), width: W, height: H });
}

const tryFi = [1, 5, 12, 21, 36, 48, 60, 75, 90];
type Cand = {
  fi: number; geom: number; rank: number; conf: number;
  botFrac: number; midBot: number; foulY: number; pinsY: number;
  corners: LaneCorners; msg: string;
};
const cands: Cand[] = [];
for (const fi of tryFi) {
  const det = detectLaneCorners(frameAt(fi), W, H);
  if (!det || det.confidence < 0.4) continue;
  const geom = scoreLaneGeometry(det, W, H);
  const c = det.corners;
  const botFrac = (c.br.x - c.bl.x) / W;
  const midBot = (c.bl.x + c.br.x) / 2;
  const foulY = ((c.bl.y + c.br.y) / 2) / H;
  const pinsY = ((c.tl.y + c.tr.y) / 2) / H;
  const widthOk =
    botFrac >= 0.5 && botFrac <= 0.56 ? 36
    : botFrac >= 0.46 && botFrac < 0.5 ? 28
    : botFrac >= 0.32 && botFrac <= 0.48 ? 20
    : botFrac >= 0.28 && botFrac <= 0.58 ? 6 : -35;
  const midFrac = Math.abs(midBot / W - 0.5);
  const midRightPen = midBot / W > 0.52 ? -18 : midBot / W > 0.5 ? -8 : 0;
  const midOk = (midFrac < 0.1 ? 22 : midFrac < 0.16 ? 6 : -30) + midRightPen;
  cands.push({
    fi, geom, rank: geom + widthOk + midOk, conf: det.confidence,
    botFrac, midBot, foulY, pinsY, corners: c, msg: det.message,
  });
}
cands.sort((a, b) => b.rank - a.rank);

const runs: {
  run: number; botFrac: number; mid: number; arr: number | null; med: number | null;
  foulY: number; pinsY: number; png: string;
  tl: string; tr: string; bl: string; br: string;
  trueG: { l: number; r: number; mid: number; frac: number; y: number };
  dxL: number; dxR: number;
}[] = [];

for (let run = 1; run <= 5; run++) {
  // Mirror Workbench: pickBestCornersByProbe on ranked, then snap
  const picked = pickBestCornersByProbe(
    cands.map((c) => ({
      det: { corners: c.corners, confidence: c.conf, message: c.msg } as any,
      geomRank: c.rank,
    })),
    probeFrames,
    10
  );
  let corners: LaneCorners;
  let arr: number | null = null;
  let med: number | null = null;
  if (picked) {
    corners = snapCornersToTrueGutter(picked.det.corners, W, H);
    const d = scoreCornersByProbe(corners, probeFrames, { geomRank: picked.detail.score });
    arr = d.arrows;
    med = d.med;
  } else if (cands[0]) {
    corners = cands[0].corners;
    const d = scoreCornersByProbe(corners, probeFrames);
    arr = d.arrows;
    med = d.med;
  } else {
    console.error("no corners");
    process.exit(1);
  }

  // Use a clear mid-shot frame for visual (fi=21 or 36)
  const visFi = [21, 36, 48, 12, 60][run - 1] ?? 21;
  const rgba = frameAt(visFi);
  const trueG = measureTrueGutter(rgba, ((corners.bl.y + corners.br.y) / 2) / H);
  const overlay = drawOverlay(rgba, corners, { trueG: { l: trueG.l, r: trueG.r, y: trueG.y } });
  const pngName = `run${run}-fi${visFi}-arr${arr != null ? arr.toFixed(1) : "na"}.png`;
  const pngPath = join(REPORT, pngName);
  writePng(overlay, pngPath);

  const botFrac = (corners.br.x - corners.bl.x) / W;
  const mid = (corners.bl.x + corners.br.x) / 2;
  const foulY = ((corners.bl.y + corners.br.y) / 2) / H;
  const pinsY = ((corners.tl.y + corners.tr.y) / 2) / H;
  const dxL = corners.bl.x - trueG.l;
  const dxR = corners.br.x - trueG.r;

  runs.push({
    run, botFrac, mid, arr, med, foulY, pinsY, png: pngPath,
    tl: `(${corners.tl.x.toFixed(0)},${corners.tl.y.toFixed(0)})`,
    tr: `(${corners.tr.x.toFixed(0)},${corners.tr.y.toFixed(0)})`,
    bl: `(${corners.bl.x.toFixed(0)},${corners.bl.y.toFixed(0)})`,
    br: `(${corners.br.x.toFixed(0)},${corners.br.y.toFixed(0)})`,
    trueG: { l: trueG.l, r: trueG.r, mid: trueG.mid, frac: trueG.frac, y: trueG.y },
    dxL, dxR,
  });
  console.log(
    `RUN${run} fi=${visFi} bot=${botFrac.toFixed(3)} mid=${mid.toFixed(0)} arr=${arr?.toFixed(1) ?? "—"} med=${med?.toFixed(0) ?? "—"} ` +
    `foulY=${foulY.toFixed(3)} pinsY=${pinsY.toFixed(3)} ` +
    `BL=${corners.bl.x.toFixed(0)} BR=${corners.br.x.toFixed(0)} trueL=${trueG.l} trueR=${trueG.r} dxL=${dxL.toFixed(0)} dxR=${dxR.toFixed(0)} → ${pngPath}`
  );
}

// Also dump one "true gutter reference" frame with measured gutters only
{
  const rgba = frameAt(21);
  const tg084 = measureTrueGutter(rgba, 0.84);
  const tg086 = measureTrueGutter(rgba, 0.86);
  console.log("trueG@0.84", tg084);
  console.log("trueG@0.86", tg086);
  // pins-ish at 0.11
  const tgPins = measureTrueGutter(rgba, 0.25); // mid-lane clearer
  console.log("gutter@0.25", tgPins);
}

writeFileSync(join(REPORT, "runs.json"), JSON.stringify(runs, null, 2));
console.log("DONE", REPORT);
