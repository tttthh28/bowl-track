/** Brute dark-blob scan: find black ball candidates per frame */
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

const TMP="/tmp/bowl-lateral", W=1060, H=954, N=120;
const OUT=join(import.meta.dirname,"../tmp-reports/auto-corners-opus-2026-10-19");
const raw=readFileSync(`${TMP}/seq.rgba`);
const fb=W*H*4;
const frameAt=(i:number)=>new Uint8ClampedArray(raw.buffer,raw.byteOffset+i*fb,fb);

function findDarkBlobs(rgba: Uint8ClampedArray, y0f: number, y1f: number) {
  const y0=Math.floor(y0f*H), y1=Math.floor(y1f*H);
  const dark: {x:number;y:number}[] = [];
  for (let y=y0;y<y1;y+=2) {
    for (let x=Math.floor(W*0.15); x<Math.floor(W*0.85); x+=2) {
      const i=(y*W+x)*4;
      const g=(rgba[i]*77+rgba[i+1]*150+rgba[i+2]*29)>>8;
      if (g < 45) dark.push({x,y});
    }
  }
  // cluster
  const used=new Uint8Array(dark.length);
  const blobs:{cx:number;cy:number;n:number;minX:number;maxX:number}[]=[];
  for (let i=0;i<dark.length;i++) {
    if (used[i]) continue;
    const q=[i]; used[i]=1;
    let sx=0,sy=0,n=0,minX=9999,maxX=0;
    while(q.length){
      const j=q.pop()!;
      const p=dark[j]; sx+=p.x;sy+=p.y;n++; minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);
      for (let k=0;k<dark.length;k++){
        if(used[k])continue;
        const d=dark[k];
        if(Math.abs(d.x-p.x)<18 && Math.abs(d.y-p.y)<18){used[k]=1;q.push(k);}
      }
    }
    if (n>=12 && n<800) blobs.push({cx:sx/n,cy:sy/n,n,minX,maxX});
  }
  blobs.sort((a,b)=>b.n-a.n);
  return blobs.slice(0,5);
}

for (const fi of [20, 30, 40, 50, 60, 70, 80]) {
  const blobs = findDarkBlobs(frameAt(fi), 0.25, 0.85);
  console.log(`fi=${fi}`, blobs.map(b=>({x:b.cx.toFixed(0), xf:(b.cx/W).toFixed(3), y:b.cy.toFixed(0), yf:(b.cy/H).toFixed(3), n:b.n, w:b.maxX-b.minX})));
}
