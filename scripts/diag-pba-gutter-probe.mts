import { readFileSync } from "fs";
import { detectBroadcastHud, detectLaneCornersBroadcast } from "../src/lib/laneDetect.ts";
import { detectLaneCornersHough } from "../src/lib/laneDetectHough.ts";

const W=1280,H=720;
const raw=readFileSync("/tmp/bowl-pba01-hough/seq.rgba");
const fi=12;
const rgba=new Uint8ClampedArray(raw.subarray(fi*W*H*4,(fi+1)*W*H*4));
const hud=detectBroadcastHud(rgba,W,H);
const mr=hud.maskRight;
const grayAt=(y:number,x:number)=>{const o=(Math.round(y)*W+Math.round(x))*4;return (rgba[o]*77+rgba[o+1]*150+rgba[o+2]*29)>>8;};

for (const yf of [0.75,0.80,0.85,0.90]) {
  const y=Math.round(H*yf);
  const row:number[]=[];
  for(let x=0;x<mr;x++){let g=0;for(let dy=-2;dy<=2;dy++)g+=grayAt(y+dy,x);row.push(g/5);}
  const Lpeaks:{x:number;flank:number;gx:number}[]=[];
  const Rpeaks:{x:number;flank:number;gx:number}[]=[];
  for(let x=30;x<mr-30;x++){
    const gx=Math.abs(row[x+1]-row[x-1]);
    if(gx<8) continue;
    let outL=0,innL=0,outR=0,innR=0;
    for(let k=3;k<=16;k++){
      outL+=row[x-k]??0; innL+=row[x+k]??0;
      outR+=row[x+k]??0; innR+=row[x-k]??0;
    }
    const fL=innL/14-outL/14;
    const fR=innR/14-outR/14;
    if(fL>15) Lpeaks.push({x,flank:+fL.toFixed(1),gx:+gx.toFixed(1)});
    if(fR>15) Rpeaks.push({x,flank:+fR.toFixed(1),gx:+gx.toFixed(1)});
  }
  Lpeaks.sort((a,b)=>b.flank-a.flank);
  Rpeaks.sort((a,b)=>b.flank-a.flank);
  // Best outer pair with width 0.25-0.48 of W
  let best=null as any;
  for(const L of Lpeaks.slice(0,20)) for(const R of Rpeaks.slice(0,20)){
    const w=R.x-L.x; if(w<W*0.22||w>W*0.5) continue;
    const m=(L.x+R.x)/2; if(m<W*0.22||m>W*0.48) continue;
    const sc=L.flank+R.flank - Math.abs(w/W-0.35)*40;
    if(!best||sc>best.sc) best={L:L.x,R:R.x,w:+(w/W).toFixed(3),m:+(m/W).toFixed(3),sc};
  }
  console.log("yf",yf,"bestPair",best,"topL",Lpeaks.slice(0,5),"topR",Rpeaks.slice(0,5));
}

const bcast=detectLaneCornersBroadcast(rgba,W,H,mr);
const hough=detectLaneCornersHough(rgba,W,H,mr,{broadcastHint:true});
console.log("bcast", bcast&&{...bcast.corners, msg:bcast.message, bl:Math.round(bcast.corners.bl.x),br:Math.round(bcast.corners.br.x),tl:Math.round(bcast.corners.tl.x),tr:Math.round(bcast.corners.tr.x)});
console.log("hough", hough&&{bl:Math.round(hough.corners.bl.x),br:Math.round(hough.corners.br.x),tl:Math.round(hough.corners.tl.x),tr:Math.round(hough.corners.tr.x),bot:+((hough.corners.br.x-hough.corners.bl.x)/W).toFixed(3)});

// Find pin deck Y: wood band ending
for(let y=Math.round(H*0.05); y<Math.round(H*0.35); y+=4){
  let wood=0,n=0;
  for(let x=Math.round(W*0.25);x<Math.round(W*0.55);x+=2){wood+=grayAt(y,x);n++;}
  const avg=wood/n;
  if(y%20===0||avg>80) console.log("y",y,"yf",+(y/H).toFixed(3),"woodAvg",avg.toFixed(1));
}
