/**
 * Corra Hough TL / pinY / mid-wedge fix self-test — 2026-10-19
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  detectLaneCorners,
  detectBroadcastHud,
  isLaneMaskOverlay,
  isNarrowMidLaneWedge,
  snapCornersToTrueGutter,
} from "../src/lib/laneDetect.ts";
import { detectLaneCornersHough } from "../src/lib/laneDetectHough.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import { mappingCornersForTrack } from "../src/lib/perspective.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const OUT = join(import.meta.dirname, "../tmp-reports/corra-hough-tl-wedge-2026-10-19");
mkdirSync(OUT, { recursive: true });

function ensureSeq(video: string, out: string, W: number, H: number, fps: number, n: number) {
  if (existsSync(out) && readFileSync(out).length >= W * H * 4 * Math.min(n, 5)) return;
  mkdirSync(out.replace(/\/[^/]+$/, ""), { recursive: true });
  execSync(
    `ffmpeg -y -i "${video}" -vf "fps=${fps},scale=${W}:${H}" -frames:v ${n} -f rawvideo -pix_fmt rgba "${out}"`,
    { stdio: "pipe" }
  );
}
function frameAt(raw: Buffer, W: number, H: number, fi: number) {
  const fb = W * H * 4;
  const u = new Uint8ClampedArray(fb);
  u.set(raw.subarray(fi * fb, (fi + 1) * fb));
  return u;
}
function drawOverlay(rgba: Uint8ClampedArray, W: number, H: number, corners: LaneCorners | null, label: string) {
  const out = new Uint8ClampedArray(rgba);
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const i = (yi * W + xi) * 4;
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  };
  const line = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, thick = 3) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      for (let dy = -thick; dy <= thick; dy++)
        for (let dx = -thick; dx <= thick; dx++) set(x + dx, y + dy, r, g, b);
    }
  };
  const marker = (x: number, y: number, r: number, g: number, b: number, rad = 10) => {
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++)
        if (dx * dx + dy * dy <= rad * rad) set(x + dx, y + dy, r, g, b);
  };
  // L15 reference: foul + pin-head Y≈0.083
  if (W === 1060) {
    line(208, H * 0.87, 552, H * 0.0888, 0, 255, 80, 2);
    line(802, H * 0.87, 697, H * 0.0888, 255, 60, 60, 2);
    // AMF band marker (~0.063) and neck band (~0.11)
    line(540, H * 0.063, 720, H * 0.063, 255, 200, 0, 1);
    line(540, H * 0.11, 720, H * 0.11, 255, 100, 255, 1);
  }
  if (corners) {
    const { tl, tr, br, bl } = corners;
    line(tl.x, tl.y, tr.x, tr.y, 0, 220, 255);
    line(tr.x, tr.y, br.x, br.y, 0, 220, 255);
    line(br.x, br.y, bl.x, bl.y, 0, 220, 255);
    line(bl.x, bl.y, tl.x, tl.y, 0, 220, 255);
    marker(tl.x, tl.y, 255, 60, 60);
    marker(tr.x, tr.y, 255, 180, 40);
    marker(bl.x, bl.y, 80, 255, 80);
    marker(br.x, br.y, 80, 140, 255);
  }
  return out;
}
function writePng(rgba: Uint8ClampedArray, W: number, H: number, path: string) {
  const rawPath = path.replace(/\.png$/, ".rgba");
  writeFileSync(rawPath, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  execSync(`ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${rawPath}" -frames:v 1 "${path}"`, { stdio: "pipe" });
}

function abovePinFrac(rgba: Uint8ClampedArray, W: number, H: number, pinY: number) {
  // bright whites above cyan top in pin corridor
  let wh = 0, n = 0;
  const y0 = Math.max(2, Math.floor(H * 0.05));
  const y1 = Math.max(y0 + 2, Math.floor(pinY - 2));
  for (let y = y0; y < y1; y += 2) {
    for (let x = 560; x < 720; x += 2) {
      const o = (y * W + x) * 4;
      const g = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
      n++;
      if (g > 175) wh++;
    }
  }
  return n ? wh / n : 0;
}

const rows: any[] = [];
const L15 = { foulL: 208, foulR: 802, pinsL: 550, pinsR: 698 }; // at pinY≈0.083

// DEMO
{
  const W = 1060, H = 954, FPS = 15, N = 80;
  const seq = "/tmp/bowl-auto-vis/seq.rgba";
  ensureSeq("/workspace/bowl-track/test-media/bowling-demo.mp4", seq, W, H, FPS, N);
  const raw = readFileSync(seq);
  const probeFrames = [];
  for (let f = 5; f < 70; f++) probeFrames.push({ rgba: frameAt(raw, W, H, f), width: W, height: H });

  for (let run = 1; run <= 3; run++) {
    const fi = [21, 36, 48][run - 1];
    const rgba = frameAt(raw, W, H, fi);
    const hough = detectLaneCornersHough(rgba, W, H);
    const det = detectLaneCorners(rgba, W, H);
    const arr = det ? scoreCornersByProbe(det.corners, probeFrames).arrows : null;
    const mapArr = det
      ? scoreCornersByProbe(det.corners, probeFrames).arrows
      : null;
    const c = det?.corners;
    const foulDxL = c ? c.bl.x - L15.foulL : null;
    const foulDxR = c ? c.br.x - L15.foulR : null;
    const pinsDxL = c ? c.tl.x - L15.pinsL : null;
    const pinsDxR = c ? c.tr.x - L15.pinsR : null;
    const botFrac = c ? (c.br.x - c.bl.x) / W : null;
    const pinY = c ? (c.tl.y + c.tr.y) / 2 / H : null;
    const above = c ? abovePinFrac(rgba, W, H, (c.tl.y + c.tr.y) / 2) : null;
    const headsOk = !!c && pinY! >= 0.084 && pinY! <= 0.095;
    const notAmf = !!c && pinY! >= 0.072;
    const notNecks = !!c && pinY! <= 0.095;
    const gutterVis =
      !!c &&
      Math.abs(foulDxL!) < 25 &&
      Math.abs(foulDxR!) < 25 &&
      Math.abs(pinsDxL!) < 35 &&
      Math.abs(pinsDxR!) < 35 &&
      botFrac! >= 0.5 &&
      botFrac! <= 0.64 &&
      headsOk;
    const png = join(OUT, `demo-run${run}-fi${fi}-pinY${pinY?.toFixed(3) ?? "na"}.png`);
    writePng(drawOverlay(rgba, W, H, det?.corners ?? null, "demo"), W, H, png);
    rows.push({
      clip: "bowling-demo", run, fi,
      path: det?.message?.slice(0, 40) ?? null,
      hough: !!hough, det: !!det,
      BL: c ? Math.round(c.bl.x) : null, BR: c ? Math.round(c.br.x) : null,
      TL: c ? Math.round(c.tl.x) : null, TR: c ? Math.round(c.tr.x) : null,
      foulDxL: foulDxL != null ? +foulDxL.toFixed(1) : null,
      foulDxR: foulDxR != null ? +foulDxR.toFixed(1) : null,
      pinsDxL: pinsDxL != null ? +pinsDxL.toFixed(1) : null,
      pinsDxR: pinsDxR != null ? +pinsDxR.toFixed(1) : null,
      botFrac: botFrac != null ? +botFrac.toFixed(3) : null,
      pinY: pinY != null ? +pinY.toFixed(3) : null,
      aboveFrac: above != null ? +above.toFixed(3) : null,
      arr, mapArr, gutterVis, headsOk, notAmf, notNecks, png,
    });
  }
}

// PBA
for (const clip of [
  { name: "pba-01", video: "test-media/pba-striketrack-01.mp4", seq: "/tmp/bowl-pba01-hough/seq.rgba" },
  { name: "pba-10", video: "test-media/pba-striketrack-10.mp4", seq: "/tmp/bowl-pba10-hough/seq.rgba" },
] as const) {
  const W = 1280, H = 720, FPS = 10, N = 40;
  ensureSeq(join("/workspace/bowl-track", clip.video), clip.seq, W, H, FPS, N);
  const raw = readFileSync(clip.seq);
  for (let run = 1; run <= 3; run++) {
    const fi = [8, 12, 16][run - 1];
    // Also probe a few more frames that previously escaped
    const extra = run === 3 ? [20, 28, 32] : [];
    for (const f of [fi, ...extra]) {
      const rgba = frameAt(raw, W, H, f);
      const hud = detectBroadcastHud(rgba, W, H);
      const hough = detectLaneCornersHough(rgba, W, H, hud.present ? hud.maskRight : W, { broadcastHint: true });
      const det = detectLaneCorners(rgba, W, H);
      const c = det?.corners;
      const wedge = c ? isNarrowMidLaneWedge(c, W, H) : null;
      const mask = c ? isLaneMaskOverlay(c, rgba, W, H, hud.maskRight) : (hough ? isLaneMaskOverlay(hough.corners, rgba, W, H, hud.maskRight) : null);
      const png = join(OUT, `${clip.name}-fi${f}-${det ? "DET" : "NULL"}.png`);
      writePng(drawOverlay(rgba, W, H, det?.corners ?? null, clip.name), W, H, png);
      rows.push({
        clip: clip.name, fi: f, hud: hud.present,
        hough: !!hough, det: !!det,
        wedge, mask,
        tonyPba: !det, // null → manual fail-open
        BL: c ? Math.round(c.bl.x) : null,
        BR: c ? Math.round(c.br.x) : null,
        pinY: c ? +((c.tl.y + c.tr.y) / 2 / H).toFixed(3) : null,
        png,
      });
    }
  }
}

// Manual
{
  const W = 1060, H = 954;
  const manual: LaneCorners = {
    tl: { x: 555, y: H * 0.088 },
    tr: { x: 695, y: H * 0.088 },
    bl: { x: 208, y: H * 0.87 },
    br: { x: 802, y: H * 0.87 },
  };
  const snapped = snapCornersToTrueGutter(manual, W, H);
  const keptEqual = JSON.stringify(snapped) === JSON.stringify(manual);
  rows.push({ clip: "manual", keptEqual, snapped });
}

writeFileSync(join(OUT, "results.json"), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows, null, 2));
