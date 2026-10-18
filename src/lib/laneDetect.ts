import type { LaneCorners, Point2D } from "./types";
import { defaultCorners } from "./perspective";

export type LaneDetectResult = {
  corners: LaneCorners;
  /** 0–1 粗信心；偏低時建議改手動 */
  confidence: number;
  message: string;
};

/**
 * 瀏覽器端球道四角自動偵測（無 OpenCV）。
 * 假設後方視角：下方 foul（較寬）、上方 pins（較窄），球道相對偏亮。
 * 流程：縮圖 → 亮區遮罩 → 每列找左右邊緣 → 擬合梯形四角。
 */
export function detectLaneCorners(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): LaneDetectResult | null {
  if (width < 80 || height < 80) return null;

  // 縮到約 320 寬以加速
  const scale = Math.min(1, 320 / width);
  const sw = Math.max(40, Math.round(width * scale));
  const sh = Math.max(40, Math.round(height * scale));
  const gray = downscaleGray(rgba, width, height, sw, sh);

  // 估計全域亮度，球道通常比 gutter／背景亮
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;
  const thr = Math.min(220, Math.max(90, mean + 12));

  // 每列掃描亮區左右邊界（略做平滑）
  const lefts: (number | null)[] = new Array(sh).fill(null);
  const rights: (number | null)[] = new Array(sh).fill(null);
  const widths: number[] = new Array(sh).fill(0);

  for (let y = 0; y < sh; y++) {
    let first = -1;
    let last = -1;
    // 要求連續亮段，避免雜點
    let run = 0;
    let bestRun = 0;
    let bestStart = -1;
    let bestEnd = -1;
    let runStart = 0;
    for (let x = 0; x < sw; x++) {
      const v = gray[y * sw + x];
      if (v >= thr) {
        if (run === 0) runStart = x;
        run++;
        if (run > bestRun) {
          bestRun = run;
          bestStart = runStart;
          bestEnd = x;
        }
      } else {
        run = 0;
      }
    }
    if (bestRun >= Math.max(8, sw * 0.08)) {
      first = bestStart;
      last = bestEnd;
      lefts[y] = first;
      rights[y] = last;
      widths[y] = last - first + 1;
    }
  }

  // 取中下～中上有效列（foul～pins 區間）
  const yBot = Math.floor(sh * 0.88);
  const yTop = Math.floor(sh * 0.12);
  const samples: { y: number; l: number; r: number; w: number }[] = [];
  for (let y = yTop; y <= yBot; y++) {
    if (lefts[y] == null || rights[y] == null) continue;
    samples.push({
      y,
      l: lefts[y]!,
      r: rights[y]!,
      w: widths[y],
    });
  }
  if (samples.length < 12) {
    return null;
  }

  // 期望梯形：下方較寬、上方較窄（後方視角）
  const lower = samples.filter((s) => s.y > sh * 0.55);
  const upper = samples.filter((s) => s.y < sh * 0.4);
  if (lower.length < 3 || upper.length < 3) return null;

  const avgW = (arr: typeof samples) =>
    arr.reduce((a, s) => a + s.w, 0) / arr.length;
  const wLow = avgW(lower);
  const wUp = avgW(upper);
  // 若上下寬度幾乎一樣或上更寬，信心降低但仍嘗試
  let confidence = 0.55;
  if (wLow > wUp * 1.08) confidence = 0.75;
  else if (wLow < wUp * 0.95) confidence = 0.35;

  // 線性擬合左／右邊緣：x = a + b*y
  const leftFit = fitLine(
    samples.map((s) => s.y),
    samples.map((s) => s.l)
  );
  const rightFit = fitLine(
    samples.map((s) => s.y),
    samples.map((s) => s.r)
  );
  if (!leftFit || !rightFit) return null;

  const yFoul = sh * 0.86;
  const yPins = sh * 0.16;
  let bl: Point2D = { x: leftFit.a + leftFit.b * yFoul, y: yFoul };
  let br: Point2D = { x: rightFit.a + rightFit.b * yFoul, y: yFoul };
  let tl: Point2D = { x: leftFit.a + leftFit.b * yPins, y: yPins };
  let tr: Point2D = { x: rightFit.a + rightFit.b * yPins, y: yPins };

  // 合理性檢查
  const botW = br.x - bl.x;
  const topW = tr.x - tl.x;
  if (botW < sw * 0.15 || topW < sw * 0.06) return null;
  if (bl.x >= br.x || tl.x >= tr.x) return null;
  if (Math.abs(botW - topW) / sw < 0.02 && confidence > 0.4) {
    confidence = Math.min(confidence, 0.45);
  }

  // 邊緣強化：在擬合附近用梯度微調（可選、輕量）
  bl = nudgeEdge(gray, sw, sh, bl, -1);
  br = nudgeEdge(gray, sw, sh, br, 1);
  tl = nudgeEdge(gray, sw, sh, tl, -1);
  tr = nudgeEdge(gray, sw, sh, tr, 1);

  // 映回原圖座標
  const inv = 1 / scale;
  const corners: LaneCorners = {
    tl: clampPt({ x: tl.x * inv, y: tl.y * inv }, width, height),
    tr: clampPt({ x: tr.x * inv, y: tr.y * inv }, width, height),
    br: clampPt({ x: br.x * inv, y: br.y * inv }, width, height),
    bl: clampPt({ x: bl.x * inv, y: bl.y * inv }, width, height),
  };

  // 覆蓋率：有效列比例
  const cover = samples.length / (yBot - yTop + 1);
  confidence = Math.max(0.2, Math.min(0.92, confidence * (0.6 + 0.4 * cover)));

  return {
    corners,
    confidence,
    message:
      confidence >= 0.55
        ? "已估四角（請確認 foul～pins），可微調藍點"
        : "自動估角信心偏低，建議改手動拖曳",
  };
}

/** 從 video／canvas 讀一幀並偵測；失敗回 null */
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

/** 沿水平方向找亮度梯度最大處微調邊緣 */
function nudgeEdge(
  gray: Uint8ClampedArray,
  sw: number,
  sh: number,
  p: Point2D,
  side: -1 | 1
): Point2D {
  const y = Math.max(1, Math.min(sh - 2, Math.round(p.y)));
  const x0 = Math.max(2, Math.min(sw - 3, Math.round(p.x)));
  let bestX = x0;
  let bestG = -1;
  const span = Math.max(4, Math.round(sw * 0.04));
  for (let dx = -span; dx <= span; dx++) {
    const x = x0 + dx;
    if (x < 1 || x >= sw - 1) continue;
    const g = Math.abs(gray[y * sw + x + 1] - gray[y * sw + x - 1]);
    // 偏好外側（往 gutter）
    const bias = side < 0 ? -dx * 0.15 : dx * 0.15;
    const score = g + bias;
    if (score > bestG) {
      bestG = score;
      bestX = x;
    }
  }
  return { x: bestX, y: p.y };
}

function clampPt(p: Point2D, w: number, h: number): Point2D {
  return {
    x: Math.max(0, Math.min(w - 1, p.x)),
    y: Math.max(0, Math.min(h - 1, p.y)),
  };
}
