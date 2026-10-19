import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { detectLane } from "../src/lib/laneDetect.ts";
import { pickBestCandidate } from "../src/lib/laneProbe.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { trackBall } from "../src/lib/tracker.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bt-quick";
const W = 1060, H = 954, FPS = 15, N = 120;
mkdirSync(OUT, { recursive: true });
if (!existsSync(join(OUT, "seq.rgba"))) {
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, { stdio: "ignore" });
}
const buf = readFileSync(join(OUT, "seq.rgba"));
const frameAt = (i: number) => {
  const n = W * H * 4;
  return new Uint8ClampedArray(buf.buffer, buf.byteOffset + i * n, n);
};
const times = [0.8, 1.39, 1.73, 3.64, 7.37, 7.97];
const cands: { det: NonNullable<ReturnType<typeof detectLane>>; geomRank: number }[] = [];
for (const t of times) {
  const fi = Math.min(N - 1, Math.round(t * FPS));
  const det = detectLane(frameAt(fi), W, H);
  if (!det) continue;
  const mid = (det.corners.bl.x + det.corners.br.x) / 2;
  const bot = (det.corners.br.x - det.corners.bl.x) / W;
  console.log(`t=${t} bot=${bot.toFixed(3)} mid=${mid.toFixed(0)} conf=${(det.confidence * 100).toFixed(0)}%`);
  cands.push({ det, geomRank: det.confidence * 100 });
}
const probeFrames = [];
for (let i = 0; i < N; i += 2) probeFrames.push({ rgba: frameAt(i), width: W, height: H });
const pick = pickBestCandidate(cands, probeFrames, 8);
if (!pick) { console.log("NO PICK"); process.exit(1); }
const mid = (pick.det.corners.bl.x + pick.det.corners.br.x) / 2;
const bot = (pick.det.corners.br.x - pick.det.corners.bl.x) / W;
console.log("PICK", { arr: pick.detail.arrows, med: pick.detail.med?.toFixed(1), score: pick.detail.score.toFixed(1), bot: bot.toFixed(3), mid: mid.toFixed(0) });
const trackFrames = [];
for (let i = 0; i < N; i++) trackFrames.push({ rgba: frameAt(i), width: W, height: H, t: i / FPS });
const path = trackBall(trackFrames, pick.det.corners, { sensitivity: 26 });
const pts = path.points.map((p) => ({ image: p.image, lane: p.lane, t: p.t }));
const est = computeShotEstimate(pts);
console.log("FULL", { arr: est.arrowsBoard, n: pts.length, bot: bot.toFixed(3), mid: mid.toFixed(0) });
const tony =
  est.arrowsBoard != null &&
  est.arrowsBoard >= 13 &&
  est.arrowsBoard <= 15 &&
  bot >= 0.5 &&
  bot <= 0.54 &&
  mid >= 440 &&
  mid <= 460;
console.log("PASS", tony);
