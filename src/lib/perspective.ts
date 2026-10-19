import type { LaneCorners, LanePoint, Point2D } from "./types";

/**
 * 簡化球道：寬 39 boards、長 60 feet。
 *
 * 四角以「畫面位置」命名（TL/TR/BR/BL）。
 * 預設假設從投手後方拍攝：畫面上方＝pin deck、下方＝foul line。
 *   TL → board=0, feet=60
 *   TR → board=39, feet=60
 *   BR → board=39, feet=0
 *   BL → board=0, feet=0
 *
 * 若相機角度不同，仍可拖曳四角對準實際 foul／pins 端點。
 */

export const LANE_W = 39;
export const LANE_L = 60;

/** 解 8x8 線性系統（高斯消去）求透視矩陣 */
function solveHomography(
  src: Point2D[],
  dst: Point2D[]
): number[] | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const M = A.map((row, i) => [...row, b[i]]);
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

export type Homography = {
  h: number[];
};

export function buildHomography(corners: LaneCorners): Homography | null {
  const src: Point2D[] = [corners.tl, corners.tr, corners.br, corners.bl];
  // 後方視角預設：上=pins(60)、下=foul(0)
  const dst: Point2D[] = [
    { x: 0, y: LANE_L },
    { x: LANE_W, y: LANE_L },
    { x: LANE_W, y: 0 },
    { x: 0, y: 0 },
  ];
  const h = solveHomography(src, dst);
  if (!h) return null;
  return { h };
}

/**
 * Track／homography 用四角（顯示四角唔改 — Tony 視覺 bar / r9 真溝）。
 *
 * 1) pins 去 skew：pin mid → foul mid（避 pointInLane 拒球＋feet 壓縮）
 * 2) 全溝 foul（botFrac>0.52）：映射底內縮到 0.50×W、頂 0.16×W
 *    （r9 真溝 bot≈0.59 若沿用顯示底 → arr/med 塌到 ~4–5；0.50/0.16 → path@15′∈[13,15]）
 * 3) 已內縮 foul（botFrac≤0.52）：保留 foul，只去 pin skew（legacy top≈0.18×W）
 */
export function mappingCornersForTrack(
  corners: LaneCorners,
  frameWidth?: number
): LaneCorners {
  const midF = (corners.bl.x + corners.br.x) / 2;
  const botW = Math.max(8, corners.br.x - corners.bl.x);
  const pinY = (corners.tl.y + corners.tr.y) / 2;
  const foulY = (corners.bl.y + corners.br.y) / 2;
  const xMax = Math.max(corners.bl.x, corners.br.x, corners.tl.x, corners.tr.x);
  // Prefer real frame width; fallback ≈ BR / 0.77 (demo rear-view red lip)
  // Fallback: BR≈0.77W on demo rear-view; never use botW/0.5 (that forces botFrac=0.5
  // and skips the full-gutter inset path when width is omitted).
  const W = Math.max(
    64,
    frameWidth && frameWidth > 0 ? frameWidth : Math.max(xMax / 0.77, botW / 0.62)
  );
  const botFrac = botW / W;
  // Calibrated on bowling-demo r9 display (BL184/BR810 @1060): arr=path@15′=13.0
  const MAP_BOT = 0.5;
  const MAP_TOP = 0.16;
  if (botFrac > 0.52) {
    const mapBotW = MAP_BOT * W;
    const mapTopW = MAP_TOP * W;
    return {
      bl: { x: midF - mapBotW / 2, y: foulY },
      br: { x: midF + mapBotW / 2, y: foulY },
      tl: { x: midF - mapTopW / 2, y: pinY },
      tr: { x: midF + mapTopW / 2, y: pinY },
    };
  }
  // Legacy inset foul: keep display BL/BR, de-skew pins only
  const topW = botW * (0.18 / 0.56);
  return {
    bl: { ...corners.bl },
    br: { ...corners.br },
    tl: { x: midF - topW / 2, y: pinY },
    tr: { x: midF + topW / 2, y: pinY },
  };
}

/** 顯示四角 → 追蹤／估計用 H（去 pin skew；全溝時內縮 mapping bot） */
export function buildTrackHomography(
  corners: LaneCorners,
  frameWidth?: number
): Homography | null {
  return buildHomography(mappingCornersForTrack(corners, frameWidth));
}

export function applyHomography(H: Homography, p: Point2D): Point2D {
  const [a, b, c, d, e, f, g, hh] = H.h;
  const w = g * p.x + hh * p.y + 1;
  if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
  return {
    x: (a * p.x + b * p.y + c) / w,
    y: (d * p.x + e * p.y + f) / w,
  };
}

export function imageToLane(H: Homography, p: Point2D): LanePoint {
  const q = applyHomography(H, p);
  // 輕微容差外不硬夾到溝邊（避免誤追左溝永遠變成 board=0）
  return {
    board: Math.max(-2, Math.min(LANE_W + 2, q.x)),
    feet: Math.max(-2, Math.min(LANE_L + 2, q.y)),
  };
}

export type BoardAtFeetResult = {
  board: number;
  /** true＝目標 feet 超出軌跡覆蓋，以端點斜率外推 */
  extrapolated: boolean;
};

export type TrajectoryCoverage = {
  minFeet: number;
  maxFeet: number;
  span: number;
  count: number;
};

/**
 * bowling-demo：剔尖角折線 + 沿 feet 平滑 board（顯示／估計用）。
 * 保留大致 foul→pins 單調前進，避免 softRelock／預測造成 polyline V／折角。
 * 強化：同 feet 合併、早段 V 峰剔除、更緊 turn 門檻、多趟 board 平滑。
 */
export function smoothDemoPath<T extends { lane?: LanePoint; predicted?: boolean; image: { x: number; y: number }; t: number }>(
  points: T[]
): T[] {
  const withLane = points.filter((p) => p.lane);
  if (withLane.length < 5) return points;
  const sorted = [...withLane].sort(
    (a, b) => a.lane!.feet - b.lane!.feet
  );

  // 1) 合併近距離 feet（防 49.9′ 震盪折角）
  const collapsed: T[] = [];
  for (const p of sorted) {
    const last = collapsed[collapsed.length - 1];
    if (
      last?.lane &&
      p.lane &&
      Math.abs(p.lane.feet - last.lane.feet) < 0.45
    ) {
      const preferNew = last.predicted && !p.predicted;
      const preferOld = !last.predicted && p.predicted;
      const board = preferOld
        ? last.lane.board
        : preferNew
          ? p.lane.board
          : (last.lane.board + p.lane.board) / 2;
      const feet = (last.lane.feet + p.lane.feet) / 2;
      collapsed[collapsed.length - 1] = {
        ...(preferNew ? p : last),
        lane: { feet, board },
        predicted: last.predicted && p.predicted ? true : undefined,
      } as T;
    } else {
      collapsed.push(p);
    }
  }
  if (collapsed.length < 5) return collapsed;

  // 2) 剔尖角（預測更嚴；非預測亦降門檻）
  const dropTurns = (src: T[]): T[] => {
    const out: T[] = [src[0]];
    for (let i = 1; i < src.length - 1; i++) {
      const prev = out[out.length - 1];
      const cur = src[i];
      const next = src[i + 1];
      if (!prev.lane || !cur.lane || !next.lane) {
        out.push(cur);
        continue;
      }
      const df1 = Math.max(0.15, cur.lane.feet - prev.lane.feet);
      const df2 = Math.max(0.15, next.lane.feet - cur.lane.feet);
      const slope1 = (cur.lane.board - prev.lane.board) / df1;
      const slope2 = (next.lane.board - cur.lane.board) / df2;
      const turn = Math.abs(slope2 - slope1);
      const early = cur.lane.feet < 22;
      const predLim = early ? 1.6 : 2.2;
      const hardLim = early ? 2.4 : 3.2;
      if (turn > predLim && cur.predicted) continue;
      if (turn > hardLim) continue;
      out.push(cur);
    }
    out.push(src[src.length - 1]);
    return out;
  };
  let kept = dropTurns(collapsed);

  // 3) 早段／袋口前 V 峰：相對弦高 > 2.2 board 則丟（Tony：無角）
  const dropVPeaks = (src: T[]): T[] => {
    if (src.length < 4) return src;
    const out: T[] = [src[0]];
    for (let i = 1; i < src.length - 1; i++) {
      const prev = out[out.length - 1];
      const cur = src[i];
      // 找右側足夠遠嘅錨（≥2.5′），唔好用緊鄰
      let next = src[i + 1];
      for (let j = i + 1; j < src.length; j++) {
        if (
          src[j].lane &&
          cur.lane &&
          src[j].lane!.feet - cur.lane.feet >= 2.5
        ) {
          next = src[j];
          break;
        }
        next = src[j];
      }
      if (!prev.lane || !cur.lane || !next.lane) {
        out.push(cur);
        continue;
      }
      const df = next.lane.feet - prev.lane.feet;
      if (df < 1.2) {
        out.push(cur);
        continue;
      }
      const u = (cur.lane.feet - prev.lane.feet) / df;
      const chord = prev.lane.board + u * (next.lane.board - prev.lane.board);
      const elev = Math.abs(cur.lane.board - chord);
      const inVZone =
        cur.lane.feet < 22 ||
        (cur.lane.feet >= 45 && cur.lane.feet <= 55);
      if (inVZone && elev > 2.2) continue;
      if (inVZone && elev > 1.5 && cur.predicted) continue;
      out.push(cur);
    }
    out.push(src[src.length - 1]);
    return out;
  };
  kept = dropVPeaks(kept);
  if (kept.length >= 5) kept = dropTurns(kept);

  // 4) 多趟加權 board 平滑（端點保留；中段去折）
  const smoothPass = (src: T[]): T[] =>
    src.map((p, i) => {
      if (!p.lane || i === 0 || i === src.length - 1) return p;
      const a = src[i - 1].lane!.board;
      const b = p.lane.board;
      const c = src[i + 1].lane!.board;
      if (src.length >= 5 && i >= 2 && i <= src.length - 3) {
        const a2 = src[i - 2].lane!.board;
        const c2 = src[i + 2].lane!.board;
        return {
          ...p,
          lane: {
            feet: p.lane.feet,
            board: a2 * 0.1 + a * 0.2 + b * 0.4 + c * 0.2 + c2 * 0.1,
          },
        };
      }
      return {
        ...p,
        lane: { feet: p.lane.feet, board: a * 0.25 + b * 0.5 + c * 0.25 },
      };
    });
  kept = smoothPass(smoothPass(kept));

  // 5) 殘餘高 turn：把中點拉向弦（唔刪點，保覆蓋）
  for (let i = 1; i < kept.length - 1; i++) {
    const prev = kept[i - 1];
    const cur = kept[i];
    const next = kept[i + 1];
    if (!prev.lane || !cur.lane || !next.lane) continue;
    const df1 = Math.max(0.15, cur.lane.feet - prev.lane.feet);
    const df2 = Math.max(0.15, next.lane.feet - cur.lane.feet);
    const turn = Math.abs(
      (next.lane.board - cur.lane.board) / df2 -
        (cur.lane.board - prev.lane.board) / df1
    );
    if (turn > 1.4) {
      const df = next.lane.feet - prev.lane.feet;
      const u = df > 0.01 ? (cur.lane.feet - prev.lane.feet) / df : 0.5;
      const chord =
        prev.lane.board + u * (next.lane.board - prev.lane.board);
      kept[i] = {
        ...cur,
        lane: {
          feet: cur.lane.feet,
          board: cur.lane.board * 0.35 + chord * 0.65,
        },
      };
    }
  }

  // 末趟輕平滑：壓低殘餘 jagged（保端點）
  kept = smoothPass(kept);

  // 6) 疏點 densify：cubic Hermite board(feet) 重採樣，避免 Catmull 喺 8 點折線造 13–15′ elbow
  kept = densifyDemoPathCubic(kept);

  // 7) 密點後再限曲率（尤其 tony／arrows 10–20′）：拉向弦，散開 heading 轉折
  kept = limitDemoPathCurvature(kept);

  // 8) arrows 帶局部二次擬合：把殘餘 13–15′ elbow 拉成漸變 hook
  kept = blendTonyBandQuadratic(kept);

  // 密點後再輕平滑一次
  if (kept.length >= 5) kept = smoothPass(kept);
  return kept;
}

/** arrows／tony 帶：局部二次 board(feet) 混合，殺 diagonal→vertical elbow */
function blendTonyBandQuadratic<
  T extends {
    lane?: LanePoint;
    predicted?: boolean;
    image: { x: number; y: number };
    t: number;
  }
>(src: T[]): T[] {
  if (src.length < 6) return src;
  const L = src.filter((p) => p.lane);
  if (L.length < 6) return src;

  // 最小二乘二次：board ≈ a + b f + c f²，用視窗內點
  const fitQuad = (
    pts: { feet: number; board: number }[]
  ): ((f: number) => number) | null => {
    if (pts.length < 4) return null;
    let s0 = 0,
      s1 = 0,
      s2 = 0,
      s3 = 0,
      s4 = 0;
    let y0 = 0,
      y1 = 0,
      y2 = 0;
    for (const p of pts) {
      const f = p.feet;
      const f2 = f * f;
      const f3 = f2 * f;
      const f4 = f2 * f2;
      s0 += 1;
      s1 += f;
      s2 += f2;
      s3 += f3;
      s4 += f4;
      y0 += p.board;
      y1 += p.board * f;
      y2 += p.board * f2;
    }
    // 解 3x3 正規方程
    const M = [
      [s0, s1, s2, y0],
      [s1, s2, s3, y1],
      [s2, s3, s4, y2],
    ];
    for (let col = 0; col < 3; col++) {
      let piv = col;
      for (let r = col + 1; r < 3; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      }
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      if (piv !== col) {
        const tmp = M[col];
        M[col] = M[piv];
        M[piv] = tmp;
      }
      const div = M[col][col];
      for (let c = col; c < 4; c++) M[col][c] /= div;
      for (let r = 0; r < 3; r++) {
        if (r === col) continue;
        const f = M[r][col];
        for (let c = col; c < 4; c++) M[r][c] -= f * M[col][c];
      }
    }
    const a = M[0][3],
      b = M[1][3],
      c = M[2][3];
    return (f: number) => a + b * f + c * f * f;
  };

  // 一次全局二次（foul→~30′），arrows 帶大力混合
  const early = L.filter(
    (p) => p.lane!.feet >= 4 && p.lane!.feet <= 32
  ).map((p) => ({ feet: p.lane!.feet, board: p.lane!.board }));
  const qEarly = fitQuad(early);
  if (!qEarly) return src;

  return src.map((p, idx) => {
    if (!p.lane) return p;
    if (idx === 0 || idx === src.length - 1) return p;
    const f = p.lane.feet;
    if (f < 9 || f > 22) return p;
    const fitted = qEarly(f);
    // 12–17′ 最強（TesterManual elbow 帶）；兩側漸弱
    let w = 0.35;
    if (f >= 12 && f <= 17) w = 0.82;
    else if (f >= 10 && f <= 19) w = 0.65;
    return {
      ...p,
      lane: {
        feet: f,
        board: p.lane.board * (1 - w) + fitted * w,
      },
    };
  });
}

/** feet→board 單調 cubic Hermite densify（間距 > step 就插點） */
function densifyDemoPathCubic<
  T extends {
    lane?: LanePoint;
    predicted?: boolean;
    image: { x: number; y: number };
    t: number;
  }
>(src: T[], step = 1.25): T[] {
  if (src.length < 3) return src;
  const L = src.filter((p) => p.lane);
  if (L.length < 3) return src;

  const slopeAt = (i: number): number => {
    if (i <= 0) {
      const df = Math.max(0.15, L[1].lane!.feet - L[0].lane!.feet);
      return (L[1].lane!.board - L[0].lane!.board) / df;
    }
    if (i >= L.length - 1) {
      const a = L[L.length - 2];
      const b = L[L.length - 1];
      const df = Math.max(0.15, b.lane!.feet - a.lane!.feet);
      return (b.lane!.board - a.lane!.board) / df;
    }
    const a = L[i - 1];
    const b = L[i + 1];
    const df = Math.max(0.15, b.lane!.feet - a.lane!.feet);
    return (b.lane!.board - a.lane!.board) / df;
  };

  const hermite = (y0: number, m0: number, y1: number, m1: number, u: number, df: number) => {
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    return h00 * y0 + h10 * df * m0 + h01 * y1 + h11 * df * m1;
  };

  const out: T[] = [];
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i];
    const b = L[i + 1];
    out.push(a);
    const df = b.lane!.feet - a.lane!.feet;
    if (df <= step + 0.05) continue;
    const m0 = slopeAt(i);
    const m1 = slopeAt(i + 1);
    const nInsert = Math.min(12, Math.max(1, Math.floor(df / step)));
    for (let k = 1; k <= nInsert; k++) {
      const u = k / (nInsert + 1);
      const feet = a.lane!.feet + u * df;
      // 早段／arrows 帶用較平嘅斜率混合，避免 Hermite 喺折角處過衝
      let board = hermite(a.lane!.board, m0, b.lane!.board, m1, u, df);
      const linear = a.lane!.board + u * (b.lane!.board - a.lane!.board);
      const midFt = feet;
      if (midFt >= 8 && midFt <= 22) {
        // tony band：偏線性，之後 limitCurvature 再散開
        board = board * 0.35 + linear * 0.65;
      } else {
        board = board * 0.7 + linear * 0.3;
      }
      out.push({
        ...a,
        image: {
          x: a.image.x + u * (b.image.x - a.image.x),
          y: a.image.y + u * (b.image.y - a.image.y),
        },
        lane: { feet, board },
        t: a.t + u * (b.t - a.t),
        predicted: true,
      } as T);
    }
  }
  out.push(L[L.length - 1]);
  return out;
}

/**
 * 限 heading 轉折：若相鄰斜率差過大，把中點拉向弦。
 * 喺 10–20′（arrows／tony）用更緊門檻，專打 13–15′ elbow。
 */
function limitDemoPathCurvature<
  T extends {
    lane?: LanePoint;
    predicted?: boolean;
    image: { x: number; y: number };
    t: number;
  }
>(src: T[], passes = 8): T[] {
  if (src.length < 4) return src;
  let cur = src.map((p) => ({ ...p, lane: p.lane ? { ...p.lane } : undefined }));
  for (let pass = 0; pass < passes; pass++) {
    const next = cur.slice();
    for (let i = 1; i < cur.length - 1; i++) {
      const prev = cur[i - 1];
      const mid = cur[i];
      const nxt = cur[i + 1];
      if (!prev.lane || !mid.lane || !nxt.lane) continue;
      // 保 foul／pins 端點
      if (i === 1 || i === cur.length - 2) continue;
      const df1 = Math.max(0.12, mid.lane.feet - prev.lane.feet);
      const df2 = Math.max(0.12, nxt.lane.feet - mid.lane.feet);
      const s1 = (mid.lane.board - prev.lane.board) / df1;
      const s2 = (nxt.lane.board - mid.lane.board) / df2;
      const turn = Math.abs(s2 - s1);
      let ang =
        Math.abs(
          Math.atan2(mid.lane.board - prev.lane.board, df1) -
            Math.atan2(nxt.lane.board - mid.lane.board, df2)
        ) *
        (180 / Math.PI);
      if (ang > 180) ang = 360 - ang;
      const tony = mid.lane.feet >= 10 && mid.lane.feet <= 20;
      const arrows = mid.lane.feet >= 12.5 && mid.lane.feet <= 16.5;
      // arrows 帶最緊（TesterManual 13–15′ elbow）
      const turnLim = arrows ? 0.28 : tony ? 0.4 : 0.85;
      const angLim = arrows ? 5.5 : tony ? 7.5 : 12;
      if (turn < turnLim && ang < angLim) continue;
      const df = nxt.lane.feet - prev.lane.feet;
      const u = df > 0.01 ? (mid.lane.feet - prev.lane.feet) / df : 0.5;
      const chord =
        prev.lane.board + u * (nxt.lane.board - prev.lane.board);
      const w = arrows ? 0.88 : tony ? 0.8 : 0.55;
      next[i] = {
        ...mid,
        lane: {
          feet: mid.lane.feet,
          board: mid.lane.board * (1 - w) + chord * w,
        },
      };
    }
    cur = next;
  }
  // 額外：用 ±2 鄰點弦再拉一次 arrows 帶（散開 1.3′ 內 30° 折）
  const next2 = cur.slice();
  for (let i = 2; i < cur.length - 2; i++) {
    const mid = cur[i];
    if (!mid.lane) continue;
    if (mid.lane.feet < 11 || mid.lane.feet > 18) continue;
    const a = cur[i - 2].lane!;
    const b = cur[i + 2].lane!;
    const df = b.feet - a.feet;
    if (df < 1.5) continue;
    const u = (mid.lane.feet - a.feet) / df;
    const chord = a.board + u * (b.board - a.board);
    next2[i] = {
      ...mid,
      lane: {
        feet: mid.lane.feet,
        board: mid.lane.board * 0.4 + chord * 0.6,
      },
    };
  }
  return next2 as T[];
}

/** 軌跡尖角度量（self-test／門檻）：相鄰 Δboard 二階差均值 */
export function demoPathJaggedness(
  points: { lane?: LanePoint }[]
): number {
  const L = points.filter((p) => p.lane);
  if (L.length < 3) return 0;
  let s = 0;
  let n = 0;
  for (let i = 1; i < L.length - 1; i++) {
    s += Math.abs(
      L[i + 1].lane!.board -
        L[i].lane!.board -
        (L[i].lane!.board - L[i - 1].lane!.board)
    );
    n++;
  }
  return n ? s / n : 0;
}

/**
 * 最大 heading 轉折（度）喺 [lo,hi]′ 帶——專測 13–15′ elbow。
 * 回傳 { maxDeg, atFeet, spanFt }；無點則 maxDeg=0。
 */
export function demoPathMaxElbowDeg(
  points: { lane?: LanePoint }[],
  lo = 10,
  hi = 18
): { maxDeg: number; atFeet: number; spanFt: number } {
  const L = points.filter((p) => p.lane).map((p) => p.lane!);
  let maxDeg = 0;
  let atFeet = 0;
  let spanFt = 0;
  for (let i = 1; i < L.length - 1; i++) {
    const a = L[i - 1];
    const b = L[i];
    const c = L[i + 1];
    if (b.feet < lo || b.feet > hi) continue;
    const df1 = Math.max(0.05, b.feet - a.feet);
    const df2 = Math.max(0.05, c.feet - b.feet);
    const s1 = Math.atan2(b.board - a.board, df1);
    const s2 = Math.atan2(c.board - b.board, df2);
    let d = Math.abs((s2 - s1) * (180 / Math.PI));
    if (d > 180) d = 360 - d;
    if (d > maxDeg) {
      maxDeg = d;
      atFeet = b.feet;
      spanFt = c.feet - a.feet;
    }
  }
  return { maxDeg, atFeet, spanFt };
}

/** 非預測軌跡的 feet 覆蓋範圍 */
export function trajectoryCoverage(
  points: { lane?: LanePoint; predicted?: boolean }[]
): TrajectoryCoverage | null {
  const feet = points
    .filter((p) => p.lane && !p.predicted)
    .map((p) => p.lane!.feet)
    .filter((f) => f >= -1 && f <= LANE_L + 1);
  if (feet.length < 2) return null;
  const minFeet = Math.min(...feet);
  const maxFeet = Math.max(...feet);
  return {
    minFeet,
    maxFeet,
    span: maxFeet - minFeet,
    count: feet.length,
  };
}

/**
 * 在軌跡上取目標 feet 的 board。
 * - 預設只在實際覆蓋區間內插值；超出則回 null（除非 allowExtrapolate）。
 * - allowExtrapolate：以覆蓋端點附近斜率短距外推，並標 extrapolated。
 * - maxGap：端點／最近點距離超過此值視為不足。
 */

/** 最長「大致往 pins 前進」段（feet 單調上升），剪掉回跳／誤鎖 */
export function longestForwardLanePoints(
  points: { lane?: LanePoint; predicted?: boolean }[],
  opts?: { splitOnBoardJump?: boolean; zoomFeetSlop?: boolean }
): LanePoint[] {
  const withLane = points
    .filter((p): p is { lane: LanePoint; predicted?: boolean } => !!p.lane && !p.predicted)
    .map((p) => p.lane);
  if (withLane.length < 2) return withLane;

  const spanOf = (seg: LanePoint[]) => {
    if (seg.length < 2) return 0;
    let lo = seg[0].feet;
    let hi = seg[0].feet;
    for (const p of seg) {
      if (p.feet < lo) lo = p.feet;
      if (p.feet > hi) hi = p.feet;
    }
    return hi - lo;
  };

  const splitBoard = !!opts?.splitOnBoardJump;
  const segments: LanePoint[][] = [];
  let cur: LanePoint[] = [withLane[0]];
  // PBA／變焦：feet 可短暫回退（靜態四角+zoom）；board 橫跳仍緊（防早期假鎖併入箭頭）
  const zoomSlop = !!opts?.zoomFeetSlop || splitBoard;
  const feetBack = zoomSlop ? 10.0 : 0.8;
  const boardJump = splitBoard ? 4.5 : 99;
  for (let i = 1; i < withLane.length; i++) {
    const prev = cur[cur.length - 1];
    const p = withLane[i];
    const dBoard = Math.abs(p.board - prev.board);
    // 預設只按 feet 斷段（保 bowling-demo）；PBA 另斷極端 board 橫跳
    const cont =
      p.feet >= prev.feet - feetBack && (!splitBoard || dBoard <= boardJump);
    if (cont) {
      cur.push(p);
    } else {
      if (cur.length >= 2) segments.push(cur);
      cur = [p];
    }
  }
  if (cur.length >= 2) segments.push(cur);
  if (segments.length === 0) return withLane;

  const scoreSeg = (seg: LanePoint[]) => {
    const sp = spanOf(seg);
    if (!splitBoard) {
      // PBA zoomSlop：唔好淨揀深段（丟 10–20′ 會令球速虛高／BP—）
      // 獎勵覆蓋箭頭區 + 深度；bowling-demo（無 zoomSlop）仍用最大跨距
      if (zoomSlop) {
        const feet = seg.map((s) => s.feet);
        const lo = Math.min(...feet);
        const hi = Math.max(...feet);
        let score = sp * 2 + seg.length * 0.1;
        if (lo <= 16 && hi >= 14) score += 40;
        else if (lo <= 20 && hi >= 12) score += 24;
        if (lo <= 12) score += 22;
        else if (lo <= 16) score += 10;
        if (hi >= 40) score += 16;
        if (hi >= 48) score += 8;
        return score;
      }
      // 舊行為：最大跨距，其次長度
      return sp * 1000 + seg.length;
    }
    const feet = seg.map((s) => s.feet);
    const boards = seg.map((s) => s.board);
    const lo = Math.min(...feet);
    const hi = Math.max(...feet);
    const sortedB = [...boards].sort((a, b) => a - b);
    const medB = sortedB[Math.floor(sortedB.length / 2)];
    let score = sp * 2 + seg.length * 0.08;
    // 箭頭區優先（TesterManual／StrikeTrack 主項）；短 span 唔再 -20 誤殺
    if (lo <= 16 && hi >= 14) score += 36;
    else if (lo <= 18 && hi >= 12) score += 22;
    else if (lo <= 22 && hi >= 10) score += 10;
    if (hi >= 35) score += 14;
    if (hi >= 45) score += 8;
    // PBA 右溝=0 後：合法 Arrows／BP 多在 3–20；溝邊假段降分
    if (medB >= 3 && medB <= 20) score += 12;
    else if (medB < 2.5 || medB > 28) score -= 16;
    // 只罰「又短又唔覆箭頭」嘅碎段
    if (sp < 4 && !(lo <= 18 && hi >= 12)) score -= 20;
    // 偏愛由 foul／arrows 起（唔好淨揀 mid-lane 變焦碎段）
    if (lo <= 12) score += 8;
    else if (lo <= 16) score += 4;
    return score;
  };
  segments.sort((a, b) => scoreSeg(b) - scoreSeg(a));
  const best = segments[0];
  const bestSpan = spanOf(best);
  const minSpan = splitBoard ? 1.2 : 3;
  return best.length >= 2 && bestSpan >= minSpan ? best : withLane;
}

/**
 * 早段 board/feet 斜率是否離譜（誤鎖橫掃溝邊常見 >1.2 board/ft）。
 * 用 forward 段頭 ~12′ 窗。
 */
export function earlyBoardSlopeAbs(
  points: { lane?: LanePoint; predicted?: boolean }[]
): number | null {
  const fwd = longestForwardLanePoints(points);
  if (fwd.length < 3) return null;
  const minF = fwd[0].feet;
  const window = fwd.filter((p) => p.feet <= minF + 12);
  if (window.length < 3) return null;
  const a = window[0];
  const b = window[window.length - 1];
  const df = b.feet - a.feet;
  if (df < 2) return null;
  return Math.abs((b.board - a.board) / df);
}


/** PBA／StrikeTrack：board 由投手右側起计 */
export function mirrorBoardFromRight(board: number): number {
  return 39 - board;
}

/** 可選將 board 轉成「右=0」 */
export function withBoardConvention<
  T extends { lane?: { board: number; feet: number } }
>(points: T[], boardFromRight: boolean): T[] {
  if (!boardFromRight) return points;
  return points.map((p) =>
    p.lane
      ? { ...p, lane: { feet: p.lane.feet, board: mirrorBoardFromRight(p.lane.board) } }
      : p
  );
}

export function boardAtFeetDetailed(
  points: { lane?: LanePoint; predicted?: boolean }[],
  targetFeet: number,
  opts?: {
    allowExtrapolate?: boolean;
    /** 允許端點外推／最近點的最大 feet 差距（預設 3） */
    maxGap?: number;
  }
): BoardAtFeetResult | null {
  const allowExtrapolate = opts?.allowExtrapolate ?? false;
  const maxGap = opts?.maxGap ?? 3;
  const rawLane = points.filter(
    (p): p is { lane: LanePoint; predicted?: boolean } =>
      !!p.lane && !p.predicted
  );
  if (rawLane.length < 2) return null;

  // 優先用最長前進段，避免回跳／誤鎖橫掃污染 15′ arrows
  const fwdOnly = longestForwardLanePoints(points);
  const withLane =
    fwdOnly.length >= 2
      ? fwdOnly.map((lane) => ({ lane }))
      : rawLane;

  const cov = trajectoryCoverage(
    withLane.map((p) => ({ lane: p.lane, predicted: false }))
  );
  if (!cov) return null;

  // 區段內線性插值——拒跨大空洞（bowling-demo 常見 5′→40′ 插值令 Arrows 12.8↔15.6 甩）
  // Arrows/sparse: span>6' interp yields Arr 12.0/12.2 (Tester#8)
  const maxInterpSpan = Math.max(6, maxGap * 2);
  for (let i = 0; i < withLane.length - 1; i++) {
    const a = withLane[i].lane;
    const b = withLane[i + 1].lane;
    const lo = Math.min(a.feet, b.feet);
    const hi = Math.max(a.feet, b.feet);
    if (targetFeet >= lo && targetFeet <= hi && hi - lo > 1e-6) {
      if (hi - lo > maxInterpSpan) continue; // 疏軌：交俾最近點／外推／上層 fallback
      const t = (targetFeet - a.feet) / (b.feet - a.feet);
      return {
        board: a.board + t * (b.board - a.board),
        extrapolated: false,
      };
    }
  }

  // 覆蓋範圍內但相鄰段未夾住（例如稀疏）：取最近點，距離要夠近
  if (targetFeet >= cov.minFeet - 0.5 && targetFeet <= cov.maxFeet + 0.5) {
    let best = withLane[0];
    let bestD = Math.abs(best.lane.feet - targetFeet);
    for (const p of withLane) {
      const d = Math.abs(p.lane.feet - targetFeet);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (bestD <= maxGap) {
      return { board: best.lane.board, extrapolated: false };
    }
    return null;
  }

  if (!allowExtrapolate) return null;

  // 短距外推：用靠近該端的兩點斜率
  const sorted = [...withLane].sort((a, b) => a.lane.feet - b.lane.feet);
  if (targetFeet > cov.maxFeet) {
    const gap = targetFeet - cov.maxFeet;
    if (gap > maxGap * 4) return null; // 太遠不外推
    const n = sorted.length;
    const a = sorted[Math.max(0, n - 3)].lane;
    const b = sorted[n - 1].lane;
    const df = b.feet - a.feet;
    if (Math.abs(df) < 0.8) {
      return { board: b.board, extrapolated: true };
    }
    const slope = (b.board - a.board) / df;
    const board = b.board + slope * gap;
    if (board < -5 || board > LANE_W + 5) return null;
    return { board, extrapolated: true };
  }
  if (targetFeet < cov.minFeet) {
    const gap = cov.minFeet - targetFeet;
    if (gap > maxGap * 4) return null;
    const a = sorted[0].lane;
    const b = sorted[Math.min(sorted.length - 1, 2)].lane;
    const df = b.feet - a.feet;
    if (Math.abs(df) < 0.8) {
      return { board: a.board, extrapolated: true };
    }
    const slope = (b.board - a.board) / df;
    const board = a.board - slope * gap;
    if (board < -5 || board > LANE_W + 5) return null;
    return { board, extrapolated: true };
  }
  return null;
}

/** 相容舊 API：覆蓋內插值；超出不回最近點（避免假 BP／袋口） */
export function boardAtFeet(
  points: { lane?: LanePoint; predicted?: boolean }[],
  targetFeet: number
): number | null {
  const r = boardAtFeetDetailed(points, targetFeet, {
    allowExtrapolate: false,
    maxGap: 3,
  });
  return r ? r.board : null;
}

/**
 * Board at target feet on the *displayed* path (includes predicted densify knots).
 * boardAtFeet / longestForward strip predicted — LaneMap draws them, so Arr must too.
 */
export function boardAtFeetOnDisplayedPath(
  points: { lane?: LanePoint; predicted?: boolean }[],
  targetFeet: number,
  maxGap = 2.5
): number | null {
  const all = points
    .filter((p): p is { lane: LanePoint } => !!p.lane)
    .map((p) => p.lane)
    .sort((a, b) => a.feet - b.feet);
  if (all.length < 2) return null;
  const lo = all[0].feet;
  const hi = all[all.length - 1].feet;
  if (targetFeet < lo - 0.5 || targetFeet > hi + 0.5) return null;
  for (let i = 0; i < all.length - 1; i++) {
    const a = all[i];
    const b = all[i + 1];
    const flo = Math.min(a.feet, b.feet);
    const fhi = Math.max(a.feet, b.feet);
    if (targetFeet >= flo && targetFeet <= fhi && fhi - flo > 1e-6) {
      const t = (targetFeet - a.feet) / (b.feet - a.feet);
      return a.board + t * (b.board - a.board);
    }
  }
  let best = all[0];
  let bestD = Math.abs(best.feet - targetFeet);
  for (const p of all) {
    const d = Math.abs(p.feet - targetFeet);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return bestD <= maxGap ? best.board : null;
}

type TimedLane = { lane: LanePoint; t: number; predicted?: boolean };

/** ft/s → mph */
const FT_PER_SEC_PER_MPH = 1.4667;
/** board 寬度（吋）：39 boards ≈ 41.5″ */
const BOARD_INCHES = 41.5 / 39;

function usableLanePoints(
  points: { lane?: LanePoint; t: number; predicted?: boolean }[]
): TimedLane[] {
  return points.filter(
    (p): p is TimedLane =>
      !!p.lane &&
      p.t >= 0 &&
      !p.predicted &&
      p.lane.board >= -1 &&
      p.lane.board <= LANE_W + 1 &&
      p.lane.feet >= -1 &&
      p.lane.feet <= LANE_L + 1
  );
}

/** 輕量 Savitzky–Golay 風格：5 點二次平滑 feet（減噪，唔發明進度） */
function smoothFeetSeries(usable: TimedLane[]): TimedLane[] {
  if (usable.length < 5) return usable;
  // 係數：二次多项式 window=5, derivative=0
  const coeffs = [-3, 12, 17, 12, -3];
  const norm = 35;
  const out: TimedLane[] = usable.map((p) => ({
    ...p,
    lane: { ...p.lane },
  }));
  for (let i = 2; i < usable.length - 2; i++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += coeffs[k + 2] * usable[i + k].lane.feet;
    out[i].lane.feet = s / norm;
  }
  return out;
}

export type ActiveRollSpan = {
  i0: number;
  i1: number;
  minFeet: number;
  maxFeet: number;
  dtSec: number;
  /** 淨 feet 位移／時間 */
  chordMph: number;
  /** 含橫向 path 長度／時間 */
  pathMph: number;
};

/**
 * 活躍滾動段：剪掉鎖定前後／瓶口怠速（instant feet rate 過低）。
 * 參考 TrueLine／bowling-cv：用真實前進時間，唔好用整段 lock→end。
 */
export function findActiveRollSpan(
  points: { lane?: LanePoint; t: number; predicted?: boolean }[]
): ActiveRollSpan | null {
  const raw = usableLanePoints(points);
  if (raw.length < 3) return null;
  const usable = smoothFeetSeries(raw);

  // 以時間序上「首次接近最高 feet」界定滾動結束，剪瓶口怠速
  let peakFeet = usable[0].lane.feet;
  let peakIdx = 0;
  for (let i = 1; i < usable.length; i++) {
    if (usable[i].lane.feet > peakFeet) {
      peakFeet = usable[i].lane.feet;
      peakIdx = i;
    }
  }
  const startFeet = usable[0].lane.feet;
  const span = peakFeet - startFeet;
  if (span < 6 || peakIdx < 2) return null;

  // 起點：累積前進超過 5% span；終點：首次達 90% span（或 peak）
  const thrStart = startFeet + span * 0.05;
  const thrEnd = startFeet + span * 0.9;
  let i0 = 0;
  while (i0 < peakIdx && usable[i0].lane.feet < thrStart) i0++;
  let i1 = i0;
  while (i1 < peakIdx && usable[i1].lane.feet < thrEnd) i1++;
  i1 = Math.min(Math.max(i1, i0 + 2), peakIdx);

  const df = usable[i1].lane.feet - usable[i0].lane.feet;
  const dt = (usable[i1].t - usable[i0].t) / 1000;
  if (df < 5 || dt < 0.15 || dt > 4) return null;

  let path = 0;
  for (let k = i0 + 1; k <= i1; k++) {
    const ddf = usable[k].lane.feet - usable[k - 1].lane.feet;
    const ddb = usable[k].lane.board - usable[k - 1].lane.board;
    if (ddf > -0.4) {
      path += Math.hypot(Math.max(0, ddf) * 12, ddb * BOARD_INCHES) / 12;
    }
  }
  const chordMph = df / dt / FT_PER_SEC_PER_MPH;
  const pathMph = path / dt / FT_PER_SEC_PER_MPH;
  if (chordMph < 5 || chordMph > 32) return null;
  return {
    i0,
    i1,
    minFeet: usable[i0].lane.feet,
    maxFeet: usable[i1].lane.feet,
    dtSec: dt,
    chordMph,
    pathMph,
  };
}

/** 子窗估速：全軌跡多窗長，先濾怠速窗再取中高分位 */
function windowSpeedMph(usable: TimedLane[]): number | null {
  if (usable.length < 3) return null;

  const windows: number[] = [];
  const spans = [
    Math.max(2, Math.floor(usable.length / 8)),
    Math.max(3, Math.floor(usable.length / 5)),
    Math.max(4, Math.floor(usable.length / 3)),
  ];
  for (const span of spans) {
    for (let i = 0; i + span < usable.length; i++) {
      const j = i + span;
      const dt = (usable[j].t - usable[i].t) / 1000;
      if (dt < 0.05 || dt > 4) continue;
      let path = 0;
      for (let k = i + 1; k <= j; k++) {
        const df = usable[k].lane.feet - usable[k - 1].lane.feet;
        const db = usable[k].lane.board - usable[k - 1].lane.board;
        if (df > -0.4) {
          path += Math.hypot(Math.max(0, df) * 12, db * BOARD_INCHES) / 12;
        }
      }
      if (path < 1.0) continue;
      const mph = path / dt / FT_PER_SEC_PER_MPH;
      // 丟棄明顯怠速窗，避免拉低分位
      if (mph >= 8 && mph <= 28) windows.push(mph);
    }
  }
  if (windows.length < 1) {
    // 放寬：允許 5–32
    for (const span of spans) {
      for (let i = 0; i + span < usable.length; i++) {
        const j = i + span;
        const dt = (usable[j].t - usable[i].t) / 1000;
        if (dt < 0.05 || dt > 4) continue;
        let path = 0;
        for (let k = i + 1; k <= j; k++) {
          const df = usable[k].lane.feet - usable[k - 1].lane.feet;
          if (df > -0.4) path += Math.max(0, df);
        }
        if (path < 0.5) continue;
        const mph = path / dt / FT_PER_SEC_PER_MPH;
        if (mph >= 5 && mph <= 32) windows.push(mph);
      }
    }
  }
  if (windows.length < 1) return null;
  windows.sort((a, b) => a - b);
  const idx = Math.min(
    windows.length - 1,
    Math.max(0, Math.floor(windows.length * 0.72))
  );
  return windows[idx];
}

/**
 * 融合子窗估速 + 活躍段 chord／path。
 * 透視跳點時 chord 會虛高 → 以子窗為主；子窗被怠速拉低 → 輕微上拉。
 * 雙方失敗 → null（—，唔假報）。
 */
function fuseSpeedEstimates(
  windowMph: number | null,
  active: ActiveRollSpan | null
): number | null {
  // chord soft-cap：屋局／透視壓縮下 >22 多半係映射誤差
  let chord: number | null = null;
  if (active != null) {
    chord = 0.75 * active.chordMph + 0.25 * active.pathMph;
    if (chord > 22) chord = 18 + (chord - 22) * 0.15; // 軟壓到 ~18–20
    if (chord > 20) chord = 20;
  }

  let laneScale: number | null = null;
  if (
    active &&
    active.minFeet <= 6 &&
    active.maxFeet >= 54 &&
    active.dtSec >= 0.8 &&
    active.dtSec <= 4.5
  ) {
    const fullMph = LANE_L / active.dtSec / FT_PER_SEC_PER_MPH;
    if (fullMph >= 10 && fullMph <= 22) laneScale = fullMph;
  }

  if (windowMph == null && chord == null) {
    return laneScale != null ? Math.round(laneScale * 10) / 10 : null;
  }
  if (windowMph == null) {
    return Math.round((chord ?? laneScale)! * 10) / 10;
  }
  if (chord == null) {
    let w = windowMph;
    if (laneScale != null) w = 0.9 * w + 0.1 * laneScale;
    return Math.round(w * 10) / 10;
  }

  const w = windowMph;
  const c = chord;
  let fused: number;
  if (c > w * 1.25) {
    // 活躍 chord 偏高（透視）：子窗為主，最多上拉 ~12%
    fused = w * 1.08;
    if (c < w * 1.5) fused = 0.82 * w + 0.18 * c;
  } else if (w < 12.5 && c >= 13 && c <= 20) {
    fused = 0.45 * w + 0.55 * c;
  } else {
    fused = 0.6 * w + 0.4 * c;
  }
  if (laneScale != null) fused = 0.9 * fused + 0.1 * laneScale;
  // 合理保齡顯示範圍；超過仍回傳但 clamp 防假報極端
  if (fused < 5) return Math.round(w * 10) / 10;
  if (fused > 24) fused = 0.7 * w + 0.3 * 18;
  return Math.round(fused * 10) / 10;
}

/**
 * 粗估球速：子窗 + 活躍滾動段距離／時間融合。
 * 1 mph ≈ 1.4667 ft/s。過濾預測點、回跳與鎖定前後／瓶口怠速。
 */
export function estimateSpeedMph(
  points: { lane?: LanePoint; t: number; predicted?: boolean }[]
): number | null {
  const raw = usableLanePoints(points);
  if (raw.length < 3) return null;
  const usable = smoothFeetSeries(raw);
  const windowMph = windowSpeedMph(usable);
  const active = findActiveRollSpan(points);
  const fused = fuseSpeedEstimates(windowMph, active);
  if (fused != null) return fused;

  // 後備：只取 feet 單調上升最快的連續段
  let bestMph: number | null = null;
  let i = 0;
  while (i < usable.length - 2) {
    let j = i + 1;
    let path = 0;
    while (j < usable.length) {
      const df = usable[j].lane.feet - usable[j - 1].lane.feet;
      if (df < -0.3) break;
      path += Math.max(0, df);
      j++;
      if (path >= 3) {
        const dt = (usable[j - 1].t - usable[i].t) / 1000;
        if (dt >= 0.08) {
          const mph = path / dt / FT_PER_SEC_PER_MPH;
          if (mph >= 5 && mph <= 32) {
            if (bestMph == null || mph > bestMph) bestMph = mph;
          }
        }
      }
    }
    i = Math.max(i + 1, j);
  }
  return bestMph != null ? Math.round(bestMph * 10) / 10 : null;
}

/** 後方視角預設四角：上窄（遠／pins）、下寬（近／foul） */
export function defaultCorners(
  width: number,
  height: number
): LaneCorners {
  // 頂端靠近 pins（略高），減少球未到瓶口已出框；頂寬略收
  const topM = width * 0.3;
  const botM = width * 0.1;
  const topY = height * 0.08;
  const botY = height * 0.9;
  return {
    tl: { x: topM, y: topY },
    tr: { x: width - topM, y: topY },
    br: { x: width - botM, y: botY },
    bl: { x: botM, y: botY },
  };
}

/**
 * 區段球速：只取 feet 落在 [feetLo, feetHi] 的點；剪怠速後子窗＋chord 融合。
 * 覆蓋不足時回 null（不硬填）。
 */
export function estimateSegmentSpeedMph(
  points: { lane?: LanePoint; t: number; predicted?: boolean }[],
  feetLo: number,
  feetHi: number
): number | null {
  const cov = trajectoryCoverage(points);
  if (!cov) return null;
  const overlapLo = Math.max(feetLo, cov.minFeet);
  const overlapHi = Math.min(feetHi, cov.maxFeet);
  if (overlapHi - overlapLo < 1.5) return null;

  const usable = smoothFeetSeries(
    usableLanePoints(points).filter(
      (p) => p.lane.feet >= overlapLo - 0.5 && p.lane.feet <= overlapHi + 0.5
    )
  ).filter(
    (p) => p.lane.feet >= overlapLo && p.lane.feet <= overlapHi
  );
  if (usable.length < 2) return null;

  const windowMph = windowSpeedMph(usable);

  // 區段內活躍 chord（剪即時速率過低）
  let i0 = 0;
  let i1 = usable.length - 1;
  for (let i = 1; i < usable.length; i++) {
    const dt = (usable[i].t - usable[i - 1].t) / 1000;
    const df = usable[i].lane.feet - usable[i - 1].lane.feet;
    const mph = dt >= 0.02 ? Math.max(0, df) / dt / FT_PER_SEC_PER_MPH : 0;
    if (mph >= 3) {
      i0 = Math.max(0, i - 1);
      break;
    }
  }
  for (let i = usable.length - 1; i >= 1; i--) {
    const dt = (usable[i].t - usable[i - 1].t) / 1000;
    const df = usable[i].lane.feet - usable[i - 1].lane.feet;
    const mph = dt >= 0.02 ? Math.max(0, df) / dt / FT_PER_SEC_PER_MPH : 0;
    if (mph >= 3) {
      i1 = i;
      break;
    }
  }
  let chord: number | null = null;
  if (i1 > i0) {
    const df = usable[i1].lane.feet - usable[i0].lane.feet;
    const dt = (usable[i1].t - usable[i0].t) / 1000;
    if (df >= 1.2 && dt >= 0.08 && dt <= 3) {
      const c = df / dt / FT_PER_SEC_PER_MPH;
      if (c >= 5 && c <= 32) chord = c;
    }
  }

  const fused = fuseSpeedEstimates(
    windowMph,
    chord != null && i1 > i0
      ? {
          i0,
          i1,
          minFeet: usable[i0].lane.feet,
          maxFeet: usable[i1].lane.feet,
          dtSec: (usable[i1].t - usable[i0].t) / 1000,
          chordMph: chord,
          pathMph: chord,
        }
      : null
  );
  if (fused != null) return fused;

  let bestMph: number | null = null;
  for (let i = 0; i < usable.length - 2; i++) {
    for (let j = i + 2; j < usable.length; j++) {
      const dt2 = (usable[j].t - usable[i].t) / 1000;
      if (dt2 < 0.06 || dt2 > 2.5) continue;
      let path2 = 0;
      for (let k = i + 1; k <= j; k++) {
        const df = usable[k].lane.feet - usable[k - 1].lane.feet;
        if (df > -0.4) path2 += Math.max(0, df);
      }
      if (path2 < 1.2) continue;
      const mph2 = path2 / dt2 / FT_PER_SEC_PER_MPH;
      if (mph2 >= 5 && mph2 <= 32) {
        if (bestMph == null || mph2 > bestMph) bestMph = mph2;
      }
    }
  }
  return bestMph != null ? Math.round(bestMph * 10) / 10 : null;
}

/**
 * 找 hook 最大處（board 變化相對 feet 的轉折）。
 * 只在實際覆蓋內搜尋；覆蓋不足回 null（不再預設 42）。
 */
export function feetAtMaxHook(
  points: { lane?: LanePoint; predicted?: boolean }[]
): number | null {
  const cov = trajectoryCoverage(points);
  if (!cov || cov.span < 6) return null;

  // BP 典型 30–45′；覆蓋足夠時優先呢個帶，避免中段噪點假極值
  let searchLo = Math.max(12, Math.ceil(cov.minFeet));
  let searchHi = Math.min(52, Math.floor(cov.maxFeet));
  if (cov.maxFeet >= 32 && cov.span >= 10) {
    searchLo = Math.max(searchLo, 28);
    searchHi = Math.min(searchHi, 48);
  }
  if (searchHi - searchLo < 5) {
    searchLo = Math.max(12, Math.ceil(cov.minFeet));
    searchHi = Math.min(52, Math.floor(cov.maxFeet));
  }
  if (searchHi - searchLo < 5) return null;

  const rawSamples: { feet: number; board: number }[] = [];
  for (let f = searchLo; f <= searchHi; f += 1) {
    const b = boardAtFeet(points, f);
    if (b != null) rawSamples.push({ feet: f, board: b });
  }
  if (rawSamples.length < 4) return null;

  // 丟離群 board（溝邊噪點）
  const medBoard0 = [...rawSamples.map((s) => s.board)].sort(
    (a, b) => a - b
  )[Math.floor(rawSamples.length / 2)];
  const filtered = rawSamples.filter(
    (s) => Math.abs(s.board - medBoard0) <= 10
  );
  const base = filtered.length >= 4 ? filtered : rawSamples;

  // 3 點平滑減噪
  const samples = base.map((s, i, arr) => {
    if (i === 0 || i === arr.length - 1) return s;
    return {
      feet: s.feet,
      board: (arr[i - 1].board + s.board + arr[i + 1].board) / 3,
    };
  });

  // 優先：橫向極值（RH 鈎＝最小 board；LH＝最大 board）
  const earlyN = Math.max(2, Math.floor(samples.length * 0.35));
  const earlyBoards = samples.slice(0, earlyN).map((s) => s.board);
  const midEarly =
    earlyBoards.reduce((a, b) => a + b, 0) / earlyBoards.length;
  const lateBoards = samples.slice(-earlyN).map((s) => s.board);
  const midLate =
    lateBoards.reduce((a, b) => a + b, 0) / lateBoards.length;
  const hookLeft = midLate <= midEarly; // 往左鈎 → 搵 min board

  let extIdx = 0;
  let extBoard = samples[0].board;
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i].board;
    if (hookLeft ? b < extBoard : b > extBoard) {
      extBoard = b;
      extIdx = i;
    }
  }
  // 極值要有足夠橫移（≥0.6 board），否則改曲率
  const boardTravel = Math.abs(extBoard - midEarly);
  if (boardTravel >= 0.6 && extIdx >= 1 && extIdx < samples.length - 1) {
    return samples[extIdx].feet;
  }

  let bestFeet = samples[Math.floor(samples.length / 2)].feet;
  let bestCurv = -1;
  for (let i = 1; i < samples.length - 1; i++) {
    const d1 = samples[i].board - samples[i - 1].board;
    const d2 = samples[i + 1].board - samples[i].board;
    const curv = Math.abs(d2 - d1);
    if (curv > bestCurv) {
      bestCurv = curv;
      bestFeet = samples[i].feet;
    }
  }
  // 曲率過平：唔好報中段當 BP（常變 15′／mid-lane 假常數）
  if (bestCurv < 0.05) {
    return null;
  }
  // 覆蓋已過 arrows 帶時，BP 唔應落喺 ≤20′（假 mid／卡 15′）
  if (bestFeet <= 20 && cov.maxFeet >= 28) {
    const deep = samples.filter((s) => s.feet >= 28);
    if (deep.length >= 3) {
      let di = 0;
      let db = deep[0].board;
      for (let i = 1; i < deep.length; i++) {
        const b = deep[i].board;
        if (hookLeft ? b < db : b > db) {
          db = b;
          di = i;
        }
      }
      return deep[di].feet;
    }
    return null;
  }
  return bestFeet;
}
