import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import { BallTrackerState, DEFAULT_TRACKER, rgbaToGray, trackBallFrame } from "../src/lib/tracker.ts";
import { imageToLane, buildHomography, defaultCorners } from "../src/lib/perspective.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-diag-track";
const W=640,H=576,FPS=15,N=130;
mkdirSync(OUT,{recursive:true});
execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,{stdio:"pipe"});
const raw=readFileSync(`${OUT}/seq.rgba`);
const fb=W*H*4;

for (const fi of [24,16,8,0,30]) {
  const off=fi*fb;
  const slice=new Uint8ClampedArray(raw.buffer,raw.byteOffset+off,fb);
  const det=detectLaneCorners(new Uint8ClampedArray(slice),W,H);
  console.log(`detect@${fi}`, det?{conf:det.confidence,tl:det.corners.tl,tr:det.corners.tr,bl:det.corners.bl,br:det.corners.br}:null);
}

let det=null as any;
for (const fi of [24,16,8,0]) {
  const off=fi*fb;
  const slice=new Uint8ClampedArray(raw.buffer,raw.byteOffset+off,fb);
  det=detectLaneCorners(new Uint8ClampedArray(slice),W,H);
  if (det && det.confidence>=0.5) break;
}
const corners=det?.corners??defaultCorners(W,H);
console.log("using", corners);
const Hm=buildHomography(corners)!;
const state=new BallTrackerState();
const settings={...DEFAULT_TRACKER,sensitivity:26,minBlobPixels:28};
const points:any[]=[];
let locks=0, raws=0;
for (let f=0;f<Math.min(N,128);f++){
  const rgba=new Uint8ClampedArray(raw.buffer,raw.byteOffset+f*fb,fb);
  const copy=new Uint8ClampedArray(rgba);
  const gray=rgbaToGray(copy,W,H);
  const res=trackBallFrame(state,gray,W,H,settings,corners,1000/FPS,copy);
  if (res.locked) locks++;
  if (res.raw) raws++;
  const pos=res.smoothed;
  if (res.locked && pos && (res.raw||res.predicted)) {
    const lane=imageToLane(Hm,pos);
    points.push({image:pos,lane,t:f*(1000/FPS),predicted:res.predicted});
    if (points.length<=3 || f%20===0) console.log(`f=${f} locked pos=${pos.x.toFixed(0)},${pos.y.toFixed(0)} board=${lane.board.toFixed(1)} feet=${lane.feet.toFixed(1)} pred=${!!res.predicted}`);
  }
}
console.log({locks,raws,points:points.length, q: evaluateShotQuality(points)});
