/** Validate bot=0.50/top=0.16 mapping on real Hough display corners */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { detectLaneCornersHough } from "../src/lib/laneDetectHough.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
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

function proposedMap(corners: LaneCorners, frameWidth: number): LaneCorners {
  const midF = (corners.bl.x + corners.br.x) / 2;
  const dispBotW = Math.max(8, corners.br.x - corners.bl.x);
  const botFrac = dispBotW / frameWidth;
  const pinY = (corners.tl.y + corners.tr.y) / 2;
  const foulY = (corners.bl.y + corners.br.y) / 2;
  const MAP_BOT = 0.50;
  const MAP_TOP = 0.16;
  if (botFrac > 0.52) {
    const mapBotW = MAP_BOT * frameWidth;
    const mapTopW = MAP_TOP * frameWidth;
    return {
      bl: { x: midF - mapBotW / 2, y: foulY },
      br: { x: midF + mapBotW / 2, y: foulY },
      tl: { x: midF - mapTopW / 2, y: pinY },
      tr: { x: midF + mapTopW / 2, y: pinY },
    };
  }
  // legacy: keep foul, de-skew pins
  const topW = dispBotW * (0.18 / 0.56);
  return {
    bl: { ...corners.bl },
    br: { ...corners.br },
    tl: { x: midF - topW / 2, y: pinY },
    tr: { x: midF + topW / 2, y: pinY },
  };
}

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
  return { arr: est?.arrowsBoard ?? null, med, path15, span: Math.max(0,maxFeet-minFeet), locks, minFeet, maxFeet };
}

// Detect Hough on several frames
const fis = [12, 21, 36, 48, 60, 72];
console.log("=== Hough display corners + proposed map arr ===");
for (const fi of fis) {
  const rgba = frameAt(fi);
  const det = detectLaneCornersHough(rgba, W, H, { demoRearView: true });
  if (!det) { console.log(`fi${fi}: null`); continue; }
  const c = det.corners;
  const botFrac = (c.br.x - c.bl.x) / W;
  const cur = mappingCornersForTrack(c);
  const prop = proposedMap(c, W);
  const rCur = scoreWithMap(cur);
  const rProp = scoreWithMap(prop);
  // Also production probe (applies mapping once to display)
  const prodCur = scoreCornersByProbe(c, probeFrames);
  console.log(`fi${fi}: disp BL/BR=${c.bl.x.toFixed(0)}/${c.br.x.toFixed(0)} TL/TR=${c.tl.x.toFixed(0)}/${c.tr.x.toFixed(0)} bot=${botFrac.toFixed(3)} foulY=${(c.bl.y/H).toFixed(3)}`);
  console.log(`  curMap  arr=${rCur?.arr?.toFixed(1)} p15=${rCur?.path15?.toFixed(1)} med=${rCur?.med?.toFixed(1)} span=${rCur?.span.toFixed(0)} | probeArr=${prodCur.arrows?.toFixed(1)} med=${prodCur.med?.toFixed(1)}`);
  console.log(`  propMap arr=${rProp?.arr?.toFixed(1)} p15=${rProp?.path15?.toFixed(1)} med=${rProp?.med?.toFixed(1)} span=${rProp?.span.toFixed(0)} mapBL/BR=${prop.bl.x.toFixed(0)}/${prop.br.x.toFixed(0)} TL/TR=${prop.tl.x.toFixed(0)}/${prop.tr.x.toFixed(0)}`);
}

// Sweep MAP_BOT / MAP_TOP on fi21-like fixed display
console.log("\n=== Sweep MAP_BOT × MAP_TOP on r9 display ===");
const display: LaneCorners = {
  bl: { x: 184, y: 0.9 * H }, br: { x: 810, y: 0.9 * H },
  tl: { x: 558, y: 0.096 * H }, tr: { x: 690, y: 0.096 * H },
};
const rows: any[] = [];
for (const mb of [0.48, 0.49, 0.50, 0.51, 0.52]) {
  for (const mt of [0.14, 0.15, 0.16, 0.17, 0.18]) {
    const midF = (display.bl.x + display.br.x) / 2;
    const map: LaneCorners = {
      bl: { x: midF - mb*W/2, y: display.bl.y },
      br: { x: midF + mb*W/2, y: display.br.y },
      tl: { x: midF - mt*W/2, y: display.tl.y },
      tr: { x: midF + mt*W/2, y: display.tr.y },
    };
    const r = scoreWithMap(map);
    if (!r) continue;
    const ok = r.path15 != null && r.path15 >= 13 && r.path15 <= 15 && Math.abs((r.arr??99)-r.path15) <= 0.5 && r.span >= 20;
    rows.push({ mb, mt, ...r, ok });
    console.log(`bot${mb}-top${mt}: arr=${r.arr?.toFixed(1)} p15=${r.path15?.toFixed(1)} med=${r.med?.toFixed(1)} span=${r.span.toFixed(0)} ${ok?'✓':''}`);
  }
}
writeFileSync("/tmp/diag-map-arr-r9e.json", JSON.stringify(rows, null, 2));
