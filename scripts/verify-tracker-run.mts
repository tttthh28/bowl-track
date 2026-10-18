import {
  ballColorScore,
  findBestBallBlob,
  BallTrackerState,
  shouldEndShot,
  DEFAULT_TRACKER,
} from "../src/lib/tracker.ts";
import { estimateSpeedMph } from "../src/lib/perspective.ts";

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("OK:", msg);
  }
}

const purple = ballColorScore(90, 40, 120);
const green = ballColorScore(40, 200, 50);
const red = ballColorScore(220, 40, 40);
assert(purple > 0.7, `purple ball color score high (${purple.toFixed(2)})`);
assert(green < 0.2, `green guide line low (${green.toFixed(2)})`);
assert(red < 0.2, `red guide line low (${red.toFixed(2)})`);

const W = 120,
  H = 120;
const mask = new Uint8Array(W * H);
const rgba = new Uint8ClampedArray(W * H * 4);
for (let i = 0; i < W * H; i++) {
  rgba[i * 4] = 180;
  rgba[i * 4 + 1] = 170;
  rgba[i * 4 + 2] = 150;
  rgba[i * 4 + 3] = 255;
}
for (let x = 10; x < 110; x++) {
  for (let dy = 0; dy < 3; dy++) {
    const y = 90 + dy;
    mask[y * W + x] = 1;
    const o = (y * W + x) * 4;
    rgba[o] = 200;
    rgba[o + 1] = 40;
    rgba[o + 2] = 200;
  }
}
const bc = { x: 60, y: 50 };
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (Math.hypot(x - bc.x, y - bc.y) <= 8) {
      mask[y * W + x] = 1;
      const o = (y * W + x) * 4;
      rgba[o] = 85;
      rgba[o + 1] = 35;
      rgba[o + 2] = 130;
    }
  }
}
const corners = {
  tl: { x: 5, y: 5 },
  tr: { x: 115, y: 5 },
  br: { x: 115, y: 115 },
  bl: { x: 5, y: 115 },
};
const best = findBestBallBlob(
  mask,
  W,
  H,
  0,
  0,
  W,
  H,
  20,
  corners,
  null,
  null,
  rgba
);
assert(!!best, "found a blob");
assert(
  !!best && Math.hypot(best.cx - bc.x, best.cy - bc.y) < 6,
  `picked circular ball not line (cx=${best?.cx}, cy=${best?.cy})`
);

const st = new BallTrackerState();
st.locked = true;
st.lost = 20;
assert(shouldEndShot(st, DEFAULT_TRACKER, true), "end on lost frames");
st.lost = 0;
st.outOfLaneFrames = 20;
assert(shouldEndShot(st, DEFAULT_TRACKER, true), "end on out of lane");
st.outOfLaneFrames = 0;
st.reachedPinZone = true;
st.lost = 6;
assert(shouldEndShot(st, DEFAULT_TRACKER, true), "end after pin zone + lost");
assert(!shouldEndShot(st, DEFAULT_TRACKER, false), "no end without points");

const pts = [];
for (let i = 0; i < 30; i++) {
  pts.push({
    lane: { board: 18, feet: 2 + i * 1.8 },
    t: i * 50,
  });
}
const mph = estimateSpeedMph(pts);
assert(
  mph != null && mph >= 10 && mph <= 30,
  `reasonable speed ${mph}`
);

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll verify checks passed");
