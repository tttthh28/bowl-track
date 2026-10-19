/** Compare sample bright-band widths / selectClosestEdges vs final clamped corners */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import { rgbaToGray } from "../src/lib/tracker.ts";

const VIDEO = "test-media/bowling-demo.mp4";
const OUT = "/tmp/bowl-width";
const W = 1060, H = 954;
mkdirSync(OUT, { recursive: true });
execSync(
  `ffmpeg -y -i "${VIDEO}" -vf "fps=15,scale=${W}:${H}" -frames:v 30 -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,
  { stdio: "pipe" }
);
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;
const fi = 21;
const rgba = new Uint8ClampedArray(frameBytes);
rgba.set(raw.subarray(fi * frameBytes, (fi + 1) * frameBytes));
const det = detectLaneCorners(rgba, W, H)!;
const c = det.corners;
console.log("FINAL corners", {
  botFrac: ((c.br.x - c.bl.x) / W).toFixed(3),
  topFrac: ((c.tr.x - c.tl.x) / W).toFixed(3),
  midBot: ((c.bl.x + c.br.x) / 2).toFixed(1),
  foulY: (((c.bl.y + c.br.y) / 2) / H).toFixed(3),
  pinsY: (((c.tl.y + c.tr.y) / 2) / H).toFixed(3),
  bl: c.bl, br: c.br, tl: c.tl, tr: c.tr,
  conf: det.confidence,
});

// Manual: scan gray for bright bands at several y
const gray = rgbaToGray(rgba, W, H);
function rowStats(y: number) {
  const row = y * W;
  // simple bright run near center
  const thr = 90;
  let bestL = 0, bestR = 0, bestW = 0;
  let s = -1;
  for (let x = 0; x < W; x++) {
    if (gray[row + x] >= thr) {
      if (s < 0) s = x;
    } else if (s >= 0) {
      const w = x - s;
      const mid = (s + x - 1) / 2;
      if (w > bestW && Math.abs(mid - W / 2) < W * 0.25) {
        bestW = w; bestL = s; bestR = x - 1;
      }
      s = -1;
    }
  }
  // also look for dark gutters flanking
  const mid = (bestL + bestR) / 2;
  // find strong |gx| peaks left/right of mid
  let leftEdge = bestL, rightEdge = bestR, maxGL = 0, maxGR = 0;
  for (let x = Math.floor(mid - W * 0.35); x < mid; x++) {
    if (x < 1 || x >= W - 1) continue;
    const g = Math.abs(gray[row + x + 1] - gray[row + x - 1]);
    if (g > maxGL) { maxGL = g; leftEdge = x; }
  }
  for (let x = Math.ceil(mid); x < mid + W * 0.35; x++) {
    if (x < 1 || x >= W - 1) continue;
    const g = Math.abs(gray[row + x + 1] - gray[row + x - 1]);
    if (g > maxGR) { maxGR = g; rightEdge = x; }
  }
  return {
    y,
    yFrac: (y / H).toFixed(3),
    brightL: bestL, brightR: bestR, brightW: (bestW / W).toFixed(3),
    edgeL: leftEdge, edgeR: rightEdge,
    edgeW: ((rightEdge - leftEdge) / W).toFixed(3),
    edgeMid: ((leftEdge + rightEdge) / 2).toFixed(0),
  };
}
for (const yf of [0.14, 0.25, 0.4, 0.55, 0.7, 0.84, 0.9]) {
  console.log(rowStats(Math.round(yf * H)));
}

// Compare final bot to idealBot formula
const topW = c.tr.x - c.tl.x;
const idealBot = Math.min(W * 0.46, Math.max(W * 0.34, Math.max(topW * 3.8, W * 0.36)));
console.log("idealBot frac", (idealBot / W).toFixed(3), "final bot", ((c.br.x - c.bl.x) / W).toFixed(3));
