"use client";

import {
  formatBoard,
  formatDeg,
  formatMph,
  formatRpm,
} from "@/lib/estimates";
import type { Shot, ShotEstimate } from "@/lib/types";

type Props = {
  liveEstimate?: ShotEstimate | null;
  shots: Shot[];
};

function StatRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-2 py-1 text-sm">
      <span className="text-slate-400">
        {label}
        {hint && (
          <span className="mt-0.5 block text-[10px] text-slate-600">{hint}</span>
        )}
      </span>
      <span className="shrink-0 font-mono font-medium text-slate-100">
        {value}
      </span>
    </div>
  );
}

export default function ShotStats({ liveEstimate, shots }: Props) {
  const last = shots[shots.length - 1];
  const est = liveEstimate ?? last?.estimate ?? null;

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">投球指標</h3>
      {est ? (
        <div className="divide-y divide-slate-800">
          <StatRow label="Foul board (≈1′)" value={formatBoard(est.foulBoard)} />
          <StatRow
            label="Arrows / Entry (≈15′)"
            value={formatBoard(est.arrowsBoard ?? est.entryBoard)}
          />
          <StatRow
            label="Breakpoint"
            value={
              est.breakpointBoard != null
                ? `${formatBoard(est.breakpointBoard)}${
                    est.breakpointDistance != null
                      ? ` @ ${est.breakpointDistance}′`
                      : ""
                  }`
                : "—"
            }
          />
          <StatRow label="進袋 board (≈58′)" value={formatBoard(est.pocketBoard)} />
          <StatRow label="Launch 角" value={formatDeg(est.launchAngleDeg)} />
          <StatRow label="Impact 角" value={formatDeg(est.impactAngleDeg)} />
          <StatRow label="Launch 球速" value={formatMph(est.launchSpeedMph)} />
          <StatRow label="Impact 球速" value={formatMph(est.impactSpeedMph)} />
          <StatRow
            label="平均球速"
            value={formatMph(est.avgSpeedMph ?? est.speedMph)}
          />
          <StatRow
            label="Hook boards"
            value={
              est.hookBoards != null
                ? `${est.hookBoards > 0 ? "+" : ""}${est.hookBoards.toFixed(1)}`
                : "—"
            }
            hint="Foul／Arrows − BP（簡化）"
          />
          <StatRow
            label="Hook factor"
            value={est.hookFactor != null ? est.hookFactor.toFixed(2) : "—"}
            hint="|hook| / (BP−15′) 簡化"
          />
          <StatRow
            label="Shot time"
            value={
              est.shotTimeSec != null ? `${est.shotTimeSec.toFixed(2)} s` : "—"
            }
          />
          <StatRow
            label="RPM（實驗）"
            value={formatRpm(est.rpm, est.rpmConfidence)}
            hint="需清晰球標；低信心勿当真"
          />
          <StatRow label="軌跡點數" value={String(est.pointCount)} />
        </div>
      ) : (
        <p className="text-xs text-slate-500">完成一投後顯示粗估</p>
      )}
      <div className="mt-3 border-t border-slate-800 pt-2">
        <p className="text-xs text-slate-400">
          本局已存 <span className="text-sky-400">{shots.length}</span> 投
        </p>
        {shots.length > 0 && (
          <ul className="mt-1 max-h-28 space-y-0.5 overflow-y-auto text-[11px] text-slate-500">
            {[...shots].reverse().map((s, i) => (
              <li key={s.id}>
                #{shots.length - i} · 袋口 {formatBoard(s.estimate.pocketBoard)}{" "}
                ·{" "}
                {s.estimate.avgSpeedMph != null || s.estimate.speedMph != null
                  ? `${s.estimate.avgSpeedMph ?? s.estimate.speedMph} mph`
                  : "—"}
                {s.estimate.rpm != null ? ` · ${s.estimate.rpm} rpm` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
