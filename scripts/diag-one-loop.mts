import { readFileSync } from "fs";
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
import type { TrackPoint } from "../src/lib/types.ts";

const OUT="/tmp/bowl-live5-30"; const W=1060,H=954,FPS=30;
const raw=readFileSync(`${OUT}/seq.rgba`); const fb=W*H*4; const framesN=Math.floor(raw.length/fb);
const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer,raw.byteOffset+Math.min(framesN-1,i)*fb,fb);
const step=2;
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
for(let i=0;i<60;i++){const rgba=frameAt(Math.round((0.2+i/15)*FPS)); if(frameHasLaneSignal(rgba,W,H)) frames.push({rgba,width:W,height:H});}
const picked=pickBestCornersByProbe(ranked.map(c=>({det:c.det,geomRank:c.rank})),frames,10);
const corners=snapCornersToTrueGutter(picked!.det.corners,W,H);
console.log('mid',((corners.bl.x+corners.br.x)/2).toFixed(0),'probe',picked!.detail.arrows);

const Hm=buildHomography(corners)!;
const {scale,tw,th}=trackWorkSize(W,H);
const workC=scaleLaneCorners(corners,scale);
const state=new BallTrackerState();
const settings={...DEFAULT_TRACKER};
let shotPts:TrackPoint[]=[];
let gutterStreak=0;
let accepted=0, rejected=0, unlocked=0, endAt=-1;
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
      if(lane.feet<45&&(lane.board>=22||lane.board<=7)) accept=false;
      if(lane.feet<40&&(lane.board>=23||lane.board<=6)){
        gutterStreak++;
        if(gutterStreak>=2){
          const good=[...shotPts].reverse().find(p=>p.lane&&p.lane.board>8&&p.lane.board<21&&p.image);
          state.beginNewShot({clearBg:true});
          if(good?.image){
            const midX=((corners.tl.x+corners.tr.x)/2+(corners.bl.x+corners.br.x)/2)/2;
            const pinY=(corners.tl.y+corners.tr.y)/2;
            const foulY=(corners.bl.y+corners.br.y)/2;
            const y=Math.max(pinY+(foulY-pinY)*0.35, good.image.y-Math.abs(foulY-pinY)*0.12);
            const s=scale<1?scale:1;
            state.seedAt({x:midX*s,y:y*s});
          }
          gutterStreak=0; unlocked++;
        }
      } else if(lane.board>8&&lane.board<21) gutterStreak=0;
    }
    if(accept&&shotPts.length&&lane){
      const prev=shotPts[shotPts.length-1];
      if(prev.lane){
        const dFeet=lane.feet-prev.lane.feet;
        const dBoard=Math.abs(lane.board-prev.lane.board);
        if(dFeet<-0.8||(dBoard>3.5&&dFeet<1)) accept=false;
        if(lane.board>22&&dFeet>0.35&&dBoard/dFeet>1.5) accept=false;
      }
    }
    if(accept&&lane){ shotPts.push({image:contact,lane,t:f*(1000/FPS)}); accepted++;
      if(accepted<=8) console.log('ACC', lane.feet.toFixed(1), lane.board.toFixed(1));
    } else {
      rejected++;
      if(rejected<=10 && lane) console.log('REJ', lane.feet.toFixed(1), lane.board.toFixed(1), 'locked', res.locked);
    }
  }
  if(shouldEndShot(state,settings,shotPts.length>0)){
    endAt=f;
    console.log('shouldEnd', {f, n:shotPts.length, q:evaluateShotQuality(shotPts), locked:state.locked});
    break;
  }
  // keep pts on unlock
}
const feet=shotPts.filter(p=>p.lane).map(p=>p.lane!.feet);
const boards=shotPts.filter(p=>p.lane).map(p=>p.lane!.board);
const path=shotPts.filter(p=>p.lane).map(p=>`${p.lane!.feet.toFixed(0)}:${p.lane!.board.toFixed(1)}`).join(' ');
console.log({accepted,rejected,unlocked,endAt,n:shotPts.length,
  ft:feet.length?`${Math.min(...feet).toFixed(1)}-${Math.max(...feet).toFixed(1)}`:null,
  boards:boards.length?`${Math.min(...boards).toFixed(1)}-${Math.max(...boards).toFixed(1)}`:null,
  q:evaluateShotQuality(shotPts),
  arr:shotPts.length?computeShotEstimate(shotPts).arrowsBoard:null,
  path:path.slice(0,200)});
