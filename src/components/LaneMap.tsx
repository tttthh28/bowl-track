"use client";

import { useMemo } from "react";
import type { LanePoint, Shot } from "@/lib/types";
import { LANE_L, LANE_W } from "@/lib/perspective";

type Props = {
  shots: Shot[];
  livePath?: LanePoint[];
  width?: number;
  height?: number;
};

const COLORS = [
  "#38bdf8",
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#f472b6",
  "#fb7185",
];

/** Classic 7 target arrows across 39 boards, centered on board 20 @ ~15′ */
const ARROW_BOARDS = [5, 10, 15, 20, 25, 30, 35];
const ARROWS_FEET = 15;

/**
 * Standard pin deck on a 39-board / 41.5″ lane.
 * Pin centers are 12″ apart (equilateral); board 20 = lane center = pin 1.
 * PIN_GAP_BOARDS = 12 × 39 / 41.5 ≈ 11.28 → back row spans ~board 3…37.
 */
const PIN_GAP_BOARDS = (12 * LANE_W) / 41.5;
/** Head pin (pin 1) feet — pocket line ≈60′; deck depth compressed for map */
const PIN_1_FEET = 57.85;
/** Row depth along lane (compressed; physical ≈0.866′) so back row ≈60′ */
const PIN_ROW_DEPTH = 0.7;

type PinDef = { num: number; board: number; feet: number; row: number };

/** Pins 1–10 in real left–right triangle (bowler view: left=low board). */
const PIN_DECK: PinDef[] = (() => {
  // row offset units from centerline (× PIN_GAP_BOARDS → board)
  // row 0 (front): 1
  // row 1: 2 3
  // row 2: 4 5 6
  // row 3 (back): 7 8 9 10
  const layout: { num: number; row: number; colOff: number }[] = [
    { num: 1, row: 0, colOff: 0 },
    { num: 2, row: 1, colOff: -0.5 },
    { num: 3, row: 1, colOff: 0.5 },
    { num: 4, row: 2, colOff: -1 },
    { num: 5, row: 2, colOff: 0 },
    { num: 6, row: 2, colOff: 1 },
    { num: 7, row: 3, colOff: -1.5 },
    { num: 8, row: 3, colOff: -0.5 },
    { num: 9, row: 3, colOff: 0.5 },
    { num: 10, row: 3, colOff: 1.5 },
  ];
  return layout.map((p) => ({
    num: p.num,
    row: p.row,
    board: 20 + p.colOff * PIN_GAP_BOARDS,
    feet: PIN_1_FEET + p.row * PIN_ROW_DEPTH,
  }));
})();

/** Feet threshold: path end / pocket counts as “near pins” for highlight */
const NEAR_PINS_FEET = 50;
/** Board distance to treat as “hit / nearest” (≈ half pin gap) */
const HIT_BOARD_TOL = PIN_GAP_BOARDS * 0.55;

function nearestPin(board: number): PinDef {
  let best = PIN_DECK[0];
  let bestD = Math.abs(board - best.board);
  for (let i = 1; i < PIN_DECK.length; i++) {
    const d = Math.abs(board - PIN_DECK[i].board);
    if (d < bestD) {
      best = PIN_DECK[i];
      bestD = d;
    }
  }
  return best;
}

/** Impact board from path end (if near pin deck) or pocketBoard. */
function impactBoardFromPath(pts: LanePoint[]): number | null {
  if (!pts.length) return null;
  const end = pts[pts.length - 1];
  if (end.feet >= NEAR_PINS_FEET) return end.board;
  // Prefer last point with feet in pin zone
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i].feet >= NEAR_PINS_FEET) return pts[i].board;
  }
  return null;
}

/**
 * 球道 2D 圖：上方＝高 feet（pins≈60′）、下方＝低 feet（foul≈0′）。
 * 軌跡與刻度必須共用同一 feet→Y 映射。
 */
export default function LaneMap({
  shots,
  livePath = [],
  width = 220,
  height = 360,
}: Props) {
  // 左側加寬，避免 feet 標籤（如 60′）被裁切
  const padL = 28;
  const padR = 12;
  const padT = 16;
  const padB = 16;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  /** feet 0→底部、feet LANE_L→頂部（與「↑ pins · foul ↓」一致） */
  const feetToY = (feet: number) =>
    padT + ((LANE_L - feet) / LANE_L) * innerH;

  const toXY = (p: LanePoint) => ({
    x: padL + (p.board / LANE_W) * innerW,
    y: feetToY(p.feet),
  });

  const boardLines = useMemo(() => {
    const lines: number[] = [];
    for (let b = 0; b <= LANE_W; b += 5) lines.push(b);
    return lines;
  }, []);

  const footMarks = [0, 15, 30, 42, 60];

  /** Catmull-Rom → cubic Bézier；張力 /7.5（標準 /6）再圓 13–15′ 疏點 elbow */
  const smoothSvgPath = (pts: LanePoint[]) => {
    if (pts.length < 2) return "";
    const xy = pts.map(toXY);
    if (xy.length === 2) {
      return `M${xy[0].x.toFixed(1)},${xy[0].y.toFixed(1)} L${xy[1].x.toFixed(1)},${xy[1].y.toFixed(1)}`;
    }
    const f = (n: number) => n.toFixed(1);
    const tension = 7.5;
    let d = `M${f(xy[0].x)},${f(xy[0].y)}`;
    for (let i = 0; i < xy.length - 1; i++) {
      const p0 = xy[Math.max(0, i - 1)];
      const p1 = xy[i];
      const p2 = xy[i + 1];
      const p3 = xy[Math.min(xy.length - 1, i + 2)];
      const c1x = p1.x + (p2.x - p0.x) / tension;
      const c1y = p1.y + (p2.y - p0.y) / tension;
      const c2x = p2.x - (p3.x - p1.x) / tension;
      const c2y = p2.y - (p3.y - p1.y) / tension;
      d += ` C${f(c1x)},${f(c1y)} ${f(c2x)},${f(c2y)} ${f(p2.x)},${f(p2.y)}`;
    }
    return d;
  };

  /** Highlighted pin nums + primary label from live / latest shot near pins */
  const { highlightNums, primaryPin, primaryLabel } = useMemo(() => {
    const hit = new Map<number, { dist: number; fromLive: boolean }>();

    const consider = (board: number | null | undefined, fromLive: boolean) => {
      if (board == null || !Number.isFinite(board)) return;
      const pin = nearestPin(board);
      const dist = Math.abs(board - pin.board);
      if (dist > HIT_BOARD_TOL * 1.35) return; // too far from any pin (gutter)
      const prev = hit.get(pin.num);
      if (!prev || dist < prev.dist || (fromLive && !prev.fromLive)) {
        hit.set(pin.num, { dist, fromLive });
      }
    };

    // Live path end
    consider(impactBoardFromPath(livePath), true);

    // Shots: pocketBoard preferred, else path end near pins (latest shot first)
    for (let si = shots.length - 1; si >= 0; si--) {
      const shot = shots[si];
      const pocket = shot.estimate?.pocketBoard ?? null;
      if (pocket != null) {
        consider(pocket, false);
      } else {
        const pts = shot.points.filter((p) => p.lane).map((p) => p.lane!);
        consider(impactBoardFromPath(pts), false);
      }
    }

    const nums = new Set(hit.keys());
    // Primary = live hit if any, else closest / latest
    let primary: PinDef | null = null;
    let label = "";
    if (livePath.length) {
      const b = impactBoardFromPath(livePath);
      if (b != null) {
        const pin = nearestPin(b);
        if (nums.has(pin.num)) {
          primary = pin;
          const d = Math.abs(b - pin.board);
          label = d <= HIT_BOARD_TOL * 0.35 ? `擊 #${pin.num}` : `近 #${pin.num}`;
        }
      }
    }
    if (!primary && shots.length) {
      const shot = shots[shots.length - 1];
      const b =
        shot.estimate?.pocketBoard ??
        impactBoardFromPath(
          shot.points.filter((p) => p.lane).map((p) => p.lane!)
        );
      if (b != null) {
        const pin = nearestPin(b);
        if (nums.has(pin.num)) {
          primary = pin;
          const d = Math.abs(b - pin.board);
          label = d <= HIT_BOARD_TOL * 0.35 ? `擊 #${pin.num}` : `近 #${pin.num}`;
        }
      }
    }

    return {
      highlightNums: nums,
      primaryPin: primary,
      primaryLabel: label,
    };
  }, [shots, livePath]);

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-100">球道圖（39 boards）</h3>
        <span className="text-xs text-slate-400">↑ pins · foul ↓</span>
      </div>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="mx-auto block w-full max-w-[240px]"
        role="img"
        aria-label="球道 2D 路徑圖，上方 pins 約 60 呎，下方 foul 約 0 呎"
      >
        <defs>
          <filter
            id="pin-glow"
            x="-80%"
            y="-80%"
            width="260%"
            height="260%"
          >
            <feGaussianBlur stdDeviation="1.8" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <rect
          x={padL}
          y={padT}
          width={innerW}
          height={innerH}
          rx={4}
          fill="#1e293b"
          stroke="#475569"
          strokeWidth={1.5}
        />
        {/* board 線 */}
        {boardLines.map((b) => {
          const x = padL + (b / LANE_W) * innerW;
          return (
            <line
              key={`b${b}`}
              x1={x}
              y1={padT}
              x2={x}
              y2={padT + innerH}
              stroke={b === 20 ? "#64748b" : "#334155"}
              strokeWidth={b === 20 ? 1.2 : 0.6}
            />
          );
        })}
        {/* feet 標記：與 toXY／feetToY 同一映射（上高下低） */}
        {footMarks.map((f) => {
          const y = feetToY(f);
          return (
            <g key={`f${f}`}>
              <line
                x1={padL}
                y1={y}
                x2={padL + innerW}
                y2={y}
                stroke="#334155"
                strokeDasharray="3 3"
                strokeWidth={0.8}
              />
              <text
                x={padL - 4}
                y={y + 3}
                textAnchor="end"
                fontSize={9}
                fill="#94a3b8"
              >
                {f}′
              </text>
            </g>
          );
        })}
        {/* 箭嘴位置：經典 7 箭 @15′（boards 5/10/15/20/25/30/35） */}
        <g aria-label="箭嘴 15呎">
          {ARROW_BOARDS.map((b) => {
            const x = padL + (b / LANE_W) * innerW;
            const y = feetToY(ARROWS_FEET);
            // 小三角指向 foul（圖下方），似真實球道箭嘴
            const s = 3.2;
            const d = `M${x.toFixed(1)},${(y + s).toFixed(1)} L${(x - s * 0.7).toFixed(1)},${(y - s * 0.55).toFixed(1)} L${(x + s * 0.7).toFixed(1)},${(y - s * 0.55).toFixed(1)} Z`;
            return (
              <path
                key={`arr-${b}`}
                d={d}
                fill="#94a3b8"
                fillOpacity={0.9}
                stroke="#cbd5e1"
                strokeWidth={0.6}
                strokeOpacity={0.85}
              />
            );
          })}
          <text
            x={padL + innerW / 2}
            y={feetToY(ARROWS_FEET) - 7}
            textAnchor="middle"
            fontSize={8}
            fill="#64748b"
          >
            箭嘴
          </text>
        </g>
        {/* board 標籤（頂部左右） */}
        <text x={padL} y={padT - 4} fontSize={9} fill="#94a3b8">
          0
        </text>
        <text
          x={padL + innerW}
          y={padT - 4}
          textAnchor="end"
          fontSize={9}
          fill="#94a3b8"
        >
          39
        </text>
        {/* 歷史投球 */}
        {shots.map((shot, si) => {
          const pts = shot.points.filter((p) => p.lane).map((p) => p.lane!);
          if (pts.length < 2) return null;
          const d = smoothSvgPath(pts);
          const color = COLORS[si % COLORS.length];
          return (
            <path
              key={shot.id}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeOpacity={0.75}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
        {/* 即時路徑 */}
        {livePath.length >= 2 && (
          <path
            d={smoothSvgPath(livePath)}
            fill="none"
            stroke="#f97316"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {livePath.length > 0 && (
          <circle
            cx={toXY(livePath[livePath.length - 1]).x}
            cy={toXY(livePath[livePath.length - 1]).y}
            r={4}
            fill="#f97316"
          />
        )}
        {/* 球瓶：標準 10-pin 三角（board≈3…37 @ ~58–60′），近/擊高亮 */}
        <g aria-label="球瓶 1–10">
          {PIN_DECK.map((pin) => {
            const { x, y } = toXY({ board: pin.board, feet: pin.feet });
            const lit = highlightNums.has(pin.num);
            const isPrimary = primaryPin?.num === pin.num;
            const r = lit ? 3.4 : 2.6;
            return (
              <g key={`pin-${pin.num}`}>
                {lit && (
                  <circle
                    cx={x}
                    cy={y}
                    r={r + 2.4}
                    fill="#fbbf24"
                    fillOpacity={0.35}
                    filter="url(#pin-glow)"
                  />
                )}
                <circle
                  cx={x}
                  cy={y}
                  r={r}
                  fill={lit ? "#fbbf24" : "#e2e8f0"}
                  fillOpacity={lit ? 0.95 : 0.75}
                  stroke={lit ? "#fef08a" : "#94a3b8"}
                  strokeWidth={lit ? 1.2 : 0.5}
                  strokeOpacity={0.9}
                />
                <text
                  x={x}
                  y={y + 2.6}
                  textAnchor="middle"
                  fontSize={lit ? 6.5 : 5.5}
                  fontWeight={lit ? 700 : 500}
                  fill={lit ? "#0f172a" : "#334155"}
                >
                  {pin.num}
                </text>
                {isPrimary && primaryLabel && (
                  <text
                    x={x}
                    y={y - r - 3.5}
                    textAnchor="middle"
                    fontSize={7}
                    fontWeight={600}
                    fill="#fbbf24"
                  >
                    {primaryLabel}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <p className="mt-2 text-center text-[10px] text-slate-500">
        箭頭≈15′ · BP≈42′ · 袋口≈60′（路徑僅畫實際追蹤點）
        {primaryLabel ? ` · ${primaryLabel}` : ""}
      </p>
    </div>
  );
}
