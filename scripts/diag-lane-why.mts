/** temporary: patch-style probe by reimplementing early-exit checks via imports */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-lane-diag2";
const W = 640, H = 576, FPS = 8, N = 48;
mkdirSync(OUT, { recursive: true });
execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, {stdio:"pipe"});
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W*H*4;

// dump fail frames as png via ffmpeg select
const fails = [1,2,4,6,7,8,9,13,15,22,47];
for (const f of fails) {
  const t = f / FPS;
  execSync(`ffmpeg -y -ss ${t} -i "${VIDEO}" -frames:v 1 -vf scale=${W}:${H} "${OUT}/f${f}.png"`, {stdio:"pipe"});
}
console.log("wrote fail frame pngs", fails.map(f=>`${OUT}/f${f}.png`).join(" "));

// mean brightness of fail vs ok
function meanBright(f: number) {
  const rgba = new Uint8ClampedArray(raw.buffer, raw.byteOffset + f*frameBytes, frameBytes);
  let s=0,n=0;
  for (let i=0;i<rgba.length;i+=4){ s += (rgba[i]*77+rgba[i+1]*150+rgba[i+2]*29)>>8; n++; }
  return s/n;
}
for (const f of [0,1,2,3,5,10,20,30,40,47]) {
  console.log(`f=${f} meanY=${meanBright(f).toFixed(1)}`);
}
