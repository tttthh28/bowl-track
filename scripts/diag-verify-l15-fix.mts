import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const TMP="/tmp/bowl-lateral", W=1060, H=954;
const OUT=join(import.meta.dirname,"../tmp-reports/auto-corners-opus-2026-10-19");
mkdirSync(OUT,{recursive:true});
const raw=readFileSync(`${TMP}/seq.rgba`);
const fb=W*H*4;
const frameAt=(i:number)=>{const u=new Uint8ClampedArray(fb);u.set(raw.subarray(i*fb,(i+1)*fb));return u;};

function writePng(rgba:Uint8ClampedArray,path:string){
  const rawPath=path.replace(/\.png$/,'.rgba');
  writeFileSync(rawPath,Buffer.from(rgba.buffer,rgba.byteOffset,rgba.byteLength));
  execSync(`ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${rawPath}" -frames:v 1 "${path}"`,{stdio:'pipe'});
}
function draw(rgba:Uint8ClampedArray, corners:LaneCorners, label:string){
  const out=new Uint8ClampedArray(rgba);
  const setPx=(x:number,y:number,r:number,g:number,b:number)=>{
    const xi=Math.round(x),yi=Math.round(y);if(xi<0||yi<0||xi>=W||yi>=H)return;
    const i=(yi*W+xi)*4;out[i]=r;out[i+1]=g;out[i+2]=b;out[i+3]=255;
  };
  const thick=(x0:number,y0:number,x1:number,y1:number,r:number,g:number,b:number,t=3)=>{
    const steps=Math.max(2,Math.ceil(Math.hypot(x1-x0,y1-y0)));
    for(let s=0;s<=steps;s++){const u=s/steps,x=x0+(x1-x0)*u,y=y0+(y1-y0)*u;
      for(let dy=-t;dy<=t;dy++)for(let dx=-t;dx<=t;dx++)setPx(x+dx,y+dy,r,g,b);}
  };
  const marker=(x:number,y:number,r:number,g:number,b:number,rad=10)=>{
    for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++)if(dx*dx+dy*dy<=rad*rad)setPx(x+dx,y+dy,r,g,b);
  };
  // L15 true gutters from pinSign track (green/red)
  const gL=[
    [0.88,355],[0.86,360],[0.80,380],[0.70,410],[0.60,445],[0.50,482],[0.40,427],[0.25,490],[0.12,511]
  ];
  const gR=[
    [0.88,808],[0.86,805],[0.80,797],[0.70,782],[0.60,767],[0.50,752],[0.40,735],[0.25,715],[0.12,693]
  ];
  for(let i=0;i<gL.length-1;i++){
    thick(gL[i][1],gL[i][0]*H,gL[i+1][1],gL[i+1][0]*H,40,220,60,3);
    thick(gR[i][1],gR[i][0]*H,gR[i+1][1],gR[i+1][0]*H,230,50,50,3);
  }
  const {tl,tr,br,bl}=corners;
  thick(tl.x,tl.y,tr.x,tr.y,0,200,255,3);
  thick(tr.x,tr.y,br.x,br.y,0,200,255,3);
  thick(br.x,br.y,bl.x,bl.y,0,200,255,3);
  thick(bl.x,bl.y,tl.x,tl.y,0,200,255,3);
  marker(tl.x,tl.y,0,200,255);marker(tr.x,tr.y,0,200,255);
  marker(bl.x,bl.y,0,200,255);marker(br.x,br.y,0,200,255);
  // foul anchors
  marker(360,0.86*H,40,255,60,6); marker(805,0.86*H,255,50,50,6);
  return out;
}

const proposed: LaneCorners = {
  bl:{x:360,y:0.86*H}, br:{x:805,y:0.86*H},
  tl:{x:0.53*W-0.10*W,y:0.11*H}, tr:{x:0.53*W+0.10*W,y:0.11*H},
};
const before = detectLaneCorners(frameAt(21),W,H)!.corners;
const probeFrames=[]; for(let f=5;f<95;f++) probeFrames.push({rgba:frameAt(f),width:W,height:H});
const pB=scoreCornersByProbe(before,probeFrames);
const pA=scoreCornersByProbe(proposed,probeFrames);
console.log("BEFORE", {arr:pB.arrows, midF:((before.bl.x+before.br.x)/2/W).toFixed(3), bot:((before.br.x-before.bl.x)/W).toFixed(3), BL:before.bl.x.toFixed(0), BR:before.br.x.toFixed(0)});
console.log("AFTER ", {arr:pA.arrows, midF:((proposed.bl.x+proposed.br.x)/2/W).toFixed(3), bot:((proposed.br.x-proposed.bl.x)/W).toFixed(3), BL:proposed.bl.x.toFixed(0), BR:proposed.br.x.toFixed(0), TL:proposed.tl.x.toFixed(0), TR:proposed.tr.x.toFixed(0)});
console.log("dx foul L15:", {dxL:(proposed.bl.x-360).toFixed(0), dxR:(proposed.br.x-805).toFixed(0)});
console.log("before dx foul L15:", {dxL:(before.bl.x-360).toFixed(0), dxR:(before.br.x-805).toFixed(0)});

for (const fi of [21, 40]) {
  writePng(draw(frameAt(fi), before, "before"), join(OUT, `compare-before-fi${fi}.png`));
  writePng(draw(frameAt(fi), proposed, "after"), join(OUT, `compare-after-fi${fi}.png`));
}
console.log("WROTE compare before/after");
