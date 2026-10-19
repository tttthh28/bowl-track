import { readFileSync } from "fs";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";
const W=1060,H=954;
const raw=readFileSync("/tmp/bowl-lateral/seq.rgba");
const fb=W*H*4;
const frameAt=(i:number)=>{const u=new Uint8ClampedArray(fb);u.set(raw.subarray(i*fb,(i+1)*fb));return u;};
const probeFrames=[]; for(let f=5;f<95;f++) probeFrames.push({rgba:frameAt(f),width:W,height:H});
for (const [tl,tr,fy,py] of [
  [511,693,0.86,0.11],
  [511,693,0.86,0.12],
  [511,693,0.84,0.11],
  [500,700,0.86,0.11],
  [520,690,0.86,0.11],
  [505,695,0.86,0.11],
  [490,710,0.86,0.11],
  [480,720,0.86,0.11],
] as const) {
  const c:LaneCorners={bl:{x:360,y:fy*H},br:{x:805,y:fy*H},tl:{x:tl,y:py*H},tr:{x:tr,y:py*H}};
  const d=scoreCornersByProbe(c,probeFrames);
  console.log(`TL${tl}-TR${tr} foulY=${fy} pinsY=${py} arr=${d.arrows?.toFixed(1)??"—"} med=${d.med?.toFixed(1)??"—"} midP=${((tl+tr)/2/W).toFixed(3)} top=${((tr-tl)/W).toFixed(3)}`);
}
