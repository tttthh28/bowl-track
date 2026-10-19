/** Build smooth forward path: mono feet↑, limited board step; then est ± mirror */
import { readFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

function ensure(path: string, video: string, n: number) {
  if (existsSync(path)) return;
  mkdirSync(path.replace(/\/seq\.rgba$/, ""), { recursive: true });
  execSync(`ffmpeg -y -i "${video}" -vf "fps=30,scale=1280:720" -frames:v ${n} -f rawvideo -pix_fmt rgba "${path}"`, { stdio: "pipe" });
}

function smoothTrack(name: string, corners: LaneCorners, path: string, gt: any) {
  const W=1280,H=720,FPS=30;
  const raw=readFileSync(path); const fb=W*H*4; const nFrames=Math.floor(raw.length/fb);
  const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer,raw.byteOffset+Math.min(nFrames-1,i)*fb,fb);
  function downscale(rgba:Uint8ClampedArray,tw:number,th:number){const out=new Uint8ClampedArray(tw*th*4);for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const sx=Math.min(W-1,Math.floor(x/tw*W)),sy=Math.min(H-1,Math.floor(y/th*H));const si=(sy*W+sx)*4,di=(y*tw+x)*4;out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;}return out;}
  const Hm=buildHomography(corners)!;
  const {scale,tw,th}=trackWorkSize(W,H); const workC=scaleLaneCorners(corners,scale);
  const state=new BallTrackerState(); const settings={...DEFAULT_TRACKER};
  const rawPts:TrackPoint[]=[];
  for(let f=0;f<nFrames;f++){
    const rgba=frameAt(f); const work=scale<1?downscale(rgba,tw,th):new Uint8ClampedArray(rgba);
    const gray=rgbaToGray(work,scale<1?tw:W,scale<1?th:H);
    const res=trackBallFrame(state,gray,scale<1?tw:W,scale<1?th:H,settings,scale<1?workC:corners,1000/FPS,work);
    const pos=res.smoothed?(scale<1?{x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed):null;
    const rFull=res.radius!=null&&res.radius>0?(scale<1?res.radius/scale:res.radius):null;
    if(res.locked&&pos&&(res.raw!=null||res.predicted)){
      const contact=ballContactPoint(pos,rFull);
      const lane=imageToLane(Hm,contact);
      if(!lane) continue;
      if((lane.board<0.5||lane.board>38.5)&&lane.feet<50) continue;
      rawPts.push({image:contact,lane,t:f*(1000/FPS),predicted:res.predicted||undefined});
    }
  }
  // Smooth: require feet increase ≥0.15, board step ≤4
  const smooth:TrackPoint[]=[];
  for(const p of rawPts){
    if(!p.lane) continue;
    if(smooth.length===0){ smooth.push(p); continue; }
    const prev=smooth[smooth.length-1].lane!;
    const df=p.lane.feet-prev.feet;
    const db=Math.abs(p.lane.board-prev.board);
    if(df < -1.0) continue; // hard rewind
    if(df < 0.05 && db > 3) continue; // lateral jump no progress
    if(db > 5 && df < 1.5) continue; // wild board jump
    smooth.push(p);
  }
  const mir = (pts:TrackPoint[]) => pts.map(p=>({...p,lane:p.lane?{feet:p.lane.feet,board:39-p.lane.board}:undefined}));
  const eL=computeShotEstimate(smooth);
  const eR=computeShotEstimate(mir(smooth));
  // Also: use board at 15' from smooth with both conventions
  const feet=smooth.filter(p=>p.lane).map(p=>p.lane!.feet);
  const pass=(got:number|null|undefined,gt:number,tol:number)=>got!=null&&Math.abs(got-gt)<=tol;
  console.log(name, {
    rawN:rawPts.length, smoothN:smooth.length,
    ft:feet.length?`${Math.min(...feet).toFixed(1)}–${Math.max(...feet).toFixed(1)}`:"—",
    left:{arr:eL.arrowsBoard,bp:eL.breakpointBoard,bpd:eL.breakpointDistance,avg:eL.avgSpeedMph},
    right:{arr:eR.arrowsBoard,bp:eR.breakpointBoard,bpd:eR.breakpointDistance,avg:eR.avgSpeedMph},
    gt,
    leftPass:{speed:pass(eL.avgSpeedMph,gt.speed,3),arr:pass(eL.arrowsBoard,gt.arr,2),bp:pass(eL.breakpointBoard,gt.bp,2)},
    rightPass:{speed:pass(eR.avgSpeedMph,gt.speed,3),arr:pass(eR.arrowsBoard,gt.arr,2),bp:pass(eR.breakpointBoard,gt.bp,2)},
  });
  // print smooth path every few
  for(let i=0;i<smooth.length;i+=Math.max(1,Math.floor(smooth.length/12))){
    const p=smooth[i];
    console.log(`  ${p.lane!.feet.toFixed(1)}′ L${p.lane!.board.toFixed(1)} R${(39-p.lane!.board).toFixed(1)}`);
  }
}

ensure("/tmp/pba-01/seq.rgba","test-media/pba-striketrack-01.mp4",110);
ensure("/tmp/pba-10/seq.rgba","test-media/pba-striketrack-10.mp4",140);
smoothTrack("01",{tl:{x:522,y:245},tr:{x:690,y:245},br:{x:559,y:610},bl:{x:249,y:610}},"/tmp/pba-01/seq.rgba",{speed:18.3,arr:9.3,bp:4.0});
smoothTrack("10",{tl:{x:496,y:180},tr:{x:753,y:180},br:{x:668,y:470},bl:{x:366,y:470}},"/tmp/pba-10/seq.rgba",{speed:16.0,arr:14.9,bp:7.6});
