/** Sweep snap mid; score path: maxBoard@ft<25, arr, b15 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners, shouldEndShot,
} from "../src/lib/tracker.ts";
import { detectLaneCorners, snapCornersToTrueGutter, scoreLaneGeometry, frameHasLaneSignal, clamp } from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";
import { pickBestCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

// patch snap via local builder
function makeCorners(base: LaneCorners, W: number, H: number, midF: number, botF: number): LaneCorners {
  const s = Math.min(1, 320 / W);
  const sw = Math.round(W * s), sh = Math.round(H * s), inv = 1/s;
  const trajMid = sw * midF;
  const half = (sw * botF) / 2;
  const foulY = Math.max(base.bl.y, base.br.y) * s;
  const fy = Math.min(sh * 0.88, Math.max(sh * 0.84, foulY));
  const pin = sh * 0.11;
  const topHalf = sw * 0.08;
  return {
    tl: { x: (trajMid - topHalf) * inv, y: pin * inv },
    tr: { x: (trajMid + topHalf) * inv, y: pin * inv },
    bl: { x: (trajMid - half) * inv, y: fy * inv },
    br: { x: (trajMid + half) * inv, y: fy * inv },
  };
}

const OUT = "/tmp/bowl-live5-30";
const W=1060,H=954,FPS=30;
const raw=readFileSync(`${OUT}/seq.rgba`);
const fb=W*H*4, framesN=Math.floor(raw.length/fb);
const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer,raw.byteOffset+Math.min(framesN-1,i)*fb,fb);
const step=2;
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
for (const t of [0.08,0.35,0.8,1.4,dur*0.28,dur*0.42,dur*0.58]) {
  const rgba=frameAt(Math.round(t*FPS));
  if(!frameHasLaneSignal(rgba,W,H)) continue;
  const next=detectLaneCorners(rgba,W,H);
  if(next) detCands.push({det:next,geom:scoreLaneGeometry(next,W,H)});
}
const ranked=detCands.map(c=>({...c,rank:c.geom})).sort((a,b)=>b.rank-a.rank);
const frames=[];
for(let i=0;i<60;i++){const rgba=frameAt(Math.round((0.2+i/15)*FPS)); if(frameHasLaneSignal(rgba,W,H)) frames.push({rgba,width:W,height:H});}
const picked=pickBestCornersByProbe(ranked.map(c=>({det:c.det,geomRank:c.rank})),frames,10);
const base=picked!.det.corners;

function trial(midF:number, botF:number, maxB:number, unlock:boolean) {
  const corners=makeCorners(base,W,H,midF,botF);
  const Hm=buildHomography(corners)!;
  const {scale,tw,th}=trackWorkSize(W,H);
  const workC=scaleLaneCorners(corners,scale);
  const state=new BallTrackerState();
  const settings={...DEFAULT_TRACKER};
  let shotPts:TrackPoint[]=[];
  let saved:TrackPoint[]|null=null;
  let gutterStreak=0;
  for(let f=0;f<framesN;f+=step){
    const rgba=frameAt(f);
    const work=scale<1?downscale(rgba,tw,th):new Uint8ClampedArray(rgba);
    const gray=rgbaToGray(work,scale<1?tw:W,scale<1?th:H);
    const res=trackBallFrame(state,gray,scale<1?tw:W,scale<1?th:H,settings,scale<1?workC:corners,1000/15,work);
    const pos=res.smoothed?(scale<1?{x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed):null;
    const rFull=res.radius!=null&&res.radius>0?(scale<1?res.radius/scale:res.radius):null;
    if(res.locked&&pos&&(res.raw!=null||res.predicted)){
      const contact=ballContactPoint(pos,rFull);
      const lane=imageToLane(Hm,contact);
      let accept=true;
      if(lane){
        if(lane.feet<40 && (lane.board>=maxB || lane.board<=6)) {
          accept=false;
          gutterStreak++;
          if(unlock && gutterStreak>=4){
            // keep good pts, unlock tracker
            state.beginNewShot({clearBg:true});
            gutterStreak=0;
          }
        } else gutterStreak=0;
      }
      if(accept && shotPts.length && lane && !res.predicted){
        const prev=shotPts[shotPts.length-1];
        if(prev.lane){
          const dFeet=lane.feet-prev.lane.feet;
          const dBoard=Math.abs(lane.board-prev.lane.board);
          if(dFeet<-0.8 || (dBoard>3.5 && dFeet<1)) accept=false;
          // steep board climb = gutter follow
          if(dFeet>0.3 && dBoard/dFeet > 1.2) accept=false;
        }
      }
      if(accept && lane) shotPts.push({image:contact,lane,t:f*(1000/FPS)});
    }
    if(shouldEndShot(state,settings,shotPts.length>0)){
      if(!saved && evaluateShotQuality(shotPts).ok) saved=shotPts.slice();
      break;
    }
  }
  if(!saved&&shotPts.length&&evaluateShotQuality(shotPts).ok) saved=shotPts;
  if(!saved) return {midF,botF,maxB,unlock,arr:null,b15:null,n:0,maxB25:null};
  const est=computeShotEstimate(saved);
  const at15=saved.filter(p=>p.lane&&p.lane.feet>=13&&p.lane.feet<=17).map(p=>p.lane!.board);
  const b15=at15.length?+[...at15].sort((a,b)=>a-b)[Math.floor(at15.length/2)].toFixed(1):null;
  const early=saved.filter(p=>p.lane&&p.lane.feet<25).map(p=>p.lane!.board);
  const maxB25=early.length?Math.max(...early):null;
  const feet=saved.filter(p=>p.lane).map(p=>p.lane!.feet);
  return {midF,botF,maxB,unlock,arr:est.arrowsBoard,b15,n:saved.length,maxB25:maxB25!=null?+maxB25.toFixed(1):null,
    ft:`${Math.min(...feet).toFixed(0)}-${Math.max(...feet).toFixed(0)}`};
}

const rows=[];
for (const mid of [0.42,0.428,0.44,0.45,0.46,0.47]) {
  for (const bot of [0.52,0.54]) {
    for (const maxB of [28, 25]) {
      for (const unlock of [true]) {
        rows.push(trial(mid, bot, maxB, unlock));
      }
    }
  }
}
rows.sort((a,b)=>{
  const sa=(a.arr!=null&&a.arr>=12.5&&a.arr<=15.5?100:0)+(a.b15!=null&&a.b15>=10&&a.b15<=18?50:0)+(a.maxB25!=null&&a.maxB25<28?30:0)+(a.n>20?10:0);
  const sb=(b.arr!=null&&b.arr>=12.5&&b.arr<=15.5?100:0)+(b.b15!=null&&b.b15>=10&&b.b15<=18?50:0)+(b.maxB25!=null&&b.maxB25<28?30:0)+(b.n>20?10:0);
  return sb-sa;
});
rows.slice(0,15).forEach(r=>console.log(JSON.stringify(r)));
