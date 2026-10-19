/**
 * Sweep mappingCornersForTrack params with FIXED r9 display corners.
 * Display stays: BL184 BR810 TL558 TR690 foulY0.90 pinY0.096
 * Goal: find map mid/topFrac that yields arr∈[13,15] without touching display.
 */
import { readFileSync, writeFileSync } from "fs";
import { buildHomography, imageToLane, mappingCornersForTrack } from "../src/lib/perspective.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const W = 1060, H = 954;
const raw = readFileSync("/tmp/bowl-lateral/seq.rgba");
const fb = W * H * 4;
const frameAt = (fi: number) => {
  const u = new Uint8ClampedArray(fb);
  u.set(raw.subarray(fi * fb, (fi + 1) * fb));
  return u;
};
const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });

// r9 display corners (from bl-x-gutter selftest)
const display: LaneCorners = {
  bl: { x: 184, y: 0.9 * H },
  br: { x: 810, y: 0.9 * H },
  tl: { x: 558, y: 0.096 * H },
  tr: { x: 690, y: 0.096 * H },
};

console.log("=== Baseline: current mappingCornersForTrack ===");
const curMap = mappingCornersForTrack(display);
console.log("display", JSON.stringify(display));
console.log("map", JSON.stringify(curMap));
const base = scoreCornersByProbe(display, probeFrames);
console.log(`arr=${base.arrows?.toFixed(1)} med=${base.med?.toFixed(1)} span=${(base.maxFeet-base.minFeet).toFixed(1)} locks=${base.locks}`);

// Monkey: temporarily replace by testing custom map via direct probe with patched corners
// We'll call score with corners that ARE the mapping (as if display=map) — that tells us H-only arr.
// Better: inline a custom score that uses custom map while display is for botFrac only.

import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";

function scoreWithMap(disp: LaneCorners, map: LaneCorners) {
  const fps = 15;
  const vw = W, vh = H;
  const Hm = buildHomography(map);
  if (!Hm) return { arr: null as number|null, med: null as number|null, span: 0, locks: 0 };
  const { scale, tw, th } = trackWorkSize(vw, vh);
  const workCorners = scaleLaneCorners(map, scale);
  const st = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const boards: number[] = [];
  const pts: any[] = [];
  let maxFeet = 0, minFeet = 99, locks = 0;
  for (let i = 0; i < probeFrames.length; i++) {
    const fr = probeFrames[i];
    let trackRgba = fr.rgba, trackW = fr.width, trackH = fr.height, useC = map;
    if (scale < 1) {
      // inline downscale from laneProbe
      const out = new Uint8ClampedArray(tw * th * 4);
      for (let y = 0; y < th; y++) {
        const sy = Math.min(vh - 1, Math.floor((y + 0.5) * vh / th));
        for (let x = 0; x < tw; x++) {
          const sx = Math.min(vw - 1, Math.floor((x + 0.5) * vw / tw));
          const si = (sy * vw + sx) * 4, di = (y * tw + x) * 4;
          out[di] = fr.rgba[si]; out[di+1] = fr.rgba[si+1]; out[di+2] = fr.rgba[si+2]; out[di+3] = 255;
        }
      }
      trackRgba = out; trackW = tw; trackH = th; useC = workCorners;
    }
    const gray = rgbaToGray(trackRgba, trackW, trackH);
    const res = trackBallFrame(st, gray, trackW, trackH, settings, useC, 1000/fps, trackRgba);
    if (res.locked && res.smoothed) {
      locks++;
      const pos = scale < 1 ? { x: res.smoothed.x/scale, y: res.smoothed.y/scale } : res.smoothed;
      const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius/scale : res.radius) : null;
      const lane = imageToLane(Hm, ballContactPoint(pos, rFull));
      if (lane.board >= 1.5 && lane.board <= 37.5) {
        boards.push(lane.board);
        if (lane.feet > maxFeet) maxFeet = lane.feet;
        if (lane.feet < minFeet) minFeet = lane.feet;
        pts.push({ image: ballContactPoint(pos, rFull), lane, t: i*(1000/fps) });
      }
    }
  }
  const med = boards.length ? [...boards].sort((a,b)=>a-b)[Math.floor(boards.length/2)] : null;
  const est = pts.length >= 4 ? computeShotEstimate(pts as any) : null;
  return { arr: est?.arrowsBoard ?? null, med, span: Math.max(0, maxFeet-minFeet), locks, path15: (() => {
    // sample board at 15 from pts
    const withL = pts.filter((p:any)=>p.lane).sort((a:any,b:any)=>a.lane.feet-b.lane.feet);
    for (let i=0;i<withL.length-1;i++) {
      const a=withL[i].lane, b=withL[i+1].lane;
      if (15>=Math.min(a.feet,b.feet) && 15<=Math.max(a.feet,b.feet)) {
        const t=(15-a.feet)/(b.feet-a.feet); return a.board+t*(b.board-a.board);
      }
    }
    return null;
  })() };
}

console.log("\n=== Sweep: foul=display BL/BR; pin mid offset from foulMid; topFrac ===");
const midF = (display.bl.x + display.br.x) / 2;
const botW = display.br.x - display.bl.x;
const pinY = (display.tl.y + display.tr.y) / 2;
const rows: any[] = [];
for (const midOff of [-0.08, -0.05, -0.02, 0, 0.02, 0.05, 0.08, 0.10, 0.12, 0.14]) {
  for (const topFrac of [0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.24, 0.28]) {
    const pinMid = midF + midOff * W;
    const topW = botW * (topFrac / 0.56); // same scale convention as current, OR absolute:
    // Also try absolute topFrac of frame width
    const topW2 = topFrac * W; // absolute
    for (const [label, tw] of [["rel", topW], ["abs", topW2]] as const) {
      if (label === "rel" && topFrac > 0.24) continue;
      if (label === "abs" && (topFrac < 0.12 || topFrac > 0.22)) continue;
      const map: LaneCorners = {
        bl: { ...display.bl }, br: { ...display.br },
        tl: { x: pinMid - tw/2, y: pinY },
        tr: { x: pinMid + tw/2, y: pinY },
      };
      const r = scoreWithMap(display, map);
      rows.push({ midOff, topFrac, label, tw: tw.toFixed(0), arr: r.arr, med: r.med, path15: r.path15, span: r.span, locks: r.locks, tl: map.tl.x.toFixed(0), tr: map.tr.x.toFixed(0) });
    }
  }
}
rows.sort((a,b) => {
  const sa = a.arr==null ? 99 : Math.abs(a.arr - 14);
  const sb = b.arr==null ? 99 : Math.abs(b.arr - 14);
  return sa - sb;
});
console.log("Top 25 closest to arr=14:");
for (const r of rows.slice(0, 25)) {
  console.log(`midOff=${r.midOff.toFixed(2)} top=${r.topFrac.toFixed(2)}${r.label} tw=${r.tw} arr=${r.arr?.toFixed(1)??'—'} med=${r.med?.toFixed(1)??'—'} p15=${r.path15?.toFixed(1)??'—'} span=${r.span.toFixed(0)} L=${r.locks} TL${r.tl}/TR${r.tr}`);
}

// Also: use DISPLAY corners as map (no de-skew) 
console.log("\n=== No de-skew (map = display) ===");
const nd = scoreWithMap(display, display);
console.log(`arr=${nd.arr?.toFixed(1)} med=${nd.med?.toFixed(1)} p15=${nd.path15?.toFixed(1)} span=${nd.span.toFixed(1)} locks=${nd.locks}`);

// Old-style inset foul with current map formula (for comparison)
console.log("\n=== Old inset foul 208/802 with current map formula ===");
const oldDisp: LaneCorners = {
  bl: { x: 208, y: 0.86*H }, br: { x: 802, y: 0.86*H },
  tl: { x: 562, y: 0.11*H }, tr: { x: 694, y: 0.11*H },
};
const oldMap = mappingCornersForTrack(oldDisp);
console.log("oldMap", JSON.stringify(oldMap));
const oldR = scoreWithMap(oldDisp, oldMap);
console.log(`arr=${oldR.arr?.toFixed(1)} med=${oldR.med?.toFixed(1)} p15=${oldR.path15?.toFixed(1)} span=${oldR.span.toFixed(1)}`);

writeFileSync("/tmp/diag-map-arr-r9.json", JSON.stringify({ base, rows: rows.slice(0,40), noDeskew: nd, old: oldR }, null, 2));
console.log("\nWrote /tmp/diag-map-arr-r9.json");
