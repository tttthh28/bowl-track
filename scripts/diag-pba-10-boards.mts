import { readFileSync } from "fs";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane, boardAtFeet } from "../src/lib/perspective.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const raw=readFileSync("/tmp/pba-10/seq.rgba");
const W=1280,H=720,FPS=30,fb=W*H*4,nFrames=Math.floor(raw.length/fb);
const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer,raw.byteOffset+Math.min(nFrames-1,i)*fb,fb);
function downscale(rgba:Uint8ClampedArray,tw:number,th:number){const out=new Uint8ClampedArray(tw*th*4);for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const sx=Math.min(W-1,Math.floor(x/tw*W)),sy=Math.min(H-1,Math.floor(y/th*H));const si=(sy*W+sx)*4,di=(y*tw+x)*4;out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;}return out;}
const corners:LaneCorners={tl:{x:496,y:180},tr:{x:753,y:180},br:{x:668,y:470},bl:{x:366,y:470}};
const Hm=buildHomography(corners)!;
const {scale,tw,th}=trackWorkSize(W,H); const workC=scaleLaneCorners(corners,scale);
const state=new BallTrackerState(); const settings={...DEFAULT_TRACKER}; const pts:any[]=[];
for(let f=0;f<nFrames;f++){
  const rgba=frameAt(f); const work=scale<1?downscale(rgba,tw,th):new Uint8ClampedArray(rgba);
  const gray=rgbaToGray(work,scale<1?tw:W,scale<1?th:H);
  const res=trackBallFrame(state,gray,scale<1?tw:W,scale<1?th:H,settings,scale<1?workC:corners,1000/FPS,work);
  const pos=res.smoothed?(scale<1?{x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed):null;
  const rFull=res.radius!=null&&res.radius>0?(scale<1?res.radius/scale:res.radius):null;
  if(res.locked&&pos&&(res.raw!=null||res.predicted)){
    const lane=imageToLane(Hm,ballContactPoint(pos,rFull));
    if(lane && !((lane.board<1.2||lane.board>37.8)&&lane.feet<45))
      pts.push({image:ballContactPoint(pos,rFull),lane,t:f*(1000/FPS)});
  }
}
for(const ft of [12,15,20,25,30,35,40,45,50]) {
  const b=boardAtFeet(pts,ft);
  console.log(`ft=${ft} board=${b?.toFixed(1)??"—"} pbaRight=${b!=null?(39-b).toFixed(1):"—"}`);
}
// print sorted by feet unique-ish
const byF=[...pts].filter(p=>p.lane).sort((a,b)=>a.lane.feet-b.lane.feet);
for(let i=0;i<byF.length;i+=Math.max(1,Math.floor(byF.length/15))) {
  const p=byF[i];
  console.log(`  ${p.lane.feet.toFixed(1)}′ board ${p.lane.board.toFixed(1)} (PBA ${ (39-p.lane.board).toFixed(1)})`);
}
