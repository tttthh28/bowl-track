/** Tune lane-15 single-strip (BL~380 BR~805) for arr 13-15 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const OUT = join(import.meta.dirname, "../tmp-reports/auto-corners-opus-2026-10-19");
const TMP = "/tmp/bowl-lateral";
const W=1060,H=954;
const raw=readFileSync(`${TMP}/seq.rgba`);
const fb=W*H*4;
const frameAt=(fi:number)=>{const u=new Uint8ClampedArray(fb);u.set(raw.subarray(fi*fb,(fi+1)*fb));return u;};
const probeFrames=[]; for(let f=5;f<95;f++) probeFrames.push({rgba:frameAt(f),width:W,height:H});

// Lane15 foul from pinSign track @0.86: interpolate L~360 R~805
// From data: y0.85 L=364 R=804; y0.89 L=352 R=810
const BL0=360, BR0=805;
const rows:any[]=[];
for (const midShift of [-20,-10,0,10,20,30]) {
  for (const botW of [0.36,0.38,0.40,0.42,0.44,0.46]) {
    for (const pinMid of [0.52,0.54,0.55,0.56,0.57,0.58,0.60]) {
      for (const topF of [0.14,0.16,0.18,0.20,0.22]) {
        for (const foulY of [0.84,0.86,0.88]) {
          const fy=foulY*H, py=0.11*H;
          const midF = (BL0+BR0)/2 + midShift;
          const half = (botW*W)/2;
          const bl = midF - half, br = midF + half;
          const tl = pinMid*W - (topF*W)/2, tr = pinMid*W + (topF*W)/2;
          if (bl<50||br>W-50||tl>=tr) continue;
          const c:LaneCorners={bl:{x:bl,y:fy},br:{x:br,y:fy},tl:{x:tl,y:py},tr:{x:tr,y:py}};
          const d=scoreCornersByProbe(c,probeFrames);
          if(d.arrows==null||d.arrows<12.8||d.arrows>15.5) continue;
          // dx vs lane15 foul anchors
          const dxL=bl-BL0, dxR=br-BR0;
          rows.push({midShift,botW,pinMid,topF,foulY,arr:d.arrows,med:d.med,dxL,dxR,bl,br,tl,tr,
            score: Math.abs(dxL)+Math.abs(dxR)+Math.abs(d.arrows-14.5)*5});
        }
      }
    }
  }
}
rows.sort((a,b)=>a.score-b.score);
console.log("Best lane15-ish with arr:");
for (const r of rows.slice(0,20)) {
  console.log(`shift=${r.midShift} bot=${r.botW} pinMid=${r.pinMid} top=${r.topF} foulY=${r.foulY} arr=${r.arr.toFixed(1)} med=${r.med?.toFixed(1)} dxL=${r.dxL.toFixed(0)} dxR=${r.dxR.toFixed(0)} BL=${r.bl.toFixed(0)} BR=${r.br.toFixed(0)} TL=${r.tl.toFixed(0)} TR=${r.tr.toFixed(0)}`);
}
console.log("total", rows.length);

// Also test exact pinSign corners with various foulY/pinsY only
console.log("\nExact pinSign fit-style:");
const lf={a: null as any}; // from pinSign: at foulY0.86 L≈360 R=805; at pins use mid0.57 top0.17
for (const foulY of [0.84,0.86,0.88]) {
  for (const pinsY of [0.10,0.11,0.12]) {
    for (const pinMid of [0.55,0.56,0.57,0.58]) {
      for (const topF of [0.16,0.18,0.20]) {
        const c:LaneCorners={
          bl:{x:360,y:foulY*H}, br:{x:805,y:foulY*H},
          tl:{x:pinMid*W-(topF*W)/2,y:pinsY*H}, tr:{x:pinMid*W+(topF*W)/2,y:pinsY*H},
        };
        const d=scoreCornersByProbe(c,probeFrames);
        if (d.arrows!=null) console.log(`foulY=${foulY} pinsY=${pinsY} pinMid=${pinMid} top=${topF} arr=${d.arrows.toFixed(1)} med=${d.med?.toFixed(1)}`);
      }
    }
  }
}
