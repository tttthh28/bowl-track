import Link from "next/link";
import Workbench from "@/components/Workbench";

export default function SessionPage() {
  return (
    <main className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-3 py-3">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="text-sm text-slate-400 hover:text-slate-200"
            >
              ← 說明
            </Link>
            <h1 className="text-base font-semibold text-white sm:text-lg">
              球局工作台
            </h1>
          </div>
          <span className="rounded-full bg-slate-800 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
            v0.2
          </span>
        </div>
      </header>
      <Workbench />
    </main>
  );
}
