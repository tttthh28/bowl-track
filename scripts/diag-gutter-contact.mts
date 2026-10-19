/** True-gutter corners × contact variants → arrows */
import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";

const VIDEO = "test-media/bowling-demo.mp4";
const OUT = "/tmp/bowl-gc";
const W = 1060, H = 954, FPS = 15, N = 120;
mkdirSync(OUT, { recursive: true });
execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, { stdio: "pipe" });
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W*H*4;
const frameAt = (fi: number) => { const u=new Uint8ClampedArray(fb); u.set(raw.subarray(fi*fb,(fi+1)*fb)); return u; };
function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw*th*4);
  for (let y=0;y<th;y++){ const sy=Math.min(H-1,Math.floor((y/th)*H));
    for(let x=0;x<tw;x++){ const sx=Math.min(W-1,Math.floor((x/tw)*W)); const si=(sy*W+sx)*4,di=(y*tw+x)*4;
      out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;}}
  return out;
}

const c0 = detectLaneCorners(frameAt(21), W, H)!.corners;
const midB = (c0.bl.x+c0.br.x)/2;
const midT = midB; // aligned
// True gutters from earlier scan at foul ~208-802, pins narrower
const gutter = {
  bl: { x: 208, y: 0.84*H },
  br: { x: 802, y: 0.84*H },
  tl: { x: midT - 0.09*W, y: 0.10*H },
  tr: { x: midT + 0.09*W, y: 0.10*H },
};
// Fit perspective: left edge from (tl) to (bl=208), right similarly — use mid of gutters
const gMid = (208+802)/2; // 505
const gutterAligned = {
  bl: { x: 208, y: 0.84*H },
  br: { x: 802, y: 0.84*H },
  tl: { x: gMid - 0.085*W, y: 0.10*H },
  tr: { x: gMid + 0.085*W, y: 0.10*H },
};
const midGutter = {
  bl: { x: midB - 0.28*W, y: 0.84*H },
  br: { x: midB + 0.28*W, y: 0.84*H },
  tl: { x: midB - 0.08*W, y: 0.11*H },
  tr: { x: midB + 0.08*W, y: 0.11*H },
};

type Mode = "none" | "contact" | "half";
function track(corners: any, mode: Mode) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
  const pts: any[] = [];
  for (let f=0;f<N;f++){
    const rgba=frameAt(f);
    const work=scale<1?downscale(rgba,tw,th):new Uint8ClampedArray(rgba);
    const gray=rgbaToGray(work,scale<1?tw:W,scale<1?th:H);
    const res=trackBallFrame(state,gray,scale<1?tw:W,scale<1?th:H,settings,scale<1?workC:corners,1000/FPS,work);
    const pos=res.smoothed?(scale<1?{x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed):null;
    if(res.locked&&pos&&(res.raw!=null||res.predicted)){
      const rFull=res.radius!=null&&res.radius>0?(scale<1?res.radius/scale:res.radius):null;
      let pt=pos;
      if(mode==="contact") pt=ballContactPoint(pos,rFull);
      if(mode==="half"&&rFull) pt={x:pos.x,y:pos.y+rFull*0.5};
      const lane=imageToLane(Hm,pt);
      if(pts.length>0||!res.predicted) pts.push({image:pt,lane,t:f*(1000/FPS),predicted:res.predicted||undefined});
    }
  }
  return { n: pts.length, est: computeShotEstimate(pts) };
}

const probeFrames=[];
for(let f=5;f<95;f++) probeFrames.push({rgba:frameAt(f),width:W,height:H});

for (const [name,c] of [["current",c0],["gutterAligned",gutterAligned],["midGutter0.56",midGutter]] as const) {
  const bot=((c.br.x-c.bl.x)/W).toFixed(3);
  const mid=((c.bl.x+c.br.x)/2).toFixed(0);
  for (const mode of ["none","contact","half"] as Mode[]) {
    const {n,est}=track(c,mode);
    console.log(`${name} bot=${bot} mid=${mid} mode=${mode}: arr=${est.arrowsBoard??"—"} bp=${est.breakpointBoard?.toFixed(1)??"—"}@${est.breakpointDistance??"—"} n=${n} cov=${est.coverageFeetMin}–${est.coverageFeetMax}`);
  }
  const d=scoreCornersByProbe(c,probeFrames,{geomRank:100});
  console.log(`  probe(contact): arr=${d.arrows??"—"} med=${d.med?.toFixed(1)} locks=${d.locks}\n`);
}
