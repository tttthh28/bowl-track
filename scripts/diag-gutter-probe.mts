import { readFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { detectLaneCornersHough } from "../src/lib/laneDetectHough.ts";
import {
  detectLaneCorners,
  detectBroadcastHud,
  cornersHitBroadcastHud,
  looksLikeBroadcastLane,
} from "../src/lib/laneDetect.ts";

const W = 1060,
  H = 954;
const raw = readFileSync("/tmp/bowl-auto-vis/seq.rgba");
const fi = 36;
const fb = W * H * 4;
const rgba = new Uint8ClampedArray(raw.subarray(fi * fb, (fi + 1) * fb));
const grayAt = (y: number, x: number) => {
  const o = (Math.round(y) * W + Math.round(x)) * 4;
  return (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
};

const foulY = Math.round(H * 0.87);
const row: number[] = [];
for (let x = 0; x < W; x++) {
  let g = 0;
  for (let dy = -2; dy <= 2; dy++) g += grayAt(foulY + dy, x);
  row.push(g / 5);
}
let bestL = { x: 0, sc: -1e9 },
  bestR = { x: 0, sc: -1e9 };
const Lpeaks: { x: number; flank: number; gx: number }[] = [];
for (let x = 40; x < W * 0.55; x++) {
  let out = 0,
    inn = 0;
  for (let k = 3; k <= 18; k++) {
    out += row[x - k] ?? 0;
    inn += row[x + k] ?? 0;
  }
  const flank = inn / 16 - out / 16;
  const gx = Math.abs(row[x + 1] - row[x - 1]);
  if (flank > 12 && gx > 6) Lpeaks.push({ x, flank: +flank.toFixed(1), gx: +gx.toFixed(1) });
  const sc = gx * 0.5 + flank * 2;
  if (sc > bestL.sc) bestL = { x, sc };
}
for (let x = W / 2; x < W - 40; x++) {
  let out = 0,
    inn = 0;
  for (let k = 3; k <= 18; k++) {
    out += row[x + k] ?? 0;
    inn += row[x - k] ?? 0;
  }
  const flank = inn / 16 - out / 16;
  const gx = Math.abs(row[x + 1] - row[x - 1]);
  const sc = gx * 0.5 + flank * 2;
  if (sc > bestR.sc) bestR = { x, sc };
}
Lpeaks.sort((a, b) => b.flank - a.flank);
console.log("foulY", foulY, "bestL", bestL, "bestR", bestR, "L15", 208, 802);
console.log("top L peaks", Lpeaks.slice(0, 15));

const pinY = Math.round(H * 0.11);
const prow: number[] = [];
for (let x = 0; x < W; x++) {
  let g = 0;
  for (let dy = -2; dy <= 2; dy++) g += grayAt(pinY + dy, x);
  prow.push(g / 5);
}
let pL = { x: 0, sc: -1e9 },
  pR = { x: 0, sc: -1e9 };
for (let x = 300; x < 600; x++) {
  let out = 0,
    inn = 0;
  for (let k = 2; k <= 12; k++) {
    out += prow[x - k] ?? 0;
    inn += prow[x + k] ?? 0;
  }
  const flank = inn / 11 - out / 11;
  const gx = Math.abs(prow[x + 1] - prow[x - 1]);
  const sc = gx + flank * 2;
  if (sc > pL.sc) pL = { x, sc };
}
for (let x = 600; x < 900; x++) {
  let out = 0,
    inn = 0;
  for (let k = 2; k <= 12; k++) {
    out += prow[x + k] ?? 0;
    inn += prow[x - k] ?? 0;
  }
  const flank = inn / 11 - out / 11;
  const gx = Math.abs(prow[x + 1] - prow[x - 1]);
  const sc = gx + flank * 2;
  if (sc > pR.sc) pR = { x, sc };
}
console.log("pinY", pinY, "pL", pL, "pR", pR, "L15pins", 562, 694);

const fmt = (c: any) =>
  c && {
    bl: Math.round(c.bl.x),
    br: Math.round(c.br.x),
    tl: Math.round(c.tl.x),
    tr: Math.round(c.tr.x),
    pinY: +((c.tl.y + c.tr.y) / 2 / H).toFixed(3),
    foulY: +((c.bl.y + c.br.y) / 2 / H).toFixed(3),
    bot: +((c.br.x - c.bl.x) / W).toFixed(3),
    top: +((c.tr.x - c.tl.x) / W).toFixed(3),
  };
const hough = detectLaneCornersHough(rgba, W, H);
const det = detectLaneCorners(rgba, W, H);
console.log("hough", fmt(hough?.corners), hough?.message);
console.log("det", fmt(det?.corners), det?.message);

const W2 = 1280,
  H2 = 720;
const pseq = "/tmp/bowl-pba01-hough/seq.rgba";
if (!existsSync(pseq)) {
  mkdirSync("/tmp/bowl-pba01-hough", { recursive: true });
  execSync(
    `ffmpeg -y -i test-media/pba-striketrack-01.mp4 -vf "fps=10,scale=${W2}:${H2}" -frames:v 40 -f rawvideo -pix_fmt rgba "${pseq}"`,
    { stdio: "pipe" }
  );
}
const raw2 = readFileSync(pseq);
const fi2 = 12;
const rgba2 = new Uint8ClampedArray(raw2.subarray(fi2 * W2 * H2 * 4, (fi2 + 1) * W2 * H2 * 4));
const hud = detectBroadcastHud(rgba2, W2, H2);
const det2 = detectLaneCorners(rgba2, W2, H2);
const h2 = detectLaneCornersHough(rgba2, W2, H2, hud.maskRight, { broadcastHint: true });
const fmt2 = (c: any) =>
  c && {
    bl: Math.round(c.bl.x),
    br: Math.round(c.br.x),
    tl: Math.round(c.tl.x),
    tr: Math.round(c.tr.x),
    pinY: +((c.tl.y + c.tr.y) / 2 / H2).toFixed(3),
    foulY: +((c.bl.y + c.br.y) / 2 / H2).toFixed(3),
    bot: +((c.br.x - c.bl.x) / W2).toFixed(3),
    top: +((c.tr.x - c.tl.x) / W2).toFixed(3),
  };
console.log("PBA hud", hud);
console.log(
  "PBA det",
  fmt2(det2?.corners),
  det2?.message,
  det2 && {
    hit: cornersHitBroadcastHud(det2.corners, W2, H2, hud.maskRight),
    bcast: looksLikeBroadcastLane(det2.corners, W2),
  }
);
console.log("PBA hough", fmt2(h2?.corners), h2?.message);

// Also PBA-10
const pseq10 = "/tmp/bowl-pba10-hough/seq.rgba";
if (!existsSync(pseq10)) {
  mkdirSync("/tmp/bowl-pba10-hough", { recursive: true });
  execSync(
    `ffmpeg -y -i test-media/pba-striketrack-10.mp4 -vf "fps=10,scale=${W2}:${H2}" -frames:v 40 -f rawvideo -pix_fmt rgba "${pseq10}"`,
    { stdio: "pipe" }
  );
}
const raw10 = readFileSync(pseq10);
const rgba10 = new Uint8ClampedArray(raw10.subarray(12 * W2 * H2 * 4, 13 * W2 * H2 * 4));
const hud10 = detectBroadcastHud(rgba10, W2, H2);
const det10 = detectLaneCorners(rgba10, W2, H2);
console.log(
  "PBA10 det",
  fmt2(det10?.corners),
  det10?.message,
  det10 && {
    hit: cornersHitBroadcastHud(det10.corners, W2, H2, hud10.maskRight),
    bcast: looksLikeBroadcastLane(det10.corners, W2),
  }
);
