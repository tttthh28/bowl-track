/**
 * PBA HUD reject self-test + demo non-regress.
 * Writes screenshots + summary for tmp-reports/pba-hud-reject-2026-10-19.md
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  detectLaneCorners,
  detectBroadcastHud,
  cornersHitBroadcastHud,
  looksLikeBroadcastLane,
} from "/workspace/bowl-track/src/lib/laneDetect.ts";
import { scoreCornersByProbe } from "/workspace/bowl-track/src/lib/laneProbe.ts";
import { mappingCornersForTrack } from "/workspace/bowl-track/src/lib/perspective.ts";
import type { LaneCorners } from "/workspace/bowl-track/src/lib/types.ts";

const OUT = "/workspace/tmp-reports/pba-hud-reject-2026-10-19";
const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });

function ensureSeq(video: string, out: string, W: number, H: number, fps: number, n: number) {
  if (existsSync(out)) return;
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
function drawOverlay(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  corners: LaneCorners,
  maskRight?: number
) {
  const out = new Uint8ClampedArray(rgba);
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    const i = (yi * W + xi) * 4;
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  };
  const line = (
    x0: number, y0: number, x1: number, y1: number,
    r: number, g: number, b: number, thick = 3
  ) => {
    const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      for (let dy = -thick; dy <= thick; dy++)
        for (let dx = -thick; dx <= thick; dx++) set(x + dx, y + dy, r, g, b);
    }
  };
  const marker = (x: number, y: number, r: number, g: number, b: number, rad = 11) => {
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
  execSync(
    `ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${rawPath}" -frames:v 1 "${path}"`,
    { stdio: "pipe" }
  );
}

type Row = Record<string, string | number | boolean | null>;
const rows: Row[] = [];

// --- DEMO ---
{
  const W = 1060, H = 954, FPS = 15, N = 80;
  const seq = "/tmp/bowl-auto-vis/seq.rgba";
  ensureSeq("/workspace/bowl-track/test-media/bowling-demo.mp4", seq, W, H, FPS, N);
  const raw = readFileSync(seq);
  for (let run = 1; run <= 3; run++) {
    const fi = [21, 36, 48][run - 1];
    const rgba = frameAt(raw, W, H, fi);
    const hud = detectBroadcastHud(rgba, W, H);
    const det = detectLaneCorners(rgba, W, H);
    const frames = [];
    for (let f = 5; f < 70; f++) frames.push({ rgba: frameAt(raw, W, H, f), width: W, height: H });
    const arr = det ? scoreCornersByProbe(det.corners, frames).arrows : null;
    const mapArr = det
      ? scoreCornersByProbe(mappingCornersForTrack(det.corners), frames).arrows
      : null;
    const c = det?.corners;
    const gutterOk =
      !!c &&
      Math.abs(c.bl.x - 208) < 8 &&
      Math.abs(c.br.x - 802) < 8 &&
      Math.abs(c.tl.x - 562) < 8 &&
      Math.abs(c.tr.x - 694) < 8;
    const tony = arr != null && arr >= 13 && arr <= 15;
    const png = join(SHOTS, `demo-run${run}-fi${fi}-arr${arr ?? "na"}.png`);
    if (det) writePng(drawOverlay(rgba, W, H, det.corners), W, H, png);
    rows.push({
      clip: "bowling-demo",
      run,
      fi,
      hud: hud.present,
      brFrac: c ? +(c.br.x / W).toFixed(3) : null,
      botFrac: c ? +((c.br.x - c.bl.x) / W).toFixed(3) : null,
      hitHud: false,
      gutterOk,
      arr,
      mapArr,
      tony,
      pass: !!det && !hud.present && gutterOk && tony,
      png,
    });
  }
}

// --- PBA ---
for (const [clip, video, seqPath, fis, manual] of [
  [
    "PBA-01",
    "/workspace/bowl-track/test-media/pba-striketrack-01.mp4",
    "/tmp/pba-hud/pba01.rgba",
    [8, 12, 16],
    { bl: 249, br: 559 },
  ],
  [
    "PBA-10",
    "/workspace/bowl-track/test-media/pba-striketrack-10.mp4",
    "/tmp/pba-hud/pba10.rgba",
    [10, 15, 20],
    { bl: 366, br: 668 },
  ],
] as const) {
  const W = 1280, H = 720;
  ensureSeq(video, seqPath, W, H, 15, 60);
  const raw = readFileSync(seqPath);
  fis.forEach((fi, idx) => {
    const rgba = frameAt(raw, W, H, fi);
    const hud = detectBroadcastHud(rgba, W, H);
    const det = detectLaneCorners(rgba, W, H);
    const c = det?.corners;
    const hit = det
      ? cornersHitBroadcastHud(det.corners, W, H, hud.maskRight)
      : true;
    const brFrac = c ? c.br.x / W : 1;
    const botFrac = c ? (c.br.x - c.bl.x) / W : 0;
    const onLane =
      !!c &&
      !hit &&
      brFrac < 0.72 &&
      botFrac < 0.45 &&
      looksLikeBroadcastLane(c, W);
    // proximity to manual foul (soft)
    const dxL = c ? Math.abs(c.bl.x - manual.bl) : 999;
    const dxR = c ? Math.abs(c.br.x - manual.br) : 999;
    const png = join(SHOTS, `${clip.toLowerCase()}-run${idx + 1}-fi${fi}.png`);
    if (det) writePng(drawOverlay(rgba, W, H, det.corners, hud.maskRight), W, H, png);
    // also copy to workspace root for easy compare
    if (det && idx === 0) {
      const rootPng = `/workspace/visual-${clip.toLowerCase().replace("-", "")}-hudfix-run1.png`;
      writePng(drawOverlay(rgba, W, H, det.corners, hud.maskRight), W, H, rootPng);
    }
    rows.push({
      clip,
      run: idx + 1,
      fi,
      hud: hud.present,
      maskRight: hud.maskRight,
      brFrac: c ? +brFrac.toFixed(3) : null,
      botFrac: c ? +botFrac.toFixed(3) : null,
      hitHud: hit,
      dxL: c ? Math.round(dxL) : null,
      dxR: c ? Math.round(dxR) : null,
      onLane,
      pass: onLane,
      png,
      msg: det?.message ?? "null",
    });
  });
}

writeFileSync(join(OUT, "selftest.json"), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows, null, 2));

const demoPass = rows.filter((r) => r.clip === "bowling-demo").every((r) => r.pass);
const pbaPass = rows.filter((r) => String(r.clip).startsWith("PBA")).every((r) => r.pass);
console.log("\nSUMMARY demoPass", demoPass, "pbaPass", pbaPass);
