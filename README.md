# Bowl Track — 保齡球球路追蹤 MVP

瀏覽器端精簡版球路追蹤（類似 LaneTrax 概念）：Next.js App Router + TypeScript，追球使用純 Canvas／ImageData 幀差，無需 TensorFlow。

## 本機啟動

```bash
cd /workspace/bowl-track
npm install
npm run dev
```

瀏覽器開啟 [http://localhost:3000](http://localhost:3000)。

正式檢查：

```bash
npm run build
npm start
```

> 手機鏡頭需在 **HTTPS** 或 `localhost` 下使用 `getUserMedia`。若用區網 IP 測手機，請自行設定 HTTPS 或用瀏覽器旗標／隧道。

## 用法

1. 首頁按「開始追蹤」進入 `/session`
2. **開啟鏡頭**（優先後置 `facingMode: environment`）或 **上傳影片**
3. 拖曳畫面四個藍點，對準球道四角（預設後方視角）：
   - **TL / TR**（上）：pin deck 左／右
   - **BL / BR**（下）：foul line 左／右
4. 調整「追蹤靈敏度」後按 **開始追蹤**
5. 投球；軌跡疊在影片上，側欄球道圖同步更新
6. 球消失約十餘幀後自動結束一投，粗估寫入本局（localStorage）

## 已實作功能

- 即時鏡頭／影片上傳
- 可拖曳四角標定 + 透視變換（影像 → 0–39 boards × 0–60 feet）
- 灰階幀差 + 最大 blob 質心追球；可調閾值與最小 blob
- 影片疊軌跡 + 2D 球道圖（簡化 39 boards）
- 粗估：箭頭區（≈15′）、breakpoint（≈42′）、進袋（≈58′）board；可選粗球速 mph
- 球局存 localStorage；清除投球／新球局
- 繁中 UI、手機 viewport

## 已知限制

- 光線不足、球與球道對比低、或相機大幅晃動時易丟球／誤追
- 需手動四角；四角標歪會讓 board／球速偏差很大
- 幀差會把「任何移動物」當候選，背景有人走過可能干擾
- 球速為路徑 feet／時間粗估，非正式雷達測速
- 資料僅存於該瀏覽器，清除網站資料即消失
- 未做多球道／計分／雲端同步

## 技術摘要

| 項目 | 說明 |
|------|------|
| 框架 | Next.js 14（App Router）、React 18、TypeScript、Tailwind |
| 追球 | `getImageData` → 灰階差 → 閾值 → 4-連通最大 blob |
| 座標 | 四點透視（homography）映射到簡化球道 |
| 儲存 | `localStorage` key `bowl-track-sessions-v1` |

## 建議試用步驟（Tony）

1. `cd /workspace/bowl-track && npm run dev`
2. 用桌上型機先上傳一段側／後方球道短片驗證四角與軌跡
3. 手機連同一 `localhost` 隧道或 HTTPS 後測後置鏡頭
4. 若雜訊多：把靈敏度調到 35–50，並加大「最小 blob」
5. 確認側欄袋口 board 與肉眼大致同向後，再連投數球看 localStorage 累積

本專案刻意不 push、不部署。
