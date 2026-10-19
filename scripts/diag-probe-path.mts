/** Compare probe track path vs live 30→15 path with same corners */
import { execSync } from "child_process";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { detectLaneCorners, snapCornersToTrueGutter, scoreLaneGeometry, frameHasLaneSignal } from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { pickBestCornersByProbe, scoreCornersByProbe } from "../src/lib/laneProbe.ts";

const OUT = "/tmp/bowl-live5-30";
const W=1060,H=954,FPS=30;
const raw=readFileSync(`${OUT}/seq.rgba`);
const fb=W*H*4, framesN=Math.floor(raw.length/fb);
const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer,raw.byteOffset+Math.min(framesN-1,i)*fb,fb);

function downscale(rgba:Uint8ClampedArray,tw:number,th:number){
  const out=new Uint8ClampedArray(tw*th*4);
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
    const sx=Math.min(W-1,Math.floor(x/tw*W)),sy=Math.min(H-1,Math.floor(y/th*H));
    const si=(sy*W+sx)*4,di=(y*tw+x)*4;
    out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;
  }
  return out;
}

const dur=framesN/FPS;
const detCands:any[]=[];
for (const t of [0.08,0.35,0.8,1.4,dur*0.28,dur*0.42,dur*0.58,dur*0.72]) {
  const rgba=frameAt(Math.round(t*FPS));
  if(!frameHasLaneSignal(rgba,W,H)) continue;
  const next=detectLaneCorners(rgba,W,H);
  if(next) detCands.push({det:next,geom:scoreLaneGeometry(next,W,H)});
}
const ranked=detCands.map(c=>({...c,rank:c.geom})).sort((a,b)=>b.rank-a.rank);
const frames=[];
for(let i=0;i<90;i++){
  const tP=Math.min(dur-0.06,0.2+i/15);
  const rgba=frameAt(Math.round(tP*FPS));
  if(frameHasLaneSignal(rgba,W,H)) frames.push({rgba,width:W,height:H,t:tP});
}
const picked=pickBestCornersByProbe(ranked.map(c=>({det:c.det,geomRank:c.rank})),frames.map(f=>({rgba:f.rgba,width:W,height:H})),10);
const corners=snapCornersToTrueGutter(picked!.det.corners,W,H);
console.log('probeArr', picked!.detail.arrows, 'med', picked!.detail.med, 'ft', picked!.detail.minFeet.toFixed(1)+'-'+picked!.detail.maxFeet.toFixed(1));

// Re-score to get path? scoreCornersByProbe doesn't return path. Manually track like probe.
const detail = scoreCornersByProbe(corners, frames.map(f=>({rgba:f.rgba,width:W,height:H})), {});
console.log('rescore', detail);

// Manual: track with DEFAULT like probe (check laneProbe settings)
import { readFileSync as rf } from "fs";
// read laneProbe track settings
