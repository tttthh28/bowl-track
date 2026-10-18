import type { LaneCorners, Point2D } from "./types";
import { defaultCorners } from "./perspective";

export type LaneDetectResult = {
  corners: LaneCorners;
  /** 0–1 粗信心；偏低時建議改手動 */
  confidence: number;
  message: string;
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

export function detectLaneCorners(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): LaneDetectResult | null {
  if (width < 80 || height < 80) return null;
  if (!frameHasLaneSignal(rgba, width, height)) return null;

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

  // 多閾值；重罰頂中線相對底中線 skew／頂邊偏離中央（易鎖隔鄰／溝）
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
  return best;
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
    pinY >= height * 0.08 && pinY <= height * 0.17
      ? 1
      : pinY < height * 0.08
        ? 0.15
        : 0.55;
  const topW = c.tr.x - c.tl.x;
  const botW = c.br.x - c.bl.x;
  const trap =
    botW > topW * 1.05 && topW > width * 0.08 && botW > width * 0.2 ? 1 : 0.3;
  // 頂右偏（吸右鄰）重罰；頂略左（本 demo 常見）唔罰
  const rightSkewPen = skewSigned > 0.02 ? skewSigned * 200 : 0;
  const absSkewPen = skewAbs > 0.08 ? (skewAbs - 0.08) * 80 : 0;
  // 單道寬：底寬吞鄰道／人影時常見 >52% 畫面
  const botFrac = botW / Math.max(1, width);
  const wideBotPen =
    botFrac > 0.48 ? (botFrac - 0.48) * 160 : botFrac > 0.44 ? (botFrac - 0.44) * 40 : 0;
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
  return (
    cand.confidence * 100 +
    pinBand * 22 +
    trap * 12 -
    centerPen -
    rightSkewPen -
    absSkewPen -
    wideBotPen -
    taperPen -
    edgePen
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
    // 防中線漂去鄰道：拉返中央
    if (Math.abs(nextMid - centerX) > sw * 0.12) {
      nextMid = nextMid * 0.45 + centerX * 0.55;
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

  const leftFit = fitLineRobust(
    useFit.map((s) => s.y),
    useFit.map((s) => s.l)
  );
  const rightFit = fitLineRobust(
    useFit.map((s) => s.y),
    useFit.map((s) => s.r)
  );
  if (!leftFit || !rightFit) return null;

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

  // 單道寬度夾緊：以頂／底中線為軸對稱收放（防切人／吞鄰道，又唔鎖錯鄰道）
  {
    botW = br.x - bl.x;
    topW = tr.x - tl.x;
    const midBot = (bl.x + br.x) / 2;
    const midTop = (tl.x + tr.x) / 2;
    // 頂若明顯偏右／偏左，拉近底中線（本 demo 球道近中央）
    let midUse = midBot;
    if (Math.abs(midTop - sw * 0.5) < Math.abs(midBot - sw * 0.5)) {
      midUse = midBot * 0.35 + midTop * 0.65;
    } else {
      midUse = midBot * 0.7 + (sw * 0.5) * 0.3;
    }
    const idealBot = clamp(
      Math.max(topW * 3.8, sw * 0.36),
      sw * 0.34,
      sw * 0.46
    );
    if (botW > idealBot * 1.05 || botW < idealBot * 0.85 || Math.abs(midBot - midUse) > sw * 0.03) {
      const half = idealBot / 2;
      bl = { ...bl, x: midUse - half };
      br = { ...br, x: midUse + half };
      botW = br.x - bl.x;
    }
    // 頂寬跟底透視
    const ratio2 = topW / Math.max(1, botW);
    if (ratio2 < 0.18 || ratio2 > 0.4 || Math.abs((tl.x + tr.x) / 2 - midUse) > sw * 0.04) {
      const targetTop = clamp(botW * 0.28, sw * 0.09, botW * 0.38);
      tl = { ...tl, x: midUse - targetTop / 2 };
      tr = { ...tr, x: midUse + targetTop / 2 };
      topW = targetTop;
    }
  }

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
  if (finalBot > width * 0.5) confidence -= 0.14; // 底過寬＝多半鎖鄰道
  else if (finalBot > width * 0.46) confidence -= 0.07;
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
    // 保留原段作候選（若中線本身就近且溝好）
    candidates.push(r);
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
      wFrac < 0.28 ? (0.28 - wFrac) * 90 : wFrac > 0.52 ? (wFrac - 0.52) * 140 : 0;
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

function findFoulY(
  gray: Uint8ClampedArray,
  sw: number,
  sh: number,
  widths: number[],
  leftFit: { a: number; b: number },
  rightFit: { a: number; b: number }
): number {
  let bestY = sh * 0.88;
  let bestScore = -1;
  const y0 = Math.floor(sh * 0.7);
  const y1 = Math.floor(sh * 0.94);
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
    const score = avgEdge * 1.1 + w * 0.04 + (y / sh) * 10;
    if (score > bestScore) {
      bestScore = score;
      bestY = y;
    }
  }
  return bestY;
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
