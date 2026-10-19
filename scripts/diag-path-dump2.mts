import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners, shouldEndShot,
} from "../src/lib/tracker.ts";
import { detectLaneCorners, snapCornersToTrueGutter, scoreLaneGeometry, frameHasLaneSignal } from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";
import { pickBestCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

const OUT = "/tmp/bowl-live5-30";
const W = 1060, H = 954, FPS = 30, N = 200;
const VIDEO = join(import.meta.dirname, "../test-media/bowling-demo.mp4");
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W*H*4;
const framesN = Math.floor(raw.length/fb);
const frameAt = (i:number)=>new Uint8ClampedArray(raw.buffer, raw.byteOffset+Math.min(framesN-1,i)*fb, fb);
const step = 2;

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
for(let i=0;i<60;i++){const rgba=frameAt(Math.round((0.2+i/15)*FPS)); if(frameHasLaneSignal(rgba,W,H)) frames.push({rgba,width:W,height:H});}
const picked=pickBestCornersByProbe(ranked.map(c=>({det:c.det,geomRank:c.rank})),frames,10);
const corners=snapCornersToTrueGutter(picked!.det.corners,W,H);
const Hm=buildHomography(corners)!;
const {scale,tw,th}=trackWorkSize(W,H);
const workC=scaleLaneCorners(corners,scale);

function run(opts: {maxBoard?:number; minBoard?:number; maxDBoard?:number; label:string}) {
  const state=new BallTrackerState();
  const settings={...DEFAULT_TRACKER};
  let shotPts:TrackPoint[]=[];
  let saved:TrackPoint[]|null=null;
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
      if(lane && !res.predicted){
        if(opts.maxBoard!=null && lane.feet<52 && lane.board>=opts.maxBoard) accept=false;
        if(opts.minBoard!=null && lane.feet<52 && lane.board<=opts.minBoard) accept=false;
      }
      if(accept && shotPts.length && lane && !res.predicted){
        const prev=shotPts[shotPts.length-1];
        if(prev.lane){
          const dFeet=lane.feet-prev.lane.feet;
          const dBoard=Math.abs(lane.board-prev.lane.board);
          if(dFeet < -0.8 || (dBoard > (opts.maxDBoard??3.5) && dFeet < 1.0)) accept=false;
          if(Math.abs(dFeet)/0.066 > 90 || dBoard > 14) accept=false;
        }
      }
      if(accept) shotPts.push({image:contact,lane,t:f*(1000/FPS),predicted:res.predicted||undefined});
    }
    if(shouldEndShot(state,settings,shotPts.length>0)){
      if(!saved && evaluateShotQuality(shotPts).ok) saved=shotPts.slice();
      shotPts=[]; state.beginNewShot({clearBg:true}); break;
    }
  }
  if(!saved&&shotPts.length&&evaluateShotQuality(shotPts).ok) saved=shotPts;
  if(!saved){console.log(JSON.stringify({label:opts.label,arr:null,n:0}));return;}
  const est=computeShotEstimate(saved);
  const at15=saved.filter(p=>p.lane&&p.lane.feet>=13&&p.lane.feet<=17).map(p=>p.lane!.board);
  const b15=at15.length?+[...at15].sort((a,b)=>a-b)[Math.floor(at15.length/2)].toFixed(1):null;
  const boards=saved.filter(p=>p.lane).map(p=>p.lane!.board);
  const feet=saved.filter(p=>p.lane).map(p=>p.lane!.feet);
  const path=saved.filter(p=>p.lane).map(p=>`${p.lane!.feet.toFixed(0)}:${p.lane!.board.toFixed(1)}`).join(' ');
  console.log(JSON.stringify({label:opts.label,arr:est.arrowsBoard,b15,n:saved.length,
    boards:`${Math.min(...boards).toFixed(1)}-${Math.max(...boards).toFixed(1)}`,
    ft:`${Math.min(...feet).toFixed(1)}-${Math.max(...feet).toFixed(1)}`, path}));
}

run({label:'jump only'});
run({label:'jump+maxBoard32', maxBoard:32});
run({label:'jump+maxBoard28', maxBoard:28});
run({label:'jump+max26', maxBoard:26});
run({label:'jump+band6-26', maxBoard:26, minBoard:6});
run({label:'jump+dBoard2.2', maxDBoard:2.2});
run({label:'jump+dBoard2+max28', maxDBoard:2.2, maxBoard:28});
