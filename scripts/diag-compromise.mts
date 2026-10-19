import { readFileSync, writeFileSync } from "fs";
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

// green L15 reference
const gL = (yf:number) => {
  // interpolate pinSign: 0.86→360, 0.11→511
  return 360 + (511-360)*(0.86-yf)/(0.86-0.11);
};
const gR = (yf:number) => 805 + (693-805)*(0.86-yf)/(0.86-0.11);

function edgeDx(c:LaneCorners) {
  const ys=[0.86,0.70,0.55,0.40,0.25,0.11];
  let s=0;
  const rows:any[]=[];
  for (const yf of ys) {
    const y=yf*H;
    const t=(y-c.tl.y)/Math.max(1e-6,c.bl.y-c.tl.y);
    const bL=c.tl.x+(c.bl.x-c.tl.x)*t;
    const bR=c.tr.x+(c.br.x-c.tr.x)*t;
    const dL=bL-gL(yf), dR=bR-gR(yf);
    s+=Math.abs(dL)+Math.abs(dR);
    rows.push({yf,dL:dL.toFixed(0),dR:dR.toFixed(0)});
  }
  return {mean:s/(ys.length*2), rows};
}

const cands: {name:string;c:LaneCorners}[] = [];
for (const pinMid of [0.53, 0.54, 0.55, 0.56, 0.57]) {
  for (const topF of [0.16, 0.18, 0.20, 0.22]) {
    cands.push({
      name: `pm${pinMid}-t${topF}`,
      c: {
        bl:{x:360,y:0.86*H}, br:{x:805,y:0.86*H},
        tl:{x:pinMid*W-topF*W/2,y:0.11*H}, tr:{x:pinMid*W+topF*W/2,y:0.11*H},
      },
    });
  }
}
// also: TL/TR on green/red (full visual)
cands.push({
  name: "on-gutter-lines",
  c: { bl:{x:360,y:0.86*H}, br:{x:805,y:0.86*H}, tl:{x:511,y:0.11*H}, tr:{x:693,y:0.11*H} },
});

for (const cand of cands) {
  const {est,pts}=fullTrack(cand.c);
  const probe=scoreCornersByProbe(cand.c,probeFrames);
  const dx=edgeDx(cand.c);
  const arr=est.arrowsBoard;
  const star = arr!=null && arr>=13 && arr<=15.5 ? "★" : " ";
  console.log(`${star} ${cand.name} n=${pts.length} arr=${arr?.toFixed(1)??'—'} probe=${probe.arrows?.toFixed(1)??'—'} mean|dx|=${dx.mean.toFixed(1)} pinsDx=${dx.rows[5].dL}/${dx.rows[5].dR} midDx=${dx.rows[2].dL}/${dx.rows[2].dR}`);
}
