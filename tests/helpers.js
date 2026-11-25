// E2E 共用工具（JavaScript）。
//
// 核心原則：測試結果不依賴即時市場價格。所有 /api/* 呼叫都在瀏覽器端攔截，
// 回傳固定的假資料；測試斷言只圍繞畫面行為。唯一依賴的外部資源是 CDN 上的
// Tailwind / Chart.js / SheetJS / Firebase（GitHub Actions runner 可連外網）。
import { expect } from '@playwright/test';

export const STORAGE_KEY = 'personal_wealth_dashboard_v1';
export const CFG_KEY = 'personal_wealth_dashboard_cfg_v1';

// 固定假報價（mock）：key 是 `市場:代號`，與 worker 的 /api/quotes 契約一致
export const MOCK_PRICES = {
  'US:AAPL': 200,
  'US:MSFT': 300,
  'TW:2330': 1000,
  'US:NVDA': 150,
};
const DEFAULT_MOCK_PRICE = 100;

export function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

// 攔截全部後端 API，回固定假資料（必須在 goto 之前註冊）
export async function mockApiRoutes(page) {
  // 匯率：固定值，測試不依賴即時匯率
  await page.route('**/api/fx*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        source: 'mock',
        updatedAt: new Date().toISOString(),
        rates: { USD: 32.5, JPY: 0.21, HKD: 4.18, CNY: 4.5 },
      }),
    });
  });

  // 股價：依請求的 items 回傳固定價，meta 一律 Yahoo、交易日為今天
  await page.route('**/api/quotes*', async (route) => {
    const url = new URL(route.request().url());
    const items = (url.searchParams.get('items') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const prices = {};
    const meta = {};
    const marketDate = todayISODate();
    const marketTime = new Date().toISOString();
    for (const item of items) {
      prices[item] = MOCK_PRICES[item] ?? DEFAULT_MOCK_PRICE;
      meta[item] = { source: 'yahoo', marketTime, marketDate };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, updatedAt: new Date().toISOString(), prices, meta }),
    });
  });

  // 歷史走勢：60 筆固定收盤價（190 → 207.7），供走勢圖測試使用
  await page.route('**/api/history*', async (route) => {
    const url = new URL(route.request().url());
    const market = url.searchParams.get('market') || 'US';
    const symbol = url.searchParams.get('symbol') || '';
    const dates = [];
    const closes = [];
    const today = new Date();
    for (let i = 59; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
      closes.push(Number((190 + (59 - i) * 0.3).toFixed(2)));
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, market, symbol, ticker: symbol, source: 'mock', dates, closes }),
    });
  });
}

export function blankState(overrides = {}) {
  return {
    version: '1.5',
    fx: { TWD: 1, USD: 32.5, JPY: 0.21, HKD: 4.18, CNY: 4.5 },
    cash: [],
    stocks: [],
    investments: [],
    fixedIncomes: [],
    fixedExpenses: [],
    randomExpenses: [],
    fxTrades: [],
    incomeReceipts: [],
    investmentLogs: [],
    stockTrades: [],
    snapshots: [],
    ledger: [],
    budgets: { monthlyTotal: 0, byCategory: {} },
    groupTrips: [],
    alertEvents: [],
    ...overrides,
  };
}

export function makeStock(overrides = {}) {
  return {
    id: 's-e2e-1',
    symbol: 'AAPL',
    name: 'Apple',
    market: 'US',
    account: '',
    currency: 'USD',
    shares: 10,
    avgCost: 180,
    currentPrice: 200,
    buyPrice: 0,
    stopPrice: 0,
    takeProfitPrice: 0,
    quoteSource: '',
    quoteDate: '',
    quoteUpdatedAt: '',
    alertState: { buy: false, stop: false, tp: false },
    ...overrides,
  };
}

// 開啟 App；有 seed 時先寫入 localStorage 再重整，讓 App 以該資料啟動
//（不用 addInitScript，因為它會在每次重整時重寫，破壞「重整後還在」的斷言）
export async function gotoApp(page, { seed = null } = {}) {
  await mockApiRoutes(page);
  await page.goto('/');
  await page.locator('.tab-btn[data-tab="overview"]').waitFor({ state: 'visible' });
  if (seed) {
    await page.evaluate(
      ({ key, stateJson }) => localStorage.setItem(key, stateJson),
      { key: STORAGE_KEY, stateJson: JSON.stringify(seed) },
    );
    await page.reload();
    await page.locator('.tab-btn[data-tab="overview"]').waitFor({ state: 'visible' });
  }
}

export async function goToTab(page, tab) {
  await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
  await page.locator(`#tab-${tab}`).waitFor({ state: 'visible' });
}

export function stockRow(page, symbol) {
  return page.locator('#stocks-tbody tr', { hasText: symbol });
}

// 走 UI 新增一檔持股（modal 欄位 name 與 openStockModal 一致）
export async function addStockViaUI(
  page,
  { symbol, name, market, currency, shares, avgCost, currentPrice },
) {
  await goToTab(page, 'stocks');
  await page.locator('#btn-add-stock').click();
  await expect(page.locator('#modal-title')).toHaveText('新增股票持倉');
  const form = page.locator('#modal-form');
  await form.locator('input[name="symbol"]').fill(symbol);
  await form.locator('input[name="name"]').fill(name);
  await form.locator('select[name="market"]').selectOption(market);
  await form.locator('select[name="currency"]').selectOption(currency);
  await form.locator('input[name="shares"]').fill(String(shares));
  await form.locator('input[name="avgCost"]').fill(String(avgCost));
  await form.locator('input[name="currentPrice"]').fill(String(currentPrice));
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#stocks-tbody')).toContainText(symbol);
}

export async function readState(page) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, STORAGE_KEY);
}

export async function readRawConfig(page) {
  return page.evaluate((key) => localStorage.getItem(key) || '', CFG_KEY);
}

// 收集未捕捉的 JS 錯誤（window.onerror / 未處理的 rejection）
export function trackPageErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(String((err && err.message) || err)));
  return errors;
}
