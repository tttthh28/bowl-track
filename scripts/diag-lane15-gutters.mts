/**
 * Find lane-15 gutters: seed from bright wood mid-lane under the "15" sign region,
 * track down to foul and up to pins. Compare widths.
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const OUT = join(import.meta.dirname, "../tmp-reports/auto-corners-opus-2026-10-19");
const TMP = "/tmp/bowl-lateral";
const W = 1060, H = 954;
mkdirSync(OUT, { recursive: true });
const raw = readFileSync(`${TMP}/seq.rgba`);
const fb = W * H * 4;
const frameAt = (fi: number) => { const u = new Uint8ClampedArray(fb); u.set(raw.subarray(fi * fb, (fi + 1) * fb)); return u; };

function toGray(rgba: Uint8ClampedArray) {
  const g = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    g[i] = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
  }
  return g;
}

/** Find brightest continuous wood band mid at given y; return L/R of band edges via |gx|+flank */
function laneBandAt(gray: Uint8ClampedArray, y: number, seedMid: number, expectW: number) {
  const row = y * W;
  // Find bright region around seedMid
  const half = expectW * 0.7;
  const x0 = Math.max(1, Math.floor(seedMid - half));
  const x1 = Math.min(W - 2, Math.ceil(seedMid + half));
  // Score candidate L/R pairs with width near expectW, mid near seed, strong gutter flank
  let best: { l: number; r: number; sc: number } | null = null;
  const gx = (x: number) => Math.abs(gray[row + x + 1] - gray[row + x - 1]);
  const flank = (x: number, side: -1 | 1) => {
    let inM = 0, outM = 0, nI = 0, nO = 0;
    for (let k = 1; k <= 14; k++) {
      const xi = x + side * k, xo = x - side * k;
      if (xi >= 0 && xi < W) { inM += gray[row + xi]; nI++; }
      if (xo >= 0 && xo < W) { outM += gray[row + xo]; nO++; }
    }
    return nI && nO ? (inM / nI - outM / nO) / 40 : 0;
  };
  const minW = expectW * 0.75, maxW = expectW * 1.25;
  for (let l = x0; l < seedMid - expectW * 0.25; l++) {
    const gL = gx(l), fL = flank(l, 1);
    if (gL < 10 || fL < 0.1) continue;
    for (let r = Math.ceil(seedMid + expectW * 0.25); r <= x1; r++) {
      const w = r - l;
      if (w < minW || w > maxW) continue;
      const gR = gx(r), fR = flank(r, -1);
      if (gR < 10 || fR < 0.1) continue;
      const mid = (l + r) / 2;
      let sc = (gL + gR) * 0.08 + (fL + fR) * 22 - Math.abs(mid - seedMid) * 3 - Math.abs(w - expectW) / W * 50;
      // prefer brighter inside
      let inside = 0, n = 0;
      for (let x = l + 2; x < r - 2; x += 3) { inside += gray[row + x]; n++; }
      sc += n ? (inside / n) / 40 : 0;
      if (!best || sc > best.sc) best = { l, r, sc };
    }
  }
  return best;
}

function fitLine(ys: number[], xs: number[]) {
  const n = ys.length; let sy=0,sx=0,syy=0,sxy=0;
  for (let i=0;i<n;i++){sy+=ys[i];sx+=xs[i];syy+=ys[i]*ys[i];sxy+=ys[i]*xs[i];}
  const den = n*syy-sy*sy; if (Math.abs(den)<1e-6) return null;
  const b=(n*sxy-sy*sx)/den, a=(sx-b*sy)/n; return {a,b};
}
const xAt=(f:{a:number;b:number},y:number)=>f.a+f.b*y;

function track(gray: Uint8ClampedArray, seedMid: number, seedW: number, label: string) {
  const pts: {y:number;l:number;r:number;mid:number;w:number}[] = [];
  let mid = seedMid, w = seedW;
  // go down to foul then we'll also go up — start from mid y=0.55
  for (const dir of [1, -1] as const) {
    let m = mid, ww = w;
    const start = dir === 1 ? 0.55 : 0.53;
    for (let yf = start; dir===1 ? yf <= 0.90 : yf >= 0.12; yf += dir * 0.02) {
      const y = Math.round(yf * H);
      // perspective width model
      const expectW = seedW * (0.55 + yf * 0.55) / (0.55 + 0.55 * 0.55); // scale vs seed y
      const altW = W * (0.20 + yf * 0.28); // 0.45 at foul, 0.23 at pins
      const useW = (ww * 0.5 + altW * 0.5);
      const band = laneBandAt(gray, y, m, useW);
      if (!band) continue;
      const bm = (band.l + band.r) / 2;
      if (Math.abs(bm - m) > W * 0.07) continue;
      pts.push({ y, l: band.l, r: band.r, mid: bm, w: (band.r - band.l) / W });
      m = m * 0.4 + bm * 0.6;
      ww = ww * 0.5 + (band.r - band.l) * 0.5;
    }
  }
  // dedupe by y
  const byY = new Map<number, typeof pts[0]>();
  for (const p of pts) byY.set(p.y, p);
  const sorted = [...byY.values()].sort((a,b)=>b.y-a.y);
  console.log(`\n=== ${label} seedMid=${seedMid.toFixed(0)} seedW=${seedW.toFixed(0)} n=${sorted.length}`);
  for (const p of sorted) console.log(`  y=${(p.y/H).toFixed(3)} L=${p.l} R=${p.r} mid=${p.mid.toFixed(1)} w=${p.w.toFixed(3)}`);
  return sorted;
}

function writePng(rgba: Uint8ClampedArray, path: string) {
  const rawPath = path.replace(/\.png$/, ".rgba");
  writeFileSync(rawPath, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  execSync(`ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${rawPath}" -frames:v 1 "${path}"`, { stdio: "pipe" });
}

function draw(rgba: Uint8ClampedArray, corners: LaneCorners, pts: {y:number;l:number;r:number}[], lf:any, rf:any) {
  const out = new Uint8ClampedArray(rgba);
  const setPx=(x:number,y:number,r:number,g:number,b:number)=>{
    const xi=Math.round(x),yi=Math.round(y); if(xi<0||yi<0||xi>=W||yi>=H)return;
    const i=(yi*W+xi)*4; out[i]=r;out[i+1]=g;out[i+2]=b;out[i+3]=255;
  };
  const thick=(x0:number,y0:number,x1:number,y1:number,r:number,g:number,b:number,t=2)=>{
    const steps=Math.max(2,Math.ceil(Math.hypot(x1-x0,y1-y0)));
    for(let s=0;s<=steps;s++){const u=s/steps,x=x0+(x1-x0)*u,y=y0+(y1-y0)*u;
      for(let dy=-t;dy<=t;dy++)for(let dx=-t;dx<=t;dx++)setPx(x+dx,y+dy,r,g,b);}
  };
  const marker=(x:number,y:number,r:number,g:number,b:number,rad=9)=>{
    for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++)if(dx*dx+dy*dy<=rad*rad)setPx(x+dx,y+dy,r,g,b);
  };
  thick(xAt(lf,H*0.1),H*0.1,xAt(lf,H*0.9),H*0.9,40,220,60,3);
  thick(xAt(rf,H*0.1),H*0.1,xAt(rf,H*0.9),H*0.9,230,50,50,3);
  for (const p of pts) { marker(p.l,p.y,40,255,60,3); marker(p.r,p.y,255,50,50,3); }
  const {tl,tr,br,bl}=corners;
  thick(tl.x,tl.y,tr.x,tr.y,0,200,255,3);
  thick(tr.x,tr.y,br.x,br.y,0,200,255,3);
  thick(br.x,br.y,bl.x,bl.y,0,200,255,3);
  thick(bl.x,bl.y,tl.x,tl.y,0,200,255,3);
  marker(tl.x,tl.y,0,200,255); marker(tr.x,tr.y,0,200,255);
  marker(bl.x,bl.y,0,200,255); marker(br.x,br.y,0,200,255);
  return out;
}

const fi = 21;
const rgba = frameAt(fi);
const gray = toGray(rgba);
const probeFrames=[]; for(let f=5;f<95;f++) probeFrames.push({rgba:frameAt(f),width:W,height:H});

// Try several seeds: lane 14-ish (left), lane 15 (center-right of pins), lane 16
const seeds = [
  { label: "lane14ish", mid: W*0.42, w: W*0.36 },
  { label: "lane15-center", mid: W*0.52, w: W*0.36 },
  { label: "lane15-right", mid: W*0.55, w: W*0.34 },
  { label: "lane15-pinSign", mid: W*0.58, w: W*0.32 }, // under "15" at pins tends right
  { label: "wide-old", mid: W*0.476, w: W*0.50 },
];

for (const s of seeds) {
  const pts = track(gray, s.mid, s.w, s.label);
  if (pts.length < 8) { console.log("too few"); continue; }
  // use foul-to-mid for stable fit
  const use = pts.filter(p => p.y/H >= 0.35);
  const ys=use.map(p=>p.y), ls=use.map(p=>p.l), rs=use.map(p=>p.r);
  const lf=fitLine(ys,ls)!, rf=fitLine(ys,rs)!;
  const fy=0.86*H, py=0.11*H;
  const corners: LaneCorners = {
    bl:{x:xAt(lf,fy),y:fy}, br:{x:xAt(rf,fy),y:fy},
    tl:{x:xAt(lf,py),y:py}, tr:{x:xAt(rf,py),y:py},
  };
  const bot=(corners.br.x-corners.bl.x)/W;
  const top=(corners.tr.x-corners.tl.x)/W;
  const midF=(corners.bl.x+corners.br.x)/2/W;
  const midP=(corners.tl.x+corners.tr.x)/2/W;
  const d=scoreCornersByProbe(corners, probeFrames);
  console.log(`  → corners bot=${bot.toFixed(3)} top=${top.toFixed(3)} midF=${midF.toFixed(3)} midP=${midP.toFixed(3)} arr=${d.arrows?.toFixed(1)??'—'} med=${d.med?.toFixed(1)??'—'} BL=${corners.bl.x.toFixed(0)} BR=${corners.br.x.toFixed(0)} TL=${corners.tl.x.toFixed(0)} TR=${corners.tr.x.toFixed(0)}`);
  writePng(draw(rgba, corners, use, lf, rf), join(OUT, `seed-${s.label}.png`));
}
console.log("DONE");
