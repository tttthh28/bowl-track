import type { LaneCorners, Point2D } from "./types";
import { defaultCorners } from "./perspective";
import { detectLaneCornersCorra } from "./laneDetectCorra";
import { detectLaneCornersHough } from "./laneDetectHough";

export type LaneDetectResult = {
  corners: LaneCorners;
  /** 0–1 粗信心；偏低時建議改手動 */
  confidence: number;
  message: string;
  /** PBA Strike Track 等右欄 HUD：唔好再 demo hard-snap */
  broadcastHud?: boolean;
};

/** 標準球道約 60′ × 41.5″ */
const LANE_ASPECT = (60 * 12) / 41.5;

/**
 * 瀏覽器端球道四角自動偵測（無 OpenCV）。
 * 後方視角：下 foul 較寬、上 pins 較窄；優先揀畫面中央球道（避相鄰道）。
 */
/** 空白／極低對比幀（seek 未完成常見）→ 唔好當球道 */
export function frameHasLaneSignal(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): boolean {
  if (width < 8 || height < 8) return false;
  const stepX = Math.max(1, Math.floor(width / 48));
  const stepY = Math.max(1, Math.floor(height / 36));
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let dark = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = (y * width + x) * 4;
      const g = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
      sum += g;
      sumSq += g * g;
      if (g < 28) dark++;
      n++;
    }
  }
  if (n < 20) return false;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  // 全黑／解碼疤：暗點過多或幾乎無對比
  if (mean < 18 && std < 12) return false;
  if (dark / n > 0.92 && std < 18) return false;
  if (std < 6) return false;
  return true;
}


/**
 * PBA／FOX Strike Track 等：右欄高亮長矩形 HUD。
 * 偵測「左暗→右亮」垂直跳變；bowling-demo 木面唔會有呢種跳。
 */
export function detectBroadcastHud(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): { present: boolean; maskRight: number } {
  if (width < 160 || height < 120) return { present: false, maskRight: width };
  const colMean = new Float64Array(width);
  const y0 = Math.floor(height * 0.18);
  const y1 = Math.floor(height * 0.82);
  for (let x = Math.floor(width * 0.55); x < width; x++) {
    let s = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 2) {
      const i = (y * width + x) * 4;
      s += (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
      n++;
    }
    colMean[x] = n > 0 ? s / n : 0;
  }
  let bestX = -1;
  let bestJump = 0;
  for (let x = Math.floor(width * 0.68); x < Math.floor(width * 0.9); x++) {
    let L = 0;
    let nL = 0;
    let R = 0;
    let nR = 0;
    for (let dx = 1; dx <= 20; dx++) {
      L += colMean[x - dx] || 0;
      nL++;
    }
    for (let dx = 1; dx <= 48; dx++) {
      if (x + dx < width) {
        R += colMean[x + dx] || 0;
        nR++;
      }
    }
    const jump = (nR ? R / nR : 0) - (nL ? L / nL : 0);
    const rightBright = (nR ? R / nR : 0) > 120;
    if (jump > 45 && rightBright && jump > bestJump) {
      bestJump = jump;
      bestX = x;
    }
  }
  const present = bestX > 0 && bestJump > 45;
  // 右遮罩略縮入 HUD 左緣，避免溝峰吸到面板邊
  const maskRight = present
    ? Math.max(Math.floor(width * 0.62), bestX - 6)
    : width;
  return { present, maskRight };
}

function grayFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const g = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    g[i] = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
  }
  return g;
}

function fitLineBroadcast(
  ys: number[],
  xs: number[]
): { a: number; b: number } | null {
  const n = ys.length;
  if (n < 4) return null;
  const fit = (yy: number[], xx: number[]) => {
    const m = yy.length;
    let sy = 0,
      sx = 0,
      syy = 0,
      sxy = 0;
    for (let i = 0; i < m; i++) {
      sy += yy[i];
      sx += xx[i];
      syy += yy[i] * yy[i];
      sxy += yy[i] * xx[i];
    }
    const den = m * syy - sy * sy;
    if (Math.abs(den) < 1e-6) return null;
    const b = (m * sxy - sy * sx) / den;
    const a = (sx - b * sy) / m;
    return { a, b };
  };
  const first = fit(ys, xs);
  if (!first) return null;
  const res = ys.map((y, i) => Math.abs(xs[i] - (first.a + first.b * y)));
  const sorted = [...res].sort((a, b) => a - b);
  const thr = Math.max(6, (sorted[Math.floor(sorted.length / 2)] || 1) * 2.4);
  const iy: number[] = [];
  const ix: number[] = [];
  for (let i = 0; i < n; i++) {
    if (res[i] <= thr) {
      iy.push(ys[i]);
      ix.push(xs[i]);
    }
  }
  if (iy.length < 5) return first;
  return fit(iy, ix) ?? first;
}

/**
 * 廣播片：遮罩右欄 HUD 後，用溝側 |gx|＋暗 flank 擬合真球道（Corra 風格）。
 * 拒絕梯形伸入 Strike Track。
 */
export function detectLaneCornersBroadcast(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  maskRight: number
): LaneDetectResult | null {
  const gray = grayFromRgba(rgba, width, height);
  const pts: { y: number; l: number; r: number }[] = [];
  // 用 foul 帶「亮木＋兩側暗溝」估 mid（拒左廣告／鄰道亮帶）
  let woodMid = Math.min(width * 0.34, maskRight * 0.42);
  {
    const yWood = Math.floor(height * 0.64);
    let bestX = woodMid;
    let bestSc = -1e9;
    const x0 = Math.floor(width * 0.18);
    const x1 = Math.min(maskRight - 24, Math.floor(width * 0.55));
    const half = Math.floor(width * 0.11);
    const flank = Math.floor(width * 0.035);
    for (let x = x0; x < x1; x += 3) {
      let wood = 0;
      let nw = 0;
      for (let dx = -half + 4; dx <= half - 4; dx += 2) {
        const xx = x + dx;
        if (xx >= 0 && xx < maskRight) {
          wood += gray[yWood * width + xx];
          nw++;
        }
      }
      const woodM = nw > 0 ? wood / nw : 0;
      let dL = 0;
      let nL = 0;
      let dR = 0;
      let nR = 0;
      for (let k = 2; k <= flank; k++) {
        const xl = x - half - k;
        const xr = x + half + k;
        if (xl >= 0) {
          dL += gray[yWood * width + xl];
          nL++;
        }
        if (xr < maskRight) {
          dR += gray[yWood * width + xr];
          nR++;
        }
      }
      const darkL = nL ? dL / nL : 99;
      const darkR = nR ? dR / nR : 99;
      if (woodM < 50) continue;
      if (woodM - darkL < 14 || woodM - darkR < 10) continue;
      const sc =
        woodM +
        Math.min(50, woodM - darkL) * 0.6 +
        Math.min(50, woodM - darkR) * 0.5;
      if (sc > bestSc) {
        bestSc = sc;
        bestX = x;
      }
    }
    if (bestSc > 0) woodMid = bestX;
  }
  // 多 mid 種子（0.30/0.34/0.38/0.42）：PBA-01 同 PBA-10 中線差大，單種子會鎖錯簇
  const midSeeds = [
    clamp(woodMid, width * 0.28, width * 0.45),
    width * 0.3,
    width * 0.34,
    width * 0.38,
    width * 0.42,
  ];
  type Cand = { y: number; l: number; r: number; m: number; sc: number };
  const allCands: Cand[] = [];
  for (const mid0 of midSeeds) {
    let mid = mid0;
    for (let yf = 0.78; yf >= 0.32; yf -= 0.025) {
      const y = Math.round(yf * height);
      const expectW = width * clamp(0.14 + yf * 0.24, 0.2, 0.36);
      const xLo = Math.floor(width * 0.1);
      const xHi = Math.min(maskRight - 4, Math.floor(width * 0.72));
      if (xHi - xLo < 40) continue;
      const gx: number[] = [];
      for (let x = xLo + 1; x < xHi - 1; x++) {
        gx[x] = Math.abs(gray[y * width + x + 1] - gray[y * width + x - 1]);
      }
      let sum = 0;
      let n = 0;
      for (let x = xLo; x < xHi; x++) {
        sum += gx[x] || 0;
        n++;
      }
      const thr = Math.max(9, (n > 0 ? sum / n : 0) * 1.2);
      const Lcand: { x: number; sc: number }[] = [];
      const Rcand: { x: number; sc: number }[] = [];
      for (let x = xLo + 3; x < xHi - 3; x++) {
        const g = gx[x] || 0;
        if (g < thr) continue;
        if (g < (gx[x - 1] || 0) || g < (gx[x + 1] || 0)) continue;
        const toward = x < mid ? 1 : -1;
        let out = 0;
        let inn = 0;
        let no = 0;
        let ni = 0;
        for (let k = 2; k <= 16; k++) {
          const xo = x - toward * k;
          const xi = x + toward * k;
          if (xo >= 0 && xo < width) {
            out += gray[y * width + xo];
            no++;
          }
          if (xi >= 0 && xi < width) {
            inn += gray[y * width + xi];
            ni++;
          }
        }
        const flank = (ni ? inn / ni : 0) - (no ? out / no : 0);
        if (flank < 10) continue;
        const sc = g * 0.35 + flank;
        if (x < mid) Lcand.push({ x, sc });
        else Rcand.push({ x, sc });
      }
      if (!Lcand.length || !Rcand.length) continue;
      Lcand.sort((a, b) => b.sc - a.sc);
      Rcand.sort((a, b) => b.sc - a.sc);
      let best: Cand | null = null;
      let bs = -1e9;
      for (const L of Lcand.slice(0, 12)) {
        for (const R of Rcand.slice(0, 12)) {
          const ww = R.x - L.x;
          if (ww < expectW * 0.55 || ww > expectW * 1.55) continue;
          if (ww / width > 0.4 || ww / width < 0.18) continue;
          const m = (L.x + R.x) / 2;
          if (m < width * 0.26 || m > width * 0.48) continue;
          if (Math.abs(m - mid) > width * 0.16) continue;
          if (R.x > maskRight - 8) continue;
          if (L.x < width * 0.12) continue;
          let darkL = 0;
          let nDL = 0;
          let darkR = 0;
          let nDR = 0;
          for (let k = 3; k <= 14; k++) {
            const xl = L.x - k;
            const xr = R.x + k;
            if (xl >= 0) {
              darkL += gray[y * width + xl];
              nDL++;
            }
            if (xr < width && xr < maskRight) {
              darkR += gray[y * width + xr];
              nDR++;
            }
          }
          const dL = nDL ? darkL / nDL : 99;
          const dR = nDR ? darkR / nDR : 99;
          let wood = 0;
          let nw = 0;
          for (let x = L.x + 6; x < R.x - 6; x += 3) {
            wood += gray[y * width + x];
            nw++;
          }
          const woodM = nw > 0 ? wood / nw : 0;
          if (woodM < 40) continue;
          if (woodM - dL < 12 || woodM - dR < 5) continue;
          const wDiff = ww - expectW;
          const wPen = wDiff < 0 ? -wDiff * 0.2 : wDiff * 0.04;
          const gutterDark =
            Math.min(40, woodM - dL) * 0.45 + Math.min(35, woodM - dR) * 0.3;
          const sc =
            L.sc +
            R.sc -
            wPen +
            gutterDark +
            Math.min(20, ww * 0.04) +
            (woodM > 60 ? 8 : 0);
          if (sc > bs) {
            bs = sc;
            best = { y, l: L.x, r: R.x, m, sc };
          }
        }
      }
      if (!best) continue;
      allCands.push(best);
      mid = mid * 0.5 + best.m * 0.5;
    }
  }
  if (allCands.length < 8) return null;
  // 以 mid 聚類：優先單道寬 bot≈0.20–0.28、mid≈0.28–0.42（真溝）
  allCands.sort((a, b) => a.m - b.m);
  let bestCluster: Cand[] = [];
  let bestClusterSc = -1e9;
  for (let i = 0; i < allCands.length; i++) {
    const lo = allCands[i].m;
    const hi = lo + width * 0.055;
    const cluster = allCands.filter((c) => c.m >= lo && c.m <= hi);
    if (cluster.length < 5) continue;
    const med = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const medM = med(cluster.map((c) => c.m));
    const medW = med(cluster.map((c) => c.r - c.l));
    const botFrac = medW / width;
    const midFrac = medM / width;
    let geom = 0;
    if (botFrac >= 0.24 && botFrac <= 0.34) geom += 40;
    else if (botFrac >= 0.2 && botFrac <= 0.38) geom += 22;
    else if (botFrac >= 0.18 && botFrac <= 0.4) geom += 8;
    else geom -= 25;
    if (midFrac >= 0.28 && midFrac <= 0.42) geom += 30;
    else if (midFrac >= 0.26 && midFrac <= 0.46) geom += 12;
    else geom -= 20;
    const sc =
      cluster.reduce((s, c) => s + c.sc, 0) / cluster.length +
      cluster.length * 1.5 +
      geom;
    if (sc > bestClusterSc) {
      bestClusterSc = sc;
      bestCluster = cluster;
    }
  }
  const useCluster = bestCluster.length >= 5 ? bestCluster : allCands;
  // 每條 y 只留最高分
  const byY = new Map<number, Cand>();
  for (const c of useCluster) {
    const prev = byY.get(c.y);
    if (!prev || c.sc > prev.sc) byY.set(c.y, c);
  }
  for (const c of Array.from(byY.values())) pts.push({ y: c.y, l: c.l, r: c.r });
  if (pts.length < 6) return null;
  if (pts.length < 6) return null;

  // 剔左／右離群（記分牌邊、內油線）再擬合
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const medL = med(pts.map((p) => p.l));
  const medR = med(pts.map((p) => p.r));
  const mad = (xs: number[], m0: number) => {
    const d = xs.map((x) => Math.abs(x - m0)).sort((a, b) => a - b);
    return Math.max(8, d[Math.floor(d.length / 2)] || 8);
  };
  const madL = mad(pts.map((p) => p.l), medL);
  const madR = mad(pts.map((p) => p.r), medR);
  const inliers = pts.filter(
    (p) =>
      Math.abs(p.l - medL) <= madL * 2.8 &&
      Math.abs(p.r - medR) <= madR * 2.8 &&
      p.r - p.l >= width * 0.16
  );
  const usePts = inliers.length >= 5 ? inliers : pts;
  if (usePts.length < 5) return null;

  const ys = usePts.map((p) => p.y);
  const leftFit = fitLineBroadcast(ys, usePts.map((p) => p.l));
  const rightFit = fitLineBroadcast(ys, usePts.map((p) => p.r));
  if (!leftFit || !rightFit) return null;

  // 廣播 foul 通常喺 0.58–0.78（廣角後視）；>0.82 易落 approach 令外推縮窄
  let foulY = height * 0.68;
  let fe = -1;
  const foulX1 = Math.min(maskRight, Math.floor(width * 0.58));
  for (let y = Math.floor(height * 0.55); y < Math.floor(height * 0.8); y++) {
    let e = 0;
    for (let x = Math.floor(width * 0.14); x < foulX1; x += 2) {
      e += Math.abs(
        gray[Math.min(height - 2, y + 1) * width + x] -
          gray[Math.max(0, y - 1) * width + x]
      );
    }
    // 輕獎接近 pts 下沿
    const yBoost = y > height * 0.62 && y < height * 0.75 ? e * 0.08 : 0;
    if (e + yBoost > fe) {
      fe = e + yBoost;
      foulY = y;
    }
  }
  // 若有採樣點：foul 唔好低過最底 sample 太多
  if (pts.length) {
    const maxPy = Math.max(...pts.map((p) => p.y));
    foulY = clamp(foulY, height * 0.55, Math.min(height * 0.8, maxPy + height * 0.06));
  }
  // 頂邊要蓋晒成排樽：白點「多段短 run」＝樽列；一大舊亮帶＝廣告／overhead
  const xAt = (fit: { a: number; b: number }, y: number) => fit.a + fit.b * y;
  type PinRow = { y: number; wh: number; runs: number; sc: number; x0: number; x1: number };
  const pinRows: PinRow[] = [];
  for (let y = Math.floor(height * 0.16); y < Math.floor(height * 0.4); y++) {
    const lX = xAt(leftFit, y);
    const rX = xAt(rightFit, y);
    if (rX - lX < width * 0.06) continue;
    const x0 = Math.max(4, Math.floor(Math.min(lX, rX) + 2));
    const x1 = Math.min(maskRight - 4, Math.ceil(Math.max(lX, rX) - 2));
    if (x1 - x0 < 12) continue;
    let white = 0;
    let n = 0;
    let runs = 0;
    let inRun = false;
    let runW = 0;
    let maxRun = 0;
    for (let x = x0; x < x1; x++) {
      const g = gray[y * width + x];
      n++;
      if (g > 170) {
        white++;
        if (!inRun) {
          runs++;
          inRun = true;
          runW = 1;
        } else runW++;
      } else if (inRun) {
        maxRun = Math.max(maxRun, runW);
        inRun = false;
        runW = 0;
      }
    }
    if (inRun) maxRun = Math.max(maxRun, runW);
    if (n < 8) continue;
    const wh = white / n;
    if (wh < 0.05) continue;
    // 樽：多段 run（≥3）且單 run 唔好佔滿走廊；廣告：1–2 條好闊 run
    const fatBanner = maxRun > (x1 - x0) * 0.55 || (runs <= 2 && wh > 0.35);
    const overhead =
      y < height * 0.19 || (y < height * 0.23 && fatBanner);
    if (overhead || fatBanner) continue;
    // 下方要似木面（唔係廣告延續）：拒 overhead 記分牌白帶
    const yBelow = Math.min(height - 2, y + Math.floor(height * 0.05));
    let below = 0;
    let nb = 0;
    for (let x = x0; x < x1; x += 3) {
      below += gray[yBelow * width + x];
      nb++;
    }
    const belowM = nb > 0 ? below / nb : 0;
    if (belowM > 145) continue; // 下面仍然好亮 = 廣告／記分牌帶
    if (belowM < 35) continue;
    const runBonus = runs >= 3 ? Math.min(8, runs) * 12 : runs * 3;
    const sc =
      wh * 160 +
      runBonus +
      (belowM > 50 && belowM < 120 ? 25 : 0) -
      (y > height * 0.34 ? 30 : 0);
    pinRows.push({ y, wh, runs, sc, x0, x1 });
  }
  let pinY = height * 0.28;
  if (pinRows.length) {
    // 由上而下第一個高分白樽帶（蓋樽）；唔好跳去 mid-lane 反光
    pinRows.sort((a, b) => a.y - b.y);
    const strong = pinRows.filter((r) => r.runs >= 3 && r.wh >= 0.1);
    const pool = strong.length ? strong : pinRows;
    let best = pool[0];
    let bestSc = -1e9;
    // 喺最頂 40px 帶內攞最高分（樽頭～樽身），避免 overhead 已被 filter
    const y0 = pool[0].y;
    for (const r of pool) {
      if (r.y > y0 + height * 0.06) break;
      if (r.sc > bestSc) {
        bestSc = r.sc;
        best = r;
      }
    }
    // Prefer uppermost strong pin-head band; only drop if clearly a banner remnant
    let chosen = best;
    if (y0 < height * 0.17 && best.runs < 3) {
      const lower = pool.filter(
        (r) => r.y > y0 + height * 0.03 && r.runs >= 3 && r.sc >= best.sc * 0.5
      );
      if (lower.length) {
        lower.sort((a, b) => a.y - b.y);
        chosen = lower[0];
      }
    }
    // Prefer pin HEADS (slightly above strong white band), not necks / mid bodies
    pinY = clamp(chosen.y - height * 0.015, height * 0.16, height * 0.3);
  } else {
    // fallback：走廊內白點最多嘅 y（仍拒過頂）
    let pe = -1e9;
    for (let y = Math.floor(height * 0.18); y < Math.floor(height * 0.34); y++) {
      const lX = xAt(leftFit, y);
      const rX = xAt(rightFit, y);
      const x0 = Math.max(4, Math.floor(lX + 2));
      const x1 = Math.min(maskRight - 4, Math.ceil(rX - 2));
      if (x1 - x0 < 12) continue;
      let white = 0;
      let n = 0;
      for (let x = x0; x < x1; x += 2) {
        if (gray[y * width + x] > 170) white++;
        n++;
      }
      const sc = (n ? white / n : 0) * 100;
      if (sc > pe) {
        pe = sc;
        pinY = y;
      }
    }
  }
  pinY = clamp(pinY, height * 0.16, height * 0.3);

  let tl = clampPt({ x: xAt(leftFit, pinY), y: pinY }, width, height);
  let tr = clampPt({ x: xAt(rightFit, pinY), y: pinY }, width, height);
  let bl = clampPt({ x: xAt(leftFit, foulY), y: foulY }, width, height);
  let br = clampPt({ x: xAt(rightFit, foulY), y: foulY }, width, height);

  // foul 列外推後再向外 snap 真溝（內油線 → 外溝）
  {
    const y = Math.round(foulY);
    const snapSide = (guess: number, side: -1 | 1) => {
      let bestX = guess;
      let bestSc = -1e9;
      const lo = side < 0 ? Math.max(width * 0.1, guess - width * 0.08) : guess - width * 0.03;
      const hi =
        side < 0
          ? guess + width * 0.03
          : Math.min(maskRight - 6, guess + width * 0.1);
      for (let x = Math.floor(lo); x <= Math.floor(hi); x++) {
        const g = Math.abs(
          gray[y * width + Math.min(width - 1, x + 1)] -
            gray[y * width + Math.max(0, x - 1)]
        );
        let out = 0;
        let inn = 0;
        let no = 0;
        let ni = 0;
        for (let k = 2; k <= 14; k++) {
          const xo = x + side * k; // side -1: outside left
          const xi = x - side * k;
          if (xo >= 0 && xo < width) {
            out += gray[y * width + xo];
            no++;
          }
          if (xi >= 0 && xi < width) {
            inn += gray[y * width + xi];
            ni++;
          }
        }
        const flank = (ni ? inn / ni : 0) - (no ? out / no : 0);
        if (flank < 8) continue;
        // 偏外加分
        const outer = side < 0 ? guess - x : x - guess;
        const sc = g * 0.4 + flank + Math.max(0, outer) * 0.15;
        if (sc > bestSc) {
          bestSc = sc;
          bestX = x;
        }
      }
      return bestX;
    };
    const newL = snapSide(bl.x, -1);
    const newR = snapSide(br.x, 1);
    const ww = newR - newL;
    if (ww >= width * 0.16 && ww <= width * 0.36 && newR < maskRight - 4) {
      // 同步按斜率平移頂角
      const dL = newL - bl.x;
      const dR = newR - br.x;
      bl = { ...bl, x: newL };
      br = { ...br, x: newR };
      tl = { ...tl, x: tl.x + dL * 0.7 };
      tr = { ...tr, x: tr.x + dR * 0.7 };
    }
  }

  // 頂邊蓋樽：透視頂寬 ≈ bot×0.80–0.90，頂 mid 略右偏（廣播機位）
  {
    const botW0 = Math.max(1, br.x - bl.x);
    const foulMid = (bl.x + br.x) / 2;
    const targetTopW = clamp(botW0 * 0.84, botW0 * 0.72, botW0 * 0.92);
    const skew = clamp((maskRight * 0.5 - foulMid) * 0.4, 0, width * 0.12);
    const topMid = clamp(foulMid + skew, width * 0.3, maskRight * 0.6);
    const half = targetTopW / 2;
    tl = { ...tl, x: topMid - half };
    tr = { ...tr, x: Math.min(topMid + half, maskRight - 4) };
  }
  // 硬拒 HUD 區
  const capX = maskRight - 2;
  bl = { ...bl, x: Math.min(bl.x, capX) };
  br = { ...br, x: Math.min(br.x, capX) };
  tl = { ...tl, x: Math.min(tl.x, capX) };
  tr = { ...tr, x: Math.min(tr.x, capX) };
  if (tl.x > tr.x) {
    const t = tl.x;
    tl = { ...tl, x: tr.x };
    tr = { ...tr, x: t };
  }
  if (bl.x > br.x) {
    const t = bl.x;
    bl = { ...bl, x: br.x };
    br = { ...br, x: t };
  }

  const botW = br.x - bl.x;
  let topW = tr.x - tl.x;
  // 拒薄楔（<16%）同過闊（鄰道／HUD）
  if (botW < width * 0.16 || botW > width * 0.4 || topW < width * 0.06) {
    return null;
  }
  if (br.x > maskRight || tr.x > maskRight) return null;
  // 梯形要似球道：底寬於頂、中線唔好飛去右欄／左記分牌
  const midBot = (bl.x + br.x) / 2;
  let midTop = (tl.x + tr.x) / 2;
  if (midBot / width > 0.5 || midBot / width < 0.24) return null;
  // 頂中線偏離：只輕推，保留外推溝（唔好收成中楔）
  if (Math.abs(midTop - midBot) / width > 0.14) {
    const half = Math.max(topW / 2, botW * 0.28);
    tl = { ...tl, x: midBot - half };
    tr = { ...tr, x: midBot + half };
    topW = tr.x - tl.x;
    midTop = midBot;
  }
  // 頂過尖／過闊：PBA 廣角後視 top/bot 可到 ~0.85；舊 0.7 上限會壓成窄楔
  {
    const tw = tr.x - tl.x;
    const ratio = tw / Math.max(1, botW);
    if (ratio < 0.32 || ratio > 0.92) {
      const target = clamp(ratio < 0.32 ? 0.45 : 0.78, 0.4, 0.85);
      const half = (botW * target) / 2;
      const m = (bl.x + br.x) / 2;
      tl = { ...tl, x: m - half };
      tr = { ...tr, x: m + half };
    }
  }
  if (botW <= tr.x - tl.x + 1) return null;

  let confidence = 0.42 + Math.min(0.28, pts.length * 0.012);
  if (br.x < maskRight * 0.92) confidence += 0.08;
  // 貼近真溝寬／中線加分
  if (botW / width >= 0.18 && botW / width <= 0.32) confidence += 0.06;
  if (midBot / width >= 0.3 && midBot / width <= 0.45) confidence += 0.04;
  confidence = clamp(confidence, 0.35, 0.85);

  return {
    corners: { tl, tr, br, bl },
    confidence,
    message: `廣播球道（遮罩右欄 HUD，底寬${((botW / width) * 100).toFixed(0)}%）`,
    broadcastHud: true,
  };
}

/** 已係廣播／左偏單道幾何 → 唔好再用 demo hard-snap 蓋掉 */
export function looksLikeBroadcastLane(
  corners: LaneCorners,
  width: number
): boolean {
  const botW = corners.br.x - corners.bl.x;
  const botFrac = botW / Math.max(1, width);
  const midBot = (corners.bl.x + corners.br.x) / 2 / Math.max(1, width);
  const brFrac = corners.br.x / Math.max(1, width);
  return (
    botFrac >= 0.15 &&
    botFrac <= 0.4 &&
    midBot >= 0.24 &&
    midBot <= 0.48 &&
    brFrac <= 0.62
  );
}

/** 四角坐喺右欄 HUD／記分牌矩形上 */
export function cornersHitBroadcastHud(
  corners: LaneCorners,
  width: number,
  height: number,
  maskRight?: number
): boolean {
  const pinY = (corners.tl.y + corners.tr.y) / 2;
  const topW = corners.tr.x - corners.tl.x;
  const brFrac = corners.br.x / Math.max(1, width);
  const trFrac = corners.tr.x / Math.max(1, width);

  // 無明確 HUD 遮罩：只罰極端右欄（demo snap BR≈0.756 唔好誤殺）
  if (maskRight == null || maskRight >= width * 0.95) {
    if (brFrac > 0.85 || trFrac > 0.88) return true;
    if (
      pinY < height * 0.1 &&
      topW / width > 0.28 &&
      trFrac > 0.72
    ) {
      return true;
    }
    return false;
  }

  const mr = maskRight;
  const inHud = (p: Point2D) => p.x >= mr - width * 0.02;
  if (inHud(corners.br) || inHud(corners.tr)) return true;
  if (corners.br.x > mr && corners.bl.x < width * 0.45) return true;
  if (pinY < height * 0.12 && topW / width > 0.2 && corners.tr.x > width * 0.62) {
    return true;
  }
  return false;
}

/**
 * Broadcast lane-mask overlay (PBA-10 style): synthetic mid-lane trapezoid graphic
 * burned into the video — NOT Strike Track side panel, NOT true gutters.
 * Signals: weak dark-outside gutters, no pin-head whites near top, short floating
 * extent / cuts bowler. Prefer fail→manual over locking the overlay.
 */
export function isLaneMaskOverlay(
  corners: LaneCorners,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  maskRight: number = width
): boolean {
  if (width < 80 || height < 80 || rgba.length < width * height * 4) return false;
  const botW = corners.br.x - corners.bl.x;
  const topW = corners.tr.x - corners.tl.x;
  const botFrac = botW / Math.max(1, width);
  const taper = topW / Math.max(1e-3, botW);
  const pinY = (corners.tl.y + corners.tr.y) / 2;
  const foulY = (corners.bl.y + corners.br.y) / 2;
  const extent = (foulY - pinY) / Math.max(1, height);
  const mr = Math.min(width - 1, Math.max(8, maskRight));

  // Sample gray flanks along L/R edges: true gutter = outside darker than inside
  let flankOk = 0;
  let flankBad = 0;
  let bowlerCut = 0;
  for (const t of [0.2, 0.45, 0.7]) {
    const y = Math.round(pinY + (foulY - pinY) * t);
    if (y < 2 || y >= height - 2) continue;
    const xL = corners.tl.x + (corners.bl.x - corners.tl.x) * t;
    const xR = corners.tr.x + (corners.br.x - corners.tr.x) * t;
    const sampleFlank = (x: number, side: -1 | 1) => {
      const xi = Math.round(x);
      if (xi < 6 || xi >= mr - 6) return { flank: 0, out: 0, inn: 0 };
      let out = 0,
        inn = 0,
        no = 0,
        ni = 0;
      for (let k = 3; k <= 18; k++) {
        const xo = Math.round(xi + side * k);
        const xii = Math.round(xi - side * k);
        if (xo >= 0 && xo < mr) {
          const o = (y * width + xo) * 4;
          out += (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
          no++;
        }
        if (xii >= 0 && xii < mr) {
          const o = (y * width + xii) * 4;
          inn += (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
          ni++;
        }
      }
      const outM = no ? out / no : 0;
      const innM = ni ? inn / ni : 0;
      return { flank: innM - outM, out: outM, inn: innM };
    };
    const L = sampleFlank(xL, -1);
    const R = sampleFlank(xR, 1);
    if (L.flank > 18) flankOk++;
    else if (L.flank < 8) flankBad++;
    if (R.flank > 18) flankOk++;
    else if (R.flank < 8) flankBad++;

    // Bowler cut: left edge through saturated / bright non-wood mid torso band
    if (t >= 0.35 && t <= 0.75 && botFrac < 0.36) {
      const xi = Math.round(xL);
      if (xi >= 2 && xi < mr - 2) {
        const o = (y * width + xi) * 4;
        const r = rgba[o],
          g = rgba[o + 1],
          b = rgba[o + 2];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const warmWood = r >= g - 8 && r >= b && g >= b - 20 && sat <= 0.55;
        // jersey / skin / bright clothing — not lane wood
        if (max > 90 && !warmWood && (sat > 0.28 || (g > r + 15 && g > b))) {
          bowlerCut++;
        }
      }
    }
  }

  // Pin-head whites near top corridor
  let pinRuns = 0;
  let pinWhite = 0;
  let pinN = 0;
  const y0 = Math.max(2, Math.floor(pinY - height * 0.03));
  const y1 = Math.min(height - 2, Math.ceil(pinY + height * 0.05));
  for (let y = y0; y < y1; y += 2) {
    const tt = (y - pinY) / Math.max(1e-3, foulY - pinY);
    const xL = corners.tl.x + (corners.bl.x - corners.tl.x) * Math.max(0, Math.min(1, tt));
    const xR = corners.tr.x + (corners.br.x - corners.tr.x) * Math.max(0, Math.min(1, tt));
    const xa = Math.max(2, Math.floor(Math.min(xL, xR) + 2));
    const xb = Math.min(mr - 2, Math.ceil(Math.max(xL, xR) - 2));
    if (xb - xa < 10) continue;
    let inRun = false;
    for (let x = xa; x < xb; x += 2) {
      const o = (y * width + x) * 4;
      const g = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
      pinN++;
      if (g > 175) {
        pinWhite++;
        if (!inRun) {
          pinRuns++;
          inRun = true;
        }
      } else inRun = false;
    }
  }
  const pinFrac = pinN ? pinWhite / pinN : 0;
  const hasPins = pinRuns >= 4 && pinFrac >= 0.06;

  // True pins often sit ABOVE a mid-lane mask top — search wider corridor above TL/TR
  let pinsAbove = 0;
  const yA0 = Math.max(2, Math.floor(height * 0.12));
  const yA1 = Math.max(yA0 + 4, Math.floor(pinY - height * 0.02));
  const midTop = (corners.tl.x + corners.tr.x) / 2;
  for (let y = yA0; y < yA1; y += 2) {
    const xa = Math.max(2, Math.floor(midTop - width * 0.18));
    const xb = Math.min(mr - 2, Math.ceil(midTop + width * 0.18));
    let runs = 0;
    let inn = false;
    let wh = 0;
    let n = 0;
    for (let x = xa; x < xb; x += 2) {
      const o = (y * width + x) * 4;
      const g = (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
      n++;
      if (g > 175) {
        wh++;
        if (!inn) {
          runs++;
          inn = true;
        }
      } else inn = false;
    }
    if (n > 20 && runs >= 3 && wh / n >= 0.05) pinsAbove++;
  }
  const pinsAboveTop = pinsAbove >= 2;

  const midBotF = (corners.bl.x + corners.br.x) / 2 / width;
  const midTopF = (corners.tl.x + corners.tr.x) / 2 / width;
  const midSkew = Math.abs(midTopF - midBotF);

  // Inset: dark gutter exists clearly outside claimed L/R at mid height
  let insetGutter = 0;
  {
    const y = Math.round((pinY + foulY) / 2);
    const xL = (corners.tl.x + corners.bl.x) / 2;
    const xR = (corners.tr.x + corners.br.x) / 2;
    const gAt = (x: number) => {
      const xi = Math.round(x);
      if (xi < 0 || xi >= mr) return 255;
      const o = (y * width + xi) * 4;
      return (rgba[o] * 77 + rgba[o + 1] * 150 + rgba[o + 2] * 29) >> 8;
    };
    // look further outside for darker channel
    let darkL = 0,
      nL = 0,
      darkR = 0,
      nR = 0;
    for (let k = 20; k <= Math.floor(width * 0.1); k += 4) {
      darkL += gAt(xL - k);
      nL++;
      darkR += gAt(xR + k);
      nR++;
    }
    const outL = nL ? darkL / nL : 255;
    const outR = nR ? darkR / nR : 255;
    const inL = gAt(xL + 10);
    const inR = gAt(xR - 10);
    if (outL + 25 < inL && outL < 70) insetGutter++;
    if (outR + 25 < inR && outR < 70) insetGutter++;
  }

  let hits = 0;
  // Classic PBA lane-mask: narrow–mid bot, fat taper, weak / inverted gutters
  if (botFrac >= 0.16 && botFrac <= 0.36 && taper >= 0.55 && flankBad >= flankOk) {
    hits += 2;
  }
  // Near-parallel / soft-perspective overlay wedge
  if (botFrac < 0.32 && taper > 0.7) hits += 2;
  if (botFrac < 0.3 && taper > 0.55 && taper < 0.7 && midSkew > 0.1) hits += 2;
  // Floating short wedge
  if (extent < 0.36 && taper > 0.65 && botFrac < 0.34) hits += 2;
  // Claimed top misses real pin row (pins sit above)
  if (pinsAboveTop) hits += 2;
  // No pin heads at claimed top
  if (!hasPins && pinY > height * 0.2 && pinY < height * 0.36) hits += 1;
  if (bowlerCut >= 1) hits += 2;
  // Gutters clearly wrong
  if (flankBad >= flankOk + 1 && botFrac < 0.38) hits += 2;
  if (flankOk === 0 && flankBad >= 2 && botFrac < 0.38) hits += 1;
  // Huge top/bot mid skew on narrow bot = mask / wrong lane
  if (midSkew > 0.12 && botFrac < 0.35) hits += 2;
  // True gutters sit outside claimed edges
  if (insetGutter >= 1 && botFrac < 0.36) hits += 2;
  // Geometric mid-wedge (no rgba): left not outer / mid bot / top short
  const leftFrac = corners.bl.x / width;
  if (botFrac < 0.38 && leftFrac > 0.24 && midBotF > 0.36) hits += 2;
  if (botFrac < 0.36 && midBotF > 0.4) hits += 2;
  if (pinY > height * 0.22 && extent < 0.52 && botFrac < 0.38 && leftFrac > 0.22)
    hits += 2;

  return hits >= 3;
}

/**
 * Pure-geometry mid-lane narrow wedge (PBA-10 style) — NO rgba required.
 * Cuts bowler / left not on outer lip / top short of pins / mid bot.
 * Prefer fail→manual even when isLaneMaskOverlay is false.
 */
export function isNarrowMidLaneWedge(
  corners: LaneCorners,
  width: number,
  height: number
): boolean {
  const botW = corners.br.x - corners.bl.x;
  const topW = corners.tr.x - corners.tl.x;
  const botFrac = botW / Math.max(1, width);
  const midBot = (corners.bl.x + corners.br.x) / 2 / Math.max(1, width);
  const midTop = (corners.tl.x + corners.tr.x) / 2 / Math.max(1, width);
  const pinY = (corners.tl.y + corners.tr.y) / 2 / Math.max(1, height);
  const foulY = (corners.bl.y + corners.br.y) / 2 / Math.max(1, height);
  const extent = foulY - pinY;
  const taper = topW / Math.max(1e-3, botW);
  const leftFrac = corners.bl.x / Math.max(1, width);
  const tlFrac = corners.tl.x / Math.max(1, width);
  const brFrac = corners.br.x / Math.max(1, width);

  let hits = 0;
  // Narrow + mid-centered bot
  if (botFrac < 0.36 && midBot > 0.4) hits += 2;
  if (botFrac < 0.38 && leftFrac > 0.18 && midBot > 0.36) hits += 2;
  // Left edge not on outer lip (true PBA left foul lip often ≤0.18)
  if (botFrac < 0.42 && leftFrac > 0.22) hits += 2;
  if (botFrac < 0.4 && leftFrac > 0.18 && midBot > 0.34) hits += 1;
  // TL also inset
  if (botFrac < 0.4 && tlFrac > 0.28) hits += 1;
  // Top short of pin heads
  if (pinY > 0.2 && pinY < 0.42 && extent < 0.55 && botFrac < 0.4) hits += 2;
  // Soft / near-parallel taper on mid-width bot (not true vanishing gutters)
  if (botFrac < 0.42 && taper > 0.78) hits += 2;
  if (botFrac < 0.36 && taper > 0.68) hits += 1;
  if (extent < 0.36 && taper > 0.65 && botFrac < 0.34) hits += 2;
  // Asymmetric: BR near right, BL mid-lane
  if (brFrac > 0.52 && leftFrac > 0.2 && botFrac < 0.42) hits += 2;
  // Strong mid skew on narrow bot
  if (Math.abs(midTop - midBot) > 0.12 && botFrac < 0.38) hits += 1;

  return hits >= 3;
}

/**
 * Geometry snap — Hough / gutter-fit refine (NO green/red UI paint lock).
 * Broadcast HUD frames: keep broadcast fit; never demo hard-snap onto Strike Track.
 * General lanes: refine L/R from |gx|+flank along perspective; foul/pins from votes.
 */
export function snapCornersToTrueGutter(
  corners: LaneCorners,
  width: number,
  height: number,
  gray?: Uint8ClampedArray,
  sw?: number,
  sh?: number,
  scale?: number,
  rgba?: Uint8ClampedArray
): LaneCorners {
  // PBA Strike Track：保留廣播擬合／拒絕再蓋 demo 校準（否則 BR 坐 HUD）
  // BUT reject broadcast lane-mask mid-wedges (PBA-10) — fall through / keep input only if clean
  if (looksLikeBroadcastLane(corners, width)) {
    if (isNarrowMidLaneWedge(corners, width, height)) {
      // Mid-wedge: do not preserve — fall through to replace / caller null
    } else if (
      !rgba ||
      rgba.length < width * height * 4 ||
      !isLaneMaskOverlay(corners, rgba, width, height)
    ) {
      return corners;
    }
    // lane-mask lock: try to replace below; if nothing better, keep (caller may null)
  }
  if (rgba && rgba.length >= width * height * 4) {
    const hud = detectBroadcastHud(rgba, width, height);
    if (hud.present) {
      const bcast = detectLaneCornersBroadcast(
        rgba,
        width,
        height,
        hud.maskRight
      );
      if (
        bcast &&
        !cornersHitBroadcastHud(bcast.corners, width, height, hud.maskRight) &&
        !isLaneMaskOverlay(bcast.corners, rgba, width, height, hud.maskRight) &&
        !isNarrowMidLaneWedge(bcast.corners, width, height)
      ) {
        return bcast.corners;
      }
      if (
        !cornersHitBroadcastHud(corners, width, height, hud.maskRight) &&
        !isLaneMaskOverlay(corners, rgba, width, height, hud.maskRight) &&
        !isNarrowMidLaneWedge(corners, width, height)
      ) {
        return corners;
      }
      // Prefer Hough under HUD mask (still reject lane-mask geometry)
      const houghHud = detectLaneCornersHough(
        rgba,
        width,
        height,
        hud.maskRight,
        { broadcastHint: true }
      );
      if (
        houghHud &&
        !cornersHitBroadcastHud(houghHud.corners, width, height, hud.maskRight) &&
        !isLaneMaskOverlay(houghHud.corners, rgba, width, height, hud.maskRight) &&
        !isNarrowMidLaneWedge(houghHud.corners, width, height)
      ) {
        return houghHud.corners;
      }
      // Prefer fail→manual over returning mid-wedge
      if (isNarrowMidLaneWedge(corners, width, height)) {
        return corners; // caller should null; keep shape only if no better
      }
      return corners;
    }
  }

  // If input already Hough-ish, keep going to gray refine below (don't re-accept raw).

  const s = scale ?? Math.min(1, 320 / width);
  const sw0 = sw ?? Math.max(40, Math.round(width * s));
  const sh0 = sh ?? Math.max(40, Math.round(height * s));
  const inv = 1 / s;
  // r7: prefer foul band ~0.885–0.90 (was floor 0.86 / prior Hough ≤0.88 → float above foul)
  const foulY = clamp(
    Math.max(corners.bl.y * s, corners.br.y * s, sh0 * 0.885),
    sh0 * 0.885,
    sh0 * 0.905
  );
  const pinTarget = clamp(
    ((corners.tl.y + corners.tr.y) / 2) * s,
    sh0 * 0.092,
    sh0 * 0.102
  );

  // If input already looks like true outer gutters, keep L/R and only fix pin mid.
  // Do NOT inset a good Hough left edge via fitSingleLaneGutters (prior FAIL).
  {
    const botW0 = corners.br.x - corners.bl.x;
    const mid0 = (corners.bl.x + corners.br.x) / 2 / width;
    const botFrac0 = botW0 / width;
    const pinY0 = (corners.tl.y + corners.tr.y) / 2;
    const outerGood =
      botFrac0 >= 0.5 &&
      botFrac0 <= 0.66 &&
      mid0 >= 0.44 &&
      mid0 <= 0.54 &&
      pinY0 >= height * 0.078 &&
      pinY0 <= height * 0.12;
    if (outerGood) {
      const midF = (corners.bl.x + corners.br.x) / 2;
      const botW = botW0;
      const skewTarget = midF + width * 0.12;
      // Manual / no-image: keep corners unchanged (idempotent keptEqual)
      if (!gray && !rgba) {
        return corners;
      }
      // Foul-anchor from BL/BR. r6: drop TL nudge; taper~0.21 / skew~0.12·W.
      // r7: snap BL/BR Y onto foul band (~0.885–0.90) and extrapolate lip X to that Y
      // (prior kept inset X from a higher/narrower row → BL ~24px right of green).
      const topW = botW * 0.21;
      const midP = clamp(skewTarget, width * 0.52, width * 0.68);
      const py = clamp(Math.max(pinY0, height * 0.094), height * 0.094, height * 0.100);
      const fy = clamp(
        Math.max((corners.bl.y + corners.br.y) / 2, height * 0.885),
        height * 0.885,
        height * 0.900
      );
      const xAtY = (
        top: { x: number; y: number },
        bot: { x: number; y: number },
        y: number
      ) => {
        const dy = bot.y - top.y;
        if (Math.abs(dy) < 1e-3) return bot.x;
        return top.x + ((bot.x - top.x) * (y - top.y)) / dy;
      };
      const blX = xAtY(corners.tl, corners.bl, fy);
      const brX = xAtY(corners.tr, corners.br, fy);
      let tlX = midP - topW / 2;
      const trX = midP + topW / 2;
      if (tlX >= trX - width * 0.08) tlX = trX - width * 0.08;
      return {
        tl: clampPt({ x: tlX, y: py }, width, height),
        tr: clampPt({ x: trX, y: py }, width, height),
        br: clampPt({ x: brX, y: fy }, width, height),
        bl: clampPt({ x: blX, y: fy }, width, height),
      };
    }
  }

  // Geometry fit from gray (no hardcoded paint coords) — prefer OUTER gutters
  if (gray && gray.length >= sw0 * sh0) {
    const seedMid = ((corners.bl.x + corners.br.x) / 2) * s;
    const fit = fitSingleLaneGutters(gray, sw0, sh0, seedMid);
    if (fit) {
      const xAt = (side: "l" | "r", y: number) =>
        side === "l" ? fit.la + fit.lb * y : fit.ra + fit.rb * y;
      let fBL = xAt("l", foulY);
      let fBR = xAt("r", foulY);
      let botW = fBR - fBL;
      let midF = (fBL + fBR) / 2;
      // Only shrink clearly two-lane (>0.68); keep true gutters ~0.50–0.64
      if (botW > sw0 * 0.68) {
        const target = sw0 * 0.56;
        const shrink = (botW - target) * 0.45;
        fBL += shrink / 2;
        fBR -= shrink / 2;
        botW = fBR - fBL;
        midF = (fBL + fBR) / 2;
      }
      let fTL = xAt("l", pinTarget);
      let fTR = xAt("r", pinTarget);
      let topW = fTR - fTL;
      let midP = (fTL + fTR) / 2;
      const taper = topW / Math.max(1e-3, botW);
      if (taper < 0.18 || taper > 0.32 || !Number.isFinite(topW)) {
        topW = botW * 0.21;
        const skewTarget = midF + sw0 * 0.12;
        midP = clamp(skewTarget, sw0 * 0.50, sw0 * 0.68);
        fTL = midP - topW / 2;
        fTR = midP + topW / 2;
      } else {
        const skewTarget = midF + sw0 * 0.12;
        midP = clamp(midP * 0.4 + skewTarget * 0.6, sw0 * 0.50, sw0 * 0.68);
        topW = clamp(topW, botW * 0.18, botW * 0.28);
        fTL = midP - topW / 2;
        fTR = midP + topW / 2;
      }
      const midFrac = midF / sw0;
      if (
        botW >= sw0 * 0.48 &&
        botW <= sw0 * 0.68 &&
        midFrac >= 0.42 &&
        midFrac <= 0.56 &&
        fTL < fTR
      ) {
        // r6: geometric lips only (no TL-only nudge — r5 +0.02·W overshot)
        let tlOut = fTL * inv;
        const trOut = fTR * inv;
        if (tlOut >= trOut - width * 0.08) tlOut = trOut - width * 0.08;
        return {
          tl: clampPt({ x: tlOut, y: pinTarget * inv }, width, height),
          tr: clampPt({ x: trOut, y: pinTarget * inv }, width, height),
          br: clampPt({ x: fBR * inv, y: foulY * inv }, width, height),
          bl: clampPt({ x: fBL * inv, y: foulY * inv }, width, height),
        };
      }
    }
  }

  // Keep input corners (manual / prior auto) — no paint hard-snap
  return corners;
}

export function detectLaneCorners(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): LaneDetectResult | null {
  if (width < 80 || height < 80) return null;
  if (!frameHasLaneSignal(rgba, width, height)) return null;

  // PBA Strike Track：優先廣播路徑（遮罩右欄＋真溝），拒絕 HUD 矩形
  const hud = detectBroadcastHud(rgba, width, height);
  if (hud.present) {
    const masks = [
      hud.maskRight,
      Math.min(width - 2, hud.maskRight + Math.floor(width * 0.03)),
      Math.max(Math.floor(width * 0.62), hud.maskRight - Math.floor(width * 0.04)),
      Math.floor(width * 0.78),
    ];
    let bcast: LaneDetectResult | null = null;
    const scoreB = (c: LaneCorners) => {
      const bot = (c.br.x - c.bl.x) / width;
      const top = (c.tr.x - c.tl.x) / width;
      const pinY = (c.tl.y + c.tr.y) / 2 / height;
      const foulY = (c.bl.y + c.br.y) / 2 / height;
      const mid = (c.bl.x + c.br.x) / 2 / width;
      const taper = top / Math.max(1e-3, bot);
      const extent = foulY - pinY;
      let sc = 0;
      // Prefer true gutters covering pin row — NOT mid-lane broadcast mask wedges
      if (bot >= 0.26 && bot <= 0.38) sc += 35;
      else if (bot >= 0.22 && bot <= 0.42) sc += 18;
      else sc -= 25;
      if (pinY >= 0.16 && pinY <= 0.28) sc += 50;
      else if (pinY >= 0.28 && pinY <= 0.34) sc += 15; // often mask / mid
      else if (pinY < 0.14) sc -= 80; // scoreboard lock
      else sc -= 10;
      // True perspective taper often 0.45–0.85; near-parallel + short = mask
      if (taper >= 0.45 && taper <= 0.85) sc += 25;
      else if (taper > 0.85 && taper <= 0.98) sc += 5;
      else if (taper >= 0.35 && taper < 0.45) sc += 10;
      else sc -= 20;
      if (extent >= 0.38) sc += 35;
      else if (extent >= 0.32) sc += 10;
      else sc -= 45; // floating mid-wedge
      if (top >= 0.14) sc += 15;
      else if (top < 0.1) sc -= 30;
      if (mid >= 0.28 && mid <= 0.45) sc += 12;
      const midTop = (c.tl.x + c.tr.x) / 2 / width;
      const midSkew = Math.abs(midTop - mid);
      // Huge top/bot mid skew = wrong L/R (HUD / neighbor), not true gutters
      if (midSkew > 0.14) sc -= 60;
      else if (midSkew > 0.1) sc -= 25;
      if (c.tr.x / width > 0.62) sc -= 40; // TR creeping into Strike Track
      if (isLaneMaskOverlay(c, rgba, width, height, hud.maskRight)) sc -= 120;
      if (isNarrowMidLaneWedge(c, width, height)) sc -= 140;
      // Near-parallel broadcast trap = not true gutters→pins
      if (taper > 0.8 && bot < 0.42) sc -= 50;
      return sc;
    };
    const accept = (det: LaneDetectResult | null, mr: number) => {
      if (!det) return null;
      if (cornersHitBroadcastHud(det.corners, width, height, mr)) return null;
      if (isLaneMaskOverlay(det.corners, rgba, width, height, mr)) return null;
      if (isNarrowMidLaneWedge(det.corners, width, height)) return null;
      return det;
    };
    for (const mr of masks) {
      const houghB = accept(
        detectLaneCornersHough(rgba, width, height, mr, {
          broadcastHint: true,
        }),
        mr
      );
      const cand = accept(
        detectLaneCornersBroadcast(rgba, width, height, mr),
        mr
      );
      const pool: LaneDetectResult[] = [];
      if (houghB) pool.push({ ...houghB, broadcastHud: true });
      if (cand) pool.push(cand);
      if (pool.length) {
        pool.sort((a, b) => scoreB(b.corners) - scoreB(a.corners));
        const best = pool[0];
        const pinY = (best.corners.tl.y + best.corners.tr.y) / 2 / height;
        const bot = (best.corners.br.x - best.corners.bl.x) / width;
        const top = (best.corners.tr.x - best.corners.tl.x) / width;
        const foulY = (best.corners.bl.y + best.corners.br.y) / 2 / height;
        const extent = foulY - pinY;
        const tapB =
          (best.corners.tr.x - best.corners.tl.x) /
          Math.max(1e-3, best.corners.br.x - best.corners.bl.x);
        const midTopB =
          (best.corners.tl.x + best.corners.tr.x) / 2 / width;
        const midBotB =
          (best.corners.bl.x + best.corners.br.x) / 2 / width;
        const skewOk = Math.abs(midTopB - midBotB) <= 0.12;
        const trOk = best.corners.tr.x / width <= 0.62;
        if (
          pinY >= 0.16 &&
          bot >= 0.2 &&
          top >= 0.1 &&
          extent >= 0.32 &&
          tapB <= 0.8 &&
          skewOk &&
          trOk &&
          scoreB(best.corners) > 30 &&
          !isNarrowMidLaneWedge(best.corners, width, height)
        ) {
          bcast = best;
          break;
        }
        if (
          !bcast &&
          scoreB(best.corners) > 40 &&
          tapB <= 0.8 &&
          skewOk &&
          trOk &&
          !isNarrowMidLaneWedge(best.corners, width, height)
        )
          bcast = best;
      }
    }
    if (
      bcast &&
      !cornersHitBroadcastHud(bcast.corners, width, height, hud.maskRight) &&
      !isLaneMaskOverlay(bcast.corners, rgba, width, height, hud.maskRight) &&
      !isNarrowMidLaneWedge(bcast.corners, width, height)
    ) {
      return bcast;
    }
    const corraHud = detectLaneCornersCorra(rgba, width, height);
    if (
      corraHud &&
      looksLikeBroadcastLane(corraHud.corners, width) &&
      !cornersHitBroadcastHud(corraHud.corners, width, height, hud.maskRight) &&
      !isLaneMaskOverlay(corraHud.corners, rgba, width, height, hud.maskRight) &&
      !isNarrowMidLaneWedge(corraHud.corners, width, height)
    ) {
      return { ...corraHud, broadcastHud: true };
    }
    // Prefer clean reject → manual over locking broadcast lane-mask / mid-wedge
    return null;
  }

  // Primary: Hough L/R + geometric constraints (general lanes)
  const hough = detectLaneCornersHough(rgba, width, height, width);

  // Secondary: Corra multi-row gutter pairs
  const corra = detectLaneCornersCorra(rgba, width, height);

  const scale = Math.min(1, 320 / width);
  const sw = Math.max(40, Math.round(width * scale));
  const sh = Math.max(40, Math.round(height * scale));
  const gray = downscaleGray(rgba, width, height, sw, sh);

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < gray.length; i++) {
    sum += gray[i];
    sumSq += gray[i] * gray[i];
  }
  const mean = sum / gray.length;
  const std = Math.sqrt(Math.max(0, sumSq / gray.length - mean * mean));
  const baseThr = Math.min(210, Math.max(75, mean + Math.max(6, std * 0.28)));

  let best: LaneDetectResult | null = null;
  let bestScore = -1e9;
  for (const dThr of [0, -10, 12, -18, 22, -6, 8]) {
    const thr = Math.min(215, Math.max(70, baseThr + dThr));
    const cand = detectLaneCornersWithThr(
      gray,
      sw,
      sh,
      thr,
      scale,
      width,
      height
    );
    if (!cand) continue;
    const score = scoreLaneGeometry(cand, width, height);
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }

  // Rank Hough / Corra / bright-band; prefer geometry that looks like true gutters
  type Cand = { det: LaneDetectResult; score: number };
  const pool: Cand[] = [];
  if (hough) {
    pool.push({
      det: hough,
      score: scoreLaneGeometry(hough, width, height) + 18, // prefer Hough primary
    });
  }
  if (corra) {
    pool.push({
      det: corra,
      score: scoreLaneGeometry(corra, width, height) + 8,
    });
  }
  if (best) {
    pool.push({ det: best, score: bestScore });
  }
  if (!pool.length) return null;
  pool.sort((a, b) => b.score - a.score);
  const src = pool[0].det;

  return {
    ...src,
    corners: snapCornersToTrueGutter(
      src.corners,
      width,
      height,
      gray,
      sw,
      sh,
      scale,
      rgba
    ),
    message: src.message || "已估四角（Hough／幾何）；失敗請手動拖曳",
  };
}

/** 幾何分：信心 + pins 帶 − 中線偏離 − 頂底中線 skew */
export function scoreLaneGeometry(
  cand: LaneDetectResult,
  width: number,
  height: number
): number {
  const c = cand.corners;
  const pinY = (c.tl.y + c.tr.y) / 2;
  const midTop = (c.tl.x + c.tr.x) / 2;
  const midBot = (c.bl.x + c.br.x) / 2;
  const mid = (midTop + midBot) / 2;
  // 球道可略偏；但 lock 鄰道（中線偏 >12%）要重罰
  const centerDist = Math.abs(mid - width * 0.5) / width;
  const skewSigned = (midTop - midBot) / width; // >0 頂右偏
  const skewAbs = Math.abs(skewSigned);
  const pinBand =
    pinY >= height * 0.092 && pinY <= height * 0.102
      ? 1.15 // demo pin heads (r4: below AMF dark, above necks)
      : pinY >= height * 0.055 && pinY < height * 0.092
        ? 0.35 // AMF / masking dark band — weak
        : pinY > height * 0.102 && pinY <= height * 0.14
          ? 0.7 // necks / deck floor — weaker
          : pinY >= height * 0.16 && pinY <= height * 0.3
            ? 0.95 // broadcast pin deck
            : pinY < height * 0.05
              ? 0.15
              : 0.4;
  const topW = c.tr.x - c.tl.x;
  const botW = c.br.x - c.bl.x;
  const trap =
    botW > topW * 1.05 && topW > width * 0.08 && botW > width * 0.2 ? 1 : 0.3;
  // 頂右偏（吸右鄰）重罰；頂略左（本 demo 常見）唔罰
  const rightSkewPen = skewSigned > 0.02 ? skewSigned * 200 : 0;
  const absSkewPen = skewAbs > 0.08 ? (skewAbs - 0.08) * 80 : 0;
  // 單道寬：底寬吞鄰道／人影時常見 >52% 畫面
  const botFrac = botW / Math.max(1, width);
  // 真溝 foul≈0.50–0.58 唔罰；過窄（亮帶）或過寬罰
  // True gutters often botFrac 0.50–0.64; only penalize inset bright-band or two-lane
  const wideBotPen =
    botFrac > 0.68
      ? (botFrac - 0.68) * 200
      : botFrac > 0.64
        ? (botFrac - 0.64) * 40
        : botFrac < 0.48
          ? (0.48 - botFrac) * 55
          : 0;
  const taper = topW / Math.max(1, botW);
  // 後方視角合理頂/底約 0.18–0.40；太扁＝鎖多道，太尖＝假夾
  const taperPen =
    taper < 0.16 ? (0.16 - taper) * 100 : taper > 0.42 ? (taper - 0.42) * 50 : 0;
  // 底角貼畫面邊：易切到鄰道／人
  const edgePen =
    (c.bl.x < width * 0.08 ? 12 : 0) + (c.br.x > width * 0.92 ? 12 : 0);
  const centerPen =
    centerDist > 0.12
      ? (centerDist - 0.06) * 160
      : Math.max(0, centerDist - 0.08) * 50;
  // 真溝 midF≈0.47–0.50；極端左右先罰
  const midBotFrac = midBot / Math.max(1, width);
  const rightLanePen =
    midBotFrac > 0.54
      ? (midBotFrac - 0.5) * 100
      : midBotFrac < 0.42
        ? (0.47 - midBotFrac) * 80
        : 0;
  // 右欄 HUD：只喺極端右緣重罰（demo BR≈0.76 唔罰）
  const hudPen = cornersHitBroadcastHud(c, width, height)
    ? 80
    : c.br.x / width > 0.86
      ? 35
      : 0;
  return (
    cand.confidence * 100 +
    pinBand * 22 +
    trap * 12 -
    centerPen -
    rightSkewPen -
    absSkewPen -
    wideBotPen -
    taperPen -
    edgePen -
    rightLanePen -
    hudPen
  );
}

function detectLaneCornersWithThr(
  gray: Uint8ClampedArray,
  sw: number,
  sh: number,
  thr: number,
  scale: number,
  width: number,
  height: number
): LaneDetectResult | null {

  const lefts: (number | null)[] = new Array(sh).fill(null);
  const rights: (number | null)[] = new Array(sh).fill(null);
  const widths: number[] = new Array(sh).fill(0);
  const rowStrength: number[] = new Array(sh).fill(0);

  // 由下往上跟住中央單道（避 longest-run 吞鄰道）；寬度跟透視微收
  let expectMid: number | null = null;
  // 單道 foul 端典型佔畫面 ~38–46%（多道合併會長到 55%+）
  let expectW: number | null = sw * 0.40;
  const centerX = sw * 0.5;
  for (let y = sh - 1; y >= 0; y--) {
    let band = pickLaneRun(gray, sw, y, thr, expectMid, expectW);
    if (
      band &&
      expectMid != null &&
      Math.abs((band.l + band.r) / 2 - centerX) > sw * 0.28 &&
      Math.abs(expectMid - centerX) > sw * 0.2
    ) {
      // 已偏離中央：改用中央偏好再揀一次
      const re = pickLaneRun(gray, sw, y, thr, centerX, expectW);
      if (re) band = re;
    }
    // 仍過寬：強制用期望寬再揀（防吞鄰道）
    if (band && expectW != null && band.r - band.l + 1 > expectW * 1.35) {
      const re = pickLaneRun(gray, sw, y, thr, expectMid ?? centerX, expectW);
      if (re && re.r - re.l + 1 < band.r - band.l + 1) band = re;
    }
    if (!band) {
      // 斷軌：下一列改從中央重試（唔沿錯誤 expect）
      if (expectMid != null && Math.abs(expectMid - centerX) > sw * 0.22) {
        expectMid = centerX;
      }
      continue;
    }
    lefts[y] = band.l;
    rights[y] = band.r;
    widths[y] = band.r - band.l + 1;
    rowStrength[y] = band.strength;
    let nextMid = (band.l + band.r) / 2;
    // 防中線漂去鄰道：拉返中央（輕拉；過猛會偏左）
    if (Math.abs(nextMid - centerX) > sw * 0.12) {
      nextMid = nextMid * 0.45 + centerX * 0.55;
    } else if (nextMid - centerX > sw * 0.06) {
      // 只對右漂（鄰道）多拉一點
      nextMid = nextMid * 0.55 + centerX * 0.45;
    }
    expectMid = nextMid;
    // 向上略收窄（透視）；下限保住頂端合理寬
    const taper = 0.994;
    expectW = Math.max(sw * 0.12, Math.min(sw * 0.46, (expectW ?? widths[y]) * taper * 0.5 + widths[y] * 0.5));
  }

  const yBotScan = Math.floor(sh * 0.94);
  const yTopScan = Math.floor(sh * 0.06);
  const samples: { y: number; l: number; r: number; w: number; s: number }[] =
    [];
  for (let y = yTopScan; y <= yBotScan; y++) {
    if (lefts[y] == null || rights[y] == null) continue;
    samples.push({
      y,
      l: lefts[y]!,
      r: rights[y]!,
      w: widths[y],
      s: rowStrength[y],
    });
  }
  if (samples.length < 8) return null;

  const lower = samples.filter((s) => s.y > sh * 0.55);
  const upper = samples.filter((s) => s.y < sh * 0.45);
  if (lower.length < 2 || upper.length < 1) return null;

  const avgW = (arr: typeof samples) =>
    arr.reduce((a, s) => a + s.w, 0) / arr.length;
  const wLow = avgW(lower);
  const wUp = avgW(upper.length ? upper : samples.slice(0, 5));

  // foul 端多道木面合併、溝唔夠暗 → 全樣本擬合易把底邊拉開到鄰道。
  // 優先用中上段（溝較清楚）擬合邊線，再外推到 foul。
  const midBand = samples.filter(
    (s) => s.y >= sh * 0.18 && s.y <= sh * 0.62
  );
  const fitSrc =
    midBand.length >= 8
      ? midBand
      : samples.filter((s) => s.y <= sh * 0.7);
  // 再丟過寬列（多道合併）
  const medW = [...fitSrc.map((s) => s.w)].sort((a, b) => a - b)[
    Math.floor(fitSrc.length / 2)
  ];
  const fitSrc2 = fitSrc.filter((s) => s.w <= medW * 1.35 && s.w >= medW * 0.55);
  const useFit = fitSrc2.length >= 6 ? fitSrc2 : fitSrc.length >= 6 ? fitSrc : samples;

  let leftFit = fitLineRobust(
    useFit.map((s) => s.y),
    useFit.map((s) => s.l)
  );
  let rightFit = fitLineRobust(
    useFit.map((s) => s.y),
    useFit.map((s) => s.r)
  );
  if (!leftFit || !rightFit) return null;

  // Corra 靈感：中上段 selectClosestEdges 再擬合；只喺中線／寬度貼近亮段時輕混
  {
    const edgeYs: number[] = [];
    const edgeLs: number[] = [];
    const edgeRs: number[] = [];
    const yRef = sh * 0.45;
    const brightMid =
      (leftFit.a + leftFit.b * yRef + rightFit.a + rightFit.b * yRef) / 2;
    const brightW =
      rightFit.a + rightFit.b * yRef - (leftFit.a + leftFit.b * yRef);
    for (const s of useFit) {
      const halfW = Math.max(sw * 0.16, (s.r - s.l + 1) * 0.55);
      // 以亮段中線為錨，唔用畫面正中（球道可略偏）
      const anchor = (s.l + s.r) / 2;
      const ep = selectClosestEdges(gray, sw, s.y, anchor, halfW);
      if (!ep) continue;
      const midE = (ep.l + ep.r) / 2;
      if (Math.abs(midE - anchor) > sw * 0.05) continue;
      if (Math.abs(midE - brightMid) > sw * 0.08) continue;
      const wE = ep.r - ep.l;
      if (wE < brightW * 0.75 || wE > brightW * 1.2) continue;
      if (wE < sw * 0.22 || wE > sw * 0.48) continue;
      edgeYs.push(s.y);
      edgeLs.push(ep.l);
      edgeRs.push(ep.r);
    }
    if (edgeYs.length >= 8) {
      const lf = fitLineRobust(edgeYs, edgeLs);
      const rf = fitLineRobust(edgeYs, edgeRs);
      if (lf && rf && lf.inlierRatio >= 0.6 && rf.inlierRatio >= 0.6) {
        const midE =
          (lf.a + lf.b * yRef + rf.a + rf.b * yRef) / 2;
        const wE = rf.a + rf.b * yRef - (lf.a + lf.b * yRef);
        // 中線／寬度唔可漂離亮段太多
        if (
          Math.abs(midE - brightMid) < sw * 0.05 &&
          wE > brightW * 0.8 &&
          wE < brightW * 1.15
        ) {
          leftFit = {
            a: leftFit.a * 0.65 + lf.a * 0.35,
            b: leftFit.b * 0.65 + lf.b * 0.35,
            inlierRatio: Math.max(leftFit.inlierRatio, lf.inlierRatio),
          };
          rightFit = {
            a: rightFit.a * 0.65 + rf.a * 0.35,
            b: rightFit.b * 0.65 + rf.b * 0.35,
            inlierRatio: Math.max(rightFit.inlierRatio, rf.inlierRatio),
          };
        }
      }
    }
  }

  let yFoul = findFoulY(gray, sw, sh, widths, leftFit, rightFit);
  let yPins = findPinsY(gray, sw, sh, lefts, rights, widths, yFoul);

  // 優先抬高 pins（TL/TR）；頂寬不足時對稱擴寬，唔好為咗寬度把 y 拉低
  const widthAt = (y: number) =>
    rightFit.a +
    rightFit.b * y -
    (leftFit.a + leftFit.b * y);
  const botW0 = Math.max(sw * 0.15, widthAt(yFoul));
  const minTop = Math.max(sw * 0.1, botW0 * 0.22);
  yPins = clamp(yPins, sh * 0.085, sh * 0.15);
  yFoul = clamp(yFoul, sh * 0.72, sh * 0.94);
  // 若擬合線喺高位交叉，只略降下（最多到 16%），其餘靠擴寬
  let guard = 0;
  while (widthAt(yPins) < sw * 0.04 && yPins < sh * 0.16 && guard < 40) {
    yPins += 1;
    guard++;
  }

  let bl: Point2D = { x: leftFit.a + leftFit.b * yFoul, y: yFoul };
  let br: Point2D = { x: rightFit.a + rightFit.b * yFoul, y: yFoul };
  let tl: Point2D = { x: leftFit.a + leftFit.b * yPins, y: yPins };
  let tr: Point2D = { x: rightFit.a + rightFit.b * yPins, y: yPins };

  let botW = br.x - bl.x;
  let topW = tr.x - tl.x;
  const buildSampleCorners = () => {
    // 只用樣本決定 y；x 一律走穩健擬合線，保持梯形一致
    const botS =
      lower[Math.floor(lower.length * 0.75)] ?? lower[lower.length - 1];
    let ty = sh * 0.11;
    for (const s of upper.length ? upper : samples.slice(0, 10)) {
      const w = widthAt(s.y);
      if (w >= minTop) {
        ty = s.y;
        break;
      }
    }
    ty = clamp(Math.min(ty, sh * 0.14), sh * 0.08, sh * 0.16);
    // 再保險：若仍太窄，下移
    let y = ty;
    let g = 0;
    while (widthAt(y) < minTop && y < sh * 0.28 && g < 60) {
      y += 1;
      g++;
    }
    const fy = clamp(botS.y, sh * 0.72, sh * 0.94);
    return {
      bl: { x: leftFit.a + leftFit.b * fy, y: fy },
      br: { x: rightFit.a + rightFit.b * fy, y: fy },
      tl: { x: leftFit.a + leftFit.b * y, y },
      tr: { x: rightFit.a + rightFit.b * y, y },
    };
  };
  if (botW < sw * 0.12 || topW < sw * 0.08 || bl.x >= br.x || tl.x >= tr.x) {
    const s = buildSampleCorners();
    bl = s.bl;
    br = { ...s.br, y: s.bl.y };
    tl = s.tl;
    tr = s.tr;
    botW = br.x - bl.x;
    topW = tr.x - tl.x;
    if (botW < sw * 0.1 || topW < sw * 0.05 || bl.x >= br.x || tl.x >= tr.x) {
      // 唔即退：用中央梯形繼續，信心稍後會拉低
      const fy = clamp(lower[lower.length - 1].y, sh * 0.75, sh * 0.94);
      const ty = sh * 0.11;
      const mid = sw * 0.5;
      bl = { x: mid - sw * 0.28, y: fy };
      br = { x: mid + sw * 0.28, y: fy };
      tl = { x: mid - sw * 0.08, y: ty };
      tr = { x: mid + sw * 0.08, y: ty };
      botW = br.x - bl.x;
      topW = tr.x - tl.x;
    }
  }

  bl = nudgeEdge(gray, sw, sh, bl, -1, 0.18);
  br = nudgeEdge(gray, sw, sh, br, 1, 0.18);
  tl = nudgeEdge(gray, sw, sh, tl, -1, 0.03);
  tr = nudgeEdge(gray, sw, sh, tr, 1, 0.03);

  // 對齊 y
  const pinY = Math.min(tl.y, tr.y, sh * 0.16);
  const foulY = Math.max(bl.y, br.y);
  tl = {
    x: leftFit.a + leftFit.b * pinY,
    y: clamp(pinY, sh * 0.08, sh * 0.16),
  };
  tr = {
    x: rightFit.a + rightFit.b * pinY,
    y: tl.y,
  };
  bl = {
    x: leftFit.a + leftFit.b * foulY,
    y: clamp(foulY, sh * 0.72, sh * 0.94),
  };
  br = {
    x: rightFit.a + rightFit.b * foulY,
    y: bl.y,
  };
  // 若對齊後交叉，用樣本
  if (tr.x - tl.x < sw * 0.09 || br.x - bl.x < sw * 0.12) {
    const botS = lower[Math.floor(lower.length * 0.75)];
    const topCand = upper.length
      ? upper[Math.min(2, upper.length - 1)]
      : samples[Math.floor(samples.length * 0.15)];
    bl = { x: botS.l, y: clamp(botS.y, sh * 0.72, sh * 0.94) };
    br = { x: botS.r, y: bl.y };
    const ty = clamp(Math.min(topCand.y, sh * 0.14), sh * 0.08, sh * 0.16);
    tl = { x: topCand.l, y: ty };
    tr = { x: topCand.r, y: ty };
  }

  bl = nudgeEdge(gray, sw, sh, bl, -1, 0.12);
  br = nudgeEdge(gray, sw, sh, br, 1, 0.12);
  tl = nudgeEdge(gray, sw, sh, { ...tl, y: tl.y }, -1, 0.02);
  tr = nudgeEdge(gray, sw, sh, { ...tr, y: tr.y }, 1, 0.02);
  // Corra：foul／pins 列用最近邊對微調（中線不變超過 3%）
  {
    const snapPair = (y: number, l0: number, r0: number) => {
      const mid0 = (l0 + r0) / 2;
      const ep = selectClosestEdges(
        gray,
        sw,
        Math.round(y),
        mid0,
        Math.max(sw * 0.18, (r0 - l0) * 0.6)
      );
      if (!ep) return null;
      const midE = (ep.l + ep.r) / 2;
      if (Math.abs(midE - mid0) > sw * 0.03) return null;
      const w0 = r0 - l0;
      const wE = ep.r - ep.l;
      if (wE < w0 * 0.85 || wE > w0 * 1.12) return null;
      return ep;
    };
    const bot = snapPair(bl.y, bl.x, br.x);
    if (bot) {
      bl = { ...bl, x: bot.l };
      br = { ...br, x: bot.r };
    }
    const top = snapPair(tl.y, tl.x, tr.x);
    if (top) {
      tl = { ...tl, x: top.l };
      tr = { ...tr, x: top.r };
    }
  }
  // 保持 pins y 對齊
  {
    const y = Math.min(tl.y, tr.y);
    tl = { ...tl, y };
    tr = { ...tr, y };
  }
  {
    const y = Math.max(bl.y, br.y);
    bl = { ...bl, y };
    br = { ...br, y };
  }

  botW = br.x - bl.x;
  topW = tr.x - tl.x;
  // 頂寬太窄／交叉：對稱擴到 minTop（保持高 pins）
  if (topW < minTop || tl.x >= tr.x) {
    const mid = tl.x >= tr.x ? (bl.x + br.x) / 2 : (tl.x + tr.x) / 2;
    tl = { ...tl, x: mid - minTop / 2 };
    tr = { ...tr, x: mid + minTop / 2 };
    topW = minTop;
  }
  // foul 端若被 nudge 夾歪，略向外對齊底寬
  if (botW < sw * 0.2) {
    const mid = (bl.x + br.x) / 2;
    const half = Math.max(botW, sw * 0.28) / 2;
    bl = { ...bl, x: mid - half };
    br = { ...br, x: mid + half };
    botW = br.x - bl.x;
  }
  if (botW < sw * 0.1 || topW < sw * 0.05 || bl.x >= br.x || tl.x >= tr.x) {
    const s = buildSampleCorners();
    bl = s.bl;
    br = { ...s.br, y: s.bl.y };
    tl = s.tl;
    tr = s.tr;
    botW = br.x - bl.x;
    topW = tr.x - tl.x;
    if (botW < sw * 0.08 || topW < sw * 0.04 || bl.x >= br.x || tl.x >= tr.x) {
      // 最終保底：用上下樣本列，頂寬強制 minTop（唔好再 return null）
      const botS = lower[lower.length - 1];
      const topS = upper[Math.min(2, upper.length - 1)] ?? samples[0];
      const fy = clamp(botS.y, sh * 0.75, sh * 0.94);
      const ty = clamp(Math.min(topS.y, sh * 0.13), sh * 0.08, sh * 0.15);
      const midB = (botS.l + botS.r) / 2;
      const halfB = Math.max((botS.r - botS.l) / 2, sw * 0.22);
      bl = { x: midB - halfB, y: fy };
      br = { x: midB + halfB, y: fy };
      const midT = midB;
      const topHalf = Math.max(minTop / 2, sw * 0.06);
      tl = { x: midT - topHalf, y: ty };
      tr = { x: midT + topHalf, y: ty };
      botW = br.x - bl.x;
      topW = tr.x - tl.x;
    }
  }
  // 絕對保底：有樣本就一定出梯形（減少第一次失敗退預設）
  if (botW < sw * 0.08 || topW < sw * 0.04 || bl.x >= br.x || tl.x >= tr.x) {
    const fy = sh * 0.88;
    const ty = sh * 0.11;
    const mid = sw * 0.5;
    bl = { x: mid - sw * 0.28, y: fy };
    br = { x: mid + sw * 0.28, y: fy };
    tl = { x: mid - sw * 0.08, y: ty };
    tr = { x: mid + sw * 0.08, y: ty };
    botW = br.x - bl.x;
    topW = tr.x - tl.x;
  }

  const ratio = topW / botW;
  if (ratio > 0.92) {
    const mid = (tl.x + tr.x) / 2;
    const targetTop = botW * 0.4;
    tl = { ...tl, x: mid - targetTop / 2 };
    tr = { ...tr, x: mid + targetTop / 2 };
    topW = targetTop;
  } else if (ratio < 0.2) {
    const mid = (tl.x + tr.x) / 2;
    const targetTop = Math.max(sw * 0.11, botW * 0.25);
    tl = { ...tl, x: mid - targetTop / 2 };
    tr = { ...tr, x: mid + targetTop / 2 };
    topW = targetTop;
  }

  // 中線微調：只修正頂邊明顯右偏（隔鄰道）；唔好強制畫面正中（球道可偏左）
  {
    const midBot = (bl.x + br.x) / 2;
    const midTop = (tl.x + tr.x) / 2;
    const midShift = midTop - midBot;
    // 頂中線明顯喺底中線右邊 → 常見誤吸右鄰道
    if (midShift > sw * 0.04) {
      const corr = midShift * 0.7;
      tl = { ...tl, x: tl.x - corr };
      tr = { ...tr, x: tr.x - corr };
    } else if (midShift < -sw * 0.1) {
      const corr = midShift * 0.45;
      tl = { ...tl, x: tl.x - corr };
      tr = { ...tr, x: tr.x - corr };
    }
  }

  // Phase A+B removed: no green/red paint hard-lock (208/802).
  // Final corners come from edge fit above; outer snap uses Hough/geometry.

  const inv = 1 / scale;
  const corners: LaneCorners = {
    tl: clampPt({ x: tl.x * inv, y: tl.y * inv }, width, height),
    tr: clampPt({ x: tr.x * inv, y: tr.y * inv }, width, height),
    br: clampPt({ x: br.x * inv, y: br.y * inv }, width, height),
    bl: clampPt({ x: bl.x * inv, y: bl.y * inv }, width, height),
  };

  // 誠實信心
  const cover = samples.length / (yBotScan - yTopScan + 1);
  const trapOk = wLow > wUp * 1.04;
  const edgeQuality = (leftFit.inlierRatio + rightFit.inlierRatio) / 2;
  const gradScore = edgeGradientScore(gray, sw, sh, corners, scale);
  const aspectPenalty = aspectSanityPenalty(corners, width, height);
  const finalTop = corners.tr.x - corners.tl.x;
  const finalBot = corners.br.x - corners.bl.x;
  const finalRatio = finalTop / Math.max(1, finalBot);

  let confidence = 0.22;
  confidence += trapOk ? 0.18 : 0.04;
  confidence += 0.18 * edgeQuality;
  confidence += 0.12 * Math.min(1, cover / 0.5);
  confidence += 0.16 * gradScore;
  confidence -= aspectPenalty;
  if (wLow < wUp * 0.95) confidence -= 0.18;
  if (corners.tl.y > height * 0.2) confidence -= 0.12;
  if (corners.tl.y < height * 0.07) confidence -= 0.08; // pins 過高易夾假斑
  {
    const mt = (corners.tl.x + corners.tr.x) / 2;
    const mb = (corners.bl.x + corners.br.x) / 2;
    if (mt - mb > width * 0.06) confidence -= 0.12; // 頂右偏
    if (Math.abs(mt - mb) > width * 0.12) confidence -= 0.06;
  }
  if (finalRatio < 0.15 || finalRatio > 0.85) confidence -= 0.1;
  if (finalBot < width * 0.25) confidence -= 0.08;
  // 真溝 foul≈0.50–0.58
  if (finalBot > width * 0.62) confidence -= 0.14;
  else if (finalBot < width * 0.45) confidence -= 0.08;
  {
    const taper = finalTop / Math.max(1, finalBot);
    if (taper < 0.16) confidence -= 0.1;
  }
  // 唔好報 >0.85 除非邊緣同梯形都靚
  const cap =
    edgeQuality > 0.75 && trapOk && gradScore > 0.45 && aspectPenalty < 0.05
      ? 0.88
      : 0.78;
  confidence = Math.max(0.12, Math.min(cap, confidence));

  return {
    corners,
    confidence,
    message:
      confidence >= 0.55
        ? "已估四角（請確認 foul～pins），可微調藍點"
        : "自動估角信心偏低，建議改手動拖曳",
  };
}

export function detectLaneFromCanvas(
  canvas: HTMLCanvasElement
): LaneDetectResult | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { width, height } = canvas;
  if (!width || !height) return null;
  const img = ctx.getImageData(0, 0, width, height);
  return detectLaneCorners(img.data, width, height);
}

export function fallbackDefaultCorners(
  width: number,
  height: number
): LaneCorners {
  return defaultCorners(width, height);
}

/** 亮段外側暗帶分數：溝槽應比道面暗 */
function gutterFlankScore(
  gray: Uint8ClampedArray,
  sw: number,
  y: number,
  l: number,
  r: number
): number {
  const span = Math.max(2, Math.round(sw * 0.025));
  let leftDark = 0;
  let rightDark = 0;
  let nL = 0;
  let nR = 0;
  let inside = 0;
  let nIn = 0;
  for (let dx = 1; dx <= span; dx++) {
    const xl = l - dx;
    const xr = r + dx;
    if (xl >= 0) {
      leftDark += gray[y * sw + xl];
      nL++;
    }
    if (xr < sw) {
      rightDark += gray[y * sw + xr];
      nR++;
    }
  }
  const mid0 = Math.max(l, Math.min(r, Math.round((l + r) / 2)));
  for (let x = Math.max(l, mid0 - span); x <= Math.min(r, mid0 + span); x++) {
    inside += gray[y * sw + x];
    nIn++;
  }
  if (nL < 1 || nR < 1 || nIn < 1) return 0;
  const inMean = inside / nIn;
  const lMean = leftDark / nL;
  const rMean = rightDark / nR;
  return (inMean - lMean) / 40 + (inMean - rMean) / 40;
}


/**
 * 單道 foul 溝對：expectW≈0.42，seed mid≈0.55（lane15）。
 * 拒絕 bot>0.50（舊 bug：14 左溝～15 右溝兩道寬）。
 */
/**
 * 由 foul 向上跟蹤單道溝，擬合 L/R 直線（外推到 pins）。
 * seed mid≈0.55；只收 bot∈[0.34,0.50] 嘅列，避兩道寬。
 */
function fitSingleLaneGutters(
  gray: Uint8ClampedArray,
  sw: number,
  sh: number,
  seedMid: number
): { la: number; lb: number; ra: number; rb: number; n: number } | null {
  const pts: { y: number; l: number; r: number }[] = [];
  let mid = seedMid;
  let expectW = sw * 0.55;
  for (let yf = 0.88; yf >= 0.36; yf -= 0.02) {
    const y = Math.round(yf * sh);
    const targetW = sw * clamp(0.22 + yf * 0.40, 0.24, 0.58);
    expectW = expectW * 0.45 + targetW * 0.55;
    const pair = measureLaneGutterPair(
      gray,
      sw,
      y,
      mid,
      expectW * 0.75,
      expectW * 1.25
    );
    if (!pair) continue;
    const w = pair.r - pair.l;
    const m = (pair.l + pair.r) / 2;
    if (Math.abs(m - mid) > sw * 0.08) continue;
    if (w < sw * 0.48 || w > sw * 0.66) continue;
    pts.push({ y, l: pair.l, r: pair.r });
    mid = mid * 0.4 + m * 0.6;
    expectW = expectW * 0.5 + w * 0.5;
  }
  if (pts.length < 8) return null;
  const fit = (ys: number[], xs: number[]) => {
    const n = ys.length;
    let sy = 0,
      sx = 0,
      syy = 0,
      sxy = 0;
    for (let i = 0; i < n; i++) {
      sy += ys[i];
      sx += xs[i];
      syy += ys[i] * ys[i];
      sxy += ys[i] * xs[i];
    }
    const den = n * syy - sy * sy;
    if (Math.abs(den) < 1e-6) return null;
    const b = (n * sxy - sy * sx) / den;
    const a = (sx - b * sy) / n;
    return { a, b };
  };
  const ys = pts.map((p) => p.y);
  const ls = pts.map((p) => p.l);
  const rs = pts.map((p) => p.r);
  // robust: drop large residuals once
  const robust = (xs: number[]) => {
    const first = fit(ys, xs);
    if (!first) return null;
    const res = ys.map((y, i) => Math.abs(xs[i] - (first.a + first.b * y)));
    const sorted = [...res].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 1;
    const thr = Math.max(3, med * 2.2);
    const iy: number[] = [];
    const ix: number[] = [];
    for (let i = 0; i < ys.length; i++) {
      if (res[i] <= thr) {
        iy.push(ys[i]);
        ix.push(xs[i]);
      }
    }
    if (iy.length < 6) return first;
    return fit(iy, ix) ?? first;
  };
  const lf = robust(ls);
  const rf = robust(rs);
  if (!lf || !rf) return null;
  return { la: lf.a, lb: lf.b, ra: rf.a, rb: rf.b, n: pts.length };
}

function measureLaneGutterPair(
  gray: Uint8ClampedArray,
  sw: number,
  y: number,
  mid: number,
  minW: number,
  maxW: number
): { l: number; r: number } | null {
  if (y < 2 || y >= gray.length / sw - 2) return null;
  const row = y * sw;
  const thrG = 14;
  const expectW = (minW + maxW) / 2;
  let best: { l: number; r: number; sc: number } | null = null;
  const xL0 = Math.max(2, Math.floor(mid - maxW * 0.7));
  const xL1 = Math.floor(mid - expectW * 0.25);
  const xR0 = Math.ceil(mid + expectW * 0.25);
  const xR1 = Math.min(sw - 3, Math.ceil(mid + maxW * 0.7));
  for (let l = xL0; l <= xL1; l++) {
    const gL = Math.abs(gray[row + l + 1] - gray[row + l - 1]);
    if (gL < thrG) continue;
    let inM = 0, outM = 0, nI = 0, nO = 0;
    for (let k = 1; k <= 12; k++) {
      if (l + k < sw) { inM += gray[row + l + k]; nI++; }
      if (l - k >= 0) { outM += gray[row + l - k]; nO++; }
    }
    const fL = nI && nO ? (inM / nI - outM / nO) / 40 : 0;
    if (fL < 0.12) continue;
    for (let r = xR0; r <= xR1; r++) {
      const w = r - l;
      if (w < minW || w > maxW) continue;
      const gR = Math.abs(gray[row + r + 1] - gray[row + r - 1]);
      if (gR < thrG) continue;
      let inR = 0, outR = 0, nIR = 0, nOR = 0;
      for (let k = 1; k <= 12; k++) {
        if (r - k >= 0) { inR += gray[row + r - k]; nIR++; }
        if (r + k < sw) { outR += gray[row + r + k]; nOR++; }
      }
      const fR = nIR && nOR ? (inR / nIR - outR / nOR) / 40 : 0;
      if (fR < 0.12) continue;
      const pairMid = (l + r) / 2;
      // Prefer outer (wider) gutter pair within band — avoid inset oil lines
      const sc =
        (gL + gR) * 0.08 +
        (fL + fR) * 26 -
        Math.abs(pairMid - mid) * 4 -
        (Math.abs(w - expectW) / sw) * 25 +
        (w / sw) * 35;
      if (!best || sc > best.sc) best = { l, r, sc };
    }
  }
  if (!best || best.sc < 0) return null;
  return { l: best.l, r: best.r };
}

/**
 * CorraPiano select_closest_lines 靈感（無 OpenCV）：
 * 喺中線左右搵最強垂直邊（|gx|），揀最接近中線、且寬度合理嗰對。
 * 溝／鄰道／人影外緣通常比木面內紋更強，故優先於純亮段。
 */
function selectClosestEdges(
  gray: Uint8ClampedArray,
  sw: number,
  y: number,
  mid: number,
  maxHalfW: number
): { l: number; r: number; strength: number } | null {
  if (y < 1 || y >= gray.length / sw - 1) return null;
  const minHalf = Math.max(4, Math.round(sw * 0.1));
  const maxHalf = Math.max(minHalf + 2, Math.round(maxHalfW));
  // 本地 |gx|；人影／鄰道常喺遠側，故距離中線越遠權重越低
  const leftPeaks: { x: number; g: number }[] = [];
  const rightPeaks: { x: number; g: number }[] = [];
  let meanG = 0;
  let nG = 0;
  const x0 = Math.max(2, Math.floor(mid - maxHalf));
  const x1 = Math.min(sw - 3, Math.ceil(mid + maxHalf));
  for (let x = x0; x <= x1; x++) {
    const g = Math.abs(gray[y * sw + x + 1] - gray[y * sw + x - 1]);
    meanG += g;
    nG++;
  }
  const thrG = Math.max(14, (nG > 0 ? meanG / nG : 0) * 1.35);
  for (let x = x0; x <= x1; x++) {
    const g = Math.abs(gray[y * sw + x + 1] - gray[y * sw + x - 1]);
    if (g < thrG) continue;
    // 非極大抑制
    const gL = Math.abs(gray[y * sw + x] - gray[y * sw + x - 2]);
    const gR = Math.abs(gray[y * sw + x + 2] - gray[y * sw + x]);
    if (g < gL || g < gR) continue;
    if (x < mid) leftPeaks.push({ x, g });
    else rightPeaks.push({ x, g });
  }
  if (leftPeaks.length === 0 || rightPeaks.length === 0) return null;

  // 真 Corra：左／右各自按「距中線」排序，近者優先；同距再比梯度
  leftPeaks.sort((a, b) => {
    const da = mid - a.x;
    const db = mid - b.x;
    return da - db || b.g - a.g;
  });
  rightPeaks.sort((a, b) => {
    const da = a.x - mid;
    const db = b.x - mid;
    return da - db || b.g - a.g;
  });

  let bestL: { x: number; g: number } | null = null;
  let bestR: { x: number; g: number } | null = null;
  let bestScore = -1e9;
  // 只睇左右各前幾條近中線候選，避外緣溝／鄰道
  const Lcand = leftPeaks.slice(0, Math.min(5, leftPeaks.length));
  const Rcand = rightPeaks.slice(0, Math.min(5, rightPeaks.length));
  for (const L of Lcand) {
    for (const R of Rcand) {
      const w = R.x - L.x;
      if (w < minHalf * 2 || w > maxHalf * 2.05) continue;
      const midPair = (L.x + R.x) / 2;
      const dist = Math.abs(midPair - mid);
      if (dist > sw * 0.1) continue; // 中線偏太多＝鄰道
      const gutter = gutterFlankScore(gray, sw, y, L.x, R.x);
      const distL = mid - L.x;
      const distR = R.x - mid;
      // 對稱＋近中線；強罰左右距差（人影單側）
      const asym = Math.abs(distL - distR) / sw;
      const score =
        -dist * 6.5 -
        asym * 55 +
        (L.g + R.g) * 0.05 +
        gutter * 18 -
        Math.abs(w / sw - 0.4) * 30;
      if (score > bestScore) {
        bestScore = score;
        bestL = L;
        bestR = R;
      }
    }
  }
  if (!bestL || !bestR || bestScore < -1e8) return null;
  // 再微調到局部最大梯度
  const snap = (x0s: number, side: -1 | 1) => {
    let bx = x0s;
    let bg = -1;
    for (let dx = -3; dx <= 3; dx++) {
      const x = x0s + dx;
      if (x < 1 || x >= sw - 1) continue;
      const g = Math.abs(gray[y * sw + x + 1] - gray[y * sw + x - 1]);
      const bias = side < 0 ? -dx * 0.4 : dx * 0.4;
      if (g + bias > bg) {
        bg = g + bias;
        bx = x;
      }
    }
    return bx;
  };
  const l = snap(bestL.x, -1);
  const r = snap(bestR.x, 1);
  if (r - l < minHalf * 2) return null;
  return {
    l,
    r,
    strength: (bestL.g + bestR.g) / 80,
  };
}

/**
 * 同一列亮段：跟中線／期望寬，輔以溝暗。
 * 長亮段（多道合併）→ 以中線為心裁成單道寬，唔滑去鄰道。
 */
function pickLaneRun(
  gray: Uint8ClampedArray,
  sw: number,
  y: number,
  thr: number,
  expectMid: number | null,
  expectW: number | null = null
): { l: number; r: number; strength: number } | null {
  const minRun = Math.max(5, Math.round(sw * 0.05));
  const runs: { l: number; r: number; sum: number }[] = [];
  let run = 0;
  let runStart = 0;
  let runSum = 0;
  for (let x = 0; x <= sw; x++) {
    const v = x < sw ? gray[y * sw + x] : 0;
    if (x < sw && v >= thr) {
      if (run === 0) {
        runStart = x;
        runSum = 0;
      }
      run++;
      runSum += v;
    } else if (run > 0) {
      if (run >= minRun) runs.push({ l: runStart, r: runStart + run - 1, sum: runSum });
      run = 0;
    }
  }
  if (runs.length === 0) return null;

  const cx = expectMid != null ? expectMid : sw * 0.5;
  const wTarget =
    expectW != null
      ? Math.max(minRun, expectW)
      : Math.max(minRun, Math.round(sw * 0.4));

  const candidates: { l: number; r: number; sum: number }[] = [];
  for (const r of runs) {
    const w = r.r - r.l + 1;
    if (w <= wTarget * 1.35) {
      candidates.push(r);
      continue;
    }
    // 多道合併：只以期望中線為心裁單道（唔滑窗，防鎖鄰道）
    const half = Math.round(wTarget / 2);
    let s = Math.round(cx) - half;
    let e = s + Math.round(wTarget) - 1;
    if (s < r.l) {
      e += r.l - s;
      s = r.l;
    }
    if (e > r.r) {
      s -= e - r.r;
      e = r.r;
    }
    s = Math.max(r.l, s);
    e = Math.min(r.r, e);
    if (e - s + 1 >= minRun) {
      let sum = 0;
      for (let x = s; x <= e; x++) sum += gray[y * sw + x];
      candidates.push({ l: s, r: e, sum });
    }
    // 唔保留過寬原段：否則人影／鄰道木面會贏（Priority 2）
  }

  let best = candidates[0];
  let bestScore = -1e9;
  for (const r of candidates) {
    const mid = (r.l + r.r) / 2;
    const w = r.r - r.l + 1;
    const dist = Math.abs(mid - cx);
    const gutter = gutterFlankScore(gray, sw, y, r.l, r.r);
    const wFrac = w / sw;
    const bandPen =
      wFrac < 0.28
        ? (0.28 - wFrac) * 90
        : wFrac > 0.5
          ? (wFrac - 0.5) * 160
          : wFrac > 0.46
            ? (wFrac - 0.46) * 40
            : 0;
    const wPen = Math.abs(w - wTarget) / sw;
    // 中線權重大：偏去鄰道係最大問題
    const score =
      -dist * (expectMid != null ? 3.2 : 2.4) -
      wPen * 40 -
      bandPen +
      gutter * 30 +
      (r.sum / w) * 0.03;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return {
    l: best.l,
    r: best.r,
    strength: best.sum / (best.r - best.l + 1) / Math.max(1, thr),
  };
}

/**
 * Black-Lights foul_line_voting 靈感（單幀版）：
 * 喺 foul 帶對水平邊能量做 1D heatmap bin 投票，揀勝出 bin 中心。
 * 比逐列 argmax 穩：唔易被單列紋理／球影拉走。
 */
function findFoulY(
  gray: Uint8ClampedArray,
  sw: number,
  sh: number,
  widths: number[],
  leftFit: { a: number; b: number },
  rightFit: { a: number; b: number }
): number {
  const y0 = Math.floor(sh * 0.7);
  const y1 = Math.floor(sh * 0.94);
  const binH = Math.max(2, Math.round(sh * 0.012));
  const nBins = Math.max(1, Math.ceil((y1 - y0 + 1) / binH));
  const votes = new Float64Array(nBins);
  const counts = new Float64Array(nBins);

  for (let y = y0; y <= y1; y++) {
    const l = Math.max(0, Math.floor(leftFit.a + leftFit.b * y));
    const r = Math.min(sw - 1, Math.ceil(rightFit.a + rightFit.b * y));
    if (r - l < sw * 0.1) continue;
    let edge = 0;
    let n = 0;
    if (y > 0) {
      for (let x = l; x <= r; x += 2) {
        edge += Math.abs(gray[y * sw + x] - gray[(y - 1) * sw + x]);
        n++;
      }
    }
    const avgEdge = n > 0 ? edge / n : 0;
    const w = widths[y] || r - l;
    // 輕罰過上；唔再用強 (y/sh)*10 把 foul 鎖死喺畫面底
    // 略偏下但唔鎖死畫面最底（地毯／檔板邊常最強）
    const nearFloorPen = y > sh * 0.92 ? (y / sh - 0.92) * 80 : 0;
    const score = avgEdge * 1.25 + w * 0.03 + (y / sh) * 2.5 - nearFloorPen;
    const bi = Math.min(nBins - 1, Math.floor((y - y0) / binH));
    votes[bi] += score;
    counts[bi] += 1;
  }

  let bestBin = -1;
  let bestVote = -1;
  let total = 0;
  for (let i = 0; i < nBins; i++) {
    total += votes[i];
    const v = votes[i];
    if (v > bestVote) {
      bestVote = v;
      bestBin = i;
    }
  }
  // 門檻：勝出 bin 佔總票太低 → 退回加權期望
  if (bestBin < 0 || total <= 0) return sh * 0.88;
  const share = bestVote / total;
  if (share < 0.12 && counts[bestBin] < 2) return sh * 0.88;

  // 勝出 bin 內再揀能量最高嘅 y（hybrid：vote + local max）
  const binY0 = y0 + bestBin * binH;
  const binY1 = Math.min(y1, binY0 + binH - 1);
  let bestY = (binY0 + binY1) / 2;
  let bestLocal = -1;
  for (let y = binY0; y <= binY1; y++) {
    const l = Math.max(0, Math.floor(leftFit.a + leftFit.b * y));
    const r = Math.min(sw - 1, Math.ceil(rightFit.a + rightFit.b * y));
    if (r - l < sw * 0.1 || y < 1) continue;
    let edge = 0;
    let n = 0;
    for (let x = l; x <= r; x += 2) {
      edge += Math.abs(gray[y * sw + x] - gray[(y - 1) * sw + x]);
      n++;
    }
    const avg = n > 0 ? edge / n : 0;
    if (avg > bestLocal) {
      bestLocal = avg;
      bestY = y;
    }
  }
  return bestY;
}

/**
 * 多幀 foul Y 投票（Workbench multi-seek 可用）。
 * Black-Lights：跨幀 heatmap → 勝出 bin。單幀 detect 唔強制呼叫。
 */
export function voteFoulYAcrossFrames(foulYs: number[], sh: number): number | null {
  const valid = foulYs.filter((y) => y >= sh * 0.68 && y <= sh * 0.96);
  if (valid.length < 2) return valid.length === 1 ? valid[0] : null;
  const y0 = Math.floor(sh * 0.7);
  const y1 = Math.floor(sh * 0.94);
  const binH = Math.max(2, Math.round(sh * 0.012));
  const nBins = Math.max(1, Math.ceil((y1 - y0 + 1) / binH));
  const votes = new Float64Array(nBins);
  for (const y of valid) {
    const bi = Math.min(nBins - 1, Math.max(0, Math.floor((y - y0) / binH)));
    votes[bi] += 1;
  }
  let bestBin = 0;
  let bestV = -1;
  for (let i = 0; i < nBins; i++) {
    if (votes[i] > bestV) {
      bestV = votes[i];
      bestBin = i;
    }
  }
  if (bestV < Math.max(2, valid.length * 0.15)) {
    // 不夠集中：用中位數
    const sorted = [...valid].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
  const binY0 = y0 + bestBin * binH;
  const inBin = valid.filter(
    (y) => y >= binY0 && y < binY0 + binH
  );
  if (inBin.length === 0) return binY0 + binH / 2;
  return inBin.reduce((a, b) => a + b, 0) / inBin.length;
}

function findPinsY(
  gray: Uint8ClampedArray,
  sw: number,
  sh: number,
  lefts: (number | null)[],
  rights: (number | null)[],
  widths: number[],
  yFoul: number
): number {
  let yPins = sh * 0.1;
  const yMax = Math.min(Math.floor(sh * 0.32), Math.floor(yFoul * 0.42));
  let streak = 0;
  let firstStable = -1;
  for (let y = Math.floor(sh * 0.04); y <= yMax; y++) {
    if (lefts[y] != null && rights[y] != null && widths[y] >= sw * 0.07) {
      streak++;
      if (streak >= 3 && firstStable < 0) firstStable = y - 2;
    } else {
      streak = 0;
    }
  }
  if (firstStable >= 0) {
    yPins = Math.max(sh * 0.085, firstStable - sh * 0.01);
  }

  let pinGlowY = -1;
  let glowBest = 0;
  for (let y = Math.floor(sh * 0.03); y <= Math.floor(sh * 0.2); y++) {
    let hi = 0;
    for (let x = Math.floor(sw * 0.28); x < Math.floor(sw * 0.72); x++) {
      if (gray[y * sw + x] > 200) hi++;
    }
    if (hi > glowBest) {
      glowBest = hi;
      pinGlowY = y;
    }
  }
  if (pinGlowY >= 0 && glowBest > sw * 0.015) {
    yPins = Math.min(yPins, Math.max(sh * 0.085, pinGlowY - sh * 0.01));
  }
  return yPins;
}

function fitLineRobust(
  ys: number[],
  xs: number[]
): { a: number; b: number; inlierRatio: number } | null {
  const first = fitLine(ys, xs);
  if (!first) return null;
  const res: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    res.push(Math.abs(xs[i] - (first.a + first.b * ys[i])));
  }
  const sorted = [...res].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 1;
  const thr = Math.max(2.5, med * 2.5);
  const iy: number[] = [];
  const ix: number[] = [];
  for (let i = 0; i < ys.length; i++) {
    if (res[i] <= thr) {
      iy.push(ys[i]);
      ix.push(xs[i]);
    }
  }
  const inlierRatio = iy.length / ys.length;
  if (iy.length < 6) return { ...first, inlierRatio };
  const second = fitLine(iy, ix);
  if (!second) return { ...first, inlierRatio };
  return { ...second, inlierRatio };
}

function fitLine(
  ys: number[],
  xs: number[]
): { a: number; b: number } | null {
  const n = ys.length;
  if (n < 4) return null;
  let sumY = 0;
  let sumX = 0;
  let sumYY = 0;
  let sumYX = 0;
  for (let i = 0; i < n; i++) {
    sumY += ys[i];
    sumX += xs[i];
    sumYY += ys[i] * ys[i];
    sumYX += ys[i] * xs[i];
  }
  const den = n * sumYY - sumY * sumY;
  if (Math.abs(den) < 1e-6) return null;
  const b = (n * sumYX - sumY * sumX) / den;
  const a = (sumX - b * sumY) / n;
  return { a, b };
}

function nudgeEdge(
  gray: Uint8ClampedArray,
  sw: number,
  sh: number,
  p: Point2D,
  side: -1 | 1,
  outwardBias = 0.15
): Point2D {
  const y = Math.max(1, Math.min(sh - 2, Math.round(p.y)));
  const x0 = Math.max(2, Math.min(sw - 3, Math.round(p.x)));
  let bestX = x0;
  let bestG = -1;
  const span = Math.max(4, Math.round(sw * 0.045));
  for (let dx = -span; dx <= span; dx++) {
    const x = x0 + dx;
    if (x < 1 || x >= sw - 1) continue;
    const g = Math.abs(gray[y * sw + x + 1] - gray[y * sw + x - 1]);
    const bias = side < 0 ? -dx * outwardBias : dx * outwardBias;
    const score = g + bias;
    if (score > bestG) {
      bestG = score;
      bestX = x;
    }
  }
  return { x: bestX, y: p.y };
}

function edgeGradientScore(
  gray: Uint8ClampedArray,
  sw: number,
  sh: number,
  corners: LaneCorners,
  scale: number
): number {
  const pts = [corners.tl, corners.bl, corners.tr, corners.br];
  let sum = 0;
  let n = 0;
  for (const p of pts) {
    const x = Math.round(p.x * scale);
    const y = Math.round(p.y * scale);
    if (x < 1 || x >= sw - 1 || y < 0 || y >= sh) continue;
    sum += Math.abs(gray[y * sw + x + 1] - gray[y * sw + x - 1]);
    n++;
  }
  if (n === 0) return 0.3;
  return Math.max(0, Math.min(1, sum / n / 40));
}

function aspectSanityPenalty(
  corners: LaneCorners,
  width: number,
  height: number
): number {
  const botW = Math.hypot(
    corners.br.x - corners.bl.x,
    corners.br.y - corners.bl.y
  );
  const topW = Math.hypot(
    corners.tr.x - corners.tl.x,
    corners.tr.y - corners.tl.y
  );
  const leftL = Math.hypot(
    corners.tl.x - corners.bl.x,
    corners.tl.y - corners.bl.y
  );
  const rightL = Math.hypot(
    corners.tr.x - corners.br.x,
    corners.tr.y - corners.br.y
  );
  if (botW < 1 || topW < 1) return 0.2;
  const ratio = topW / botW;
  let pen = 0;
  if (ratio > 0.95 || ratio < 0.1) pen += 0.12;
  const sideAsym = Math.abs(leftL - rightL) / Math.max(leftL, rightL);
  if (sideAsym > 0.25) pen += 0.08;
  const hImg =
    (corners.bl.y + corners.br.y) / 2 - (corners.tl.y + corners.tr.y) / 2;
  if (hImg < height * 0.45) pen += 0.1;
  void LANE_ASPECT;
  void width;
  return pen;
}

function downscaleGray(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  sw: number,
  sh: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(sw * sh);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(h - 1, Math.floor((y / sh) * h));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(w - 1, Math.floor((x / sw) * w));
      const i = (sy * w + sx) * 4;
      out[y * sw + x] =
        (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    }
  }
  return out;
}

function clampPt(p: Point2D, w: number, h: number): Point2D {
  return {
    x: Math.max(0, Math.min(w - 1, p.x)),
    y: Math.max(0, Math.min(h - 1, p.y)),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
