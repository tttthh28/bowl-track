import { readFileSync } from "fs";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const TMP="/tmp/bowl-lateral", W=1060, H=954, N=120, FPS=15;
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
        pts.push({ image: contact, lane, t: f * (1000 / FPS), predicted: res.predicted || undefined, f });
      }
    }
  }
  return { pts, est: computeShotEstimate(pts) };
}
const probeFrames=[]; for(let f=5;f<95;f++) probeFrames.push({rgba:frameAt(f),width:W,height:H});

const tests: {name:string;c:LaneCorners}[] = [];
// Progressive BL move right, keep BR~800, vary top
for (const bl of [212, 260, 300, 330, 360, 380]) {
  for (const br of [795, 805]) {
    for (const pinMid of [0.50, 0.53, 0.56]) {
      for (const topF of [0.16, 0.18, 0.20]) {
        const c:LaneCorners={
          bl:{x:bl,y:0.86*H}, br:{x:br,y:0.86*H},
          tl:{x:pinMid*W-topF*W/2,y:0.11*H}, tr:{x:pinMid*W+topF*W/2,y:0.11*H},
        };
        tests.push({name:`BL${bl}-BR${br}-pm${pinMid}-t${topF}`, c});
      }
    }
  }
}
console.log("tests", tests.length);
for (const t of tests) {
  const {est,pts}=fullTrack(t.c);
  const probe=scoreCornersByProbe(t.c,probeFrames);
  const arr=est.arrowsBoard;
  const bot=(t.c.br.x-t.c.bl.x)/W;
  const midF=(t.c.bl.x+t.c.br.x)/2/W;
  const flag = arr!=null && arr>=13 && arr<=15.5 ? "★" : " ";
  if (arr!=null || pts.length>20) {
    console.log(`${flag} ${t.name} bot=${bot.toFixed(3)} midF=${midF.toFixed(3)} n=${pts.length} arr=${arr?.toFixed(1)??'—'} probe=${probe.arrows?.toFixed(1)??'—'}`);
  }
}
