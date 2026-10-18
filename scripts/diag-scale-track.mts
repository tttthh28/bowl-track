/**
 * Prove: track on downscaled buffer (map corners), remap points to full-res for lane.
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, rgbaToGray, trackBallFrame,
} from "../src/lib/tracker.ts";
import { detectLaneCorners, scoreLaneGeometry } from "../src/lib/laneDetect.ts";
import { imageToLane, buildHomography, defaultCorners } from "../src/lib/perspective.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-scaletrack";
mkdirSync(OUT, { recursive: true });
const W = 1060, H = 954, FPS = 15, N = 120;
execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba" 2>/dev/null`, { stdio: "pipe" });
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W * H * 4;
const frames = Math.floor(raw.length / fb);

let det = null as any, bestG = -1e9;
for (const fi of [0, 8, 16, 24, 40]) {
  const cand = detectLaneCorners(new Uint8ClampedArray(raw.subarray(fi * fb, fi * fb + fb)), W, H);
  if (!cand) continue;
  const g = scoreLaneGeometry(cand, W, H);
  if (g > bestG) { bestG = g; det = cand; }
}
const cornersFull = det.corners;
const Hm = buildHomography(cornersFull)!;

function downscale(rgba: Uint8ClampedArray, sw: number, sh: number) {
  const out = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(H - 1, Math.floor((y / sh) * H));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(W - 1, Math.floor((x / sw) * W));
      const si = (sy * W + sx) * 4;
      const di = (y * sw + x) * 4;
      out[di] = rgba[si]; out[di+1]=rgba[si+1]; out[di+2]=rgba[si+2]; out[di+3]=255;
    }
  }
  return out;
}

function runTrack(mode: "full" | "down", tw: number, th: number) {
  const sx = tw / W, sy = th / H;
  const corners = mode === "full" ? cornersFull : {
    tl: { x: cornersFull.tl.x * sx, y: cornersFull.tl.y * sy },
    tr: { x: cornersFull.tr.x * sx, y: cornersFull.tr.y * sy },
    br: { x: cornersFull.br.x * sx, y: cornersFull.br.y * sy },
    bl: { x: cornersFull.bl.x * sx, y: cornersFull.bl.y * sy },
  };
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  let points: any[] = [];
  let shotStart = 0;
  for (let f = 0; f < frames; f++) {
    const full = new Uint8ClampedArray(raw.buffer, raw.byteOffset + f * fb, fb);
    let rgba: Uint8ClampedArray;
    let w: number, h: number;
    if (mode === "full") { rgba = new Uint8ClampedArray(full); w = W; h = H; }
    else { rgba = downscale(full, tw, th); w = tw; h = th; }
    const gray = rgbaToGray(rgba, w, h);
    const res = trackBallFrame(state, gray, w, h, settings, corners, 1000 / FPS, rgba);
    const pos = res.smoothed;
    if (res.locked && pos && (res.raw || res.predicted)) {
      if (points.length === 0 && !res.predicted) shotStart = f * (1000 / FPS);
      if (points.length > 0 || !res.predicted) {
        const t = f * (1000 / FPS) - shotStart;
        // map to full-res for lane
        const fullPos = mode === "full" ? pos : { x: pos.x / sx, y: pos.y / sy };
        const lane = imageToLane(Hm, fullPos);
        if (!((lane.board < 1.2 || lane.board > 37.8) && lane.feet < 45))
          points.push({ image: fullPos, lane: { board: lane.board, feet: lane.feet }, t, predicted: res.predicted || undefined });
      }
    }
  }
  const q = evaluateShotQuality(points);
  const real = points.filter(p => !p.predicted);
  const feet = real.map(p => p.lane.feet);
  const est = q.ok ? computeShotEstimate(points) : null;
  console.log(`${mode} ${tw}x${th}: pts=${points.length} real=${real.length} feet=[${feet.length?Math.min(...feet).toFixed(1):'-'}..${feet.length?Math.max(...feet).toFixed(1):'-'}] q=${q.ok}/${q.reason} span=${q.feetSpan.toFixed(1)} travel=${q.travelPx.toFixed(0)} avg=${est?.avgSpeedMph} L=${est?.launchSpeedMph} I=${est?.impactSpeedMph}`);
}

runTrack("full", W, H);
runTrack("down", 640, 576);
runTrack("down", 720, Math.round(954 * 720 / 1060));
runTrack("down", 800, Math.round(954 * 800 / 1060));
runTrack("down", 480, Math.round(954 * 480 / 1060));
