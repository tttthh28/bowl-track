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

驗證腳本（合成 blob／色球偏好／shot end）：

```bash
npx tsx scripts/verify-tracker-run.mts
```

> 手機鏡頭需在 **HTTPS** 或 `localhost` 下使用 `getUserMedia`。

## 用法

1. 首頁按「開始追蹤」進入 `/session`
2. **開啟鏡頭**（優先後置）或 **上傳影片**——鏡頭需見到 **foul～pins**
3. 按 **自動偵測球道**，或拖曳四個藍點對準四角：
   - **TL / TR**（上）：pin deck 左／右
   - **BL / BR**（下）：foul line 左／右
4. 調整靈敏度（可開「自動微調」）後按 **開始追蹤**
5. 等紫色／暗色球出現自動鎖定，或**直接點影片上的球**強制鎖定
6. 球消失／出球道／到 pin 區後消失／**影片 loop 回繞** → 自動結束並寫入本局（localStorage＋側欄）

## 已實作功能

- 即時鏡頭／影片上傳
- **自動偵測球道四角**（亮區／梯形邊緣擬合）＋手動拖曳後備
- 透視變換（影像 → 0–39 boards × 0–60 feet）
- **穩健追球**：
  - 背景模型＋球道多邊形 ROI＋幀差融合
  - **圓形度／填滿率**（忽略細長導引線）
  - **紫／暗色球色偏好**（壓低紅／綠導引線）
  - 速度／加速度限制、誤鎖靜物自動解除
  - 啟動可點選球或等球移動出現
  - EMA 平滑、丟幀預測、自動閾值
- 明確 **shot end**：連續丟幀、出 ROI、pin 區後消失、影片 `currentTime` 回繞 flush
- 存檔品質門檻：軌跡點數＋像素位移＋ feet 跨度不足則不寫入
- 影片疊軌跡 + 2D 球道圖
- 指標：Foul／Arrows／Entry、Breakpoint、Launch／Impact 角與球速、Hook、Shot time、實驗 RPM
- 球局存 localStorage；清除投球／新球局
- 繁中 UI、手機 viewport

## 指標怎麼算（簡述）

| 指標 | 算法 |
|------|------|
| Foul / Arrows / Pocket board | 軌跡在 ≈1′ / 15′ / 58′ 的 board 線性插值 |
| Breakpoint | 15′–48′ 間 board 對 feet 曲率最大處（失敗則 42′） |
| Launch / Impact 角 | 區段 Δboard／Δfeet 轉成相對中線角度（度） |
| Launch / Impact / Avg 速 | 過濾預測點後，沿 feet 進度／時間 → mph（滑窗中位，約 5–35） |
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
- 強烈反光／與球同色的大塊靜物仍可能誤觸（已加運動門檻與靜止解除）
- 相機大幅晃動仍可能誤觸
- 球速／角度／Hook 為路徑粗估（非雷達）
- 資料僅存該瀏覽器
- 未做多球道／計分／雲端
- demo 影片若四角未對準，請先自動偵測或手動拖點；必要時點球鎖定

## 建議試用步驟（Tony）

1. `cd /workspace/bowl-track && npm run dev`
2. 上傳 `test-media/bowling-demo.mp4` → **自動偵測** → 微調藍點對 foul～pins → **開始追蹤**
3. 等紫球出現，或**點一下球**鎖定；播完 loop 應見側欄「本局已存 ≥1 投」
4. 若仍鎖導引線：點球強制鎖定；加大最小 blob；靈敏度 30–45
5. 確認球速非「—」、2D 圖為一條往 pins 的曲線而非亂線
6. `npm run build` 應通過（不要 push／部署，除非明確說「做」）

本專案刻意不 push、不部署（等明確「做」）。
