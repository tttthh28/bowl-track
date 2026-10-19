import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";
import type { LaneCorners } from "../src/lib/types.ts";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "tmp-reports/auto-corners-opus-2026-10-19");
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
function fitLine(ys: number[], xs: number[]) {
  const n = ys.length; let sy=0,sx=0,syy=0,sxy=0;
  for (let i=0;i<n;i++){sy+=ys[i];sx+=xs[i];syy+=ys[i]*ys[i];sxy+=ys[i]*xs[i];}
  const den=n*syy-sy*sy; if(Math.abs(den)<1e-6)return null;
  const b=(n*sxy-sy*sx)/den, a=(sx-b*sy)/n; return {a,b};
}
function xAt(f:{a:number;b:number},y:number){return f.a+f.b*y;}

/** Reliable gutter track y=0.40..0.90 */
function trackGutters(gray: Uint8ClampedArray) {
  const pts: { y: number; l: number; r: number }[] = [];
  let expectMid = W * 0.476, expectW = W * 0.56;
  for (let yf = 0.90; yf >= 0.38; yf -= 0.02) {
    const y = Math.round(yf * H);
    const row = y * W;
    const targetW = W * (0.18 + yf * 0.42);
    expectW = expectW * 0.4 + targetW * 0.6;
    const half = expectW * 0.55;
    const xL0 = Math.max(2, Math.floor(expectMid - half));
    const xL1 = Math.floor(expectMid - expectW * 0.28);
    const xR0 = Math.ceil(expectMid + expectW * 0.28);
    const xR1 = Math.min(W - 3, Math.ceil(expectMid + half));
    const scoreSide = (x: number, side: -1 | 1) => {
      const g = Math.abs(gray[row + x + 1] - gray[row + x - 1]);
      if (g < 12) return -1e9;
      let inM = 0, outM = 0, nI = 0, nO = 0;
      for (let k = 1; k <= 16; k++) {
        const xi = x + side * k, xo = x - side * k;
        if (xi >= 0 && xi < W) { inM += gray[row + xi]; nI++; }
        if (xo >= 0 && xo < W) { outM += gray[row + xo]; nO++; }
      }
      const flank = nI && nO ? (inM / nI - outM / nO) / 40 : 0;
      if (flank < 0.12) return -1e9;
      return g * 0.1 + flank * 28;
    };
    let bestL = { x: Math.floor(expectMid - expectW / 2), sc: -1e9 };
    let bestR = { x: Math.ceil(expectMid + expectW / 2), sc: -1e9 };
    for (let x = xL0; x <= xL1; x++) { const sc = scoreSide(x, 1); if (sc > bestL.sc) bestL = { x, sc }; }
    for (let x = xR0; x <= xR1; x++) { const sc = scoreSide(x, -1); if (sc > bestR.sc) bestR = { x, sc }; }
    if (bestL.sc < 0 || bestR.sc < 0) continue;
    const w = bestR.x - bestL.x, mid = (bestL.x + bestR.x) / 2;
    if (Math.abs(mid - expectMid) > W * 0.06) continue;
    if (w < expectW * 0.65 || w > expectW * 1.4) continue;
    pts.push({ y, l: bestL.x, r: bestR.x });
    expectMid = expectMid * 0.45 + mid * 0.55;
    expectW = expectW * 0.5 + w * 0.5;
  }
  return pts;
}

function writePng(rgba: Uint8ClampedArray, path: string) {
  const rawPath = path.replace(/\.png$/, ".rgba");
  writeFileSync(rawPath, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  execSync(`ffmpeg -y -f rawvideo -pix_fmt rgba -s ${W}x${H} -i "${rawPath}" -frames:v 1 "${path}"`, { stdio: "pipe" });
}

function draw(rgba: Uint8ClampedArray, corners: LaneCorners, gutters: {y:number;l:number;r:number}[], lf:{a:number;b:number}, rf:{a:number;b:number}) {
  const out = new Uint8ClampedArray(rgba);
  const setPx = (x:number,y:number,r:number,g:number,b:number) => {
    const xi=Math.round(x),yi=Math.round(y); if(xi<0||yi<0||xi>=W||yi>=H)return;
    const i=(yi*W+xi)*4; out[i]=r;out[i+1]=g;out[i+2]=b;out[i+3]=255;
  };
  const thick=(x0:number,y0:number,x1:number,y1:number,r:number,g:number,b:number,t=2)=>{
    const steps=Math.max(2,Math.ceil(Math.hypot(x1-x0,y1-y0)));
    for(let s=0;s<=steps;s++){const u=s/steps,x=x0+(x1-x0)*u,y=y0+(y1-y0)*u;
      for(let dy=-t;dy<=t;dy++)for(let dx=-t;dx<=t;dx++)setPx(x+dx,y+dy,r,g,b);}
  };
  const marker=(x:number,y:number,r:number,g:number,b:number,rad=10)=>{
    for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++)if(dx*dx+dy*dy<=rad*rad)setPx(x+dx,y+dy,r,g,b);
  };
  // green/red = extrapolated true gutters from foul→mid fit
  const y0 = H * 0.10, y1 = H * 0.90;
  thick(xAt(lf,y0), y0, xAt(lf,y1), y1, 40, 220, 60, 3);
  thick(xAt(rf,y0), y0, xAt(rf,y1), y1, 230, 50, 50, 3);
  for (const p of gutters) { marker(p.l,p.y,40,255,60,3); marker(p.r,p.y,255,50,50,3); }
  const {tl,tr,br,bl}=corners;
  thick(tl.x,tl.y,tr.x,tr.y,0,200,255,3);
  thick(tr.x,tr.y,br.x,br.y,0,200,255,3);
  thick(br.x,br.y,bl.x,bl.y,0,200,255,3);
  thick(bl.x,bl.y,tl.x,tl.y,0,200,255,3);
  marker(tl.x,tl.y,0,200,255); marker(tr.x,tr.y,0,200,255);
  marker(bl.x,bl.y,0,200,255); marker(br.x,br.y,0,200,255);
  return out;
}

function dxAt(corners: LaneCorners, lf:{a:number;b:number}, rf:{a:number;b:number}, yFrac: number) {
  const y = yFrac * H;
  const t = (y - corners.tl.y) / Math.max(1e-6, corners.bl.y - corners.tl.y);
  const blueL = corners.tl.x + (corners.bl.x - corners.tl.x) * t;
  const blueR = corners.tr.x + (corners.br.x - corners.tr.x) * t;
  return { y, dxL: blueL - xAt(lf,y), dxR: blueR - xAt(rf,y), blueL, blueR, trueL: xAt(lf,y), trueR: xAt(rf,y) };
}

const fi = 21;
const rgba = frameAt(fi);
const gray = toGray(rgba);
const gutters = trackGutters(gray);
const ys = gutters.map(p=>p.y), ls=gutters.map(p=>p.l), rs=gutters.map(p=>p.r);
const lf = fitLine(ys, ls)!, rf = fitLine(ys, rs)!;
console.log("gutter fit L", lf.a.toFixed(1), lf.b.toFixed(4), "R", rf.a.toFixed(1), rf.b.toFixed(4));
console.log("true @foul0.86", xAt(lf,0.86*H).toFixed(0), xAt(rf,0.86*H).toFixed(0));
console.log("true @0.55", xAt(lf,0.55*H).toFixed(0), xAt(rf,0.55*H).toFixed(0));
console.log("true @pins0.11", xAt(lf,0.11*H).toFixed(0), xAt(rf,0.11*H).toFixed(0));

const probeFrames = [];
for (let f = 5; f < 95; f++) probeFrames.push({ rgba: frameAt(f), width: W, height: H });

const foulY = 0.86, pinsY = 0.11;
const fy = foulY*H, py = pinsY*H;

type Cand = { name: string; corners: LaneCorners };
const cands: Cand[] = [];

// BEFORE: current detect
const det = detectLaneCorners(rgba, W, H)!;
cands.push({ name: "before-current-snap", corners: det.corners });

// A: foul true + no skew mid0.476 top0.16
cands.push({ name: "A-mid476-noskew-top16", corners: {
  bl:{x:208,y:fy}, br:{x:802,y:fy},
  tl:{x:0.476*W-0.08*W,y:py}, tr:{x:0.476*W+0.08*W,y:py},
}});

// B: foul true + pinMid0.50 top0.20
cands.push({ name: "B-foulTrue-pin50-top20", corners: {
  bl:{x:208,y:fy}, br:{x:802,y:fy},
  tl:{x:0.50*W-0.10*W,y:py}, tr:{x:0.50*W+0.10*W,y:py},
}});

// C: foul true + pinMid0.51 top0.22
cands.push({ name: "C-foulTrue-pin51-top22", corners: {
  bl:{x:208,y:fy}, br:{x:802,y:fy},
  tl:{x:0.51*W-0.11*W,y:py}, tr:{x:0.51*W+0.11*W,y:py},
}});

// D: foul true + pinMid0.52 top0.24
cands.push({ name: "D-foulTrue-pin52-top24", corners: {
  bl:{x:208,y:fy}, br:{x:802,y:fy},
  tl:{x:0.52*W-0.12*W,y:py}, tr:{x:0.52*W+0.12*W,y:py},
}});

// E: corners from extrapolated fit (full skew)
cands.push({ name: "E-fit-extrapolate", corners: {
  bl:{x:xAt(lf,fy),y:fy}, br:{x:xAt(rf,fy),y:fy},
  tl:{x:xAt(lf,py),y:py}, tr:{x:xAt(rf,py),y:py},
}});

// F: foul true + moderated skew (50% of fit skew toward pins)
{
  const fitTL = xAt(lf,py), fitTR = xAt(rf,py);
  const noSkewTL = 0.476*W - 0.08*W, noSkewTR = 0.476*W + 0.08*W;
  const tl = noSkewTL * 0.45 + fitTL * 0.55;
  const tr = noSkewTR * 0.45 + fitTR * 0.55;
  cands.push({ name: "F-blend55-fitSkew", corners: {
    bl:{x:208,y:fy}, br:{x:802,y:fy},
    tl:{x:tl,y:py}, tr:{x:tr,y:py},
  }});
}

// G: mid 0.476 bot 0.56 asymmetric match true, pinMid 0.50 top 0.18
cands.push({ name: "G-mid476-bot56-pin50-top18", corners: {
  bl:{x:208,y:fy}, br:{x:802,y:fy},
  tl:{x:0.50*W-0.09*W,y:py}, tr:{x:0.50*W+0.09*W,y:py},
}});

const summary: any[] = [];
for (const c of cands) {
  const d = scoreCornersByProbe(c.corners, probeFrames);
  const dxF = dxAt(c.corners, lf, rf, foulY);
  const dxM = dxAt(c.corners, lf, rf, 0.55);
  const dxP = dxAt(c.corners, lf, rf, pinsY);
  const bot = (c.corners.br.x - c.corners.bl.x) / W;
  const top = (c.corners.tr.x - c.corners.tl.x) / W;
  const midF = (c.corners.bl.x + c.corners.br.x) / 2 / W;
  const midP = (c.corners.tl.x + c.corners.tr.x) / 2 / W;
  const meanAbsDx = (Math.abs(dxF.dxL)+Math.abs(dxF.dxR)+Math.abs(dxM.dxL)+Math.abs(dxM.dxR)+Math.abs(dxP.dxL)+Math.abs(dxP.dxR))/6;
  console.log(`\n${c.name}: arr=${d.arrows?.toFixed(1)??'—'} med=${d.med?.toFixed(1)??'—'} bot=${bot.toFixed(3)} top=${top.toFixed(3)} midF=${midF.toFixed(3)} midP=${midP.toFixed(3)}`);
  console.log(`  foul dxL/R=${dxF.dxL.toFixed(0)}/${dxF.dxR.toFixed(0)}  mid dx=${dxM.dxL.toFixed(0)}/${dxM.dxR.toFixed(0)}  pins dx=${dxP.dxL.toFixed(0)}/${dxP.dxR.toFixed(0)}  mean|dx|=${meanAbsDx.toFixed(1)}`);
  writePng(draw(rgba, c.corners, gutters, lf, rf), join(OUT, `${c.name}.png`));
  summary.push({ name: c.name, arr: d.arrows, med: d.med, bot, top, midF, midP, dxF, dxM, dxP, meanAbsDx, corners: c.corners });
}
writeFileSync(join(OUT, "candidates.json"), JSON.stringify(summary, null, 2));
console.log("\nDONE", OUT);
