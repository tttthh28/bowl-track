/**
 * Corra Hough auto-corners self-test (LOCAL)
 * bowling-demo + PBA-01; screenshots → tmp-reports/corra-hough-2026-10-19/
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  detectLaneCorners,
  detectBroadcastHud,
  cornersHitBroadcastHud,
  looksLikeBroadcastLane,
  snapCornersToTrueGutter,
} from "../src/lib/laneDetect.ts";
import { detectLaneCornersHough } from "../src/lib/laneDetectHough.ts";
import { detectLaneCornersCorra } from "../src/lib/laneDetectCorra.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import { mappingCornersForTrack } from "../src/lib/perspective.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const OUT = join(import.meta.dirname, "../tmp-reports/corra-hough-2026-10-19");
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
function drawOverlay(rgba: Uint8ClampedArray, W: number, H: number, corners: LaneCorners, maskRight?: number) {
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
  if (maskRight != null) line(maskRight, 0, maskRight, H - 1, 255, 0, 255, 2);
  const { tl, tr, br, bl } = corners;
  line(tl.x, tl.y, tr.x, tr.y, 0, 220, 255);
  line(tr.x, tr.y, br.x, br.y, 0, 220, 255);
  line(br.x, br.y, bl.x, bl.y, 0, 220, 255);
  line(bl.x, bl.y, tl.x, tl.y, 0, 220, 255);
  marker(tl.x, tl.y, 255, 60, 60);
  marker(tr.x, tr.y, 255, 180, 40);
  marker(bl.x, bl.y, 80, 255, 80);
  marker(br.x, br.y, 80, 140, 255);
  return out;
}
function writePng(rgba: Uint8ClampedArray, W: number, H: number, path: string) {
  const rawPath = path.replace(/\.png$/, ".rgba");
  writeFileSync(rawPath, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  execSync(`ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${rawPath}" -frames:v 1 "${path}"`, { stdio: "pipe" });
}

const rows: any[] = [];

// --- DEMO ---
{
  const W = 1060, H = 954, FPS = 15, N = 80;
  const seq = "/tmp/bowl-auto-vis/seq.rgba";
  ensureSeq("/workspace/bowl-track/test-media/bowling-demo.mp4", seq, W, H, FPS, N);
  const raw = readFileSync(seq);
  const probeFrames = [];
  for (let f = 5; f < 70; f++) probeFrames.push({ rgba: frameAt(raw, W, H, f), width: W, height: H });

  // Measured L15 true gutters (geometry reference — not used as detector lock)
  const L15 = { foulL: 208, foulR: 802, pinsL: 562, pinsR: 694, foulY: 0.87, pinsY: 0.11 };

  for (let run = 1; run <= 3; run++) {
    const fi = [21, 36, 48][run - 1];
    const rgba = frameAt(raw, W, H, fi);
    const hud = detectBroadcastHud(rgba, W, H);
    const hough = detectLaneCornersHough(rgba, W, H);
    const corra = detectLaneCornersCorra(rgba, W, H);
    const det = detectLaneCorners(rgba, W, H);
    const arr = det ? scoreCornersByProbe(det.corners, probeFrames).arrows : null;
    const mapArr = det
      ? scoreCornersByProbe(mappingCornersForTrack(det.corners), probeFrames).arrows
      : null;
    const c = det?.corners;
    const foulDxL = c ? c.bl.x - L15.foulL : null;
    const foulDxR = c ? c.br.x - L15.foulR : null;
    const pinsDxL = c ? c.tl.x - L15.pinsL : null;
    const pinsDxR = c ? c.tr.x - L15.pinsR : null;
    const botFrac = c ? (c.br.x - c.bl.x) / W : null;
    const midBot = c ? (c.bl.x + c.br.x) / 2 / W : null;
    const pinY = c ? (c.tl.y + c.tr.y) / 2 / H : null;
    const tony = (mapArr ?? arr) != null && (mapArr ?? arr)! >= 13 && (mapArr ?? arr)! <= 15;
    const gutterVis =
      !!c &&
      Math.abs(foulDxL!) < 40 &&
      Math.abs(foulDxR!) < 40 &&
      botFrac! >= 0.45 &&
      botFrac! <= 0.65;
    const png = join(OUT, `demo-run${run}-fi${fi}-arr${(mapArr ?? arr)?.toFixed?.(1) ?? "na"}.png`);
    if (det) writePng(drawOverlay(rgba, W, H, det.corners), W, H, png);
    if (hough) writePng(drawOverlay(rgba, W, H, hough.corners), W, H, join(OUT, `demo-hough-fi${fi}.png`));
    rows.push({
      clip: "bowling-demo",
      run, fi,
      hud: hud.present,
      path: det?.message?.slice(0, 40) ?? null,
      hough: !!hough, corra: !!corra, det: !!det,
      BL: c ? Math.round(c.bl.x) : null,
      BR: c ? Math.round(c.br.x) : null,
      TL: c ? Math.round(c.tl.x) : null,
      TR: c ? Math.round(c.tr.x) : null,
      foulDxL: foulDxL != null ? +foulDxL.toFixed(1) : null,
      foulDxR: foulDxR != null ? +foulDxR.toFixed(1) : null,
      pinsDxL: pinsDxL != null ? +pinsDxL.toFixed(1) : null,
      pinsDxR: pinsDxR != null ? +pinsDxR.toFixed(1) : null,
      botFrac: botFrac != null ? +botFrac.toFixed(3) : null,
      midBot: midBot != null ? +midBot.toFixed(3) : null,
      pinY: pinY != null ? +pinY.toFixed(3) : null,
      arr, mapArr,
      tonyBand: tony,
      gutterVis,
      png,
    });
  }
}

// --- PBA-01 ---
{
  const W = 1280, H = 720, FPS = 10, N = 40;
  const seq = "/tmp/bowl-pba01-hough/seq.rgba";
  ensureSeq("/workspace/bowl-track/test-media/pba-striketrack-01.mp4", seq, W, H, FPS, N);
  const raw = readFileSync(seq);
  for (let run = 1; run <= 3; run++) {
    const fi = [8, 12, 16][run - 1];
    const rgba = frameAt(raw, W, H, fi);
    const hud = detectBroadcastHud(rgba, W, H);
    const det = detectLaneCorners(rgba, W, H);
    const hough = detectLaneCornersHough(rgba, W, H, hud.maskRight, { broadcastHint: true });
    const c = det?.corners;
    const hitHud = c ? cornersHitBroadcastHud(c, W, H, hud.maskRight) : null;
    const bcast = c ? looksLikeBroadcastLane(c, W) : null;
    const botFrac = c ? (c.br.x - c.bl.x) / W : null;
    const brFrac = c ? c.br.x / W : null;
    const png = join(OUT, `pba01-run${run}-fi${fi}.png`);
    if (det) writePng(drawOverlay(rgba, W, H, det.corners, hud.maskRight), W, H, png);
    else if (hough) writePng(drawOverlay(rgba, W, H, hough.corners, hud.maskRight), W, H, png);
    rows.push({
      clip: "pba-01",
      run, fi,
      hud: hud.present,
      maskR: hud.maskRight,
      det: !!det,
      hough: !!hough,
      BL: c ? Math.round(c.bl.x) : null,
      BR: c ? Math.round(c.br.x) : null,
      botFrac: botFrac != null ? +botFrac.toFixed(3) : null,
      brFrac: brFrac != null ? +brFrac.toFixed(3) : null,
      hitHud,
      bcast,
      msg: det?.message?.slice(0, 48) ?? null,
      png,
    });
  }
}

// Manual fallback smoke: null auto → snap keeps manual corners
{
  const manual: LaneCorners = {
    tl: { x: 400, y: 100 },
    tr: { x: 660, y: 100 },
    br: { x: 900, y: 850 },
    bl: { x: 160, y: 850 },
  };
  const kept = snapCornersToTrueGutter(manual, 1060, 954);
  rows.push({
    clip: "manual-fallback",
    keptEqual:
      Math.abs(kept.bl.x - manual.bl.x) < 1 &&
      Math.abs(kept.br.x - manual.br.x) < 1 &&
      Math.abs(kept.tl.x - manual.tl.x) < 1 &&
      Math.abs(kept.tr.x - manual.tr.x) < 1,
  });
}

writeFileSync(join(OUT, "selftest.json"), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows, null, 2));
