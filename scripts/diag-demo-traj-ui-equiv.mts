/** UI-equivalent self-test mirroring patched Workbench upload loop */
import { readFileSync, writeFileSync } from "fs";
import {
  BallTrackerState, DEFAULT_TRACKER, ballContactPoint, rgbaToGray,
  trackBallFrame, trackWorkSize, scaleLaneCorners, shouldEndShot, insetLaneCorners,
} from "/workspace/bowl-track/src/lib/tracker.ts";
import { buildHomography, buildTrackHomography, imageToLane, smoothDemoPath, demoPathJaggedness, demoPathMaxElbowDeg, boardAtFeetOnDisplayedPath } from "/workspace/bowl-track/src/lib/perspective.ts";
import { computeShotEstimate } from "/workspace/bowl-track/src/lib/estimates.ts";
import { evaluateShotQuality } from "/workspace/bowl-track/src/lib/shotQuality.ts";
import type { LaneCorners, TrackPoint } from "/workspace/bowl-track/src/lib/types.ts";

const OUT = "/tmp/bowl-live5-30";
const W = 1060, H = 954, FPS = 30;
const raw = readFileSync(`${OUT}/seq.rgba`);
const fb = W * H * 4;
const framesN = Math.floor(raw.length / fb);
const frameAt = (i: number) => new Uint8ClampedArray(raw.buffer, raw.byteOffset + Math.min(framesN - 1, i) * fb, fb);
// TesterManual r3 corners (manual-demo-traj-20261019-r3)
const manual: LaneCorners = {
  tl: { x: 542, y: 152 }, tr: { x: 704, y: 152 },
  bl: { x: 180, y: 864 }, br: { x: 815, y: 864 },
};
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
function jagged(pts: TrackPoint[]) {
  return demoPathJaggedness(pts);
}

function run(label: string, seedAt?: number, seedPx?: { x: number; y: number }) {
  // Visual H for offline harness continuity (elbow/coverage). Workbench live uses
  // buildTrackHomography; Arr≈path identity holds for both (see unit + trackH case).
  const Hm = buildHomography(manual)!;
  const { scale, tw, th } = trackWorkSize(W, H);
  const workC = scaleLaneCorners(manual, scale);
  const insetC = insetLaneCorners(workC, 0.15);
  const state = new BallTrackerState();
  const settings = { ...DEFAULT_TRACKER };
  let shotPts: TrackPoint[] = [];
  let gutterStreak = 0;
  let demoInset = true;
  let lastTrackedVt = -1;
  let endReason = "eof";
  let seeded = false;
  let midRecoverUsed = 0;

  for (let f = 0; f < framesN; f++) {
    const vt = f / FPS;
    if (lastTrackedVt >= 0 && vt + 1e-6 < lastTrackedVt + 1 / 15) continue;
    const dtMs = lastTrackedVt < 0 ? 33 : Math.min(80, Math.max(1, (vt - lastTrackedVt) * 1000));
    lastTrackedVt = vt;

    if (seedAt != null && !seeded && f >= seedAt) {
      let tx: number, y: number;
      if (seedPx) {
        tx = seedPx.x; y = seedPx.y;
      } else {
        const foulY = (manual.bl.y + manual.br.y) / 2;
        const pinY = (manual.tl.y + manual.tr.y) / 2;
        y = foulY + (pinY - foulY) * (8 / 60);
        const tt = Math.abs(foulY - pinY) > 1 ? Math.max(0, Math.min(1, (foulY - y) / (foulY - pinY))) : 0.25;
        const leftX = manual.bl.x + (manual.tl.x - manual.bl.x) * tt;
        const rightX = manual.br.x + (manual.tr.x - manual.br.x) * tt;
        tx = leftX + (rightX - leftX) * (10 / 39);
      }
      state.seedAt(scale < 1 ? { x: tx * scale, y: y * scale } : { x: tx, y });
      seeded = true;
    }

    const rgba = frameAt(f);
    const work = scale < 1 ? downscale(rgba, tw, th) : new Uint8ClampedArray(rgba);
    const gray = rgbaToGray(work, scale < 1 ? tw : W, scale < 1 ? th : H);
    const feetNow = shotPts.filter(p => p.lane).map(p => p.lane!.feet);
    const maxNow = feetNow.length ? Math.max(...feetNow) : 0;
    if ((feetNow.length >= 3 && maxNow >= 16) || (feetNow.length >= 5 && maxNow >= 20)) demoInset = false;
    const fast = state.fastRelockFrames > 0;
    const useC = (demoInset && !fast) ? insetC : workC;
    const res = trackBallFrame(state, gray, scale < 1 ? tw : W, scale < 1 ? th : H, settings, useC, dtMs, work);
    const pos = res.smoothed ? (scale < 1 ? { x: res.smoothed.x / scale, y: res.smoothed.y / scale } : res.smoothed) : null;
    const rFull = res.radius != null && res.radius > 0 ? (scale < 1 ? res.radius / scale : res.radius) : null;

    if (res.locked && pos && (res.raw != null || res.predicted)) {
      if (shotPts.length > 0 || !res.predicted) {
        const t = Math.round(vt * 1000);
        let contact = ballContactPoint(pos, rFull);
        let lane = imageToLane(Hm, contact);
        // gentle apex pull (match Workbench: only near tony band, 0.28)
        if (res.predicted && fast && lane && lane.feet >= 12 && lane.feet <= 18 &&
            lane.board >= 10 && lane.board <= 19) {
          const foulY = (manual.bl.y + manual.br.y) / 2;
          const pinY = (manual.tl.y + manual.tr.y) / 2;
          const tt = Math.abs(foulY - pinY) > 1 ? Math.max(0, Math.min(1, (foulY - contact.y) / (foulY - pinY))) : 0.25;
          const leftX = manual.bl.x + (manual.tl.x - manual.bl.x) * tt;
          const rightX = manual.br.x + (manual.tr.x - manual.br.x) * tt;
          const targetX = leftX + (rightX - leftX) * (14.3 / 39);
          contact = { x: contact.x * 0.72 + targetX * 0.28, y: contact.y };
          lane = imageToLane(Hm, contact) ?? lane;
        }
        let accept = true;
        if (lane) {
          if (lane.feet < 52 && (lane.board >= 30 || lane.board <= 2.8)) accept = false;
          if (lane.feet < 16 && lane.board >= 22) accept = false;
          if (lane.feet >= 16 && lane.feet < 55 && lane.board >= 27) accept = false;
          const leftGutterish = lane.feet < 16 && lane.board <= 5.5;
          const rightCrawl = lane.feet < 24 && lane.board >= 30;
          const midLeftDrift = lane.feet >= 16 && lane.feet < 45 && lane.board <= 5.0;
          const lanePts = shotPts.filter(p => p.lane);
          const maxLive = lanePts.reduce((m, p) => Math.max(m, p.lane!.feet), 0);
          const established = maxLive >= 18 && lanePts.some(p => p.lane!.feet >= 10 && p.lane!.board > 8 && p.lane!.board < 22);
          const stuckLow = !established && lane.feet < 12 && lane.board <= 8 && lanePts.length >= 4 && lanePts.every(p => p.lane!.feet < 12);
          if (leftGutterish || rightCrawl) accept = false;
          if (midLeftDrift && lane.board <= 3.5) accept = false;
          if (!established && (leftGutterish || rightCrawl || stuckLow)) {
            gutterStreak++;
            if (gutterStreak >= (stuckLow || leftGutterish ? 1 : 2)) {
              state.softRelockMid(workC);
              shotPts = shotPts.filter(p => !p.lane || p.lane.feet <= 14);
              gutterStreak = 0;
            }
          } else if (established && (midLeftDrift || rightCrawl)) {
            state.nudgeMidKeepLock(workC);
            gutterStreak = 0;
          } else if (lane.board > 6 && lane.board < 28) gutterStreak = 0;
        }
        if (accept && shotPts.length > 0 && lane) {
          const prev = shotPts[shotPts.length - 1];
          if (prev.lane) {
            const dFeet = lane.feet - prev.lane.feet;
            const dBoard = Math.abs(lane.board - prev.lane.board);
            const dtPt = Math.max(1, t - prev.t) / 1000;
            const backLim = fast ? -3.5 : -0.8;
            const boardJumpLim = fast ? 6.5 : 3.5;
            if (dFeet < backLim || (dBoard > boardJumpLim && dFeet < 1.0)) accept = false;
            const speedCap = lane.feet >= 20 ? 150 : 90;
            if (Math.abs(dFeet) / dtPt > speedCap || dBoard > 14) accept = false;
            if (lane.board > 28 && dFeet > 0.35 && dBoard / dFeet > 1.8) accept = false;
            if (accept && !fast && shotPts.length >= 2 && dFeet > 0.2) {
              const p2 = shotPts[shotPts.length - 2];
              if (p2.lane) {
                const slope1 = (prev.lane.board - p2.lane.board) / Math.max(0.15, prev.lane.feet - p2.lane.feet);
                const slope2 = (lane.board - prev.lane.board) / dFeet;
                const turn = Math.abs(slope2 - slope1);
                const early = prev.lane.feet < 18;
                const pred = !!res.predicted;
                if (early && pred && turn > 2.4) accept = false;
                else if (early && turn > 3.2) accept = false;
                else if (!early && turn > 2.2) accept = false;
                else if (turn > 3.5) accept = false;
              }
            }
          }
        }
        if (accept) {
          if (shotPts.length > 0 && lane && !res.predicted) {
            const prev = shotPts[shotPts.length - 1];
            if (prev.lane) {
              const dF = lane.feet - prev.lane.feet;
              const inTonySpan =
                prev.lane.feet < 22 && lane.feet > 8 &&
                prev.lane.board > 8 && prev.lane.board < 23 &&
                lane.board > 8 && lane.board < 23;
              const crossArrows =
                dF > 3.5 && prev.lane.feet < 15.5 && lane.feet > 14.5 &&
                prev.lane.board > 9 && prev.lane.board < 22 &&
                lane.board > 9 && lane.board < 22;
              const sparseTony = inTonySpan && dF > 2.8;
              if (crossArrows || sparseTony) {
                const targets: number[] = [];
                if (crossArrows) {
                  for (const tf of [13, 14, 15, 16]) targets.push(tf);
                } else {
                  const n = Math.min(4, Math.max(1, Math.floor(dF / 1.4)));
                  for (let k = 1; k <= n; k++) targets.push(prev.lane.feet + (dF * k) / (n + 1));
                }
                for (const tf of targets) {
                  if (tf <= prev.lane.feet + 0.35 || tf >= lane.feet - 0.35) continue;
                  const u = (tf - prev.lane.feet) / dF;
                  const b = prev.lane.board + u * (lane.board - prev.lane.board);
                  if (b < 7.5 || b > 24) continue;
                  shotPts.push({
                    image: { x: prev.image.x + u * (contact.x - prev.image.x), y: prev.image.y + u * (contact.y - prev.image.y) },
                    lane: { feet: tf, board: b }, t: prev.t + u * (t - prev.t), predicted: true,
                  });
                }
              }
            }
          }
          shotPts.push({ image: contact, lane, t, predicted: res.predicted || undefined });
        }
      }
    }

    const maxLiveFeet = shotPts.filter(p => p.lane).reduce((m, p) => Math.max(m, p.lane!.feet), 0);
    // mid recover up to 2× (match Workbench r7)
    if (
      midRecoverUsed < 2 &&
      state.locked &&
      state.lost >= (midRecoverUsed === 0 ? 10 : 12) &&
      maxLiveFeet >= 14 &&
      maxLiveFeet < 48 &&
      state.fastRelockFrames <= 0
    ) {
      state.softRelockMid(workC);
      shotPts = shotPts.filter(p => !p.lane || p.lane.feet <= maxLiveFeet + 2);
      demoInset = false;
      midRecoverUsed += 1;
    }
    const endSettings = {
      ...settings,
      lostFramesToEnd: maxLiveFeet >= 40 ? 56 : maxLiveFeet >= 28 ? 50 : maxLiveFeet >= 16 ? 40 : Math.max(settings.lostFramesToEnd, 28),
    };
    if (shouldEndShot(state, endSettings, shotPts.length > 0)) {
      endReason = `end@${maxLiveFeet.toFixed(0)} lost=${state.lost}`;
      break;
    }
  }

  const smoothed = smoothDemoPath(shotPts);
  const trimmed = smoothed.filter(p => !p.lane || p.lane.feet >= 12 || (p.lane.board > 5.5 && p.lane.board < 22));
  const estPts = trimmed.filter(p => p.lane).length >= 8 ? trimmed : smoothed;
  const q = evaluateShotQuality(smoothed);
  const est = computeShotEstimate(estPts, null, { boardFromRight: false });
  const all = smoothed.filter(p => p.lane);
  const feet = all.map(p => p.lane!.feet);
  const rawN = smoothed.filter(p => p.lane && !p.predicted).length;
  const maxB = all.length ? Math.max(...all.map(p => p.lane!.board)) : null;
  const path15 = boardAtFeetOnDisplayedPath(smoothed, 15, 2.5);
  const arrPathDelta =
    est.arrowsBoard != null && path15 != null
      ? Math.abs(est.arrowsBoard - path15)
      : null;
  return {
    label, endReason, qOk: q.ok, n: smoothed.length, nRaw: rawN, nBeforeSmooth: shotPts.length,
    pathFt: feet.length ? `${Math.min(...feet).toFixed(1)}-${Math.max(...feet).toFixed(1)}` : "—",
    covUI: est.coverageFeetMin != null ? `${est.coverageFeetMin}-${est.coverageFeetMax}` : "—",
    arr: est.arrowsBoard,
    path15: path15 != null ? +path15.toFixed(2) : null,
    arrPathDelta: arrPathDelta != null ? +arrPathDelta.toFixed(2) : null,
    bp: est.breakpointBoard != null ? +est.breakpointBoard.toFixed(1) : null,
    pocket: est.pocketBoard != null ? +est.pocketBoard.toFixed(1) : null,
    avg: est.avgSpeedMph, L: est.launchSpeedMph, I: est.impactSpeedMph, time: est.shotTimeSec,
    maxB: maxB != null ? +maxB.toFixed(1) : null,
    jagged: +jagged(smoothed).toFixed(2), jaggedRaw: +jagged(shotPts).toFixed(2),
    elbow: (() => { const e = demoPathMaxElbowDeg(smoothed, 10, 18); return { deg: +e.maxDeg.toFixed(1), at: +e.atFeet.toFixed(1), span: +e.spanFt.toFixed(2) }; })(),
    elbowRaw: (() => { const e = demoPathMaxElbowDeg(shotPts, 10, 18); return { deg: +e.maxDeg.toFixed(1), at: +e.atFeet.toFixed(1), span: +e.spanFt.toFixed(2) }; })(),
    foulOk: feet.length > 0 && Math.min(...feet) <= 8,
    pinsOk: feet.length > 0 && Math.max(...feet) >= 50,
    // Informational only — prior tickets forced [13,15] via PROBE_TGT; r5 requires Arr≈path
    arrIn1315: est.arrowsBoard != null && est.arrowsBoard >= 13 && est.arrowsBoard <= 15,
    arrPathOk: arrPathDelta != null && arrPathDelta <= 1.0,
    elbowOk: demoPathMaxElbowDeg(smoothed, 10, 18).maxDeg < 12,
    path: all.map(p => `${p.lane!.feet.toFixed(1)}/${p.lane!.board.toFixed(1)}${p.predicted?"p":""}`).join(" "),
  };
}

// Synthetic r4-like 8-pt sparse elbow (TesterManual visual)
function synthSparseElbow() {
  const pts = [
    [6.2, 7.5],[10.0, 12.8],[13.2, 15.5],[14.5, 15.8],[21.0, 18.0],[32.0, 21.0],[43.0, 23.5],[53.4, 25.1],
  ].map(([f,b],j) => ({ lane: { feet: f, board: b }, image: { x: 0, y: 0 }, t: j * 300 }));
  const rawE = demoPathMaxElbowDeg(pts, 10, 18);
  const sm = smoothDemoPath(pts as any);
  const smE = demoPathMaxElbowDeg(sm, 10, 18);
  return {
    label: "synth-r4-sparse8",
    nBefore: pts.length,
    nAfter: sm.filter((p: any) => p.lane).length,
    elbowRaw: { deg: +rawE.maxDeg.toFixed(1), at: +rawE.atFeet.toFixed(1), span: +rawE.spanFt.toFixed(2) },
    elbow: { deg: +smE.maxDeg.toFixed(1), at: +smE.atFeet.toFixed(1), span: +smE.spanFt.toFixed(2) },
    jagged: +demoPathJaggedness(sm).toFixed(2),
    path: sm.filter((p: any) => p.lane).map((p: any) => `${p.lane.feet.toFixed(1)}/${p.lane.board.toFixed(1)}${p.predicted?"p":""}`).join(" "),
    elbowOk: smE.maxDeg < 12,
  };
}

// r3 click ~(493,654); r4 click ~(416,625) @ ~2.3s
const rows = [
  run("unseeded"),
  run("seeded-early", Math.round(0.8 * FPS)),
  run("seeded-r3-click", Math.round(1.2 * FPS), { x: 493, y: 654 }),
  run("seeded-r4-click", Math.round(2.3 * FPS), { x: 416, y: 625 }),
  // TesterManual r5 ball-click ~(370,660)
  run("seeded-r5-click", Math.round(2.0 * FPS), { x: 370, y: 660 }),
  // TesterManual r6 mid click ~(450,590) — must still reach foul→pins or fail q
  run("seeded-r6-mid", Math.round(2.0 * FPS), { x: 450, y: 590 }),
];
const synth = synthSparseElbow();
for (const r of rows) {
  const { path, ...sum } = r;
  console.log(JSON.stringify(sum));
  console.log(" ", path.slice(0, 500));
}
console.log(JSON.stringify({ ...synth, path: undefined }));
console.log(" ", synth.path.slice(0, 500));
// densify must not inflate quality past MIN_POINTS (r6 6-raw @18–35′)
const r6frag = [
  [17.6, 16.0], [20.0, 16.0], [22.5, 15.5], [26.0, 13.5], [30.0, 11.5], [35.4, 8.7],
].map(([f, b], i) => ({
  lane: { feet: f, board: b },
  image: { x: 400 + i * 10, y: 600 - i * 40 },
  t: i * 90,
}));
const r6sm = smoothDemoPath(r6frag as any);
const r6qRaw = evaluateShotQuality(r6frag as any);
const r6qSm = evaluateShotQuality(r6sm as any);
const densifyOk = r6qRaw.ok === false && r6qSm.ok === false;
console.log(JSON.stringify({
  label: "r6-densify-quality",
  qRaw: r6qRaw.ok, reasonRaw: r6qRaw.reason,
  qSm: r6qSm.ok, reasonSm: r6qSm.reason, nSm: r6sm.length, densifyOk,
}));

// r7 success: foul→pins, smooth elbow, |Arr−path@15′|≤1, densify≠fake-ok
const ok = rows.some(r => r.foulOk && r.pinsOk && r.qOk && r.jagged < 1.0 && r.arrPathOk && r.elbowOk) && synth.elbowOk && densifyOk;
const okCov = rows.filter(r => r.foulOk && r.pinsOk);
const okArrPath = rows.filter(r => r.arrPathOk);
console.log("PASS_ANY", ok, "nCov", okCov.length, "nArrPathOk", okArrPath.length,
  "bestJagged", Math.min(...rows.map(r => r.jagged)),
  "bestElbow", Math.min(...rows.map(r => r.elbow.deg)), "synthElbow", synth.elbow.deg,
  "maxArrPathDelta", Math.max(...rows.filter(r => r.arrPathDelta != null).map(r => r.arrPathDelta as number)));
writeFileSync("/tmp/diag-ui-equiv.json", JSON.stringify({ rows, synth }, null, 2));
writeFileSync("/workspace/bowl-track/tmp-reports/demo-traj-ui-equiv-results.txt",
  rows.map(r => { const { path, ...s } = r; return JSON.stringify(s) + "\n  " + path.slice(0, 500); }).join("\n")
  + "\n" + JSON.stringify({ label: synth.label, nBefore: synth.nBefore, nAfter: synth.nAfter, elbowRaw: synth.elbowRaw, elbow: synth.elbow, jagged: synth.jagged, elbowOk: synth.elbowOk })
  + "\n  " + synth.path.slice(0, 500)
  + `\nPASS_ANY ${ok}\n`);
writeFileSync("/workspace/tmp-reports/demo-traj-ui-equiv-results.txt",
  rows.map(r => { const { path, ...s } = r; return JSON.stringify(s) + "\n  " + path.slice(0, 500); }).join("\n")
  + "\n" + JSON.stringify({ label: synth.label, nBefore: synth.nBefore, nAfter: synth.nAfter, elbowRaw: synth.elbowRaw, elbow: synth.elbow, jagged: synth.jagged, elbowOk: synth.elbowOk })
  + "\n  " + synth.path.slice(0, 500)
  + `\nPASS_ANY ${ok}\n`);
