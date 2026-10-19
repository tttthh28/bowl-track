/** Finer mapping sweep: prefer arr≈path15 ∈[12,16], good span */
import { readFileSync, writeFileSync } from "fs";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
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
  return { arr: est?.arrowsBoard ?? null, med, path15, span: Math.max(0,maxFeet-minFeet), locks, minFeet, maxFeet };
}

// Finer: pinMid as fraction of W, topW as fraction of botW (taper)
const rows: any[] = [];
for (const pinMidFrac of [0.44,0.45,0.46,0.47,0.475,0.48,0.49,0.50,0.51,0.52,0.53,0.54,0.55,0.56,0.57,0.58]) {
  for (const taper of [0.14,0.16,0.18,0.20,0.22,0.24,0.26,0.28,0.30,0.32]) {
    const pinMid = pinMidFrac * W;
    const topW = botW * taper;
    const map: LaneCorners = {
      bl: { ...display.bl }, br: { ...display.br },
      tl: { x: pinMid - topW/2, y: pinY },
      tr: { x: pinMid + topW/2, y: pinY },
    };
    const r = scoreWithMap(map);
    if (!r) continue;
    const delta = r.arr != null && r.path15 != null ? Math.abs(r.arr - r.path15) : 99;
    const inBand = r.path15 != null && r.path15 >= 12 && r.path15 <= 16;
    rows.push({
      pinMidFrac, taper, ...r, delta,
      tl: map.tl.x.toFixed(0), tr: map.tr.x.toFixed(0),
      score: r.path15 == null || r.span < 20 ? 999 :
        Math.abs((r.path15 ?? 99) - 14) + delta * 2 + (r.span < 30 ? 5 : 0) + (inBand ? 0 : 10)
    });
  }
}
rows.sort((a,b) => a.score - b.score);
console.log("Best by path15≈14, arr≈path, span≥20:");
for (const r of rows.slice(0, 30)) {
  console.log(`mid=${r.pinMidFrac.toFixed(3)} tap=${r.taper.toFixed(2)} arr=${r.arr?.toFixed(1)??'—'} p15=${r.path15?.toFixed(1)??'—'} Δ=${r.delta.toFixed(2)} med=${r.med?.toFixed(1)??'—'} span=${r.span.toFixed(0)} [${r.minFeet.toFixed(0)}-${r.maxFeet.toFixed(0)}] TL${r.tl}/TR${r.tr}`);
}

// Also try: keep DISPLAY pin skew partially (lerp display mid toward foul mid)
console.log("\n=== Partial de-skew: lerp pinMid display→foulMid ===");
const dispMid = (display.tl.x + display.tr.x) / 2;
const dispTopW = display.tr.x - display.tl.x;
for (const alpha of [0, 0.25, 0.4, 0.5, 0.6, 0.75, 1.0]) {
  for (const topScale of [0.8, 1.0, 1.2, 1.5, 2.0, 2.5]) {
    const pinMid = dispMid + alpha * (midF - dispMid);
    const topW = Math.min(botW * 0.4, dispTopW * topScale);
    // also try fixed taper
    const map: LaneCorners = {
      bl: { ...display.bl }, br: { ...display.br },
      tl: { x: pinMid - topW/2, y: pinY },
      tr: { x: pinMid + topW/2, y: pinY },
    };
    const r = scoreWithMap(map);
    if (!r || r.path15 == null || r.span < 20) continue;
    const delta = Math.abs((r.arr ?? 99) - r.path15);
    if (r.path15 >= 11 && r.path15 <= 17) {
      console.log(`α=${alpha.toFixed(2)} topSc=${topScale.toFixed(1)} mid=${(pinMid/W).toFixed(3)} tw=${topW.toFixed(0)} arr=${r.arr?.toFixed(1)} p15=${r.path15.toFixed(1)} Δ=${delta.toFixed(2)} med=${r.med?.toFixed(1)} span=${r.span.toFixed(0)}`);
    }
  }
}

writeFileSync("/tmp/diag-map-arr-r9b.json", JSON.stringify(rows.slice(0,50), null, 2));
