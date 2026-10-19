/** Probe corners + 30fps track (browser-like decode denser) */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners, shouldEndShot,
} from "../src/lib/tracker.ts";
import { detectLaneCorners, snapCornersToTrueGutter, scoreLaneGeometry, frameHasLaneSignal } from "../src/lib/laneDetect.ts";
import { buildHomography, imageToLane } from "../src/lib/perspective.ts";
import { computeShotEstimate } from "../src/lib/estimates.ts";
import { evaluateShotQuality } from "../src/lib/shotQuality.ts";
import { pickBestCornersByProbe } from "../src/lib/laneProbe.ts";
import type { LaneCorners, TrackPoint } from "../src/lib/types.ts";

const OUT15 = "/tmp/bowl-live5";
const OUT30 = "/tmp/bowl-live5-30";
const W = 1060, H = 954;
const VIDEO = join(import.meta.dirname, "../test-media/bowling-demo.mp4");
mkdirSync(OUT15, { recursive: true });
mkdirSync(OUT30, { recursive: true });
if (!existsSync(`${OUT15}/seq.rgba`)) {
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=15,scale=${W}:${H}" -frames:v 120 -f rawvideo -pix_fmt rgba "${OUT15}/seq.rgba"`, { stdio: "pipe" });
}
if (!existsSync(`${OUT30}/seq.rgba`)) {
  execSync(`ffmpeg -y -i "${VIDEO}" -vf "fps=30,scale=${W}:${H}" -frames:v 200 -f rawvideo -pix_fmt rgba "${OUT30}/seq.rgba"`, { stdio: "pipe" });
}

function load(path: string) {
  const raw = readFileSync(path);
  const fb = W * H * 4;
  const n = Math.floor(raw.length / fb);
  return { n, at: (i: number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + Math.min(n - 1, i) * fb, fb) };
}
const f15 = load(`${OUT15}/seq.rgba`);
const f30 = load(`${OUT30}/seq.rgba`);

function downscale(rgba: Uint8ClampedArray, tw: number, th: number) {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const sx = Math.min(W - 1, Math.floor((x / tw) * W));
    const sy = Math.min(H - 1, Math.floor((y / th) * H));
    const si = (sy * W + sx) * 4, di = (y * tw + x) * 4;
    out[di] = rgba[si]; out[di+1]=rgba[si+1]; out[di+2]=rgba[si+2]; out[di+3]=255;
  }
  return out;
}

// detect+probe on 15fps like Workbench
const dur = f15.n / 15;
const tryTimes = [0.08,0.35,0.8,1.4,dur*0.28,dur*0.42,dur*0.58,dur*0.72,dur*0.85];
const detCands: any[] = [];
for (const t of tryTimes) {
  const i = Math.min(f15.n-1, Math.round(t*15));
  const rgba = f15.at(i);
  if (!frameHasLaneSignal(rgba,W,H)) continue;
  const next = detectLaneCorners(rgba,W,H);
  if (next) detCands.push({ det: next, geom: scoreLaneGeometry(next,W,H) });
}
const ranked = detCands.map(c=>({...c,rank:c.geom})).sort((a,b)=>b.rank-a.rank);
const frames=[];
for(let i=0;i<60;i++){ const rgba=f15.at(Math.min(f15.n-1, Math.round((0.2+i/15)*15))); if(frameHasLaneSignal(rgba,W,H)) frames.push({rgba,width:W,height:H}); }
const picked = pickBestCornersByProbe(ranked.map(c=>({det:c.det,geomRank:c.rank})), frames, 10);
let corners = snapCornersToTrueGutter((picked?.det.corners ?? ranked[0].det.corners), W, H);
console.log("probeArr", picked?.detail.arrows, "mid", ((corners.bl.x+corners.br.x)/2).toFixed(0));

function track(frames: ReturnType<typeof load>, fps: number, dups: number, edge: boolean, label: string) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER };
  let shotPts: TrackPoint[] = [];
  let saved: TrackPoint[] | null = null;
  for (let f = 0; f < frames.n; f++) {
    const rgba = frames.at(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    // skip-dup: only innermost once if dups==1; if dups>1 simulate without skip
    for (let d = 0; d < dups; d++) {
      const res = trackBallFrame(state, gray, scale<1?tw:W, scale<1?th:H, settings, scale<1?workC:corners, 1000/fps, work);
      const pos = res.smoothed ? (scale<1?{x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed) : null;
      const rFull = res.radius!=null&&res.radius>0?(scale<1?res.radius/scale:res.radius):null;
      if (res.locked && pos && (res.raw!=null||res.predicted)) {
        const contact = ballContactPoint(pos, rFull);
        const lane = imageToLane(Hm, contact);
        let accept = true;
        if (edge && lane && (lane.board<2.8||lane.board>36.2)&&lane.feet<48) accept=false;
        if (accept && shotPts.length && lane && !res.predicted) {
          const prev = shotPts[shotPts.length-1];
          if (prev.lane) {
            const dFeet = lane.feet - prev.lane.feet;
            const dBoard = Math.abs(lane.board - prev.lane.board);
            if (dFeet < -0.8 || (dBoard > 3.5 && dFeet < 1)) accept = false;
          }
        }
        if (accept) shotPts.push({image:contact,lane,t:f*(1000/fps),predicted:res.predicted||undefined});
      }
      if (shouldEndShot(state, settings, shotPts.length>0)) {
        if (!saved && evaluateShotQuality(shotPts).ok) saved = shotPts.slice();
        shotPts=[]; state.beginNewShot({clearBg:true});
      } else if (!res.locked && shotPts.length) {
        shotPts=[]; state.beginNewShot({clearBg:true});
      }
    }
  }
  if (!saved && shotPts.length && evaluateShotQuality(shotPts).ok) saved = shotPts;
  if (!saved) { console.log(JSON.stringify({label,arr:null,n:0})); return; }
  const est = computeShotEstimate(saved);
  const boards = saved.filter(p=>p.lane).map(p=>p.lane!.board);
  const med = [...boards].sort((a,b)=>a-b)[Math.floor(boards.length/2)];
  // raw board at 15'
  const around15 = boards.length ? saved.filter(p=>p.lane && p.lane.feet>=13 && p.lane.feet<=17).map(p=>p.lane!.board) : [];
  const raw15 = around15.length ? [...around15].sort((a,b)=>a-b)[Math.floor(around15.length/2)] : null;
  console.log(JSON.stringify({label, arr:est.arrowsBoard, raw15: raw15!=null?+raw15.toFixed(1):null, med:+med.toFixed(1), n:saved.length,
    boards:`${Math.min(...boards).toFixed(1)}-${Math.max(...boards).toFixed(1)}`,
    ft: (()=>{const f=saved.filter(p=>p.lane).map(p=>p.lane!.feet);return `${Math.min(...f).toFixed(1)}-${Math.max(...f).toFixed(1)}`;})()
  }));
}

track(f15, 15, 1, true, "15fps skipdup edge");
track(f30, 30, 1, true, "30fps skipdup edge");
track(f30, 30, 3, true, "30fps 3xdup edge");
track(f30, 30, 1, false, "30fps skipdup noedge");
track(f15, 15, 3, true, "15fps 3xdup edge");

// 30fps 片只 step 偶數幀 ≈15fps（對齊 Workbench minDt）
function trackSub15(frames: ReturnType<typeof load>, fps: number, label: string) {
  const Hm = buildHomography(corners)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(corners, scale);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER };
  let shotPts: TrackPoint[] = [];
  let saved: TrackPoint[] | null = null;
  const step = Math.max(1, Math.round(fps / 15));
  for (let f = 0; f < frames.n; f += step) {
    const rgba = frames.at(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const res = trackBallFrame(state, gray, scale<1?tw:W, scale<1?th:H, settings, scale<1?workC:corners, 1000/15, work);
    const pos = res.smoothed ? (scale<1?{x:res.smoothed.x/scale,y:res.smoothed.y/scale}:res.smoothed) : null;
    const rFull = res.radius!=null&&res.radius>0?(scale<1?res.radius/scale:res.radius):null;
    if (res.locked && pos && (res.raw!=null||res.predicted)) {
      const contact = ballContactPoint(pos, rFull);
      const lane = imageToLane(Hm, contact);
      let accept = true;
      if (lane && (lane.board<2.8||lane.board>36.2)&&lane.feet<48) accept=false;
      if (accept && shotPts.length && lane && !res.predicted) {
        const prev = shotPts[shotPts.length-1];
        if (prev.lane) {
          const dFeet = lane.feet - prev.lane.feet;
          const dBoard = Math.abs(lane.board - prev.lane.board);
          if (dFeet < -0.8 || (dBoard > 3.5 && dFeet < 1)) accept = false;
        }
      }
      if (accept) shotPts.push({image:contact,lane,t:f*(1000/fps),predicted:res.predicted||undefined});
    }
    if (shouldEndShot(state, settings, shotPts.length>0)) {
      if (!saved && evaluateShotQuality(shotPts).ok) saved = shotPts.slice();
      shotPts=[]; state.beginNewShot({clearBg:true});
    } else if (!res.locked && shotPts.length) {
      shotPts=[]; state.beginNewShot({clearBg:true});
    }
  }
  if (!saved && shotPts.length && evaluateShotQuality(shotPts).ok) saved = shotPts;
  if (!saved) { console.log(JSON.stringify({label,arr:null,n:0})); return; }
  const est = computeShotEstimate(saved);
  const boards = saved.filter(p=>p.lane).map(p=>p.lane!.board);
  const around15 = saved.filter(p=>p.lane && p.lane.feet>=13 && p.lane.feet<=17).map(p=>p.lane!.board);
  const raw15 = around15.length ? [...around15].sort((a,b)=>a-b)[Math.floor(around15.length/2)] : null;
  const med = [...boards].sort((a,b)=>a-b)[Math.floor(boards.length/2)];
  console.log(JSON.stringify({label, arr:est.arrowsBoard, raw15: raw15!=null?+raw15.toFixed(1):null, med:+med.toFixed(1), n:saved.length}));
}
trackSub15(f30, 30, "30fps→15 subsample (Workbench fix)");
