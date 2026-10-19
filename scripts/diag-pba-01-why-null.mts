/** Why pba-01 arr/bp null with manual corners — dump boards by feet */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { boardAtFeet, boardAtFeetDetailed, trajectoryCoverage } from "../src/lib/perspective.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/pba-striketrack-01.mp4");
const OUT = "/tmp/pba-01";
const W = 1280, H = 720, FPS = 30, N = 110;
mkdirSync(OUT, { recursive: true });
if (!existsSync(`${OUT}/seq.rgba`)) {
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, { stdio: "pipe" });
}
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W * H * 4;
const nFrames = Math.floor(raw.length / fb);
const frameAt = (i: number) => {
  const j = Math.min(nFrames - 1, Math.max(0, i));
  return new Uint8ClampedArray(raw.buffer, raw.byteOffset + j * fb, fb);
};
function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw*th*4);
  for (let y=0;y<th;y++) for (let x=0;x<tw;x++) {
    const sx=Math.min(W-1,Math.floor(x/tw*W)), sy=Math.min(H-1,Math.floor(y/th*H));
    const si=(sy*W+sx)*4, di=(y*tw+x)*4;
    out[di]=rgba[si]; out[di+1]=rgba[si+1]; out[di+2]=rgba[si+2]; out[di+3]=255;
  }
  return out;
}
const corners: LaneCorners = {
  tl:{x:522,y:245}, tr:{x:690,y:245}, br:{x:559,y:610}, bl:{x:249,y:610},
};
const Hm = buildHomography(corners)!;
const { scale, tw, th } = trackWorkSize(W, H);
const workC = scaleLaneCorners(corners, scale);
const state = new BallTrackerState();
const settings = { ...DEFAULT_TRACKER };
const pts: any[] = [];
for (let f=0;f<nFrames;f++) {
  const rgba=frameAt(f);
  const work=scale<1?downscale(rgba,tw,th):new Uint8ClampedArray(rgba);
  const gray=rgbaToGray(work,scale<1?tw:W,scale<1?th:H);
  const res=trackBallFrame(state,gray,scale<1?tw:W,scale<1?th:H,settings,scale<1?workC:corners,1000/FPS,work);
  const pos=res.smoothed?(scale<1?{x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed):null;
  const rFull=res.radius!=null&&res.radius>0?(scale<1?res.radius/scale:res.radius):null;
  if (res.locked&&pos&&(res.raw!=null||res.predicted)) {
    const contact=ballContactPoint(pos,rFull);
    const lane=imageToLane(Hm,contact);
    if (lane && !(!res.predicted && (lane.board<1.2||lane.board>37.8)&&lane.feet<45)) {
      pts.push({ image: contact, lane, t: f*(1000/FPS), predicted: res.predicted||undefined });
    }
  }
}
const cov = trajectoryCoverage(pts);
console.log("cov", cov);
console.log("n", pts.length);
// sample every ~5 feet
for (const ft of [5,10,15,20,25,30,35,40]) {
  const b = boardAtFeet(pts, ft);
  const d = boardAtFeetDetailed(pts, ft, { allowExtrapolate: true, maxGap: 8 });
  console.log(`ft=${ft} boardAtFeet=${b} detailed=${d?`${d.board.toFixed(1)} ext=${d.extrapolated}`:"null"}`);
}
const est = computeShotEstimate(pts);
console.log("est", { arr: est.arrowsBoard, bp: est.breakpointBoard, bpDist: est.breakpointDistance, avg: est.avgSpeedMph });
// board series
const series = pts.filter(p=>p.lane).map(p=>({f:p.lane.feet.toFixed(1), b:p.lane.board.toFixed(1)}));
console.log("first10", series.slice(0,10));
console.log("mid10", series.slice(Math.floor(series.length/2)-5, Math.floor(series.length/2)+5));
console.log("last10", series.slice(-10));
