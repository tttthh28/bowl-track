/** PBA GT test: collect all points (soft edge only), estimate with boardFromRight */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane, longestForwardLanePoints } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

function ensure(out: string, video: string, n: number) {
  mkdirSync(out, { recursive: true });
  const rgba = `${out}/seq.rgba`;
  if (!existsSync(rgba)) {
    execSync(`ffmpeg -y -i "${video}" -vf "fps=30,scale=1280:720" -frames:v ${n} -f rawvideo -pix_fmt rgba "${rgba}"`, { stdio: "pipe" });
  }
  return rgba;
}

function collect(corners: LaneCorners, rgbaPath: string): TrackPoint[] {
  const W=1280,H=720,FPS=30;
  const raw=readFileSync(rgbaPath);
  const fb=W*H*4, nFrames=Math.floor(raw.length/fb);
  const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer,raw.byteOffset+Math.min(nFrames-1,i)*fb,fb);
  function downscale(rgba:Uint8ClampedArray,tw:number,th:number){const out=new Uint8ClampedArray(tw*th*4);for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const sx=Math.min(W-1,Math.floor(x/tw*W)),sy=Math.min(H-1,Math.floor(y/th*H));const si=(sy*W+sx)*4,di=(y*tw+x)*4;out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;}return out;}
  const Hm=buildHomography(corners)!;
  const {scale,tw,th}=trackWorkSize(W,H); const workC=scaleLaneCorners(corners,scale);
  const state=new BallTrackerState(); const settings={...DEFAULT_TRACKER};
  const pts:TrackPoint[]=[];
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
      if(!lane) continue;
      if((lane.board<0.3||lane.board>38.7)&&lane.feet<50) continue;
      pts.push({image:contact,lane,t:f*(1000/FPS)});
    }
  }
  return pts;
}

function score(name:string, pts:TrackPoint[], gt:{speed:number;arr:number;bp:number}) {
  const fwd=longestForwardLanePoints(pts);
  const est=computeShotEstimate(pts,null,{boardFromRight:true});
  const pass=(g:number|null|undefined,t:number,tol:number)=>g!=null&&Math.abs(g-t)<=tol;
  const feet=pts.filter(p=>p.lane).map(p=>p.lane!.feet);
  const ok={
    speed:pass(est.avgSpeedMph,gt.speed,3),
    arr:pass(est.arrowsBoard,gt.arr,2),
    bp:pass(est.breakpointBoard,gt.bp,2),
  };
  console.log(JSON.stringify({
    name, n:pts.length, fwd:fwd.length,
    ft:feet.length?`${Math.min(...feet).toFixed(1)}–${Math.max(...feet).toFixed(1)}`:"—",
    avg:est.avgSpeedMph, arr:est.arrowsBoard, bp:est.breakpointBoard, bpd:est.breakpointDistance,
    ok, primary:`${Object.values(ok).filter(Boolean).length}/3`, gt,
  }));
  return Object.values(ok).filter(Boolean).length;
}

const ROOT=join(import.meta.dirname,"..");
const p01=ensure("/tmp/pba-01",join(ROOT,"test-media/pba-striketrack-01.mp4"),110);
const p10=ensure("/tmp/pba-10",join(ROOT,"test-media/pba-striketrack-10.mp4"),140);
const c01:LaneCorners={tl:{x:522,y:245},tr:{x:690,y:245},br:{x:559,y:610},bl:{x:249,y:610}};
const c10:LaneCorners={tl:{x:496,y:180},tr:{x:753,y:180},br:{x:668,y:470},bl:{x:366,y:470}};
const n1=score("01",collect(c01,p01),{speed:18.3,arr:9.3,bp:4});
const n2=score("10",collect(c10,p10),{speed:16,arr:14.9,bp:7.6});
console.log("SUMMARY",{primaryOk:`${n1+n2}/6`,pct:Math.round(((n1+n2)/6)*100),pass80:n1+n2>=5});
