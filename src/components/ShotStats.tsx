"use client";

import { formatBoard } from "@/lib/estimates";
import type { Shot, ShotEstimate } from "@/lib/types";

type Props = {
  liveEstimate?: ShotEstimate | null;
  shots: Shot[];
};

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-sm">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono font-medium text-slate-100">{value}</span>
    </div>
  );
}

export default function ShotStats({ liveEstimate, shots }: Props) {
  const last = shots[shots.length - 1];
  const est = liveEstimate ?? last?.estimate ?? null;

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-3">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">粗估數據</h3>
      {est ? (
        <div className="divide-y divide-slate-800">
          <StatRow label="箭頭區 board (≈15′)" value={formatBoard(est.arrowsBoard)} />
          <StatRow label="Breakpoint (≈42′)" value={formatBoard(est.breakpointBoard)} />
          <StatRow label="進袋附近 (≈58′)" value={formatBoard(est.pocketBoard)} />
          <StatRow
            label="粗估球速"
            value={est.speedMph != null ? `${est.speedMph} mph` : "—"}
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
                #{shots.length - i} · 袋口 {formatBoard(s.estimate.pocketBoard)} ·{" "}
                {s.estimate.speedMph != null ? `${s.estimate.speedMph} mph` : "—"}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
