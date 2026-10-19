/** Full track + probe with lane-15 single-strip corners; dump overlay with ball */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const TMP="/tmp/bowl-lateral", W=1060, H=954, N=120, FPS=15;
const OUT=join(import.meta.dirname,"../tmp-reports/auto-corners-opus-2026-10-19");
mkdirSync(OUT,{recursive:true});
const raw=readFileSync(`${TMP}/seq.rgba`);
const fb=W*H*4;
const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer,raw.byteOffset+i*fb,fb);
function downscale(rgba:Uint8ClampedArray,tw:number,th:number){
  const out=new Uint8ClampedArray(tw*th*4);
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
    const sx=Math.min(W-1,Math.floor(x/tw*W)),sy=Math.min(H-1,Math.floor(y/th*H));
    const si=(sy*W+sx)*4,di=(y*tw+x)*4;
    out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;
  }
  return out;
}

function fullTrack(corners: LaneCorners) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const pts: any[] = [];
  for (let f = 0; f < N; f++) {
    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, scale < 1 ? workC : corners, 1000 / FPS, work);
    const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed) : null;
    if (res.locked && pos && (res.raw != null || res.predicted)) {
      const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;
      const contact = ballContactPoint(pos, rFull);
      const lane = imageToLane(Hm, contact);
      let accept = true;
      if (!res.predicted && (lane.board < 1.2 || lane.board > 37.8) && lane.feet < 45) accept = false;
      if (accept && (pts.length > 0 || !res.predicted)) {
        pts.push({ image: contact, lane, t: f * (1000 / FPS), predicted: res.predicted || undefined, f });
      }
    }
  }
  return { pts, est: computeShotEstimate(pts) };
}

function writePng(rgba: Uint8ClampedArray, path: string) {
  const rawPath = path.replace(/\.png$/, ".rgba");
  writeFileSync(rawPath, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  execSync(`ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${rawPath}" -frames:v 1 "${path}"`, { stdio: "pipe" });
}

function draw(rgba: Uint8ClampedArray, corners: LaneCorners, pts: any[], gutters?: {l:number;r:number;y:number}[]) {
  const out = new Uint8ClampedArray(rgba);
  const setPx=(x:number,y:number,r:number,g:number,b:number)=>{
    const xi=Math.round(x),yi=Math.round(y); if(xi<0||yi<0||xi>=W||yi>=H)return;
    const i=(yi*W+xi)*4; out[i]=r;out[i+1]=g;out[i+2]=b;out[i+3]=255;
  };
  const thick=(x0:number,y0:number,x1:number,y1:number,r:number,g:number,b:number,t=2)=>{
    const steps=Math.max(2,Math.ceil(Math.hypot(x1-x0,y1-y0)));
    for(let s=0;s<=steps;s++){const u=s/steps,x=x0+(x1-x0)*u,y=y0+(y1-y0)*u;
      for(let dy=-t;dy<=t;dy++)for(let dx=-t;dx<=t;dx++)setPx(x+dx,y+dy,r,g,b);}
  };
  const marker=(x:number,y:number,r:number,g:number,b:number,rad=8)=>{
    for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++)if(dx*dx+dy*dy<=rad*rad)setPx(x+dx,y+dy,r,g,b);
  };
  // green/red gutters if provided
  if (gutters && gutters.length>=2) {
    for (let i=0;i<gutters.length-1;i++) {
      thick(gutters[i].l,gutters[i].y,gutters[i+1].l,gutters[i+1].y,40,220,60,3);
      thick(gutters[i].r,gutters[i].y,gutters[i+1].r,gutters[i+1].y,230,50,50,3);
    }
  }
  const {tl,tr,br,bl}=corners;
  thick(tl.x,tl.y,tr.x,tr.y,0,200,255,3);
  thick(tr.x,tr.y,br.x,br.y,0,200,255,3);
  thick(br.x,br.y,bl.x,bl.y,0,200,255,3);
  thick(bl.x,bl.y,tl.x,tl.y,0,200,255,3);
  marker(tl.x,tl.y,0,200,255); marker(tr.x,tr.y,0,200,255);
  marker(bl.x,bl.y,0,200,255); marker(br.x,br.y,0,200,255);
  for (const p of pts) marker(p.image.x, p.image.y, 255, 140, 0, 5);
  return out;
}

const probeFrames=[]; for(let f=5;f<95;f++) probeFrames.push({rgba:frameAt(f),width:W,height:H});

// Lane-15 calibrated from pinSign foul + perspective top
// Foul: L=360 R=805 (from pinSign @0.85-0.86); mid=582.5=0.549
// Pins: use mid~0.58 top~0.18 from pinSign extrapolate TL~511 TR~693 mid~0.568
const candidates: {name:string; c:LaneCorners}[] = [
  { name: "current", c: detectLaneCorners(frameAt(21),W,H)!.corners },
  { name: "L15-A", c: { // foul true single-lane, mild top
    bl:{x:360,y:0.86*H}, br:{x:805,y:0.86*H},
    tl:{x:0.56*W-0.09*W,y:0.11*H}, tr:{x:0.56*W+0.09*W,y:0.11*H},
  }},
  { name: "L15-B", c: {
    bl:{x:360,y:0.86*H}, br:{x:805,y:0.86*H},
    tl:{x:0.57*W-0.10*W,y:0.11*H}, tr:{x:0.57*W+0.10*W,y:0.11*H},
  }},
  { name: "L15-C", c: {
    bl:{x:350,y:0.86*H}, br:{x:800,y:0.86*H},
    tl:{x:0.55*W-0.10*W,y:0.11*H}, tr:{x:0.55*W+0.10*W,y:0.11*H},
  }},
  { name: "L15-D", c: { // narrower bot matching mid-lane scale-up
    bl:{x:380,y:0.86*H}, br:{x:790,y:0.86*H},
    tl:{x:0.56*W-0.09*W,y:0.11*H}, tr:{x:0.56*W+0.09*W,y:0.11*H},
  }},
  { name: "L15-E", c: { // from pinSign fit numbers
    bl:{x:381,y:0.86*H}, br:{x:806,y:0.86*H},
    tl:{x:511,y:0.11*H}, tr:{x:693,y:0.11*H},
  }},
];

// gutter polyline for L15 from pinSign-ish
const guttersL15 = [
  {y:0.88*H,l:355,r:808},{y:0.80*H,l:380,r:797},{y:0.70*H,l:410,r:782},
  {y:0.60*H,l:445,r:767},{y:0.50*H,l:482,r:752},{y:0.40*H,l:420,r:736},
  {y:0.25*H,l:490,r:715},{y:0.12*H,l:511,r:693},
];

for (const cand of candidates) {
  const { pts, est } = fullTrack(cand.c);
  const probe = scoreCornersByProbe(cand.c, probeFrames);
  const bot=(cand.c.br.x-cand.c.bl.x)/W;
  const midF=(cand.c.bl.x+cand.c.br.x)/2/W;
  const midP=(cand.c.tl.x+cand.c.tr.x)/2/W;
  const boards = pts.filter(p=>p.lane&&!p.predicted).map(p=>p.lane.board);
  const xs = pts.filter(p=>!p.predicted).map(p=>p.image.x);
  const meanX = xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:NaN;
  console.log(`\n${cand.name}: bot=${bot.toFixed(3)} midF=${midF.toFixed(3)} midP=${midP.toFixed(3)}`);
  console.log(`  track n=${pts.length} arr=${est.arrowsBoard?.toFixed(1)??'—'} bp=${est.breakpointBoard?.toFixed(1)??'—'} probeArr=${probe.arrows?.toFixed(1)??'—'} med=${probe.med?.toFixed(1)??'—'}`);
  console.log(`  meanImgX=${meanX.toFixed(0)} boardRange=${boards.length?`${Math.min(...boards).toFixed(1)}-${Math.max(...boards).toFixed(1)}`:'—'}`);
  if (pts.length) {
    const sample = pts.filter(p=>!p.predicted).slice(0,8).map(p=>`f${p.f}@${p.image.x.toFixed(0)},${p.lane.board.toFixed(1)}b/${p.lane.feet.toFixed(0)}′`);
    console.log(`  sample`, sample.join(' '));
  }
  writePng(draw(frameAt(40), cand.c, pts, guttersL15), join(OUT, `track-${cand.name}.png`));
}
console.log("DONE");
