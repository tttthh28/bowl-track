/** True-gutter fit with inset / moderated top → arr */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const OUT = join(import.meta.dirname, "../tmp-reports/auto-corners-opus-2026-10-19");
const TMP = "/tmp/bowl-lateral";
const W = 1060, H = 954;
const raw = readFileSync(`${TMP}/seq.rgba`);
const fb = W*H*4;
const frameAt = (fi:number) => { const u=new Uint8ClampedArray(fb); u.set(raw.subarray(fi*fb,(fi+1)*fb)); return u; };
const probeFrames=[]; for(let f=5;f<95;f++) probeFrames.push({rgba:frameAt(f),width:W,height:H});

// True fit coeffs from prior
const lf={a:615.2,b:-0.5070}, rf={a:678.0,b:0.1547};
const xAt=(f:{a:number;b:number},y:number)=>f.a+f.b*y;

const foulY=0.86, pinsY=0.11;
const fy=foulY*H, py=pinsY*H;
const trueBL=xAt(lf,fy), trueBR=xAt(rf,fy), trueTL=xAt(lf,py), trueTR=xAt(rf,py);
console.log("true corners", {trueBL,trueBR,trueTL,trueTR});

function mk(insetBot: number, insetTop: number, skewBlend: number): LaneCorners {
  // inset as fraction of width at that end (positive = inward toward mid)
  const bl = trueBL + insetBot * (trueBR-trueBL);
  const br = trueBR - insetBot * (trueBR-trueBL);
  // skewBlend 0 = no skew (pin mid = foul mid, topFrac 0.16), 1 = full fit
  const foulMid = (bl+br)/2;
  const foulHalf = (br-bl)/2;
  const fitTL = trueTL + insetTop * (trueTR-trueTL);
  const fitTR = trueTR - insetTop * (trueTR-trueTL);
  const noTL = foulMid - foulHalf * (0.16/0.56); // match current top/bot ratio-ish
  const noTR = foulMid + foulHalf * (0.16/0.56);
  // better: no-skew uses topFrac param
  const topHalf = (0.16 * W) / 2;
  const noTL2 = foulMid - topHalf, noTR2 = foulMid + topHalf;
  const tl = noTL2 * (1-skewBlend) + fitTL * skewBlend;
  const tr = noTR2 * (1-skewBlend) + fitTR * skewBlend;
  return { bl:{x:bl,y:fy}, br:{x:br,y:fy}, tl:{x:tl,y:py}, tr:{x:tr,y:py} };
}

const rows:any[]=[];
for (const insetBot of [0, 0.02, 0.04, 0.06]) {
  for (const insetTop of [0, 0.02, 0.05, 0.08, 0.10]) {
    for (const skew of [0, 0.25, 0.4, 0.55, 0.7, 0.85, 1.0]) {
      for (const topF of [0.14, 0.16, 0.18, 0.20]) {
        // rebuild with explicit topF for no-skew part
        const bl = trueBL + insetBot * (trueBR-trueBL);
        const br = trueBR - insetBot * (trueBR-trueBL);
        const foulMid = (bl+br)/2;
        const fitTL = trueTL + insetTop * (trueTR-trueTL);
        const fitTR = trueTR - insetTop * (trueTR-trueTL);
        const noTL = foulMid - (topF*W)/2, noTR = foulMid + (topF*W)/2;
        const tl = noTL * (1-skew) + fitTL * skew;
        const tr = noTR * (1-skew) + fitTR * skew;
        const c: LaneCorners = { bl:{x:bl,y:fy}, br:{x:br,y:fy}, tl:{x:tl,y:py}, tr:{x:tr,y:py} };
        const bot=(br-bl)/W, top=(tr-tl)/W;
        if (top < 0.08 || top > 0.35 || tl>=tr) continue;
        const d = scoreCornersByProbe(c, probeFrames);
        if (d.arrows == null || d.arrows < 12.5 || d.arrows > 15.5) continue;
        // dx vs true (no inset) at foul/mid/pins
        const dx = (y:number) => {
          const t=(y-py)/Math.max(1e-6,fy-py);
          const bL=tl+(bl-tl)*t, bR=tr+(br-tr)*t;
          return {dxL:bL-xAt(lf,y), dxR:bR-xAt(rf,y)};
        };
        const a=dx(fy), b=dx(0.55*H), p=dx(py);
        const mean=([a,b,p].reduce((s,z)=>s+Math.abs(z.dxL)+Math.abs(z.dxR),0))/6;
        rows.push({insetBot,insetTop,skew,topF,arr:d.arrows,med:d.med,bot,top,mean,
          midP:(tl+tr)/2/W, dxPinsL:p.dxL, dxPinsR:p.dxR, dxMidL:b.dxL, dxMidR:b.dxR,
          tl, tr, bl, br});
      }
    }
  }
}
rows.sort((a,b)=>a.mean-b.mean || Math.abs(a.arr-14.5)-Math.abs(b.arr-14.5));
console.log("Best arr∈[12.5,15.5] by mean|dx|:");
for (const r of rows.slice(0, 25)) {
  console.log(`inB=${r.insetBot} inT=${r.insetTop} skew=${r.skew} topF=${r.topF} arr=${r.arr.toFixed(1)} mean=${r.mean.toFixed(1)} midP=${r.midP.toFixed(3)} pinsDx=${r.dxPinsL.toFixed(0)}/${r.dxPinsR.toFixed(0)} midDx=${r.dxMidL.toFixed(0)}/${r.dxMidR.toFixed(0)} TL=${r.tl.toFixed(0)} TR=${r.tr.toFixed(0)}`);
}
console.log("total", rows.length);
writeFileSync(join(OUT,"inset-sweep.json"), JSON.stringify(rows.slice(0,40),null,2));
