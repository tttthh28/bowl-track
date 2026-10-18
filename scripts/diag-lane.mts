import { execSync } from "child_process";
import { readFileSync, mkdirSync } from "fs";
import { join } from "path";
import { detectLaneCorners } from "../src/lib/laneDetect.ts";

const ROOT = join(import.meta.dirname, "..");
const VIDEO = join(ROOT, "test-media/bowling-demo.mp4");
const OUT = "/tmp/bowl-lane-diag";
const W = 640, H = 576, FPS = 8, N = 48;
mkdirSync(OUT, { recursive: true });
execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`, {stdio:"pipe"});
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W*H*4;
let ok=0,fail=0;
for (let f=0; f<N; f++) {
  const rgba = new Uint8ClampedArray(raw.buffer, raw.byteOffset + f*frameBytes, frameBytes);
  const det = detectLaneCorners(new Uint8ClampedArray(rgba), W, H);
  if (!det) { console.log(`FAIL f=${f}`); fail++; }
  else {
    ok++;
    const c=det.corners;
    const pinOk = c.tl.y<=H*0.18 && c.tr.y<=H*0.18;
    const foulOk = c.bl.y>=H*0.7 && c.br.y>=H*0.7;
    const botW=c.br.x-c.bl.x, topW=c.tr.x-c.tl.x;
    const trap=botW>topW*1.05;
    if (!pinOk||!foulOk||!trap||det.confidence<0.5)
      console.log(`WEAK f=${f} conf=${(det.confidence*100).toFixed(0)} pin=${pinOk} foul=${foulOk} trap=${trap} TL.y=${c.tl.y.toFixed(0)}`);
  }
}
console.log(`ok=${ok}/${N} fail=${fail} rate=${((ok/N)*100).toFixed(1)}%`);
