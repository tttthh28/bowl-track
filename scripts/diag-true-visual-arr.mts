/** True visual gutters (bot mid≈505, top mid≈560) × tune → arr */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners,
} from "../src/lib/tracker.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const OUT="/tmp/bowl-live5"; const W=1060,H=954,FPS=15,N=120;
const VIDEO=join(import.meta.dirname,"../test-media/bowling-demo.mp4");
mkdirSync(OUT,{recursive:true});
if(!existsSync(`${OUT}/seq.rgba`)) execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,{stdio:"pipe"});
const raw=readFileSync(`${OUT}/seq.rgba`); const fb=W*H*4;
const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer,raw.byteOffset+i*fb,fb);
function downscale(rgba:Uint8ClampedArray,tw:number,th:number){const out=new Uint8ClampedArray(tw*th*4);for(let y=0;y<th;y++)for(let x=0;x<tw;x++){const sx=Math.min(W-1,Math.floor(x/tw*W)),sy=Math.min(H-1,Math.floor(y/th*H));const si=(sy*W+sx)*4,di=(y*tw+x)*4;out[di]=rgba[si];out[di+1]=rgba[si+1];out[di+2]=rgba[si+2];out[di+3]=255;}return out;}
const settings={...DEFAULT_TRACKER,sensitivity:26,minBlobPixels:28};
function fullTrack(c:LaneCorners){const Hm=buildHomography(c)!;const {scale,tw,th}=trackWorkSize(W,H);const workC=scaleLaneCorners(c,scale);const state=new BallTrackerState();const pts:any[]=[];for(let f=0;f<N;f++){const rgba=frameAt(f);const work=scale<1?downscale(rgba,tw,th):new Uint8ClampedArray(rgba);const gray=rgbaToGray(work,scale<1?tw:W,scale<1?th:H);const res=trackBallFrame(state,gray,scale<1?tw:W,scale<1?th:H,settings,scale<1?workC:c,1000/FPS,work);const pos=res.smoothed?(scale<1?{x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed):null;if(res.locked&&pos&&(res.raw!=null||res.predicted)){const rFull=res.radius!=null&&res.radius>0?(scale<1?res.radius/scale:res.radius):null;const contact=ballContactPoint(pos,rFull);const lane=imageToLane(Hm,contact);let accept=true;if(!res.predicted&&(lane.board<1.2||lane.board>37.8)&&lane.feet<45)accept=false;if(accept&&(pts.length>0||!res.predicted))pts.push({image:contact,lane,t:f*(1000/FPS),predicted:res.predicted||undefined});}}return computeShotEstimate(pts);}
const probeFrames=[]; for(let i=0;i<N;i+=2)probeFrames.push({rgba:frameAt(i),width:W,height:H});

// Visual truth anchors from gutter map
const configs: {name:string;c:LaneCorners}[] = [];
// 1) exact foul gutters + pins mid 560 width 0.16
configs.push({name:"trueGutter-top560", c:{
  bl:{x:208,y:0.84*H}, br:{x:802,y:0.84*H},
  tl:{x:560-85,y:0.11*H}, tr:{x:560+85,y:0.11*H},
}});
// 2) foul gutters + pins mid 587 (measured at 0.25)
configs.push({name:"trueGutter-top587", c:{
  bl:{x:208,y:0.84*H}, br:{x:802,y:0.84*H},
  tl:{x:587-70,y:0.11*H}, tr:{x:587+70,y:0.11*H},
}});
// 3) compromise bot: L=180 R=770 mid≈475, top 540
configs.push({name:"compromise-180-770-top540", c:{
  bl:{x:180,y:0.837*H}, br:{x:770,y:0.837*H},
  tl:{x:540-85,y:0.11*H}, tr:{x:540+85,y:0.11*H},
}});
// 4) arr-known: mid448 bot0.52 + top shifted right to 520
configs.push({name:"arr448-bot52-top520", c:{
  bl:{x:172,y:0.837*H}, br:{x:724,y:0.837*H},
  tl:{x:520-85,y:0.11*H}, tr:{x:520+85,y:0.11*H},
}});
// 5) arr448 bot52 top448 (current style)
configs.push({name:"arr448-bot52-top448", c:{
  bl:{x:172,y:0.837*H}, br:{x:724,y:0.837*H},
  tl:{x:448-85,y:0.11*H}, tr:{x:448+85,y:0.11*H},
}});
// 6) bl162 br750 top500 (asym that had arr13.8)
configs.push({name:"asym162-750-top500", c:{
  bl:{x:162,y:0.837*H}, br:{x:750,y:0.837*H},
  tl:{x:500-85,y:0.11*H}, tr:{x:500+85,y:0.11*H},
}});
// 7) bl180 br750 top520
configs.push({name:"asym180-750-top520", c:{
  bl:{x:180,y:0.837*H}, br:{x:750,y:0.837*H},
  tl:{x:520-85,y:0.11*H}, tr:{x:520+85,y:0.11*H},
}});
// 8) slightly inset true gutters
configs.push({name:"inset220-790-top560", c:{
  bl:{x:220,y:0.84*H}, br:{x:790,y:0.84*H},
  tl:{x:560-80,y:0.11*H}, tr:{x:560+80,y:0.11*H},
}});

for (const {name,c} of configs) {
  const est=fullTrack(c);
  const d=scoreCornersByProbe(c,probeFrames);
  const tony=(a:number|null|undefined)=>a!=null&&a>=12.5&&a<=15.5;
  const mark=tony(est.arrowsBoard)&&tony(d.arrows)?"★":tony(est.arrowsBoard)||tony(d.arrows)?"·":" ";
  console.log(`${mark} ${name}: arr=${est.arrowsBoard??"—"} probe=${d.arrows??"—"} med=${d.med?.toFixed(0)??"—"} bp=${est.breakpointBoard?.toFixed(1)??"—"}@${est.breakpointDistance??"—"} pocket=${est.pocketBoard?.toFixed(1)??"—"} bot=${((c.br.x-c.bl.x)/W).toFixed(3)} midB=${((c.bl.x+c.br.x)/2).toFixed(0)} midT=${((c.tl.x+c.tr.x)/2).toFixed(0)}`);
}
