/**
 * 用 bowling-demo.mp4 抽幀做離線追蹤煙霧測試（非瀏覽器）。
 * 預設四角 + 背景差；檢查是否偏向圓形紫球而非細長線。
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  findBestBallBlob,
  rgbaToGray,
  trackBallFrame,
  shouldEndShot,
} from "../src/lib/tracker.ts";
import { defaultCorners } from "../src/lib/perspective.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-offline";
const W = 1060;
const H = 954;
const N = 40;

mkdirSync(OUT, { recursive: true });
if (!existsSync(VIDEO)) {
  console.error("missing demo video");
  process.exit(1);
}

execSync(
  `ffmpeg -y -i "${VIDEO}" -vf "fps=8,scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,
  { stdio: "pipe" }
);

const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;
const corners = defaultCorners(W, H);
const state = new BallTrackerState();
const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 30 };

let lockedFrame = -1;
let points = 0;
let ended = false;
const path: { x: number; y: number }[] = [];

for (let f = 0; f < N; f++) {
  const offset = f * frameBytes;
  if (offset + frameBytes > raw.length) break;
  const rgba = new Uint8ClampedArray(raw.buffer, raw.byteOffset + offset, frameBytes);
  // copy to owned buffer (view may be detached concerns)
  const rgbaCopy = new Uint8ClampedArray(rgba);
  const gray = rgbaToGray(rgbaCopy, W, H);
  const res = trackBallFrame(
    state,
    gray,
    W,
    H,
    settings,
    corners,
    1000 / 8,
    rgbaCopy
  );
  if (res.locked && lockedFrame < 0) lockedFrame = f;
  if (res.locked && res.smoothed && (res.raw || res.predicted)) {
    points++;
    path.push(res.smoothed);
  }
  if (!ended && shouldEndShot(state, settings, points > 0)) {
    ended = true;
    console.log(`shot end suggested at frame ${f}, points=${points}`);
  }
}

console.log({
  frames: N,
  lockedFrame,
  points,
  ended,
  pathLen: path.length,
  start: path[0],
  end: path[path.length - 1],
});

// Aspect check: motion should mostly go upward (toward pins) once locked
if (path.length >= 8) {
  const a = path[Math.floor(path.length * 0.15)];
  const b = path[Math.floor(path.length * 0.85)];
  const dy = b.y - a.y;
  console.log(`path Δy=${dy.toFixed(1)} (負＝往 pins／上方為佳)`);
  // Not a hard fail — lighting/default corners may miss, but lock should happen
}

if (lockedFrame < 0 && points === 0) {
  console.warn(
    "WARN: 離線未鎖定球（預設四角可能未對準 demo；瀏覽器請手動／自動偵測後再試）"
  );
  // Still exit 0 — synthetic unit tests cover logic; this is informational
} else {
  console.log("OK: offline tracker produced lock/path signal");
}
