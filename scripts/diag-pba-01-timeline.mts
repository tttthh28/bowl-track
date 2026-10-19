import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane, longestForwardLanePoints, computeShotEstimate } from "../src/lib/perspective.ts";
import { computeShotEstimate as est2 } from "../src/lib/estimates.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const OUT="/tmp/pba-01", W=1280, H=720, FPS=30;
const raw=readFileSync(`${OUT}/seq.rgba`);
const fb=W*H*4, nFrames=Math.floor(raw.length/fb);
const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer, raw.byteOffset+Math.min(nFrames-1,i)*fb, fb);
function downscale(rgba:Uint8ClampedArray,tw:number,th:number){const out=new Uint8ClampedArray(tw*th*4);for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const sx=Math.min(W-1,Math.floor(x/tw*W)),sy=Math.min(H-1,Math.floor(y/th*H));const si=(sy*W+sx)*4,di=(y*tw+x)*4;out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;}return out;}
const corners:LaneCorners={tl:{x:522,y:245},tr:{x:690,y:245},br:{x:559,y:610},bl:{x:249,y:610}};
const Hm=buildHomography(corners)!;
const {scale,tw,th}=trackWorkSize(W,H);
const workC=scaleLaneCorners(corners,scale);
const state=new BallTrackerState();
const settings={...DEFAULT_TRACKER};
const pts:any[]=[];
let maxFeet=0;
for(let f=0;f<nFrames;f++){
  const rgba=frameAt(f);
  const work=scale<1?downscale(rgba,tw,th):new Uint8ClampedArray(rgba);
  const gray=rgbaToGray(work,scale<1?tw:W,scale<1?th:H);
  const res=trackBallFrame(state,gray,scale<1?tw:W,scale<1?th:H,settings,scale<1?workC:corners,1000/FPS,work);
  const pos=res.smoothed?(scale<1?{x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed):null;
  const rFull=res.radius!=null&&res.radius>0?(scale<1?res.radius/scale:res.radius):null;
  if(res.locked&&pos&&(res.raw!=null||res.predicted)){
    const contact=ballContactPoint(pos,rFull);
    const lane=imageToLane(Hm,contact);
    const t=f*(1000/FPS);
    // progressive filter: drop if feet << maxFeet (zoom rewind)
    let accept=true;
    if(lane){
      if((lane.board<1.2||lane.board>37.8)&&lane.feet<45) accept=false;
      if(accept && maxFeet>8 && lane.feet < maxFeet-2.5) accept=false;
      if(accept){ maxFeet=Math.max(maxFeet, lane.feet); pts.push({image:contact,lane,t,f,predicted:res.predicted||undefined}); }
    }
  }
}
console.log("filtered n", pts.length, "maxFeet", maxFeet);
for(const p of pts) console.log(`f=${p.f} t=${(p.t/1000).toFixed(2)} ft=${p.lane.feet.toFixed(1)} bd=${p.lane.board.toFixed(1)}`);
const est=est2(pts);
console.log("est", {arr:est.arrowsBoard, bp:est.breakpointBoard, bpDist:est.breakpointDistance, avg:est.avgSpeedMph});
const mir=(b:number|null|undefined)=>b==null?null:Math.round((39-b)*10)/10;
console.log("mirror", {arr:mir(est.arrowsBoard), bp:mir(est.breakpointBoard)});
const fwd=longestForwardLanePoints(pts);
console.log("fwd n", fwd.length, "ft", fwd.length?`${fwd[0].feet.toFixed(1)}–${fwd[fwd.length-1].feet.toFixed(1)}`:"");
