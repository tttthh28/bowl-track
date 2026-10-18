# Bowl Track — 保齡球球路追蹤

瀏覽器端球路追蹤（類似 LaneTrax 概念）：Next.js App Router + TypeScript，追球使用純 Canvas／ImageData，無需 TensorFlow。

**v0.3**：Guest（localStorage）＋可選電郵登入；登入後可把球局／投球同步到 **Neon Postgres**。無 `DATABASE_URL` 時行為與先前相同（純本機）。

## 本機啟動

```bash
cd /workspace/bowl-track
cp .env.example .env.local   # 按下方填寫；可先空著只跑 Guest
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

## 環境變數（`.env.local`）

| 變數 | 必填？ | 說明 |
|------|--------|------|
| `DATABASE_URL` | 雲端同步時必填 | Neon **Singapore pooled** 連線字串（`…-pooler…` + `sslmode=require`）。只放環境變數，勿 commit。 |
| `AUTH_SECRET` | 正式登入建議必填 | Auth.js 密鑰，≥32 字元。`openssl rand -base64 32` |
| `AUTH_URL` | 本機建議 | 例：`http://localhost:3000`（Auth 回調基底） |
| `EMAIL_SERVER` / `EMAIL_FROM` | 可選 | 預留 magic link；**目前實作為「輸入電郵即登入」**（無密碼）。設了也不會自動切 magic，見下方擴充。 |

**沒有 `DATABASE_URL`**：Guest／即使登入也只寫 **localStorage**；`/api/sessions` 回 503 並標 `fallback: localStorage`；`npm run build` 仍通過。

**有 `DATABASE_URL` + 登入**：球局 upsert 到 Neon；本機仍先寫 localStorage 作離線後備。

### 第一次建表

任選其一：

```bash
# 需已在 .env.local 設 DATABASE_URL
npm run db:push
```

或在 Neon SQL Editor 執行 `drizzle/0000_init.sql`。

## 架構（帳號＋存檔）

```
UI（繁中）
  ├─ Guest → src/lib/storage.ts → localStorage
  └─ 登入（NextAuth Credentials 電郵）→ JWT
        └─ 有 DATABASE_URL 時背景同步
              POST/GET /api/sessions
              POST /api/sessions/[id]/shots
              DELETE /api/sessions/[id]?clearShots=1
                    ↓
              Drizzle + @neondatabase/serverless
                    ↓
              Neon Postgres（users / bowling_sessions / shots）
```

- **Auth**：`src/auth.ts`（Auth.js／next-auth v5）、`/api/auth/[...nextauth]`、`/login`
- **探測**：`GET /api/cloud` → `{ database, authenticated, user }`
- **ORM**：`src/db/schema.ts`、`src/db/index.ts`（無 URL 時 `getDb()` = `null`）
- **Repo**：`src/lib/sessionRepo.ts`
- **混合存檔**：`storage.ts` 永遠寫本機；登入＋DB 時 `cloudClient.ts` 非同步同步

## 用法（追球）

1. 首頁按「開始追蹤」進入 `/session`（或先「登入同步雲端」）
2. **開啟鏡頭**（優先後置）或 **上傳影片**——鏡頭需見到 **foul～pins**
3. 按 **自動偵測球道**，或拖曳四個藍點對準四角
4. 調整靈敏度後按 **開始追蹤**
5. 等球出現自動鎖定，或**直接點影片上的球**
6. 球消失／出球道／影片 loop → 自動結束並寫入本局

## 已實作功能

- 即時鏡頭／影片上傳、自動／手動四角、穩健追球、LaneTrax 風格指標＋實驗 RPM
- 球局 localStorage；**可選登入＋Neon 同步**
- 繁中 UI、手機 viewport

## 點試（Tony）

### A. 無 DB（Guest，必過）

1. 不要設 `DATABASE_URL`（或留空）
2. `npm run dev` → `/session` → 上傳 `test-media/bowling-demo.mp4` → 追蹤 → 側欄有投球
3. 重新整理仍在（localStorage）
4. `npm run build` 應通過

### B. 有 Neon（登入同步）

1. `.env.local` 填 Neon pooled `DATABASE_URL`、`AUTH_SECRET`、`AUTH_URL=http://localhost:3000`
2. `npm run db:push`（或跑 `drizzle/0000_init.sql`）
3. `npm run dev` → `/login` 輸入電郵 → 進 `/session` 追一投
4. Neon 表 `bowling_sessions`／`shots` 應有列；另開無痕／清 localStorage 再登入同一電郵應能還原
5. 關掉 `DATABASE_URL` 重啟 → 仍可用本機後備

### C. 不要做的事

- **不要 push／部署**，除非明確說「做」
- 不要把 `DATABASE_URL`／`AUTH_SECRET` 寫進 git

## 指標怎麼算（簡述）

| 指標 | 算法 |
|------|------|
| Foul / Arrows / Pocket board | 軌跡在 ≈1′ / 15′ / 58′ 的 board 線性插值 |
| Breakpoint | 15′–48′ 間 board 對 feet 曲率最大處（失敗則 42′） |
| Launch / Impact 角 | 區段 Δboard／Δfeet 轉成相對中線角度（度） |
| Launch / Impact / Avg 速 | 過濾預測點後，沿 feet 進度／時間 → mph |
| Hook boards | Foul（或 Arrows）board − BP board |
| Hook factor | \|hook\| / (BP feet − 15′) |
| Shot time | 首末有效軌跡點時間差 |
| RPM（實驗） | 球周環帶極座標強度條幀間循環相關 → RPM |

## RPM／已知限制

- RPM 需球表高對比標記；模糊／素色球信心低
- 自動偵測暗館／側拍易失敗 → 手動
- 球速／角度／Hook 為路徑粗估
- 電郵登入為**無密碼簡化**；正式建議改 Auth.js Email magic＋`EMAIL_SERVER`
- 未做多球道／正式計分／OAuth

## 擴充（可選）

- 加 `Email` provider（Resend／SMTP）做 magic link，關掉 Credentials
- Vercel 專案環境變數對應同表；Hobby 夠用；連 Neon Singapore pooled

本專案刻意不 push、不部署（等明確「做」）。
