import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-8 px-4 py-10">
      <div>
        <p className="mb-2 text-sm font-medium text-sky-400">Bowl Track</p>
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          保齡球球路追蹤
        </h1>
        <p className="mt-3 text-slate-400 leading-relaxed">
          類似 LaneTrax 的瀏覽器版：鏡頭／上傳、自動或手動球道四角、穩健追球，並粗估
          Foul／Arrows／Breakpoint／角度／球速／Hook／Shot time，以及實驗性 RPM。
        </p>
      </div>

      <ol className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 text-sm text-slate-300">
        <li>
          <span className="font-semibold text-slate-100">1. 開啟鏡頭或上傳</span>
          <br />
          從球道後方拍攝，畫面需見到 foul line～pins（參考 LaneTrax）。
        </li>
        <li>
          <span className="font-semibold text-slate-100">2. 自動偵測或拖曳四角</span>
          <br />
          按「自動偵測球道」估四角；失敗或不準可手動拖藍點。
        </li>
        <li>
          <span className="font-semibold text-slate-100">3. 開始追蹤</span>
          <br />
          背景模型＋ROI＋平滑／丟幀預測；投球後自動存檔。
        </li>
        <li>
          <span className="font-semibold text-slate-100">4. 查看指標</span>
          <br />
          側欄顯示 board、角度、球速、Hook、Shot time；RPM 標為實驗／需球標。
        </li>
      </ol>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link
          href="/session"
          className="inline-flex items-center justify-center rounded-xl bg-sky-600 px-5 py-3 text-center text-base font-semibold text-white shadow-lg shadow-sky-900/40 hover:bg-sky-500"
        >
          開始追蹤
        </Link>
      </div>

      <p className="text-xs text-slate-600 leading-relaxed">
        已知限制：自動偵測在暗光／無明顯亮球道時易失敗；RPM
        需球表高對比標記且信心常偏低；數值為軌跡粗估，非正式雷達／光學量測。資料僅存
        localStorage。
      </p>
    </main>
  );
}
