/**
 * Find dark gutter troughs (not just bright-wood flanks) for lane 15.
 */
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const OUT = join(import.meta.dirname, "../tmp-reports/auto-corners-opus-2026-10-19");
const TMP = "/tmp/bowl-lateral";
const W = 1060, H = 954;
const raw = readFileSync(`${TMP}/seq.rgba`);
const fb = W * H * 4;
const frameAt = (fi: number) => {
  const u = new Uint8ClampedArray(fb);
  u.set(raw.subarray(fi * fb, (fi + 1) * fb));
  return u;
};

function toGray(rgba: Uint8ClampedArray) {
  const g = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    g[i] = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
  }
  return g;
}

/** Dark trough: local min + both sides brighter (gutter channel) */
function darkTroughsAt(gray: Uint8ClampedArray, y: number, x0: number, x1: number) {
  const row = y * W;
  const cands: { x: number; depth: number; g: number }[] = [];
  for (let x = x0 + 4; x < x1 - 4; x++) {
    const v = gray[row + x];
    if (v > 90) continue; // not dark enough
    let left = 0, right = 0, nL = 0, nR = 0;
    for (let k = 3; k <= 18; k++) {
      left += gray[row + x - k]; nL++;
      right += gray[row + x + k]; nR++;
    }
    const lM = left / nL, rM = right / nR;
    const depth = Math.min(lM - v, rM - v);
    if (depth < 18) continue;
    // local min
    if (v > gray[row + x - 1] || v > gray[row + x + 1]) continue;
    cands.push({ x, depth, g: v });
  }
  cands.sort((a, b) => b.depth - a.depth || a.g - b.g);
  return cands.slice(0, 8);
}

const fi = 21;
const rgba = frameAt(fi);
const gray = toGray(rgba);
const det = detectLaneCorners(rgba, W, H)!;
console.log("detect corners", {
  BL: det.corners.bl.x.toFixed(1), BR: det.corners.br.x.toFixed(1),
  TL: det.corners.tl.x.toFixed(1), TR: det.corners.tr.x.toFixed(1),
  midF: ((det.corners.bl.x + det.corners.br.x) / 2 / W).toFixed(3),
  midP: ((det.corners.tl.x + det.corners.tr.x) / 2 / W).toFixed(3),
});

for (const yf of [0.88, 0.86, 0.80, 0.70, 0.55, 0.40, 0.25, 0.15, 0.11]) {
  const y = Math.round(yf * H);
  const troughs = darkTroughsAt(gray, y, Math.floor(W * 0.15), Math.floor(W * 0.90));
  console.log(`y=${yf.toFixed(2)} troughs:`, troughs.map(t => `x=${t.x}(d=${t.depth.toFixed(0)},g=${t.g})`).join(" | "));
}

// Pick L15 pair: two troughs around mid~0.55 with spacing ~single lane
function pickL15(yf: number) {
  const y = Math.round(yf * H);
  const troughs = darkTroughsAt(gray, y, Math.floor(W * 0.18), Math.floor(W * 0.88));
  const expectW = W * (0.20 + yf * 0.28);
  let best: { l: number; r: number; sc: number } | null = null;
  for (let i = 0; i < troughs.length; i++) {
    for (let j = i + 1; j < troughs.length; j++) {
      const a = troughs[i], b = troughs[j];
      const l = Math.min(a.x, b.x), r = Math.max(a.x, b.x);
      const w = r - l;
      if (w < expectW * 0.7 || w > expectW * 1.35) continue;
      const mid = (l + r) / 2;
      if (mid < W * 0.48 || mid > W * 0.62) continue;
      const sc = a.depth + b.depth - Math.abs(w - expectW) * 0.05 - Math.abs(mid - W * 0.55) * 0.02;
      if (!best || sc > best.sc) best = { l, r, sc };
    }
  }
  return best;
}

console.log("\nL15 dark-trough pairs:");
const pts: { y: number; l: number; r: number }[] = [];
for (const yf of [0.88, 0.86, 0.82, 0.76, 0.70, 0.62, 0.55, 0.48, 0.40, 0.30, 0.20, 0.12]) {
  const p = pickL15(yf);
  if (!p) { console.log(`  y=${yf} NONE`); continue; }
  pts.push({ y: yf * H, l: p.l, r: p.r });
  console.log(`  y=${yf} L=${p.l} R=${p.r} mid=${((p.l+p.r)/2).toFixed(0)} w=${((p.r-p.l)/W).toFixed(3)}`);
}

function fit(ys: number[], xs: number[]) {
  const n = ys.length; let sy=0,sx=0,syy=0,sxy=0;
  for (let i=0;i<n;i++){sy+=ys[i];sx+=xs[i];syy+=ys[i]*ys[i];sxy+=ys[i]*xs[i];}
  const den=n*syy-sy*sy; if(Math.abs(den)<1e-6)return null;
  const b=(n*sxy-sy*sx)/den, a=(sx-b*sy)/n; return {a,b};
}
if (pts.length >= 6) {
  const ys=pts.map(p=>p.y), ls=pts.map(p=>p.l), rs=pts.map(p=>p.r);
  const lf=fit(ys,ls)!, rf=fit(ys,rs)!;
  const foulY=0.86*H, pinsY=0.11*H;
  const corners: LaneCorners = {
    bl:{x:lf.a+lf.b*foulY,y:foulY}, br:{x:rf.a+rf.b*foulY,y:foulY},
    tl:{x:lf.a+lf.b*pinsY,y:pinsY}, tr:{x:rf.a+rf.b*pinsY,y:pinsY},
  };
  console.log("\ndark-fit corners", {
    BL: corners.bl.x.toFixed(0), BR: corners.br.x.toFixed(0),
    TL: corners.tl.x.toFixed(0), TR: corners.tr.x.toFixed(0),
    midF: ((corners.bl.x+corners.br.x)/2/W).toFixed(3),
    midP: ((corners.tl.x+corners.tr.x)/2/W).toFixed(3),
    bot: ((corners.br.x-corners.bl.x)/W).toFixed(3),
    top: ((corners.tr.x-corners.tl.x)/W).toFixed(3),
  });
  // overlay
  const out = new Uint8ClampedArray(rgba);
  const setPx=(x:number,y:number,r:number,g:number,b:number)=>{
    const xi=Math.round(x),yi=Math.round(y); if(xi<0||yi<0||xi>=W||yi>=H)return;
    const i=(yi*W+xi)*4; out[i]=r;out[i+1]=g;out[i+2]=b;out[i+3]=255;
  };
  const thick=(x0:number,y0:number,x1:number,y1:number,r:number,g:number,b:number,t=3)=>{
    const steps=Math.max(2,Math.ceil(Math.hypot(x1-x0,y1-y0)));
    for(let s=0;s<=steps;s++){const u=s/steps,x=x0+(x1-x0)*u,y=y0+(y1-y0)*u;
      for(let dy=-t;dy<=t;dy++)for(let dx=-t;dx<=t;dx++)setPx(x+dx,y+dy,r,g,b);}
  };
  const marker=(x:number,y:number,r:number,g:number,b:number,rad=10)=>{
    for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++)if(dx*dx+dy*dy<=rad*rad)setPx(x+dx,y+dy,r,g,b);
  };
  // green/red = dark-fit lines
  thick(corners.tl.x,corners.tl.y,corners.bl.x,corners.bl.y,40,220,60,4);
  thick(corners.tr.x,corners.tr.y,corners.br.x,corners.br.y,230,50,50,4);
  for (const p of pts) { marker(p.l,p.y,40,255,60,4); marker(p.r,p.y,255,50,50,4); }
  // cyan = current detect
  const c=det.corners;
  thick(c.tl.x,c.tl.y,c.tr.x,c.tr.y,0,200,255,3);
  thick(c.tr.x,c.tr.y,c.br.x,c.br.y,0,200,255,3);
  thick(c.br.x,c.br.y,c.bl.x,c.bl.y,0,200,255,3);
  thick(c.bl.x,c.bl.y,c.tl.x,c.tl.y,0,200,255,3);
  marker(c.tl.x,c.tl.y,0,200,255); marker(c.tr.x,c.tr.y,0,200,255);
  marker(c.bl.x,c.bl.y,0,200,255); marker(c.br.x,c.br.y,0,200,255);
  const path=join(OUT,"dark-trough-vs-detect-fi21.png");
  writeFileSync(path.replace(/\.png$/,'.rgba'), Buffer.from(out.buffer,out.byteOffset,out.byteLength));
  execSync(`ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${path.replace(/\.png$/,'.rgba')}" -frames:v 1 "${path}"`,{stdio:'pipe'});
  console.log("WROTE", path);
}
