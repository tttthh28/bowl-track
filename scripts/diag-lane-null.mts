import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-lane-diag3";
const W = 640, H = 576, FPS = 8, N = 48;
mkdirSync(OUT, { recursive: true });
execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, {stdio:"pipe"});
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W*H*4;

// Inline a instrumented slice of detect logic for fail frames
function probe(rgba: Uint8ClampedArray) {
  const width=W, height=H;
  const scale = Math.min(1, 320 / width);
  const sw = Math.max(40, Math.round(width * scale));
  const sh = Math.max(40, Math.round(height * scale));
  const gray = new Uint8ClampedArray(sw*sh);
  for (let y=0;y<sh;y++){
    const sy=Math.min(height-1,Math.floor((y/sh)*height));
    for (let x=0;x<sw;x++){
      const sx=Math.min(width-1,Math.floor((x/sw)*width));
      const i=(sy*width+sx)*4;
      gray[y*sw+x]=(rgba[i]*77+rgba[i+1]*150+rgba[i+2]*29)>>8;
    }
  }
  let sum=0,sumSq=0;
  for (let i=0;i<gray.length;i++){sum+=gray[i];sumSq+=gray[i]*gray[i];}
  const mean=sum/gray.length;
  const std=Math.sqrt(Math.max(0,sumSq/gray.length-mean*mean));
  const thr=Math.min(210,Math.max(75,mean+Math.max(6,std*0.28)));

  function pick(y:number, expectMid:number|null){
    const minRun=Math.max(5,Math.round(sw*0.05));
    const runs:{l:number;r:number;sum:number}[]=[];
    let run=0,runStart=0,runSum=0;
    for (let x=0;x<=sw;x++){
      const v=x<sw?gray[y*sw+x]:0;
      if(x<sw&&v>=thr){if(run===0){runStart=x;runSum=0;}run++;runSum+=v;}
      else if(run>0){if(run>=minRun)runs.push({l:runStart,r:runStart+run-1,sum:runSum});run=0;}
    }
    if(!runs.length) return null;
    const cx=expectMid!=null?expectMid:sw*0.5;
    let best=runs[0],bestScore=-1e9;
    for(const r of runs){
      const mid=(r.l+r.r)/2,w=r.r-r.l+1,dist=Math.abs(mid-cx);
      const score=w*1.1-dist*(expectMid!=null?2.2:1)+(r.sum/w)*0.05;
      if(score>bestScore){bestScore=score;best=r;}
    }
    return best;
  }
  const lefts:(number|null)[]=Array(sh).fill(null);
  const rights:(number|null)[]=Array(sh).fill(null);
  let expectMid:number|null=null;
  let tracked=0;
  for(let y=sh-1;y>=0;y--){
    const band=pick(y,expectMid);
    if(!band) continue;
    lefts[y]=band.l; rights[y]=band.r; expectMid=(band.l+band.r)/2; tracked++;
  }
  const samples=[];
  for(let y=Math.floor(sh*0.06);y<=Math.floor(sh*0.94);y++){
    if(lefts[y]==null) continue;
    samples.push({y,l:lefts[y]!,r:rights[y]!,w:rights[y]!-lefts[y]!+1});
  }
  const lower=samples.filter(s=>s.y>sh*0.55);
  const upper=samples.filter(s=>s.y<sh*0.45);
  return {tracked, samples:samples.length, lower:lower.length, upper:upper.length, thr, mean, expectLast:expectMid};
}

const fails=[1,2,4,6,7,8,9,13,15,22,47];
for (const f of [...fails, 0,10,20]) {
  const rgba=new Uint8ClampedArray(raw.buffer, raw.byteOffset+f*frameBytes, frameBytes);
  console.log(`f=${f}`, probe(new Uint8ClampedArray(rgba)));
}
