import Link from "next/link";
import AuthBar from "@/components/AuthBar";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-8 px-4 py-10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="mb-2 text-sm font-medium text-sky-400">Bowl Track</p>
          <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            保齡球球路追蹤
          </h1>
        </div>
        <AuthBar />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link
          href="/session"
          className="inline-flex items-center justify-center rounded-xl bg-sky-600 px-5 py-3 text-center text-base font-semibold text-white shadow-lg shadow-sky-900/40 hover:bg-sky-500"
        >
          開始追蹤
        </Link>
        <Link
          href="/login"
          className="inline-flex items-center justify-center rounded-xl border border-slate-700 px-5 py-3 text-center text-base font-semibold text-slate-200 hover:bg-slate-900"
        >
          登入同步雲端
        </Link>
      </div>
    </main>
  );
}
