/** Find ball X through demo frames → which lane strip is active */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { BallTrackerState, DEFAULT_TRACKER, rgbaToGray, trackBallFrame, trackWorkSize, scaleLaneCorners } from "../src/lib/tracker.ts";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const TMP="/tmp/bowl-lateral", W=1060, H=954, N=120;
const OUT=join(import.meta.dirname,"../tmp-reports/auto-corners-opus-2026-10-19");
const raw=readFileSync(`${TMP}/seq.rgba`);
const fb=W*H*4;
const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer, raw.byteOffset+i*fb, fb);

function downscale(rgba:Uint8ClampedArray,tw:number,th:number){
  const out=new Uint8ClampedArray(tw*th*4);
  for(let y=0;y<th;y++)for(let x=0;x<tw;x++){
    const sx=Math.min(W-1,Math.floor(x/tw*W)), sy=Math.min(H-1,Math.floor(y/th*H));
    const si=(sy*W+sx)*4,di=(y*tw+x)*4;
    out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;
  }
  return out;
}

// Use a wide generous quad covering both 14 and 15 so tracker can find the ball
const corners: LaneCorners = {
  tl:{x:300,y:H*0.11}, tr:{x:750,y:H*0.11},
  bl:{x:150,y:H*0.88}, br:{x:900,y:H*0.88},
};
const settings={...DEFAULT_TRACKER, sensitivity:26, minBlobPixels:28};
const {scale,tw,th}=trackWorkSize(W,H);
const workC=scaleLaneCorners(corners,scale);
const state=new BallTrackerState();
const hits:{f:number;x:number;y:number;r:number}[]=[];
for(let f=0;f<N;f++){
  const rgba=frameAt(f);
  const work=scale<1?downscale(rgba,tw,th):new Uint8ClampedArray(rgba);
  const gray=rgbaToGray(work, scale<1?tw:W, scale<1?th:H);
  const res=trackBallFrame(state,gray,scale<1?tw:W,scale<1?th:H,settings,scale<1?workC:corners,1000/15,work);
  if(res.locked && res.smoothed && !res.predicted){
    const x=scale<1?res.smoothed.x/scale:res.smoothed.x;
    const y=scale<1?res.smoothed.y/scale:res.smoothed.y;
    const r=res.radius!=null&&scale<1?res.radius/scale:(res.radius??0);
    hits.push({f,x,y,r});
  }
}
console.log("ball locks", hits.length);
for (const h of hits) console.log(`f=${h.f} x=${h.x.toFixed(0)} (${(h.x/W).toFixed(3)}) y=${h.y.toFixed(0)} (${(h.y/H).toFixed(3)}) r=${h.r.toFixed(1)}`);

// Compare ball X to lane midlines
// lane14ish mid ~0.42, current mid~0.475, lane15 pinSign mid~0.56
const xs=hits.map(h=>h.x);
const meanX=xs.reduce((a,b)=>a+b,0)/xs.length;
console.log("\nmean ball X", meanX.toFixed(0), (meanX/W).toFixed(3));
console.log("vs mid0.42", (0.42*W).toFixed(0), "delta", (meanX-0.42*W).toFixed(0));
console.log("vs mid0.475", (0.475*W).toFixed(0), "delta", (meanX-0.475*W).toFixed(0));
console.log("vs mid0.56", (0.56*W).toFixed(0), "delta", (meanX-0.56*W).toFixed(0));

// Overlay ball path on frame 36
const fi=36;
const rgba=new Uint8ClampedArray(frameAt(fi));
const setPx=(x:number,y:number,r:number,g:number,b:number)=>{
  const xi=Math.round(x),yi=Math.round(y); if(xi<0||yi<0||xi>=W||yi>=H)return;
  const i=(yi*W+xi)*4; rgba[i]=r;rgba[i+1]=g;rgba[i+2]=b;rgba[i+3]=255;
};
for (const h of hits) {
  for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++)
    if(dx*dx+dy*dy<=16) setPx(h.x+dx,h.y+dy,255,140,0);
}
// draw candidate mids as vertical lines at foul
for (const [xf,r,g,b] of [[0.42*W,255,0,0],[0.475*W,0,255,255],[0.56*W,0,255,0]] as const) {
  for(let y=H*0.7;y<H*0.9;y++) setPx(xf,y,r,g,b);
}
const path=`${OUT}/ball-path-fi36.png`;
writeFileSync(path.replace(/\.png$/,'.rgba'), Buffer.from(rgba.buffer,rgba.byteOffset,rgba.byteLength));
execSync(`ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${path.replace(/\.png$/,'.rgba')}" -frames:v 1 "${path}"`,{stdio:'pipe'});
console.log("WROTE", path);
