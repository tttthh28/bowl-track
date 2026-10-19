import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane, longestForwardLanePoints } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

function ensure(path: string, video: string, n: number) {
  if (existsSync(path)) return;
  mkdirSync(path.replace(/\/seq.rgba$/, ""), { recursive: true });
  execSync(`ffmpeg -y -i "${video}" -vf "fps=30,scale=1280:720" -frames:v ${n} -f rawvideo -pix_fmt rgba "${path}"`, { stdio: "pipe" });
}

function track(name: string, corners: LaneCorners, path: string, W: number, H: number, FPS: number) {
  const raw = readFileSync(path);
  const fb = W*H*4, nFrames = Math.floor(raw.length/fb);
  const frameAt = (i:number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset+Math.min(nFrames-1,i)*fb, fb);
  function downscale(rgba:Uint8ClampedArray,tw:number,th:number){const out=new Uint8ClampedArray(tw*th*4);for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const sx=Math.min(W-1,Math.floor(x/tw*W)),sy=Math.min(H-1,Math.floor(y/th*H));const si=(sy*W+sx)*4,di=(y*tw+x)*4;out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;}return out;}
  const Hm=buildHomography(corners)!;
  const {scale,tw,th}=trackWorkSize(W,H);
  const workC=scaleLaneCorners(corners,scale);
  const state=new BallTrackerState();
  const settings={...DEFAULT_TRACKER};
  const pts:TrackPoint[]=[];
  let maxF=0;
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
      if((lane.board<1.2||lane.board>37.8)&&lane.feet<45) continue;
      if(maxF>6 && lane.feet < maxF-3.5) continue;
      maxF=Math.max(maxF,lane.feet);
      pts.push({image:contact,lane,t:f*(1000/FPS)});
    }
  }
  const fwd = longestForwardLanePoints(pts);
  const asPts = fwd.map((p,i)=>({image:{x:0,y:0}, lane:{board:p.board,feet:p.feet}, t:i*50}));
  const mirPts = pts.map(p=>({...p, lane:p.lane?{...p.lane, board:39-p.lane.board}:undefined}));
  const mirFwd = longestForwardLanePoints(mirPts).map((p,i)=>({image:{x:0,y:0},lane:{board:p.board,feet:p.feet},t:i*50}));
  const e1=computeShotEstimate(pts);
  const e2=computeShotEstimate(asPts as any);
  const e3=computeShotEstimate(mirPts);
  const e4=computeShotEstimate(mirFwd as any);
  const feet=pts.filter(p=>p.lane).map(p=>p.lane!.feet);
  console.log(name, {
    n:pts.length, fwd:fwd.length,
    ft:feet.length?`${Math.min(...feet).toFixed(1)}–${Math.max(...feet).toFixed(1)}`:"—",
    raw:{arr:e1.arrowsBoard,bp:e1.breakpointBoard,bpd:e1.breakpointDistance,avg:e1.avgSpeedMph},
    fwdOnly:{arr:e2.arrowsBoard,bp:e2.breakpointBoard,bpd:e2.breakpointDistance,avg:e2.avgSpeedMph},
    mirrored:{arr:e3.arrowsBoard,bp:e3.breakpointBoard,bpd:e3.breakpointDistance,avg:e3.avgSpeedMph},
    mirFwd:{arr:e4.arrowsBoard,bp:e4.breakpointBoard,bpd:e4.breakpointDistance,avg:e4.avgSpeedMph},
  });
}
ensure("/tmp/pba-01/seq.rgba", "test-media/pba-striketrack-01.mp4", 110);
ensure("/tmp/pba-10/seq.rgba", "test-media/pba-striketrack-10.mp4", 140);
track("01", {tl:{x:522,y:245},tr:{x:690,y:245},br:{x:559,y:610},bl:{x:249,y:610}}, "/tmp/pba-01/seq.rgba", 1280,720,30);
track("10", {tl:{x:496,y:180},tr:{x:753,y:180},br:{x:668,y:470},bl:{x:366,y:470}}, "/tmp/pba-10/seq.rgba", 1280,720,30);
