# 個人資產總帳 (Wealth Ledger)

一個輕量、本機優先的個人理財與資產管理 Web App，整合**台／美／港股、跨幣別銀行現金、實體投資、固定收入、支出紀錄與外幣交易**，並透過 **Cloudflare Workers** 提供即時股價與匯率查詢 API，支援 PWA 安裝、JSON / Excel 備份，以及可選的 Firebase 雲端同步。

---

## 主要功能

### 資產管理與儀表板
- **今日任務與總覽儀表板**：一眼掌握總淨資產、資產成長趨勢線圖、資產配置比例與各幣別曝險分佈。
- **股票與 ETF**：支援 **台股（上市 / 上櫃）**、**美股**、**港股** 持倉管理，可即時更新股價，也支援批次手動調價與 Google 試算表 CSV 備援報價。
- **銀行現金**：管理多幣別存款帳戶，自動依即時匯率換算為新台幣（TWD）。
- **實體投資**：追蹤房地產、貴金屬或其他非證券類實體投資項目。

### 現金流與歷史追蹤
- **固定收入與支出紀錄**：記錄每月固定收入與日常／不定期支出。
- **外幣交易**：記錄換匯明細與成本。
- **歷史紀錄與快照**：支援自動記錄每日淨資產快照，以圖表檢視長期資產變化趨勢。

### 隱私、備份與跨裝置同步
- **本機優先（Local-First）**：預設所有資料僅儲存在瀏覽器 `localStorage`，無需註冊帳號即可使用。
- **完整匯出與還原**：一鍵匯出／匯入 **JSON** 完整備份檔或 **Excel (`.xlsx`)** 報表。
- **可選雲端同步**：於「匯率與備份」頁面填入自己的 Firebase Config JSON，即可啟用 Google 登入與 Firestore 跨裝置同步。
- **PWA 支援**：內建 `manifest.json` 與 Service Worker，可加入手機或電腦主畫面作為獨立 App 使用。

---

## 技術架構

| 層級 | 技術 |
| --- | --- |
| **前端介面** | 單頁應用（`public/index.html`）、Tailwind CSS、Chart.js、SheetJS (`xlsx`) |
| **雲端同步（選用）** | Firebase Authentication (Google) & Cloud Firestore |
| **後端與託管** | Cloudflare Workers + Workers Static Assets (`wrangler.jsonc`) |
| **即時報價來源** | Yahoo Finance API（台股自動備援 TWSE / TPEx 公開資訊） |
| **即時匯率來源** | Yahoo Finance FX（自動備援 `open.er-api.com`，支援 160+ 幣別） |

---

## 專案結構

```text
wealth-ledger/
├── worker.js              # Cloudflare Worker：處理 /api/quotes、/api/fx 並導向靜態資源
├── wrangler.jsonc         # Cloudflare Workers 設定檔（指定 Worker 入口與 ./public 靜態目錄）
└── public/
    ├── index.html         # 前端完整應用程式（UI、圖表、本機儲存、匯入匯出、Firebase 同步）
    ├── manifest.json      # PWA Web App Manifest
    └── sw.js              # Service Worker（支援快取與離線降級）
```

---

## 內建 API 端點

由 `worker.js` 提供，預設套用 60 秒快取（`Cache-Control: public, max-age=60`）：

### 1. 查詢即時股價
```http
GET /api/quotes?items=TW:2330,US:AAPL,HK:0700
```
- **參數**：`items` 以逗號分隔，格式為 `市場:代號`（支援 `TW`、`US`、`HK`，省略市場前綴時預設為 `US`；單次上限 40 檔）。
- **回應範例**：
  ```json
  {
    "ok": true,
    "updatedAt": "2026-11-21T00:00:00.000Z",
    "prices": {
      "TW:2330": 1050,
      "US:AAPL": 228.5,
      "HK:0700": 410.2
    }
  }
  ```

### 2. 查詢即時匯率（對新台幣 TWD）
```http
GET /api/fx?currencies=USD,JPY,HKD,CNY
```
- **參數**：`currencies` 以逗號分隔的 3 碼 ISO 幣別代碼（預設 `USD,JPY,HKD,CNY`；單次上限 25 種幣別）。
- **回應範例**：
  ```json
  {
    "ok": true,
    "source": "yahoo",
    "updatedAt": "2026-11-21T00:00:00.000Z",
    "rates": {
      "USD": 32.5,
      "JPY": 0.215,
      "HKD": 4.18,
      "CNY": 4.52
    }
  }
  ```

---

## 本機開發與部署

### 環境需求
- Node.js 18+（用於執行 `npx wrangler`）
- Cloudflare 帳號（部署至 Cloudflare Workers 時需要）

### 本機預覽
```bash
npx wrangler dev
```
啟動後即可在瀏覽器開啟本機預覽網址，並同時測試 `/api/quotes` 與 `/api/fx`。

### 手動部署至 Cloudflare Workers
```bash
npx wrangler deploy
```

### 透過 GitHub 自動部署（Cloudflare Workers Builds）
1. 在 Cloudflare Dashboard 進入 **Workers & Pages**，建立或選擇專案並連接此 GitHub Repository。
2. 建置設定如下：
   - **Production branch**：`main`
   - **Build command**：留空（本專案無需額外編譯步驟）
   - **Deploy command**：`npx wrangler deploy`
   - **Root directory**：`/`
3. 之後每次推送至 `main` 分支，Cloudflare 即會自動部署最新版本。

---

## 注意事項
- **免責聲明**：本專案串接之即時股價與匯率資料僅供個人資產統計參考，不構成任何投資建議；實際報價與匯率請以各券商及銀行公告為準。
- **資料備份**：若未使用 Firebase 雲端同步，清除瀏覽器快取或更換裝置可能導致本機資料遺失，建議定期於介面右上角或「匯率與備份」頁下載 JSON / Excel 備份檔。