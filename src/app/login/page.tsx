"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useEffect, useState } from "react";
import { fetchCloudStatus, invalidateCloudStatus } from "@/lib/cloudClient";

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const callbackUrl = search.get("callbackUrl") || "/session";
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dbOk, setDbOk] = useState<boolean | null>(null);

  useEffect(() => {
    void fetchCloudStatus(true).then((s) => setDbOk(s.database));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await signIn("email", {
        email: email.trim().toLowerCase(),
        name: name.trim() || undefined,
        redirect: false,
        callbackUrl,
      });
      if (res?.error) {
        setError("登入失敗：請檢查電郵格式。");
        setBusy(false);
        return;
      }
      invalidateCloudStatus();
      router.push(callbackUrl);
      router.refresh();
    } catch {
      setError("登入時發生錯誤");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div>
        <Link href="/" className="text-sm text-slate-400 hover:text-slate-200">
          ← 回首頁
        </Link>
        <h1 className="mt-4 text-2xl font-bold text-white">登入 Bowl Track</h1>
        <p className="mt-2 text-sm text-slate-400 leading-relaxed">
          Guest 可不登入，球局只存本機 localStorage。登入後若已設定 Neon
          DATABASE_URL，球局會同步到雲端。
        </p>
      </div>

      {dbOk === false && (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
          目前未偵測到 <code className="text-amber-50">DATABASE_URL</code>
          。仍可登入（JWT），但球局不會寫入 Neon，繼續用本機後備。
        </div>
      )}
      {dbOk === true && (
        <div className="rounded-xl border border-emerald-800/50 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-100">
          已連上 Neon：登入後球局會同步雲端。
        </div>
      )}

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-5"
      >
        <label className="block text-sm">
          <span className="text-slate-300">電郵</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-sky-500"
            placeholder="you@example.com"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-300">顯示名稱（可選）</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-sky-500"
            placeholder="Tony"
          />
        </label>
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-sky-600 py-2.5 font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
        >
          {busy ? "登入中…" : "以電郵登入"}
        </button>
        <p className="text-xs text-slate-500 leading-relaxed">
          本機簡化模式：輸入電郵即可建立／還原帳號（無密碼）。正式環境可再加
          Email magic link（見 README 的 EMAIL_SERVER）。
        </p>
      </form>

      <Link
        href="/session"
        className="text-center text-sm text-slate-400 hover:text-sky-400"
      >
        或以 Guest 繼續（僅本機）→
      </Link>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center text-slate-400">
          載入…
        </main>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
