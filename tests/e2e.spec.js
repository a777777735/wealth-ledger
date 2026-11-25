// 持倉監控平台 E2E 功能測試（JavaScript，Playwright + Chromium）。
//
// 不依賴即時市場價格：所有 /api/fx、/api/quotes、/api/history 都在 tests/helpers.js
// 以固定假資料攔截（AAPL 固定 200 美元、匯率固定、走勢 60 筆固定收盤價）。
// 測試只斷言畫面行為：列表出現、徽章出現、localStorage 寫入、彈窗流程。
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blankState,
  makeStock,
  gotoApp,
  goToTab,
  addStockViaUI,
  stockRow,
  readState,
  readRawConfig,
  trackPageErrors,
  todayISODate,
} from './helpers.js';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'sample-import.json',
);

test('1. 儀表板載入：無未捕捉 JS 錯誤，總淨資產與持股列表出現', async ({ page }) => {
  const errors = trackPageErrors(page);
  await gotoApp(page, { seed: blankState({ stocks: [makeStock()] }) });

  await expect(page).toHaveTitle(/個人資產總帳/);

  await goToTab(page, 'overview');
  await expect(page.locator('#kpi-total-networth')).toBeVisible();
  await expect(page.locator('#kpi-total-networth')).toContainText('NT$');

  await goToTab(page, 'stocks');
  await expect(page.locator('#stocks-tbody')).toBeVisible();
  await expect(page.locator('#stocks-tbody')).toContainText('AAPL');

  expect(errors).toEqual([]);
});

test('2. 新增持股：走 UI 新增 US:AAPL，儲存後列表出現、寫入 localStorage，重整後還在', async ({
  page,
}) => {
  await gotoApp(page, { seed: blankState() });

  await addStockViaUI(page, {
    symbol: 'AAPL',
    name: 'Apple',
    market: 'US',
    currency: 'USD',
    shares: 10,
    avgCost: 180,
    currentPrice: 200,
  });

  const state = await readState(page);
  expect(state.stocks.some((s) => s.symbol === 'AAPL' && s.market === 'US')).toBe(true);

  await page.reload();
  await goToTab(page, 'stocks');
  await expect(page.locator('#stocks-tbody')).toContainText('AAPL');

  const stateAfterReload = await readState(page);
  expect(stateAfterReload.stocks.some((s) => s.symbol === 'AAPL')).toBe(true);
});

test('3. 提醒設定：設定買進／停損／停利價，重整後還在；現價觸及買進價時出現徽章與事件', async ({
  page,
}) => {
  await gotoApp(page, { seed: blankState() });
  await addStockViaUI(page, {
    symbol: 'AAPL',
    name: 'Apple',
    market: 'US',
    currency: 'USD',
    shares: 10,
    avgCost: 180,
    currentPrice: 200,
  });

  // 買進價 210 高於 mock 現價 200（買進條件：現價 ≤ 買進價），停損 190，停利 250
  // 芒格式預設不用價格停損：要填停損價需先勾「另設硬性停損價」，停損輸入框才會顯示
  await stockRow(page, 'AAPL').locator('button[data-action="edit-stock"]').click();
  await expect(page.locator('#modal-title')).toHaveText('編輯股票持倉');
  const form = page.locator('#modal-form');
  await expect(page.locator('#stock-stop-wrap')).toBeHidden();
  await form.locator('#stock-hard-stop-toggle').check();
  await expect(page.locator('#stock-stop-wrap')).toBeVisible();
  await form.locator('input[name="buyPrice"]').fill('210');
  await form.locator('input[name="stopPrice"]').fill('190');
  await form.locator('input[name="takeProfitPrice"]').fill('250');
  await form.locator('button[type="submit"]').click();

  // 觸發一次報價更新（mock 回固定價 200），確認只產生一筆事件、不重複
  await page.locator('#btn-refresh-prices').click();
  const row = stockRow(page, 'AAPL');
  await expect(row).toContainText('買進價到');
  await expect(row).toContainText('提醒 買 210.00 · 停 190.00 · 利 250.00');
  await expect(page.locator('#alert-events-list')).toContainText('買進價到');
  await expect(page.locator('#alert-events-list')).toContainText('AAPL');
  await expect(page.locator('#alert-events-count')).toHaveText('1 則');

  const state = await readState(page);
  const aapl = state.stocks.find((s) => s.symbol === 'AAPL');
  expect(aapl.buyPrice).toBe(210);
  expect(aapl.stopPrice).toBe(190);
  expect(aapl.takeProfitPrice).toBe(250);
  expect(state.alertEvents).toHaveLength(1);
  expect(state.alertEvents[0].type).toBe('buy');

  // 重整後設定、徽章與事件都還在，且不會重複產生事件
  await page.reload();
  await goToTab(page, 'stocks');
  await expect(stockRow(page, 'AAPL')).toContainText('買進價到');
  await expect(page.locator('#alert-events-count')).toHaveText('1 則');
  const stateAfterReload = await readState(page);
  expect(stateAfterReload.stocks.find((s) => s.symbol === 'AAPL').buyPrice).toBe(210);
  expect(stateAfterReload.alertEvents).toHaveLength(1);
});

test('4. 走勢圖：有提醒價的持股，圖表渲染且包含三條提醒線', async ({ page }) => {
  await gotoApp(page, {
    seed: blankState({
      stocks: [makeStock({ buyPrice: 210, stopPrice: 190, takeProfitPrice: 250 })],
    }),
  });
  await goToTab(page, 'stocks');

  await stockRow(page, 'AAPL').locator('button[data-action="chart-stock"]').click();
  await expect(page.locator('#stock-chart-modal')).toBeVisible();
  const canvas = page.locator('#stock-chart-canvas');
  await expect(canvas).toBeVisible();

  // 等圖表實例建立（mock 的 /api/history 回 60 筆收盤價）
  await page.waitForFunction(() => window.__stockChartDetail, null, { timeout: 15000 });
  const size = await canvas.evaluate((el) => ({ w: el.width, h: el.height }));
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);

  // 畫面上的提醒價副標題
  await expect(page.locator('#stock-chart-sub')).toContainText('買進 210.00');
  await expect(page.locator('#stock-chart-sub')).toContainText('停損 190.00');
  await expect(page.locator('#stock-chart-sub')).toContainText('停利 250.00');

  // 圖表設定本身：三條提醒線資料集（虛線）與包含三條線的 Y 軸範圍
  const chartInfo = await page.evaluate(() => {
    const c = window.__stockChartDetail;
    return {
      labels: c.data.datasets.map((d) => d.label),
      dashedLabels: c.data.datasets.filter((d) => d.borderDash).map((d) => d.label),
      yMin: c.options.scales.y.min,
      yMax: c.options.scales.y.max,
    };
  });
  expect(chartInfo.labels).toContain('買進 210.00');
  expect(chartInfo.labels).toContain('停損 190.00');
  expect(chartInfo.labels).toContain('停利 250.00');
  expect(chartInfo.dashedLabels).toHaveLength(3);
  expect(chartInfo.yMin).toBeLessThanOrEqual(190);
  expect(chartInfo.yMax).toBeGreaterThanOrEqual(250);

  await page.locator('#btn-close-stock-chart').click();
  await expect(page.locator('#stock-chart-modal')).toBeHidden();
});

test('5. 報價透明：持股列顯示報價來源與最後收盤日期', async ({ page }) => {
  await gotoApp(page, { seed: blankState({ stocks: [makeStock()] }) });
  await goToTab(page, 'stocks');

  await page.locator('#btn-refresh-prices').click();
  const row = stockRow(page, 'AAPL');
  await expect(row).toContainText('Yahoo');
  const mmdd = todayISODate().slice(5).replace('-', '/');
  await expect(row).toContainText(`收盤 ${mmdd}`);
  // 剛更新過，不應出現舊資料徽章
  await expect(row).not.toContainText('舊資料');
});

test('6. 匯入預覽：先預覽再寫入，取消不寫入、確認才寫入', async ({ page }) => {
  await gotoApp(page, {
    seed: blankState({
      stocks: [
        makeStock({
          id: 's-e2e-2330',
          symbol: '2330',
          name: '台積電',
          market: 'TW',
          currency: 'TWD',
          shares: 1000,
          avgCost: 900,
          currentPrice: 1000,
        }),
      ],
    }),
  });
  await goToTab(page, 'settings');

  // 先取消：資料不變
  await page.setInputFiles('#input-import-json', fixturePath);
  await expect(page.locator('#modal-title')).toHaveText('匯入 JSON 備份預覽');
  await expect(page.locator('#modal-fields')).toContainText('股票持倉');
  await expect(page.locator('#modal-fields')).toContainText('價格提醒事件');
  await page.locator('#btn-modal-cancel').click();
  await expect(page.locator('#form-modal')).toBeHidden();
  let state = await readState(page);
  expect(state.stocks.map((s) => s.symbol)).toEqual(['2330']);

  // 再確認：寫入備份內容（完整覆蓋對應項目）
  await page.setInputFiles('#input-import-json', fixturePath);
  await expect(page.locator('#modal-title')).toHaveText('匯入 JSON 備份預覽');
  await page.locator('#modal-form button[type="submit"]').click();
  await expect(page.locator('#form-modal')).toBeHidden();

  await goToTab(page, 'stocks');
  await expect(page.locator('#stocks-tbody')).toContainText('AAPL');
  await expect(page.locator('#stocks-tbody')).not.toContainText('2330');
  state = await readState(page);
  expect(state.stocks.map((s) => s.symbol)).toEqual(['AAPL']);
  expect(state.stocks[0].buyPrice).toBe(210);
});

test('7. 清空帳本：未輸入確認文字前按鈕停用，取消後資料還在', async ({ page }) => {
  await gotoApp(page, {
    seed: blankState({
      stocks: [
        makeStock({
          id: 's-e2e-2330',
          symbol: '2330',
          name: '台積電',
          market: 'TW',
          currency: 'TWD',
          shares: 1000,
          avgCost: 900,
          currentPrice: 1000,
        }),
      ],
    }),
  });
  await goToTab(page, 'settings');

  await page.locator('#btn-clear-blank').click();
  await expect(page.locator('#modal-title')).toHaveText('清空為空白帳本');
  const submit = page.locator('#modal-form button[type="submit"]');
  await expect(submit).toHaveText('確認清空');
  await expect(submit).toBeDisabled();

  await page.locator('#modal-form input[name="confirmText"]').fill('清空');
  await expect(submit).toBeEnabled();

  // 取消：資料還在
  await page.locator('#btn-modal-cancel').click();
  await expect(page.locator('#form-modal')).toBeHidden();
  let state = await readState(page);
  expect(state.stocks.map((s) => s.symbol)).toEqual(['2330']);

  // 真的清空：輸入確認文字後執行，資料歸零
  await page.locator('#btn-clear-blank').click();
  await page.locator('#modal-form input[name="confirmText"]').fill('清空');
  await page.locator('#modal-form button[type="submit"]').click();
  await expect(page.locator('#form-modal')).toBeHidden();
  state = await readState(page);
  expect(state.stocks).toEqual([]);
});

test('8. API Key 加密存放：設定 passphrase 後，localStorage 沒有 Key 明文', async ({
  page,
}) => {
  const fakeKey = 'sk-playwright-e2e-test-key-9f8e7d6c5b4a';
  const passphrase = 'playwright-test-passphrase';
  await gotoApp(page, { seed: blankState() });
  await goToTab(page, 'settings');

  // 加入一組測試 Key（此時還是明文存放）
  await page.locator('#cfg-ai-key').fill(fakeKey);
  await page.locator('#btn-save-ai-cfg').click();
  await expect(page.locator('#cfg-ai-key-list')).toContainText('Groq');

  // 設定加密密碼並遷移
  await page.locator('#cfg-ai-vault-banner button[data-vault-act="setup"]').click();
  await expect(page.locator('#modal-title')).toHaveText('設定金鑰加密密碼');
  await page.locator('#modal-form input[name="pw1"]').fill(passphrase);
  await page.locator('#modal-form input[name="pw2"]').fill(passphrase);
  await page.locator('#modal-form button[type="submit"]').click();
  await expect(page.locator('#cfg-ai-vault-banner')).toContainText('保險庫已解鎖');

  // localStorage 裡不得出現 Key 明文，只能看到 enc1. 密文
  const rawCfg = await readRawConfig(page);
  expect(rawCfg).not.toContain(fakeKey);
  expect(rawCfg).toContain('enc1.');
  await expect(page.locator('#cfg-ai-key-list')).toContainText('已加密存放');
});

test('9. 芒格式策略：IV=100、安全邊際 30 → 建議買進 70、停利 100；套用後儲存，圖表只畫兩條線、無停損線', async ({
  page,
}) => {
  await gotoApp(page, { seed: blankState() });
  await addStockViaUI(page, {
    symbol: 'AAPL',
    name: 'Apple',
    market: 'US',
    currency: 'USD',
    shares: 10,
    avgCost: 180,
    currentPrice: 90,
  });

  await stockRow(page, 'AAPL').locator('button[data-action="edit-stock"]').click();
  await expect(page.locator('#modal-title')).toHaveText('編輯股票持倉');
  const form = page.locator('#modal-form');
  // 策略預設為芒格式；芒格式面板顯示、停損輸入框預設隱藏
  await expect(form.locator('select[name="strategy"]')).toHaveValue('munger');
  await expect(page.locator('#stock-munger-panel')).toBeVisible();
  await expect(page.locator('#stock-stop-wrap')).toBeHidden();

  await form.locator('input[name="intrinsicValue"]').fill('100');
  await form.locator('input[name="marginOfSafety"]').fill('30');
  await expect(page.locator('#stock-munger-suggest-buy')).toHaveText('70.00');
  await expect(page.locator('#stock-munger-suggest-tp')).toHaveText('100.00');

  await page.locator('#btn-apply-munger-suggest').click();
  await expect(form.locator('input[name="buyPrice"]')).toHaveValue('70');
  await expect(form.locator('input[name="takeProfitPrice"]')).toHaveValue('100');

  await form.locator('input[name="sellConditions"][value="moat"]').check();
  await form.locator('input[name="sellConditions"][value="fcf"]').check();
  await form.locator('textarea[name="thesisNotes"]').fill('護城河是品牌與規模');
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#form-modal')).toBeHidden();

  // 儲存結果：停損價為空、策略與芒格式欄位齊全；列表顯示策略徽章與「停損：看基本面」
  const state = await readState(page);
  const aapl = state.stocks.find((s) => s.symbol === 'AAPL');
  expect(aapl.strategy).toBe('munger');
  expect(aapl.intrinsicValue).toBe(100);
  expect(aapl.marginOfSafety).toBe(30);
  expect(aapl.buyPrice).toBe(70);
  expect(aapl.takeProfitPrice).toBe(100);
  expect(aapl.stopPrice).toBe(0);
  expect(aapl.sellConditions).toEqual(['moat', 'fcf']);
  expect(aapl.thesisNotes).toBe('護城河是品牌與規模');
  const row = stockRow(page, 'AAPL');
  await expect(row).toContainText('芒格式');
  await expect(row).toContainText('停損：看基本面');
  await expect(row).toContainText('提醒 買 70.00 · 停損：看基本面 · 利 100.00');

  // 走勢圖：只畫買進＋停利兩條虛線，沒有停損線
  await row.locator('button[data-action="chart-stock"]').click();
  await expect(page.locator('#stock-chart-modal')).toBeVisible();
  await page.waitForFunction(() => window.__stockChartDetail, null, { timeout: 15000 });
  await expect(page.locator('#stock-chart-sub')).toContainText('買進 70.00');
  await expect(page.locator('#stock-chart-sub')).toContainText('停利 100.00');
  await expect(page.locator('#stock-chart-sub')).not.toContainText('停損');
  const chartInfo = await page.evaluate(() => {
    const c = window.__stockChartDetail;
    return {
      labels: c.data.datasets.map((d) => d.label),
      dashedLabels: c.data.datasets.filter((d) => d.borderDash).map((d) => d.label),
    };
  });
  expect(chartInfo.dashedLabels).toHaveLength(2);
  expect(chartInfo.labels).toContain('買進 70.00');
  expect(chartInfo.labels).toContain('停利 100.00');
  await page.locator('#btn-close-stock-chart').click();
});

test('10. 策略持久化：芒格式欄位重整後仍存在，編輯表單正確回填', async ({ page }) => {
  await gotoApp(page, {
    seed: blankState({
      stocks: [
        makeStock({
          strategy: 'munger',
          intrinsicValue: 100,
          marginOfSafety: 30,
          buyPrice: 70,
          takeProfitPrice: 100,
          stopPrice: 0,
          sellConditions: ['moat', 'debt'],
          thesisNotes: '護城河是品牌與規模',
          currentPrice: 90,
        }),
      ],
    }),
  });
  await goToTab(page, 'stocks');
  await expect(stockRow(page, 'AAPL')).toContainText('芒格式');
  await expect(stockRow(page, 'AAPL')).toContainText('停損：看基本面');

  await page.reload();
  await goToTab(page, 'stocks');
  const state = await readState(page);
  const aapl = state.stocks.find((s) => s.symbol === 'AAPL');
  expect(aapl.strategy).toBe('munger');
  expect(aapl.intrinsicValue).toBe(100);
  expect(aapl.marginOfSafety).toBe(30);
  expect(aapl.buyPrice).toBe(70);
  expect(aapl.takeProfitPrice).toBe(100);
  expect(aapl.stopPrice).toBe(0);
  expect(aapl.sellConditions).toEqual(['moat', 'debt']);
  expect(aapl.thesisNotes).toBe('護城河是品牌與規模');

  // 編輯表單回填：策略、IV、安全邊際、賣出條件、備註、停損隱藏、建議價重算
  await stockRow(page, 'AAPL').locator('button[data-action="edit-stock"]').click();
  const form = page.locator('#modal-form');
  await expect(form.locator('select[name="strategy"]')).toHaveValue('munger');
  await expect(form.locator('input[name="intrinsicValue"]')).toHaveValue('100');
  await expect(form.locator('input[name="marginOfSafety"]')).toHaveValue('30');
  await expect(form.locator('input[name="sellConditions"][value="moat"]')).toBeChecked();
  await expect(form.locator('input[name="sellConditions"][value="debt"]')).toBeChecked();
  await expect(form.locator('input[name="sellConditions"][value="fcf"]')).not.toBeChecked();
  await expect(form.locator('textarea[name="thesisNotes"]')).toHaveValue('護城河是品牌與規模');
  await expect(page.locator('#stock-stop-wrap')).toBeHidden();
  await expect(page.locator('#stock-munger-suggest-buy')).toHaveText('70.00');
  await expect(page.locator('#stock-munger-suggest-tp')).toHaveText('100.00');
});

test('11. 手機版排版：390×844 視窗下總覽、持股、現金頁無橫向溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = trackPageErrors(page);
  await gotoApp(page, { seed: blankState({ stocks: [makeStock()] }) });

  const assertNoHorizontalOverflow = async () => {
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
  };

  await goToTab(page, 'overview');
  await assertNoHorizontalOverflow();
  await page.screenshot({ path: 'test-results/mobile-overview.png' });

  await goToTab(page, 'stocks');
  await assertNoHorizontalOverflow();
  await page.screenshot({ path: 'test-results/mobile-stocks.png' });

  await goToTab(page, 'cash');
  await assertNoHorizontalOverflow();
  await page.screenshot({ path: 'test-results/mobile-cash.png' });

  expect(errors).toEqual([]);
});

// 1x1 白色 PNG（照片上傳測試共用），避免測試依賴外部圖片檔
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('12. 照片上傳：AI 助理點 label 會開出檔案選擇器，選檔後縮圖出現', async ({ page }) => {
  const errors = trackPageErrors(page);
  await gotoApp(page, { seed: blankState() });

  const pngPath = test.info().outputPath('tiny.png');
  fs.writeFileSync(pngPath, Buffer.from(TINY_PNG_BASE64, 'base64'));

  await page.locator('#btn-ai-copilot-fab').click();
  await expect(page.locator('#ai-copilot-drawer')).toBeVisible();
  await page.locator('#btn-ai-copilot-plus').click();
  await expect(page.locator('#ai-copilot-plus-menu')).toBeVisible();

  // 關鍵斷言：點包著 file input 的 label 必須開出檔案選擇器
  //（舊版 input 用 display:none，Chrome 點 label 完全沒反應）
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('#ai-copilot-plus-menu label:has(#ai-copilot-file)').click(),
  ]);
  await fileChooser.setFiles(pngPath);
  await expect(page.locator('#ai-copilot-thumbs img')).toBeVisible();
  expect(errors).toEqual([]);
});

test('13. 照片上傳：搬家、拍照批次、記帳照片三處點 label 都會開出檔案選擇器', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await gotoApp(page, { seed: blankState() });

  const pngPath = test.info().outputPath('tiny.png');
  fs.writeFileSync(pngPath, Buffer.from(TINY_PNG_BASE64, 'base64'));
  const pickFile = async (labelSelector) => {
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator(labelSelector).click(),
    ]);
    await fc.setFiles(pngPath);
  };

  // 搬家頁：選擇圖片（image 子面板預設隱藏，須先點「2. 截圖／照片」切換鈕；真實使用者也是這樣操作）
  await goToTab(page, 'migrate');
  await page.locator('button[data-migrate-src="image"]').click();
  await expect(page.locator('#migrate-pane-image')).toBeVisible();
  await pickFile('label:has(#migrate-img-input)');

  // 支出頁：拍照批次記帳（彈窗）
  await goToTab(page, 'expenses');
  await page.locator('#btn-photo-batch-expense').click();
  await expect(page.locator('#modal-title')).toContainText('拍照批次');
  await pickFile('label:has(#qpb-file-input)');
  await expect(page.locator('#qpb-thumbs img')).toBeVisible();
  await page.locator('#btn-modal-cancel').click();
  await expect(page.locator('#form-modal')).toBeHidden();

  // 記帳照片：新增隨機支出彈窗內的拍照／選圖
  await page.locator('#btn-add-random-exp').click();
  await expect(page.locator('#modal-title')).toHaveText('新增隨機支出');
  await pickFile('#form-modal label:has(#modal-photo-ai-input)');
  // 選檔後會嘗試 AI 辨識（無 Key 會失敗並顯示提示），只斷言狀態有變化、無 JS 錯誤
  await expect(page.locator('#modal-photo-ai-status')).not.toHaveText(
    '支援拍發票、收據、帳單或貼上截圖，自動填入下方欄位',
    { timeout: 15000 },
  );
  expect(errors).toEqual([]);
});

test('14. 加密入口常駐：0 組 Key 也能先設加密密碼，設好後新增的 Key 自動加密', async ({
  page,
}) => {
  await gotoApp(page, { seed: blankState() });
  await goToTab(page, 'settings');

  // 0 組 Key 時加密橫幅仍顯示、可設定密碼（舊版直接隱藏，整頁找不到入口）
  const banner = page.locator('#cfg-ai-vault-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('尚未設定加密密碼');
  await banner.locator('button[data-vault-act="setup"]').click();
  await expect(page.locator('#modal-title')).toHaveText('設定金鑰加密密碼');
  await page.locator('#modal-form input[name="pw1"]').fill('playwright-test-passphrase');
  await page.locator('#modal-form input[name="pw2"]').fill('playwright-test-passphrase');
  await page.locator('#modal-form button[type="submit"]').click();
  await expect(banner).toContainText('保險庫已就緒');

  // 先設密碼再輸 Key：新增的 Key 應自動加密存放，localStorage 沒有明文
  await page.locator('#cfg-ai-key').fill('sk-playwright-e2e-test-key-9f8e7d6c5b4a');
  await page.locator('#btn-save-ai-cfg').click();
  await expect(page.locator('#cfg-ai-key-list')).toContainText('已加密存放');
  const rawCfg = await readRawConfig(page);
  expect(rawCfg).not.toContain('sk-playwright-e2e-test-key-9f8e7d6c5b4a');
  expect(rawCfg).toContain('enc1.');
});

test('15. 雲端同步預設不勾：未設定過的使用者預設不勾選，明確勾選後才持久化', async ({
  page,
}) => {
  await gotoApp(page, { seed: blankState() });
  await goToTab(page, 'settings');

  const syncChk = page.locator('#cfg-ai-sync-cloud');
  await expect(syncChk).not.toBeChecked();

  // 明確勾選後會寫入設定，重整後仍勾選（已明確的選擇要維持）
  await syncChk.check();
  await page.reload();
  await goToTab(page, 'settings');
  await expect(page.locator('#cfg-ai-sync-cloud')).toBeChecked();
});

test('16. 預設模型一致：無 Key 時助理預設走 Groq（與設定頁預設供應商一致），而非 Gemini', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await gotoApp(page, { seed: blankState() });
  await goToTab(page, 'settings');
  await expect(page.locator('#cfg-ai-provider')).toHaveValue('groq');

  await page.locator('#btn-ai-copilot-fab').click();
  await expect(page.locator('#ai-copilot-drawer')).toBeVisible();
  await expect(page.locator('#ai-copilot-model-badge')).toHaveText('尚未設定 Key');

  // 無 Key 提問：worker 會直接回「尚未填寫 API Key」（不連外網），
  // 錯誤訊息應標示預設供應商 Groq，不應再出現 Gemini
  await page.locator('#ai-copilot-input').fill('我目前持有 0050 多少股？');
  await page.locator('#btn-ai-copilot-send').click();
  const messages = page.locator('#ai-copilot-messages');
  await expect(messages).toContainText('連線失敗：#1 Groq', { timeout: 15000 });
  await expect(messages).not.toContainText('Gemini');
  expect(errors).toEqual([]);
});

test('17. 總覽圖表：圓環圖例顯示百分比，淨值線以最近快照延伸、不只剩一個點', async ({
  page,
}) => {
  await gotoApp(page, {
    seed: blankState({
      stocks: [makeStock()],
      snapshots: [
        {
          id: 'snap-e2e-1',
          date: '2026-09-01',
          cashTWD: 1500000,
          stocksTWD: 1500000,
          investmentsTWD: 0,
          totalTWD: 3000000,
          note: '',
        },
        {
          id: 'snap-e2e-2',
          date: '2026-11-25',
          cashTWD: 2020498,
          stocksTWD: 1791935,
          investmentsTWD: 4800000,
          totalTWD: 3812433,
          note: '',
        },
      ],
    }),
  });
  await goToTab(page, 'overview');

  // 圓環圖例直接顯示百分比
  await page.waitForFunction(() => window.__allocationChartDetail, null, { timeout: 15000 });
  const legendTexts = await page.evaluate(() => {
    const c = window.__allocationChartDetail;
    return c.options.plugins.legend.labels.generateLabels(c).map((l) => l.text);
  });
  expect(legendTexts.some((t) => t.includes('%'))).toBe(true);
  expect(legendTexts.join(' ')).toContain('銀行與券商現金');
  expect(legendTexts.join(' ')).toContain('股票與黃金 ETF');

  // 淨值線：以最近快照向前延伸，區間內每個點都有值（舊版大多是 null、只剩一個點）
  await page.waitForFunction(() => window.__trendChartDetail, null, { timeout: 15000 });
  const nw = await page.evaluate(() => {
    const c = window.__trendChartDetail;
    const ds = c.data.datasets.find((d) => String(d.label || '').includes('總資產淨值'));
    return {
      label: ds.label,
      nulls: ds.data.filter((v) => v === null || v === undefined).length,
      total: ds.data.length,
      last: ds.data[ds.data.length - 1],
    };
  });
  expect(nw.label).toContain('最近快照');
  expect(nw.total).toBeGreaterThan(1);
  expect(nw.nulls).toBe(0);
  expect(nw.last).toBe(3812433);
});

test('18. 上傳入口同類修復：搬家 CSV／PDF、備份 JSON／Excel 四處點 label 都會開出檔案選擇器', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await gotoApp(page, { seed: blankState() });

  // 這四處與照片上傳是同一個 bug（label 包 display:none 的 input，Chrome 點了沒反應），
  // 同批改為 sr-only；只斷言選擇器會開啟，不實際選檔（避免觸發匯入解析）。
  // 注意：每開一次選擇器都要用空清單關掉它，否則未處理的選擇器會擋住下一次開啟；
  // 四處 input 的 change handler 對空檔案清單都是 no-op，已在程式中確認。
  const openChooser = async (labelSelector) => {
    const [fc] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator(labelSelector).click(),
    ]);
    await fc.setFiles([]);
    return fc;
  };

  await goToTab(page, 'migrate');
  await openChooser('label:has(#migrate-file-input)');
  // PDF 子面板預設隱藏，須先點「3. PDF 電子對帳單」切換鈕；真實使用者也是這樣操作
  await page.locator('button[data-migrate-src="pdf"]').click();
  await expect(page.locator('#migrate-pane-pdf')).toBeVisible();
  await openChooser('label:has(#migrate-pdf-input)');

  await goToTab(page, 'settings');
  await openChooser('label:has(#input-import-json)');
  await openChooser('label:has(#input-import-xlsx)');
  expect(errors).toEqual([]);
});

test('19. 切換分頁：捲動位置回到最上方', async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  // 種 30 檔持股讓持股頁夠長、可往下捲；視窗調矮一點，讓總覽頁也一定可捲，
  // 避免切換後 scrollY 因頁面不夠長而自然歸零、測試失去意義
  await page.setViewportSize({ width: 1280, height: 600 });
  const stocks = Array.from({ length: 30 }, (_, i) =>
    makeStock({ id: `s-e2e-scroll-${i}`, symbol: `SC${String(i).padStart(2, '0')}` }),
  );
  await gotoApp(page, { seed: blankState({ stocks }) });

  await goToTab(page, 'stocks');
  await expect(page.locator('#stocks-tbody tr')).toHaveCount(30);
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  // 切換到總覽頁，捲動位置應回到頂部
  await goToTab(page, 'overview');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  // 總覽頁本身可捲：若不可捲，上一行即使沒有修復也會是 0，測不到東西
  const overviewScrollable = await page.evaluate(
    () => document.documentElement.scrollHeight > window.innerHeight,
  );
  expect(overviewScrollable).toBe(true);
  expect(errors).toEqual([]);
});
