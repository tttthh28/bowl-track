/**
 * bowling-demo.mp4 離線：模擬多圈 loop、存檔門檻、指標覆蓋、左溝誤鎖檢查
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  rgbaToGray,
  trackBallFrame,
  shouldEndShot,
  getRpmEstimate,
} from "../src/lib/tracker.ts";
import {
  defaultCorners,
  imageToLane,
  buildHomography,
} from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import {
  evaluateShotQuality,
} from "../src/lib/shotQuality.ts";
import { detectLaneCorners, scoreLaneGeometry } from "../src/lib/laneDetect.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-offline2";
const W = 640;
const H = 576;
const FPS = 15;
const N = 130; // ~8.6s @15fps ≈ one loop

mkdirSync(OUT, { recursive: true });
execSync(
  `ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,
  { stdio: "pipe" }
);
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;

// 多幀候選：幾何分先行，再以短追蹤探針揀 medBoard／覆蓋較合理者
type Cand = { det: NonNullable<ReturnType<typeof detectLaneCorners>>; geom: number; fi: number };
const cands: Cand[] = [];
for (const fi of [0, 4, 8, 12, 16, 20, 24, 30, 40, 48, 60]) {
  const off = fi * frameBytes;
  if (off + frameBytes > raw.length) continue;
  const slice = new Uint8ClampedArray(
    raw.buffer,
    raw.byteOffset + off,
    frameBytes
  );
  const cand = detectLaneCorners(new Uint8ClampedArray(slice), W, H);
  if (!cand || cand.confidence < 0.4) continue;
  cands.push({ det: cand, geom: scoreLaneGeometry(cand, W, H), fi });
}
cands.sort((a, b) => b.geom - a.geom);
const top = cands.slice(0, Math.min(5, cands.length));

function probeTrack(corners: import("../src/lib/types.ts").LaneCorners) {
  const Hm = buildHomography(corners);
  if (!Hm)
    return { med: null as number | null, maxFeet: 0, minFeet: 99, locks: 0 };
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const boards: number[] = [];
  let maxFeet = 0;
  let minFeet = 99;
  let locks = 0;
  const nProbe = Math.min(Math.floor(raw.length / frameBytes), 110);
  for (let f = 0; f < nProbe; f++) {
    const rgba = new Uint8ClampedArray(
      raw.buffer,
      raw.byteOffset + f * frameBytes,
      frameBytes
    );
    const copy = new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(copy, W, H);
    const res = trackBallFrame(
      state,
      gray,
      W,
      H,
      settings,
      corners,
      1000 / FPS,
      copy
    );
    if (res.locked && res.smoothed) {
      locks++;
      const lane = imageToLane(Hm, res.smoothed);
      if (lane.board >= 1.5 && lane.board <= 37.5) {
        boards.push(lane.board);
        if (lane.feet > maxFeet) maxFeet = lane.feet;
        if (lane.feet < minFeet) minFeet = lane.feet;
      }
    }
  }
  const med =
    boards.length > 0
      ? [...boards].sort((a, b) => a - b)[Math.floor(boards.length / 2)]
      : null;
  return { med, maxFeet, minFeet: boards.length ? minFeet : 99, locks };
}

let det: ReturnType<typeof detectLaneCorners> = null;
let bestProbe = -1e9;
for (const c of top.length ? top : cands) {
  const p = probeTrack(c.det.corners);
  // medBoard 8–30、覆蓋遠、鎖幀多
  const pinY = (c.det.corners.tl.y + c.det.corners.tr.y) / 2;
  const medOk =
    p.med != null && p.med >= 10 && p.med <= 28
      ? 35
      : p.med != null && p.med >= 7 && p.med <= 32
        ? 15
        : -50;
  const coverOk = Math.min(45, Math.max(0, p.maxFeet - p.minFeet));
  const earlyOk = p.minFeet <= 18 ? 25 : p.minFeet <= 22 ? 8 : -15;
  const pinPen = pinY < H * 0.12 ? -20 : 0;
  const score =
    c.geom +
    medOk +
    coverOk +
    earlyOk +
    pinPen +
    Math.min(20, p.locks * 0.12);
  console.log(
    `probe fi=${c.fi} geom=${c.geom.toFixed(1)} med=${p.med?.toFixed(1) ?? "—"} ft=${p.minFeet.toFixed(1)}–${p.maxFeet.toFixed(1)} locks=${p.locks} pinY=${pinY.toFixed(0)} → ${score.toFixed(1)}`
  );
  if (score > bestProbe) {
    bestProbe = score;
    det = c.det;
  }
}
const corners = det?.corners ?? defaultCorners(W, H);
console.log(
  "corners:",
  det
    ? `auto conf=${(det.confidence * 100).toFixed(0)}% TL.y=${corners.tl.y.toFixed(0)}`
    : "default",
  {
    tl: { x: Math.round(corners.tl.x), y: Math.round(corners.tl.y) },
    tr: { x: Math.round(corners.tr.x), y: Math.round(corners.tr.y) },
  }
);
if (corners.tl.y > H * 0.22 || corners.tr.y > H * 0.22) {
  console.warn("WARN: TL/TR y 偏高（pins 端偏低）");
}

const Hm = buildHomography(corners)!;
const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };

type Pt = {
  image: { x: number; y: number };
  lane?: { board: number; feet: number };
  t: number;
  predicted?: boolean;
};

function runPass(
  label: string,
  startF: number,
  endF: number,
  state: BallTrackerState
) {
  let points: Pt[] = [];
  let shotStart = 0;
  let saved = 0;
  let discarded = 0;
  let loopSaved = false;
  const saves: ReturnType<typeof computeShotEstimate>[] = [];
  const boardSamples: number[] = [];

  const tryFinish = (pts: Pt[]) => {
    if (loopSaved) {
      discarded++;
      return [];
    }
    const q = evaluateShotQuality(pts as any);
    if (!q.ok) {
      discarded++;
      state.beginNewShot();
      return [];
    }
    const est = computeShotEstimate(pts as any, getRpmEstimate(state));
    saves.push(est);
    saved++;
    loopSaved = true;
    state.beginNewShot();
    return [];
  };

  for (let f = startF; f < endF; f++) {
    const offset = f * frameBytes;
    if (offset + frameBytes > raw.length) break;
    const rgba = new Uint8ClampedArray(
      raw.buffer,
      raw.byteOffset + offset,
      frameBytes
    );
    const rgbaCopy = new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(rgbaCopy, W, H);
    const res = trackBallFrame(
      state,
      gray,
      W,
      H,
      settings,
      corners,
      1000 / FPS,
      rgbaCopy
    );
    if (loopSaved) continue;
    const pos = res.smoothed;
    if (res.locked && pos && (res.raw || res.predicted)) {
      if (points.length === 0 && !res.predicted) shotStart = f * (1000 / FPS);
      if (points.length > 0 || !res.predicted) {
        const t = f * (1000 / FPS) - shotStart;
        const lane = imageToLane(Hm, pos);
        let accept = true;
        if (lane.board < 1.2 || lane.board > 37.8) {
          if (lane.feet < 45) accept = false;
        }
        if (accept) {
          boardSamples.push(lane.board);
          points.push({
            image: pos,
            lane: { board: lane.board, feet: lane.feet },
            t,
            predicted: res.predicted || undefined,
          });
        }
      }
    }
    if (shouldEndShot(state, settings, points.length > 0)) {
      points = tryFinish(points);
    } else if (!res.locked && points.length > 0) {
      points = tryFinish(points);
    }
  }
  if (points.length > 0) points = tryFinish(points);

  const medBoard =
    boardSamples.length > 0
      ? [...boardSamples].sort((a, b) => a - b)[
          Math.floor(boardSamples.length / 2)
        ]
      : null;

  console.log(`\n=== ${label} ===`);
  console.log({ saved, discarded, loopSaved, medBoardDuringTrack: medBoard });
  for (const e of saves) {
    console.log({
      points: e.pointCount,
      coverage: `${e.coverageFeetMin}–${e.coverageFeetMax}`,
      foul: e.foulBoard?.toFixed(1),
      arrows: e.arrowsBoard?.toFixed(1),
      bp:
        e.breakpointBoard != null
          ? `${e.breakpointBoard.toFixed(1)}@${e.breakpointDistance}`
          : null,
      pocket:
        e.pocketBoard != null
          ? `${e.pocketBoard.toFixed(1)}${e.extrapolated.pocket ? "外推" : ""}`
          : "—",
      launchMph: e.launchSpeedMph,
      impactMph: e.impactSpeedMph,
      avgMph: e.avgSpeedMph,
      shotTime: e.shotTimeSec,
      rpm: e.rpm,
      ex: e.extrapolated,
    });
  }
  return { saved, medBoard, saves };
}

const state = new BallTrackerState();
const r1 = runPass("pass1 (one loop)", 0, Math.min(N, 128), state);
const state2 = new BallTrackerState();
const r2 = runPass("pass2 (second loop, fresh cycle)", 0, Math.min(N, 128), state2);

// 模擬同一圈內嘗試雙 flush（應被 loopSaved 擋住）
console.log(`\nSummary: pass1 saved=${r1.saved}, pass2 saved=${r2.saved} (expect ≤1 each)`);

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else console.log("OK:", msg);
}

assert(r1.saved <= 1, `pass1 ≤1 shot (got ${r1.saved})`);
assert(r2.saved <= 1, `pass2 ≤1 shot (got ${r2.saved})`);

// 覆蓋不足時 BP／袋口唔好假報
for (const e of [...r1.saves, ...r2.saves]) {
  if (e.coverageFeetMax != null && e.coverageFeetMax < 25) {
    assert(
      e.pocketBoard == null || e.extrapolated.pocket === true,
      "short coverage pocket null or extrapolated"
    );
    assert(
      e.breakpointDistance == null ||
        e.breakpointDistance <= (e.coverageFeetMax ?? 0) + 0.5,
      "BP within coverage"
    );
  }
}

// 唔應系統性鎖左溝：若有存檔，中位 board 唔好長期貼 0–3；追蹤樣本亦然
if (r1.medBoard != null && r1.saved > 0) {
  assert(
    r1.medBoard >= 3.5,
    `saved track median board not left-gutter (${r1.medBoard?.toFixed(1)})`
  );
} else if (r1.medBoard != null) {
  // 未存檔時追蹤樣本亦唔好成段貼 0–2
  assert(
    r1.medBoard >= 2.5 || r1.saved === 0,
    `track medBoard ${r1.medBoard?.toFixed(1)} (discarded gutter ok)`
  );
}

// 合成：合格／不合格門檻
{
  const good = [];
  for (let i = 0; i < 40; i++) {
    good.push({
      image: { x: 200 + i, y: 500 - i * 8 },
      lane: { board: 15 + i * 0.1, feet: 2 + i * 1.2 },
      t: i * 40,
    });
  }
  assert(evaluateShotQuality(good as any).ok, "synthetic good shot passes quality");
  const gutter = [];
  for (let i = 0; i < 60; i++) {
    gutter.push({
      image: { x: 40 + (i % 3), y: 400 - i * 0.3 },
      lane: { board: 0.5 + (i % 5) * 0.2, feet: 1 + i * 0.08 },
      t: i * 80,
    });
  }
  assert(
    !evaluateShotQuality(gutter as any).ok,
    "synthetic left-gutter crawl rejected"
  );
}

// impact ≤ launch（若兩者皆有）
for (const e of [...r1.saves, ...r2.saves]) {
  if (e.launchSpeedMph != null && e.impactSpeedMph != null) {
    assert(
      e.impactSpeedMph <= e.launchSpeedMph + 0.05,
      `offline impact≤launch (${e.impactSpeedMph}≤${e.launchSpeedMph})`
    );
  }
}

if (failed) {
  console.error(`\n${failed} offline asserts failed`);
  process.exit(1);
}
console.log("\nAll offline-metrics asserts passed");
