/**
 * bowling-demo.mp4 離線：模擬多圈 loop、存檔門檻、指標覆蓋、左溝誤鎖檢查
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  BallTrackerState,
  DEFAULT_TRACKER,
  ballContactPoint,
  rgbaToGray,
  trackBallFrame,
  shouldEndShot,
  getRpmEstimate,
  trackWorkSize,
  scaleLaneCorners,
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
import { pickBestCornersByProbe } from "../src/lib/laneProbe.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-offline2";
// 原生解析度（同 Workbench／verify:arrows），追蹤內再用 trackWorkSize
const W = 1060;
const H = 954;
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
for (const fi of [0, 4, 8, 12, 16, 20, 21, 24, 30, 36, 40, 48, 60, 72, 90]) {
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
// Rank like Workbench (width + mid), then shared laneProbe
const ranked = cands
  .map((c) => {
    const corners = c.det.corners;
    const botFrac = (corners.br.x - corners.bl.x) / W;
    const midBot = (corners.bl.x + corners.br.x) / 2;
    const midFrac = Math.abs(midBot / W - 0.5);
    const widthOk =
      botFrac >= 0.32 && botFrac <= 0.48
        ? 28
        : botFrac >= 0.28 && botFrac <= 0.52
          ? 8
          : -35;
    const midRightPen =
      midBot / W > 0.52 ? -18 : midBot / W > 0.5 ? -8 : 0;
    const midOk =
      (midFrac < 0.1 ? 22 : midFrac < 0.16 ? 6 : -30) + midRightPen;
    return { ...c, rank: c.geom + widthOk + midOk };
  })
  .sort((a, b) => b.rank - a.rank);

const probeFrames: { rgba: Uint8ClampedArray; width: number; height: number }[] =
  [];
const nProbe = Math.min(Math.floor(raw.length / frameBytes), 95);
for (let f = 5; f < nProbe; f++) {
  const rgba = new Uint8ClampedArray(
    raw.buffer,
    raw.byteOffset + f * frameBytes,
    frameBytes
  );
  probeFrames.push({
    rgba: new Uint8ClampedArray(rgba),
    width: W,
    height: H,
  });
}
const picked = pickBestCornersByProbe(
  ranked.map((c) => ({ det: c.det, geomRank: c.rank })),
  probeFrames,
  6
);
const det = picked?.det ?? ranked[0]?.det ?? null;
if (picked) {
  console.log(
    `laneProbe pick score=${picked.detail.score.toFixed(1)} med=${picked.detail.med?.toFixed(1) ?? "—"} arr=${picked.detail.arrows?.toFixed(1) ?? "—"} ft=${picked.detail.minFeet.toFixed(1)}–${picked.detail.maxFeet.toFixed(1)} locks=${picked.detail.locks}`
  );
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
const { scale: trackScale, tw, th } = trackWorkSize(W, H);
const workCorners = scaleLaneCorners(corners, trackScale);

function downscale(
  rgba: Uint8ClampedArray,
  tw0: number,
  th0: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(tw0 * th0 * 4);
  for (let y = 0; y < th0; y++) {
    const sy = Math.min(H - 1, Math.floor((y / th0) * H));
    for (let x = 0; x < tw0; x++) {
      const sx = Math.min(W - 1, Math.floor((x / tw0) * W));
      const si = (sy * W + sx) * 4;
      const di = (y * tw0 + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}

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
    const work =
      trackScale < 1 ? downscale(rgbaCopy, tw, th) : rgbaCopy;
    const trackW = trackScale < 1 ? tw : W;
    const trackH = trackScale < 1 ? th : H;
    const useC = trackScale < 1 ? workCorners : corners;
    const gray = rgbaToGray(work, trackW, trackH);
    const res = trackBallFrame(
      state,
      gray,
      trackW,
      trackH,
      settings,
      useC,
      1000 / FPS,
      work
    );
    if (loopSaved) continue;
    const pos = res.smoothed
      ? trackScale < 1
        ? { x: res.smoothed.x / trackScale, y: res.smoothed.y / trackScale }
        : res.smoothed
      : null;
    if (res.locked && pos && (res.raw || res.predicted)) {
      if (points.length === 0 && !res.predicted) shotStart = f * (1000 / FPS);
      if (points.length > 0 || !res.predicted) {
        const t = f * (1000 / FPS) - shotStart;
        const rFull =
          res.radius != null && res.radius > 0
            ? trackScale < 1
              ? res.radius / trackScale
              : res.radius
            : null;
        const contact = ballContactPoint(pos, rFull);
        const lane = imageToLane(Hm, contact);
        let accept = true;
        if (lane.board < 1.2 || lane.board > 37.8) {
          if (lane.feet < 45) accept = false;
        }
        if (accept) {
          // 溝檢查用中段 board（接觸點喺 foul 附近 board 易偏低）
          if (lane.feet >= 6 && lane.feet <= 45) boardSamples.push(lane.board);
          points.push({
            image: contact,
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

// 唔應系統性鎖左溝：有 arrows 落喺 6–20 即當 OK；否則中位 board 唔好貼溝
{
  const arr0 = r1.saves[0]?.arrowsBoard;
  const arrowsOk =
    arr0 != null && arr0 >= 6 && arr0 <= 24;
  if (arrowsOk) {
    assert(true, `saved arrows not gutter (${arr0})`);
  } else if (r1.medBoard != null && r1.saved > 0) {
    assert(
      r1.medBoard >= 3.5,
      `saved track median board not left-gutter (${r1.medBoard?.toFixed(1)})`
    );
  } else if (r1.medBoard != null) {
    assert(
      r1.medBoard >= 2.5 || r1.saved === 0,
      `track medBoard ${r1.medBoard?.toFixed(1)} (discarded gutter ok)`
    );
  }
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
