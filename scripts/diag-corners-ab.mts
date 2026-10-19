/**
 * A/B: corner geometry + probe scores with current code;
 * also dump all candidate probe arrows to find ~28.5 path.
 */
import { execSync } from "child_process";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import {
  detectLaneCorners,
  scoreLaneGeometry,
} from "../src/lib/laneDetect.ts";
import { pickBestCornersByProbe, scoreCornersByProbe } from "../src/lib/laneProbe.ts";
import { buildHomography } from "../src/lib/perspective.ts";

const VIDEO = "test-media/bowling-demo.mp4";
const OUT = "/tmp/bowl-corners-ab";
const W = 1060, H = 954, FPS = 15, N = 120;
mkdirSync(OUT, { recursive: true });
execSync(
  `ffmpeg -y -i "${VIDEO}" -vf "fps=${FPS},scale=${W}:${H}" -frames:v ${N} -f rawvideo -pix_fmt rgba "${OUT}/seq.rgba"`,
  { stdio: "pipe" }
);
const raw = readFileSync(`${OUT}/seq.rgba`);
const frameBytes = W * H * 4;
function frameAt(fi: number) {
  const u8 = new Uint8ClampedArray(frameBytes);
  u8.set(raw.subarray(fi * frameBytes, (fi + 1) * frameBytes));
  return u8;
}

const tryFi = [1, 5, 12, 21, 36, 48, 60, 75, 90, 100, 110];
const cands = [];
for (const fi of tryFi) {
  const det = detectLaneCorners(frameAt(fi), W, H);
  if (!det || det.confidence < 0.4) continue;
  const geom = scoreLaneGeometry(det, W, H);
  const c = det.corners;
  const botFrac = (c.br.x - c.bl.x) / W;
  const topFrac = (c.tr.x - c.tl.x) / W;
  const midBot = (c.bl.x + c.br.x) / 2;
  const midTop = (c.tl.x + c.tr.x) / 2;
  const foulY = ((c.bl.y + c.br.y) / 2) / H;
  const pinsY = ((c.tl.y + c.tr.y) / 2) / H;
  const widthOk =
    botFrac >= 0.32 && botFrac <= 0.48 ? 28 : botFrac >= 0.28 && botFrac <= 0.52 ? 8 : -35;
  const midFrac = Math.abs(midBot / W - 0.5);
  const midRightPen = midBot / W > 0.52 ? -18 : midBot / W > 0.5 ? -8 : 0;
  const midOk = (midFrac < 0.1 ? 22 : midFrac < 0.16 ? 6 : -30) + midRightPen;
  const rank = geom + widthOk + midOk;
  cands.push({
    fi, geom, rank, conf: det.confidence,
    botFrac, topFrac, midBot, midTop, foulY, pinsY,
    corners: c,
    msg: det.message,
  });
}
cands.sort((a, b) => b.rank - a.rank);
console.log("=== ALL CANDS (geom rank) ===");
for (const c of cands) {
  console.log(
    `fi=${c.fi} rank=${c.rank.toFixed(1)} geom=${c.geom.toFixed(1)} conf=${(c.conf*100).toFixed(0)}% ` +
    `bot=${c.botFrac.toFixed(3)} top=${c.topFrac.toFixed(3)} midBot=${c.midBot.toFixed(0)} ` +
    `foulY=${c.foulY.toFixed(3)} pinsY=${c.pinsY.toFixed(3)} ` +
    `tl=(${c.corners.tl.x.toFixed(0)},${c.corners.tl.y.toFixed(0)}) tr=(${c.corners.tr.x.toFixed(0)},${c.corners.tr.y.toFixed(0)}) ` +
    `bl=(${c.corners.bl.x.toFixed(0)},${c.corners.bl.y.toFixed(0)}) br=(${c.corners.br.x.toFixed(0)},${c.corners.br.y.toFixed(0)})`
  );
}

const probeFrames = [];
for (let f = 5; f < Math.min(N, 95); f++) {
  probeFrames.push({ rgba: frameAt(f), width: W, height: H });
}

console.log("\n=== PROBE EACH CAND (top 8) ===");
for (const c of cands.slice(0, 8)) {
  const d = scoreCornersByProbe(c.corners, probeFrames, { geomRank: c.rank });
  console.log(
    `fi=${c.fi} probeScore=${d.score.toFixed(1)} arr=${d.arrows?.toFixed(1) ?? "—"} med=${d.med?.toFixed(1) ?? "—"} ` +
    `ft=${d.minFeet.toFixed(1)}–${d.maxFeet.toFixed(1)} locks=${d.locks} gutter=${d.gutterRace}`
  );
}

const picked = pickBestCornersByProbe(
  cands.map((c) => ({
    det: { corners: c.corners, confidence: c.conf, message: c.msg } as any,
    geomRank: c.rank,
  })),
  probeFrames,
  6
);
console.log("\n=== PICKED ===", {
  arr: picked?.detail.arrows,
  med: picked?.detail.med,
  score: picked?.detail.score,
  locks: picked?.detail.locks,
  botFrac: picked ? ((picked.det.corners.br.x - picked.det.corners.bl.x) / W).toFixed(3) : null,
  midBot: picked ? ((picked.det.corners.bl.x + picked.det.corners.br.x) / 2).toFixed(0) : null,
  pinsY: picked ? (((picked.det.corners.tl.y + picked.det.corners.tr.y) / 2) / H).toFixed(3) : null,
  foulY: picked ? (((picked.det.corners.bl.y + picked.det.corners.br.y) / 2) / H).toFixed(3) : null,
});

// Compare: artificially shrink corners 8% inward — does that give ~28.5?
if (picked) {
  const c = picked.det.corners;
  const shrink = (frac: number) => {
    const midB = (c.bl.x + c.br.x) / 2;
    const midT = (c.tl.x + c.tr.x) / 2;
    const halfB = ((c.br.x - c.bl.x) / 2) * frac;
    const halfT = ((c.tr.x - c.tl.x) / 2) * frac;
    return {
      tl: { x: midT - halfT, y: c.tl.y },
      tr: { x: midT + halfT, y: c.tr.y },
      bl: { x: midB - halfB, y: c.bl.y },
      br: { x: midB + halfB, y: c.br.y },
    };
  };
  for (const frac of [0.92, 0.85, 0.78, 0.7]) {
    const sc = shrink(frac);
    const d = scoreCornersByProbe(sc, probeFrames, { geomRank: 100 });
    console.log(
      `shrink ${frac}: bot=${((sc.br.x-sc.bl.x)/W).toFixed(3)} arr=${d.arrows?.toFixed(1)??"—"} med=${d.med?.toFixed(1)??"—"} locks=${d.locks} ft=${d.minFeet.toFixed(1)}–${d.maxFeet.toFixed(1)}`
    );
  }
  // Raise foul / lower pins
  for (const [dyF, dyP] of [[-0.05, 0.08], [-0.08, 0.12], [0.03, 0.05]]) {
    const sc = {
      ...c,
      bl: { ...c.bl, y: c.bl.y + dyF * H },
      br: { ...c.br, y: c.br.y + dyF * H },
      tl: { ...c.tl, y: c.tl.y + dyP * H },
      tr: { ...c.tr, y: c.tr.y + dyP * H },
    };
    const d = scoreCornersByProbe(sc, probeFrames, { geomRank: 100 });
    console.log(
      `shift foul ${dyF} pins ${dyP}: foulY=${((sc.bl.y)/H).toFixed(3)} pinsY=${((sc.tl.y)/H).toFixed(3)} arr=${d.arrows?.toFixed(1)??"—"} med=${d.med?.toFixed(1)??"—"} locks=${d.locks}`
    );
  }
}
