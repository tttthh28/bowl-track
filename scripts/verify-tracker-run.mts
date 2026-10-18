import {
  ballColorScore,
  findBestBallBlob,
  BallTrackerState,
  shouldEndShot,
  DEFAULT_TRACKER,
  getRpmEstimate,
} from "../src/lib/tracker.ts";
import {
  estimateSpeedMph,
  boardAtFeet,
  boardAtFeetDetailed,
  feetAtMaxHook,
  trajectoryCoverage,
  estimateSegmentSpeedMph,
} from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import {
  evaluateShotQuality,
  isDuplicateOfLastShot,
} from "../src/lib/shotQuality.ts";

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

// --- 覆蓋範圍指標 ---
const shortPts = [];
for (let i = 0; i < 20; i++) {
  shortPts.push({
    image: { x: 100, y: 400 - i * 8 },
    lane: { board: 15 + i * 0.05, feet: 3 + i * 0.9 }, // ~3–20′
    t: i * 40,
  });
}
const cov = trajectoryCoverage(shortPts);
assert(!!cov && cov.maxFeet < 25, `short coverage max≈${cov?.maxFeet}`);
assert(boardAtFeet(shortPts, 58) == null, "no silent pocket at 58′ when only ~20′");
assert(boardAtFeet(shortPts, 42) == null, "no silent BP board at 42′ when only ~20′");
assert(feetAtMaxHook(shortPts) != null, "hook feet within coverage");
const hookF = feetAtMaxHook(shortPts);
assert(
  hookF != null && hookF <= (cov?.maxFeet ?? 0) + 0.5,
  `hook feet ${hookF} within coverage`
);

const shortEst = computeShotEstimate(shortPts);
assert(shortEst.pocketBoard == null || shortEst.extrapolated.pocket === true,
  `pocket null or extrapolated (got ${shortEst.pocketBoard}, ex=${shortEst.extrapolated.pocket})`);
assert(
  shortEst.breakpointBoard == null ||
    (shortEst.breakpointDistance != null &&
      shortEst.breakpointDistance <= shortEst.coverageFeetMax! + 0.5),
  `BP within coverage or null (bp=${shortEst.breakpointDistance}, max=${shortEst.coverageFeetMax})`
);
assert(
  shortEst.shotTimeSec != null && shortEst.shotTimeSec >= 0.7,
  `shot time from lock-to-end ≈${shortEst.shotTimeSec}`
);
assert(shortEst.avgSpeedMph != null, `avg speed present ${shortEst.avgSpeedMph}`);
assert(
  shortEst.launchSpeedMph != null || shortEst.avgSpeedMph != null,
  "launch or avg speed from short path"
);
// Impact：覆蓋不足時可為區段估計並標 extrapolated，或 null
if (shortEst.impactSpeedMph != null) {
  assert(
    shortEst.extrapolated.impactSpeed === true,
    "impact speed from short path marked as segment/extrapolated"
  );
}

const far = boardAtFeetDetailed(shortPts, 30, {
  allowExtrapolate: true,
  maxGap: 4,
});
assert(!!far && far.extrapolated, "extrapolate beyond short coverage marks flag");

// 長軌跡：58′ 應可插值
const longPts = [];
for (let i = 0; i < 40; i++) {
  longPts.push({
    image: { x: 100, y: 500 - i * 10 },
    lane: { board: 18, feet: 1 + i * 1.5 },
    t: i * 45,
  });
}
assert(boardAtFeet(longPts, 58) != null, "long path can interpolate pocket");
assert(estimateSegmentSpeedMph(longPts, 40, 58) != null, "impact speed on long path");

// RPM 低信心 → —
const rpmEst = getRpmEstimate(st);
assert(rpmEst.rpm == null || rpmEst.confidence >= 0.55, "rpm gate");


// --- 存檔合格／去重／左溝 ---
{
  const good = [];
  for (let i = 0; i < 40; i++) {
    good.push({
      image: { x: 200 + i * 2, y: 500 - i * 9 },
      lane: { board: 14 + i * 0.12, feet: 2 + i * 1.3 },
      t: i * 45,
    });
  }
  assert(evaluateShotQuality(good as any).ok, "quality accepts real-ish path");
  const slowGutter = [];
  for (let i = 0; i < 80; i++) {
    slowGutter.push({
      image: { x: 30 + (i % 2), y: 420 - i * 0.4 },
      lane: { board: 0.8 + (i % 4) * 0.3, feet: 0.5 + i * 0.1 },
      t: i * 70,
    });
  }
  assert(!evaluateShotQuality(slowGutter as any).ok, "quality rejects left-gutter crawl");
  const short = [];
  for (let i = 0; i < 12; i++) {
    short.push({
      image: { x: 100, y: 400 - i },
      lane: { board: 18, feet: 3 + i * 0.2 },
      t: i * 30,
    });
  }
  assert(!evaluateShotQuality(short as any).ok, "quality rejects short feet span");
  assert(
    isDuplicateOfLastShot(good as any, good as any, Date.now() - 500, Date.now()),
    "dedup catches near-identical recent shot"
  );
}

// --- 球速：impact ≤ launch ---
{
  const pts = [];
  for (let i = 0; i < 40; i++) {
    pts.push({
      image: { x: 200 + i * 1.5, y: 520 - i * 10 },
      lane: { board: 16 + i * 0.05, feet: 2 + i * 1.4 },
      t: i * 45,
    });
  }
  const est = computeShotEstimate(pts as any);
  if (est.launchSpeedMph != null && est.impactSpeedMph != null) {
    assert(
      est.impactSpeedMph <= est.launchSpeedMph + 0.05,
      `impact≤launch (${est.impactSpeedMph}≤${est.launchSpeedMph})`
    );
  } else {
    console.log(
      "OK: impact/launch partial",
      est.launchSpeedMph,
      est.impactSpeedMph
    );
  }
}

// --- 去重：幾乎相同軌跡 ---
{
  const mk = (ox = 0) => {
    const pts = [];
    for (let i = 0; i < 30; i++) {
      pts.push({
        image: { x: 180 + ox + i * 2, y: 500 - i * 9 },
        lane: { board: 15, feet: 3 + i * 1.2 },
        t: i * 40,
      });
    }
    return pts;
  };
  const a = mk(0);
  const b = mk(2);
  assert(
    isDuplicateOfLastShot(b as any, a as any, Date.now() - 3000, Date.now()),
    "near-identical paths deduped within loop window"
  );
}

if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nAll verify checks passed");
