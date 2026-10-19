/**
 * Test: display = r9 true gutters (visual unchanged);
 * mapping foul inset / pins de-skewed to restore arr∈[13,15].
 */
import { readFileSync, writeFileSync } from "fs";
import { buildHomography, imageToLane, mappingCornersForTrack } from "../src/lib/perspective.ts";
import type { LaneCorners } from "../src/lib/types.ts";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";

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

/** Custom score: H+ROI from map; report arr/path15/med/span */
function scoreWithMap(map: LaneCorners, label: string) {
  const fps = 15;
  const Hm = buildHomography(map);
  if (!Hm) { console.log(label, "no H"); return null; }
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
  const r = { arr: est?.arrowsBoard ?? null, med, path15, span: Math.max(0,maxFeet-minFeet), locks, minFeet, maxFeet,
    mapBL: map.bl.x.toFixed(0), mapBR: map.br.x.toFixed(0), mapTL: map.tl.x.toFixed(0), mapTR: map.tr.x.toFixed(0),
    botFrac: ((map.br.x-map.bl.x)/W).toFixed(3), midF: (((map.bl.x+map.br.x)/2)/W).toFixed(3),
    midP: (((map.tl.x+map.tr.x)/2)/W).toFixed(3), topFrac: (((map.tr.x-map.tl.x)/W)).toFixed(3) };
  console.log(`${label}: arr=${r.arr?.toFixed(1)??'—'} p15=${r.path15?.toFixed(1)??'—'} med=${r.med?.toFixed(1)??'—'} span=${r.span.toFixed(0)} [${r.minFeet.toFixed(0)}-${r.maxFeet.toFixed(0)}] L=${r.locks} mapBL/BR=${r.mapBL}/${r.mapBR} TL/TR=${r.mapTL}/${r.mapTR} bot=${r.botFrac} midF=${r.midF} midP=${r.midP} top=${r.topFrac}`);
  return r;
}

console.log("=== A: current mappingCornersForTrack(display) ===");
scoreWithMap(mappingCornersForTrack(display), "cur");

console.log("\n=== B: mapping foul = old inset 208/802; pins de-skew midF+top0.18 ===");
{
  const bl = 208, br = 802, fy = 0.9*H, py = 0.096*H;
  const mid = (bl+br)/2, botW = br-bl, topW = botW*(0.18/0.56);
  scoreWithMap({
    bl:{x:bl,y:fy}, br:{x:br,y:fy},
    tl:{x:mid-topW/2,y:py}, tr:{x:mid+topW/2,y:py},
  }, "old-inset-deskew");
}

console.log("\n=== C: mapping foul inset from display toward mid (botFrac targets) ===");
const midDisp = (display.bl.x + display.br.x) / 2;
const pinY = (display.tl.y + display.tr.y) / 2;
for (const botFrac of [0.50, 0.52, 0.54, 0.56, 0.58]) {
  for (const topAbs of [0.16, 0.18, 0.20]) { // top as fraction of W
    const half = (botFrac * W) / 2;
    const bl = midDisp - half, br = midDisp + half;
    const topW = topAbs * W;
    const map: LaneCorners = {
      bl: { x: bl, y: display.bl.y }, br: { x: br, y: display.br.y },
      tl: { x: midDisp - topW/2, y: pinY }, tr: { x: midDisp + topW/2, y: pinY },
    };
    scoreWithMap(map, `bot${botFrac}-top${topAbs}`);
  }
}

console.log("\n=== D: hybrid ROI=display H=inset-map (track ROI vs H split) ===");
// Simulate: track with display ROI but H from inset map — need custom loop
async function scoreSplit(roi: LaneCorners, hCorners: LaneCorners, label: string) {
  const fps = 15;
  const Hm = buildHomography(hCorners);
  if (!Hm) return;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workRoi = scaleLaneCorners(roi, scale);
  const st = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const boards: number[] = [];
  const pts: any[] = [];
  let maxFeet = 0, minFeet = 99, locks = 0;
  for (let i = 0; i < probeFrames.length; i++) {
    const fr = probeFrames[i];
    let trackRgba = fr.rgba, trackW = W, trackH = H, useC = roi;
    if (scale < 1) {
      trackRgba = downscale(fr.rgba, W, H, tw, th);
      trackW = tw; trackH = th; useC = workRoi;
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
  console.log(`${label}: arr=${est?.arrowsBoard?.toFixed(1)??'—'} p15=${path15?.toFixed(1)??'—'} med=${med?.toFixed(1)??'—'} span=${Math.max(0,maxFeet-minFeet).toFixed(0)} [${minFeet.toFixed(0)}-${maxFeet.toFixed(0)}] L=${locks}`);
}

// inset map for H
{
  const mid = midDisp, botW = 0.56*W, topW = 0.18*W;
  const hMap: LaneCorners = {
    bl: { x: mid - botW/2, y: display.bl.y }, br: { x: mid + botW/2, y: display.br.y },
    tl: { x: mid - topW/2, y: pinY }, tr: { x: mid + topW/2, y: pinY },
  };
  await scoreSplit(display, hMap, "ROI=display H=inset0.56/0.18");
  await scoreSplit(hMap, hMap, "ROI=H=inset0.56/0.18");
  // Current map for H, display for ROI
  await scoreSplit(display, mappingCornersForTrack(display), "ROI=display H=curMap");
  // Old 208/802 deskew for H
  const bl=208,br=802,botW2=br-bl,topW2=botW2*(0.18/0.56),mid2=(bl+br)/2;
  const oldH: LaneCorners = {
    bl:{x:bl,y:display.bl.y}, br:{x:br,y:display.br.y},
    tl:{x:mid2-topW2/2,y:pinY}, tr:{x:mid2+topW2/2,y:pinY},
  };
  await scoreSplit(display, oldH, "ROI=display H=old208/802");
  await scoreSplit(oldH, oldH, "ROI=H=old208/802");
}

console.log("\n=== E: scoreCornersByProbe(display) — production path ===");
const prod = scoreCornersByProbe(display, probeFrames);
console.log(`prod arr=${prod.arrows?.toFixed(1)} med=${prod.med?.toFixed(1)} span=${(prod.maxFeet-prod.minFeet).toFixed(1)} locks=${prod.locks}`);
