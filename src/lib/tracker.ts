import type { Point2D, TrackerSettings } from "./types";

export const DEFAULT_TRACKER: TrackerSettings = {
  sensitivity: 28,
  minBlobPixels: 40,
  lostFramesToEnd: 12,
};

/**
 * 相鄰幀灰階差 → 閾值 → 最大 blob 質心。
 * 使用簡單 flood-fill 找最大連通區（4-連通）。
 */
export function findBallCentroid(
  currGray: Uint8ClampedArray,
  prevGray: Uint8ClampedArray,
  width: number,
  height: number,
  settings: TrackerSettings,
  /** 可選：限制搜尋 ROI（球道四邊形外接矩形） */
  roi?: { x0: number; y0: number; x1: number; y1: number }
): Point2D | null {
  const thr = settings.sensitivity;
  const x0 = Math.max(0, Math.floor(roi?.x0 ?? 0));
  const y0 = Math.max(0, Math.floor(roi?.y0 ?? 0));
  const x1 = Math.min(width, Math.ceil(roi?.x1 ?? width));
  const y1 = Math.min(height, Math.ceil(roi?.y1 ?? height));

  const mask = new Uint8Array(width * height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      const d = Math.abs(currGray[i] - prevGray[i]);
      if (d >= thr) mask[i] = 1;
    }
  }

  // 找最大 blob
  const visited = new Uint8Array(width * height);
  let bestSize = 0;
  let bestCx = 0;
  let bestCy = 0;

  const stackX: number[] = [];
  const stackY: number[] = [];

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const start = y * width + x;
      if (!mask[start] || visited[start]) continue;

      stackX.length = 0;
      stackY.length = 0;
      stackX.push(x);
      stackY.push(y);
      visited[start] = 1;

      let size = 0;
      let sumX = 0;
      let sumY = 0;

      while (stackX.length) {
        const cx = stackX.pop()!;
        const cy = stackY.pop()!;
        size++;
        sumX += cx;
        sumY += cy;

        const neighbors = [
          [cx + 1, cy],
          [cx - 1, cy],
          [cx, cy + 1],
          [cx, cy - 1],
        ];
        for (const [nx, ny] of neighbors) {
          if (nx < x0 || nx >= x1 || ny < y0 || ny >= y1) continue;
          const ni = ny * width + nx;
          if (!mask[ni] || visited[ni]) continue;
          visited[ni] = 1;
          stackX.push(nx);
          stackY.push(ny);
        }
      }

      if (size > bestSize) {
        bestSize = size;
        bestCx = sumX / size;
        bestCy = sumY / size;
      }
    }
  }

  if (bestSize < settings.minBlobPixels) return null;
  return { x: bestCx, y: bestCy };
}

export function rgbaToGray(
  data: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    // ITU-R BT.601
    gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  return gray;
}

export function cornersBBox(
  corners: { tl: Point2D; tr: Point2D; br: Point2D; bl: Point2D },
  pad = 8
): { x0: number; y0: number; x1: number; y1: number } {
  const xs = [corners.tl.x, corners.tr.x, corners.br.x, corners.bl.x];
  const ys = [corners.tl.y, corners.tr.y, corners.br.y, corners.bl.y];
  return {
    x0: Math.min(...xs) - pad,
    y0: Math.min(...ys) - pad,
    x1: Math.max(...xs) + pad,
    y1: Math.max(...ys) + pad,
  };
}
