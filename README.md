# Bowl Track — 保齡球球路追蹤

瀏覽器端球路追蹤（類似 LaneTrax 概念）：Next.js App Router + TypeScript，追球使用純 Canvas／ImageData，無需 TensorFlow。

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

> 手機鏡頭需在 **HTTPS** 或 `localhost` 下使用 `getUserMedia`。

## 用法

1. 首頁按「開始追蹤」進入 `/session`
2. **開啟鏡頭**（優先後置）或 **上傳影片**——鏡頭需見到 **foul～pins**
3. 按 **自動偵測球道**，或拖曳四個藍點對準四角：
   - **TL / TR**（上）：pin deck 左／右
   - **BL / BR**（下）：foul line 左／右
4. 調整靈敏度（可開「自動微調」）後按 **開始追蹤**
5. 投球；軌跡疊在影片上（黃點＝預測幀），側欄同步更新
6. 球消失約十餘幀後自動結束一投並寫入本局（localStorage）

## 已實作功能

- 即時鏡頭／影片上傳
- **自動偵測球道四角**（亮區／梯形邊緣擬合）＋手動拖曳後備
- 透視變換（影像 → 0–39 boards × 0–60 feet）
- **穩健追球**：背景模型＋球道多邊形 ROI＋幀差融合、EMA 平滑、丟幀預測、自動閾值、偏好預測鄰近 blob
- 影片疊軌跡 + 2D 球道圖
- 指標：Foul／Arrows／Entry、Breakpoint board＋distance、Launch／Impact 角、Launch／Impact／Avg 球速、Hook boards／Hook factor（簡化）、Shot time
- **實驗性 RPM**：球表極座標循環相關估角速度；UI 標實驗／信心；可調對比門檻
- 球局存 localStorage；清除投球／新球局
- 繁中 UI、手機 viewport

## 指標怎麼算（簡述）

| 指標 | 算法 |
|------|------|
| Foul / Arrows / Pocket board | 軌跡在 ≈1′ / 15′ / 58′ 的 board 線性插值 |
| Breakpoint | 15′–48′ 間 board 對 feet 曲率最大處（失敗則 42′） |
| Launch / Impact 角 | 區段 Δboard／Δfeet 轉成相對中線角度（度） |
| Launch / Impact / Avg 速 | 區段或全程 feet／時間 → mph |
| Hook boards | Foul（或 Arrows）board − BP board |
| Hook factor | \|hook\| / (BP feet − 15′) |
| Shot time | 首末有效軌跡點時間差 |
| RPM（實驗） | 球周環帶極座標強度條幀間循環相關 → deg/s → RPM |

## RPM 限制

- 需球表**高對比色塊／標記**；素色球幾乎無解
- 模糊、曝光、遮擋會讓信心偏低；UI 顯示「低信心」時勿当真
- 估的是影像角自旋投影，非正式陀螺／雷達 RPM
- 進階面板可關 RPM 或調「對比門檻」

## 已知限制

- 自動偵測依賴亮球道與後方梯形視角；暗館／側拍易失敗 → 改手動
- 相機大幅晃動仍可能誤觸（背景模型可緩解）
- 球速／角度／Hook 為路徑粗估
- 資料僅存該瀏覽器
- 未做多球道／計分／雲端

## 建議試用步驟（Tony）

1. `cd /workspace/bowl-track && npm run dev`
2. 上傳後方 foul～pins 短片 → **自動偵測** → 微調藍點 → **開始追蹤**
3. 雜訊多：開「自動微調」、靈敏度 35–50、加大最小 blob；進階可降背景學習率
4. 測 RPM：球上貼清晰對比標，進階開啟 RPM，看信心標籤
5. 確認側欄指標後連投數球看 localStorage 累積

本專案刻意不 push、不部署（等明確「做」）。
