import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-8 px-4 py-10">
      <div>
        <p className="mb-2 text-sm font-medium text-sky-400">Bowl Track MVP</p>
        <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          保齡球球路追蹤
        </h1>
        <p className="mt-3 text-slate-400 leading-relaxed">
          類似 LaneTrax 的精簡瀏覽器版：用手機鏡頭或上傳影片，手動標定球道四角，以幀差追球並在 39-board 球道圖上畫出路徑，粗估箭頭區／breakpoint／進袋 board。
        </p>
      </div>

      <ol className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 text-sm text-slate-300">
        <li>
          <span className="font-semibold text-slate-100">1. 開啟鏡頭或上傳</span>
          <br />
          建議從球道側後方拍攝；手機優先使用後置鏡頭。
        </li>
        <li>
          <span className="font-semibold text-slate-100">2. 拖曳四角</span>
          <br />
          後方拍攝時：上兩邊對準 pin deck，下兩邊對準 foul line（可拖曳調整）。
        </li>
        <li>
          <span className="font-semibold text-slate-100">3. 開始追蹤</span>
          <br />
          投球後自動疊軌跡；球消失數幀後結束一投並存入本機。
        </li>
        <li>
          <span className="font-semibold text-slate-100">4. 查看球道圖與粗估</span>
          <br />
          側欄顯示路徑與箭頭／BP／袋口 board、可選球速。
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
        已知限制：依賴光線與球／背景對比；深色球在暗道上可能追不到；四角需手動；透視與球速為粗估，非正式量測。資料僅存瀏覽器 localStorage。
      </p>
    </main>
  );
}
