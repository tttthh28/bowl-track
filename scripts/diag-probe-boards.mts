import { readFileSync } from "fs";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { detectLaneCorners, snapCornersToTrueGutter, scoreLaneGeometry, frameHasLaneSignal } from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { pickBestCornersByProbe } from "../src/lib/laneProbe.ts";

const OUT="/tmp/bowl-live5-30"; const W=1060,H=954,FPS=30;
const raw=readFileSync(`${OUT}/seq.rgba`); const fb=W*H*4; const framesN=Math.floor(raw.length/fb);
const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer,raw.byteOffset+Math.min(framesN-1,i)*fb,fb);
function downscale(rgba:Uint8ClampedArray,tw:number,th:number){
  const out=new Uint8ClampedArray(tw*th*4);
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
    const sx=Math.min(W-1,Math.floor(x/tw*W)),sy=Math.min(H-1,Math.floor(y/th*H));
    const si=(sy*W+sx)*4,di=(y*tw+x)*4;
    out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;
  } return out;
}
const dur=framesN/FPS;
const detCands:any[]=[];
for(const t of [0.08,0.35,0.8,1.4,dur*0.28,dur*0.42,dur*0.58]){
  const rgba=frameAt(Math.round(t*FPS));
  if(!frameHasLaneSignal(rgba,W,H)) continue;
  const next=detectLaneCorners(rgba,W,H);
  if(next) detCands.push({det:next,geom:scoreLaneGeometry(next,W,H)});
}
const ranked=detCands.map(c=>({...c,rank:c.geom})).sort((a,b)=>b.rank-a.rank);
const frames=[];
for(let i=0;i<90;i++){
  const tP=0.2+i/15;
  const rgba=frameAt(Math.min(framesN-1,Math.round(tP*FPS)));
  if(frameHasLaneSignal(rgba,W,H)) frames.push({rgba,width:W,height:H});
}
const picked=pickBestCornersByProbe(ranked.map(c=>({det:c.det,geomRank:c.rank})),frames,10);
const corners=snapCornersToTrueGutter(picked!.det.corners,W,H);
console.log('probeArr',picked!.detail.arrows,'med',picked!.detail.med);

// Replay probe-style: frames at 15fps spacing from t=0.2, dt=1000/15
const Hm=buildHomography(corners)!;
const {scale,tw,th}=trackWorkSize(W,H);
const workC=scaleLaneCorners(corners,scale);
const state=new BallTrackerState();
const settings={...DEFAULT_TRACKER, sensitivity:26, minBlobPixels:28};
const path:string[]=[];
for(let i=0;i<frames.length;i++){
  const rgba=frames[i].rgba;
  const work=scale<1?downscale(rgba,tw,th):new Uint8ClampedArray(rgba);
  const gray=rgbaToGray(work,scale<1?tw:W,scale<1?th:H);
  const res=trackBallFrame(state,gray,scale<1?tw:W,scale<1?th:H,settings,scale<1?workC:corners,1000/15,work);
  if(res.locked&&res.smoothed){
    const pos=scale<1?{x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed;
    const r=res.radius!=null&&res.radius>0?(scale<1?res.radius/scale:res.radius):null;
    const lane=imageToLane(Hm,ballContactPoint(pos,r));
    if(lane&&lane.board>=1.5&&lane.board<=37.5) path.push(`${lane.feet.toFixed(0)}:${lane.board.toFixed(1)}`);
  }
}
console.log('probePath', path.join(' '));
console.log('est', computeShotEstimate(path.map((s,i)=>{
  const [f,b]=s.split(':').map(Number);
  return {image:{x:0,y:0},lane:{feet:f,board:b},t:i*66};
})).arrowsBoard);
