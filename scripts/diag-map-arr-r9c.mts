/** Focused sweep for path15 ∈[13,15] with r9 foul lips */
import { readFileSync, writeFileSync } from "fs";
import { buildHomography, imageToLane, mappingCornersForTrack } from "../src/lib/perspective.ts";
import type { LaneCorners } from "../src/lib/types.ts";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";

const W = 1060, H = 954;
const raw = readFileSync("/tmp/bowl-lateral/seq.rgba");
const fb = W * H * 4;
const frameAt = (fi: number) => { const u = new Uint8ClampedArray(fb); u.set(raw.subarray(fi*fb,(fi+1)*fb)); return u; };
const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });

const display: LaneCorners = {
  bl: { x: 184, y: 0.9 * H }, br: { x: 810, y: 0.9 * H },
  tl: { x: 558, y: 0.096 * H }, tr: { x: 690, y: 0.096 * H },
};
const midF = (display.bl.x + display.br.x) / 2;
const botW = display.br.x - display.bl.x;
const pinY = (display.tl.y + display.tr.y) / 2;

function downscale(rgba: Uint8ClampedArray, vw: number, vh: number, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(vh - 1, Math.floor((y + 0.5) * vh / th));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(vw - 1, Math.floor((x + 0.5) * vw / tw));
      const si = (sy * vw + sx) * 4, di = (y * tw + x) * 4;
      out[di] = rgba[si]; out[di+1] = rgba[si+1]; out[di+2] = rgba[si+2]; out[di+3] = 255;
    }
  }
  return out;
}

function scoreWithMap(map: LaneCorners) {
  const fps = 15;
  const Hm = buildHomography(map);
  if (!Hm) return null;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workCorners = scaleLaneCorners(map, scale);
  const st = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const boards: number[] = [];
  const pts: any[] = [];
  let maxFeet = 0, minFeet = 99, locks = 0;
  for (let i = 0; i < probeFrames.length; i++) {
    const fr = probeFrames[i];
    let trackRgba = fr.rgba, trackW = W, trackH = H, useC = map;
    if (scale < 1) {
      trackRgba = downscale(fr.rgba, W, H, tw, th);
      trackW = tw; trackH = th; useC = workCorners;
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
  const withL = pts.filter((p:any)=>p.lane).sort((a:any,b:any)=>a.lane.feet-b.lane.feet);
  let path15: number|null = null;
  for (let i=0;i<withL.length-1;i++) {
    const a=withL[i].lane, b=withL[i+1].lane;
    if (15>=Math.min(a.feet,b.feet) && 15<=Math.max(a.feet,b.feet) && Math.abs(b.feet-a.feet)>1e-6) {
      const t=(15-a.feet)/(b.feet-a.feet); path15 = a.board+t*(b.board-a.board); break;
    }
  }
  // early boards mean (≤18′)
  const early = pts.filter((p:any)=>p.lane && p.lane.feet<=18).map((p:any)=>p.lane.board);
  const earlyMean = early.length ? early.reduce((a:number,b:number)=>a+b,0)/early.length : null;
  return { arr: est?.arrowsBoard ?? null, med, path15, earlyMean, span: Math.max(0,maxFeet-minFeet), locks, minFeet, maxFeet, n: boards.length };
}

const rows: any[] = [];
for (let pinMidFrac = 0.430; pinMidFrac <= 0.520; pinMidFrac += 0.005) {
  for (let taper = 0.20; taper <= 0.36; taper += 0.01) {
    const pinMid = pinMidFrac * W;
    const topW = botW * taper;
    const map: LaneCorners = {
      bl: { ...display.bl }, br: { ...display.br },
      tl: { x: pinMid - topW/2, y: pinY },
      tr: { x: pinMid + topW/2, y: pinY },
    };
    const r = scoreWithMap(map);
    if (!r || r.path15 == null) continue;
    const delta = r.arr != null ? Math.abs(r.arr - r.path15) : 99;
    rows.push({ pinMidFrac: +pinMidFrac.toFixed(3), taper: +taper.toFixed(2), ...r, delta,
      tl: +(map.tl.x.toFixed(0)), tr: +(map.tr.x.toFixed(0)) });
  }
}

// Filter path15 in [12.5, 15.5], span>=25, delta<=1
const good = rows.filter(r => r.path15 >= 12.5 && r.path15 <= 15.5 && r.span >= 25 && r.delta <= 1.0);
good.sort((a,b) => Math.abs(a.path15-14) - Math.abs(b.path15-14));
console.log(`Total rows=${rows.length} good=${good.length}`);
console.log("\nGood (path15∈[12.5,15.5] span≥25 Δ≤1):");
for (const r of good.slice(0, 40)) {
  console.log(`mid=${r.pinMidFrac.toFixed(3)} tap=${r.taper.toFixed(2)} p15=${r.path15.toFixed(2)} arr=${r.arr?.toFixed(1)} med=${r.med?.toFixed(1)} early=${r.earlyMean?.toFixed(1)} span=${r.span.toFixed(0)} [${r.minFeet.toFixed(0)}-${r.maxFeet.toFixed(0)}] TL${r.tl}/TR${r.tr}`);
}

// Also show near-band
const near = rows.filter(r => r.path15 >= 11 && r.path15 <= 17 && r.span >= 25 && r.delta <= 0.5);
near.sort((a,b) => Math.abs(a.path15-14) - Math.abs(b.path15-14));
console.log("\nNear (path15∈[11,17]):");
for (const r of near.slice(0, 25)) {
  console.log(`mid=${r.pinMidFrac.toFixed(3)} tap=${r.taper.toFixed(2)} p15=${r.path15.toFixed(2)} arr=${r.arr?.toFixed(1)} med=${r.med?.toFixed(1)} span=${r.span.toFixed(0)} TL${r.tl}/TR${r.tr}`);
}

// Current formula baseline
const cur = mappingCornersForTrack(display);
console.log("\nCurrent map TL/TR", cur.tl.x.toFixed(0), cur.tr.x.toFixed(0), "taper", ((cur.tr.x-cur.tl.x)/botW).toFixed(3));
const curR = scoreWithMap(cur);
console.log("Current:", curR);

writeFileSync("/tmp/diag-map-arr-r9c.json", JSON.stringify({ good: good.slice(0,40), near: near.slice(0,25), current: curR }, null, 2));
