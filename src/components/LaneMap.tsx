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
          const d = pts
            .map((p, i) => {
              const { x, y } = toXY(p);
              return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(" ");
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
            d={livePath
              .map((p, i) => {
                const { x, y } = toXY(p);
                return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
              })
              .join(" ")}
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
        {/* 球瓶示意（≈58–60′，應在圖上方） */}
        <g>
          {[0, 1, 2, 3].map((row) =>
            Array.from({ length: row + 1 }).map((_, i) => {
              const boards = 20 + (i - row / 2) * 3.5;
              const feet = 58 + row * 0.6;
              const { x, y } = toXY({ board: boards, feet });
              return (
                <circle
                  key={`pin-${row}-${i}`}
                  cx={x}
                  cy={y}
                  r={2.2}
                  fill="#e2e8f0"
                  opacity={0.7}
                />
              );
            })
          )}
        </g>
      </svg>
      <p className="mt-2 text-center text-[10px] text-slate-500">
        箭頭≈15′ · BP≈42′ · 袋口≈60′（路徑僅畫實際追蹤點）
      </p>
    </div>
  );
}
