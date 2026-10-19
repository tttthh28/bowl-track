/** Dump detect corners + try asymmetric BR→true gutter while keeping arr */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { detectLaneCorners, scoreLaneGeometry, frameHasLaneSignal } from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { pickBestCornersByProbe, scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const OUT = "/tmp/bowl-live5";
const W = 1060, H = 954, FPS = 15, N = 120;
const VIDEO = join(import.meta.dirname, "../test-media/bowling-demo.mp4");
mkdirSync(OUT, { recursive: true });
if (!existsSync(`${OUT}/seq.rgba`)) {
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, { stdio: "pipe" });
}
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W*H*4;
const frameAt = (i:number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset+i*fb, fb);
function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw*th*4);
  for (let y=0;y<th;y++) for (let x=0;x<tw;x++) {
    const sx=Math.min(W-1,Math.floor(x/tw*W)), sy=Math.min(H-1,Math.floor(y/th*H));
    const si=(sy*W+sx)*4, di=(y*tw+x)*4;
    out[di]=rgba[si]; out[di+1]=rgba[si+1]; out[di+2]=rgba[si+2]; out[di+3]=255;
  }
  return out;
}
const settings = { ...DEFAULT_TRACKER, sensitivity: 26, minBlobPixels: 28 };
function fullTrack(corners: LaneCorners) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const pts: any[] = [];
  for (let f=0;f<N;f++) {
    const rgba=frameAt(f);
    const work=scale<1?downscale(rgba,tw,th):new Uint8ClampedArray(rgba);
    const gray=rgbaToGray(work,scale<1?tw:W,scale<1?th:H);
    const res=trackBallFrame(state,gray,scale<1?tw:W,scale<1?th:H,settings,scale<1?workC:corners,1000/FPS,work);
    const pos=res.smoothed?(scale<1?{x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed):null;
    if (res.locked&&pos&&(res.raw!=null||res.predicted)) {
      const rFull=res.radius!=null&&res.radius>0?(scale<1?res.radius/scale:res.radius):null;
      const contact=ballContactPoint(pos,rFull);
      const lane=imageToLane(Hm,contact);
      let accept=true;
      if (!res.predicted&&(lane.board<1.2||lane.board>37.8)&&lane.feet<45) accept=false;
      if (accept&&(pts.length>0||!res.predicted)) pts.push({image:contact,lane,t:f*(1000/FPS),predicted:res.predicted||undefined});
    }
  }
  return computeShotEstimate(pts);
}

// Workbench-like pick
const tryFi=[1,5,12,21,36,48,60,75,90,100,110];
const cands=[];
for (const fi of tryFi) {
  const rgba=frameAt(fi);
  if (!frameHasLaneSignal(rgba,W,H)) continue;
  const det=detectLaneCorners(rgba,W,H);
  if (!det) continue;
  const botFrac=(det.corners.br.x-det.corners.bl.x)/W;
  const midBot=(det.corners.bl.x+det.corners.br.x)/2;
  const midFrac=Math.abs(midBot/W-0.5);
  const widthOk=botFrac>=0.5&&botFrac<=0.54?36:botFrac>=0.46&&botFrac<0.5?28:20;
  const midOk=(midFrac<0.1?22:midFrac<0.16?6:-30)+(midBot/W>0.52?-18:0);
  cands.push({det, geomRank: scoreLaneGeometry(det,W,H)+widthOk+midOk});
}
const probeFrames=[];
for (let i=0;i<N;i+=2) probeFrames.push({rgba:frameAt(i),width:W,height:H});
const picked=pickBestCornersByProbe(cands,probeFrames,10);
if (!picked) { console.log("NO PICK"); process.exit(1); }
const base=picked.det.corners;
const dump=(c:LaneCorners,label:string)=>{
  const bot=(c.br.x-c.bl.x)/W;
  const mid=(c.bl.x+c.br.x)/2;
  const top=(c.tr.x-c.tl.x)/W;
  const est=fullTrack(c);
  const d=scoreCornersByProbe(c,probeFrames);
  console.log(label, {
    bl:+c.bl.x.toFixed(0), br:+c.br.x.toFixed(0), tl:+c.tl.x.toFixed(0), tr:+c.tr.x.toFixed(0),
    foulY:+((c.bl.y)/H).toFixed(3), pinsY:+((c.tl.y)/H).toFixed(3),
    bot:+bot.toFixed(3), mid:+mid.toFixed(0), top:+top.toFixed(3),
    arr:est.arrowsBoard, probe:d.arrows, med:d.med?.toFixed(1),
    bp: est.breakpointBoard!=null?`${est.breakpointBoard.toFixed(1)}@${est.breakpointDistance}`:"—",
    pocket: est.pocketBoard?.toFixed(1) ?? "—",
    gErr: (Math.abs(c.bl.x-208)+Math.abs(c.br.x-802)).toFixed(0),
  });
};
dump(base, "DETECT+probe");

// Asymmetric: push BR toward 802, optionally BL toward 208, keep top
const TRUE_R=802, TRUE_L=208;
for (const brTarget of [750, 770, 785, 802]) {
  for (const blTarget of [base.bl.x, 200, 208, 180]) {
    const c={...base, bl:{...base.bl,x:blTarget}, br:{...base.br,x:brTarget}};
    // also nudge tr toward proportional
    const botMid=(blTarget+brTarget)/2;
    const topHalf=(base.tr.x-base.tl.x)/2;
    c.tl={...base.tl,x:botMid-topHalf};
    c.tr={...base.tr,x:botMid+topHalf};
    dump(c, `asym bl=${blTarget.toFixed(0)} br=${brTarget}`);
  }
}

// Shift mid toward 505 with bot 0.52 keeping detect foul/pins/topFrac
const topF=(base.tr.x-base.tl.x)/W;
const botF=0.52;
for (const mid of [448,455,465,475,485,495,505]) {
  const half=(botF*W)/2;
  const th=(topF*W)/2;
  const c:LaneCorners={
    bl:{x:mid-half,y:base.bl.y}, br:{x:mid+half,y:base.br.y},
    tl:{x:mid-th,y:base.tl.y}, tr:{x:mid+th,y:base.tr.y},
  };
  dump(c, `shift mid=${mid} bot=0.52`);
}
