"use client";

import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import {
  fetchCloudStatus,
  invalidateCloudStatus,
  type CloudStatus,
} from "@/lib/cloudClient";

export default function AuthBar({ compact = false }: { compact?: boolean }) {
  const { data: session, status } = useSession();
  const [cloud, setCloud] = useState<CloudStatus | null>(null);

  useEffect(() => {
    void fetchCloudStatus(true).then(setCloud);
  }, [session?.user?.id]);

  const loading = status === "loading";
  const email = session?.user?.email;

  if (loading) {
    return (
      <span className="text-xs text-slate-500">
        {compact ? "…" : "檢查登入…"}
      </span>
    );
  }

  if (email) {
    return (
      <div
        className={`flex items-center gap-2 ${
          compact ? "text-xs" : "text-sm"
        }`}
      >
        <span
          className="max-w-[10rem] truncate text-slate-300 sm:max-w-[14rem]"
          title={email}
        >
          {session?.user?.name || email}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            cloud?.database
              ? "bg-emerald-900/60 text-emerald-300"
              : "bg-amber-900/50 text-amber-200"
          }`}
        >
          {cloud?.database ? "雲端 Neon" : "僅本機"}
        </span>
        <button
          type="button"
          onClick={() => {
            invalidateCloudStatus();
            void signOut({ callbackUrl: "/" });
          }}
          className="rounded-lg border border-slate-700 px-2 py-1 text-slate-300 hover:bg-slate-800"
        >
          登出
        </button>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${compact ? "text-xs" : "text-sm"}`}>
      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-400">
        Guest
      </span>
      <Link
        href="/login"
        className="rounded-lg bg-sky-700/80 px-2.5 py-1 font-medium text-white hover:bg-sky-600"
      >
        登入
      </Link>
    </div>
  );
}
