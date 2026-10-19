/** Shift mid right while keeping trackable bot; measure arr + foul dx vs L15 anchors */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const TMP="/tmp/bowl-lateral", W=1060, H=954, N=120, FPS=15;
const OUT=join(import.meta.dirname,"../tmp-reports/auto-corners-opus-2026-10-19");
const raw=readFileSync(`${TMP}/seq.rgba`);
const fb=W*H*4;
const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer,raw.byteOffset+i*fb,fb);
function downscale(rgba:Uint8ClampedArray,tw:number,th:number){
  const out=new Uint8ClampedArray(tw*th*4);
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
    const sx=Math.min(W-1,Math.floor(x/tw*W)),sy=Math.min(H-1,Math.floor(y/th*H));
    const si=(sy*W+sx)*4,di=(y*tw+x)*4;
    out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;
  }
  return out;
}
function fullTrack(corners: LaneCorners) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const pts: any[] = [];
  for (let f = 0; f < N; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000 / FPS, work);
    const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed) : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;
      const contact = ballContactPoint(pos, rFull);
      const lane = imageToLane(Hm, contact);
      let accept = true;
      if (!res.predicted && (lane.board < 1.2 || lane.board > 37.8) && lane.feet < 45) accept = false;
      if (accept && (pts.length > 0 || !res.predicted)) {
        pts.push({ image: contact, lane, t: f * (1000 / FPS), predicted: res.predicted || undefined });
      }
    }
  }
  return { pts, est: computeShotEstimate(pts) };
}

const probeFrames=[]; for(let f=5;f<95;f++) probeFrames.push({rgba:frameAt(f),width:W,height:H});
// L15 foul anchors from pinSign
const L15L=360, L15R=805;

const rows:any[]=[];
for (const midF of [0.475, 0.49, 0.50, 0.51, 0.52, 0.53, 0.54, 0.55]) {
  for (const bot of [0.42, 0.46, 0.50, 0.52, 0.55, 0.56]) {
    for (const pinMid of [midF, midF+0.02, midF+0.04, 0.56]) {
      for (const topF of [0.16, 0.18, 0.20]) {
        const fy=0.86*H, py=0.11*H;
        const half=bot*W/2;
        const bl=midF*W-half, br=midF*W+half;
        if (bl<80||br>W-80) continue;
        const tl=pinMid*W-topF*W/2, tr=pinMid*W+topF*W/2;
        if (tl>=tr||tl<50||tr>W-50) continue;
        const c:LaneCorners={bl:{x:bl,y:fy},br:{x:br,y:fy},tl:{x:tl,y:py},tr:{x:tr,y:py}};
        const {est,pts}=fullTrack(c);
        const probe=scoreCornersByProbe(c,probeFrames);
        const arr=est.arrowsBoard;
        if (arr==null || arr<12.5 || arr>16) continue;
        const dxL=bl-L15L, dxR=br-L15R;
        rows.push({midF,bot,pinMid,topF,arr,probe:probe.arrows,n:pts.length,
          dxL,dxR,absFoul:Math.abs(dxL)+Math.abs(dxR),
          bl,br,tl,tr,
          score: Math.abs(dxL)+Math.abs(dxR)+Math.abs(arr-14.5)*8});
      }
    }
  }
}
rows.sort((a,b)=>a.score-b.score);
console.log("Hits with arr∈[12.5,16], best foul-dx to L15:");
for (const r of rows.slice(0,20)) {
  console.log(`midF=${r.midF.toFixed(3)} bot=${r.bot.toFixed(2)} pinMid=${r.pinMid.toFixed(3)} top=${r.topF} arr=${r.arr.toFixed(1)} probe=${r.probe?.toFixed(1)??'—'} n=${r.n} dxL=${r.dxL.toFixed(0)} dxR=${r.dxR.toFixed(0)} BL=${r.bl.toFixed(0)} BR=${r.br.toFixed(0)}`);
}
console.log("total", rows.length);
writeFileSync(join(OUT,"shift-right.json"), JSON.stringify(rows.slice(0,30),null,2));
