export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/quotes') {
      return handleQuotes(url);
    }

    return env.ASSETS.fetch(request);
  }
};

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function toYahooCandidates(market, rawSymbol) {
  const sym = String(rawSymbol || '').trim().toUpperCase();
  if (!sym) return [];
  if (market === 'TW') {
    const base = sym.replace(/\.TW(O)?$/i, '');
    return [`${base}.TW`, `${base}.TWO`];
  }
  if (market === 'HK') {
    const digits = sym.replace(/\.HK$/i, '').replace(/^0+/, '') || '0';
    const padded = digits.padStart(4, '0');
    return [`${padded}.HK`];
  }
  return [sym.replace(/\./g, '-')];
}

async function fetchYahooPrice(ticker) {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const host of hosts) {
    try {
      const res = await fetch(
        `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`,
        {
          headers: {
            'User-Agent': BROWSER_UA,
            'Accept': 'application/json,text/plain,*/*'
          },
          cf: { cacheTtl: 60, cacheEverything: true }
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const meta = data && data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
      if (meta) {
        const price = Number(meta.regularMarketPrice ?? meta.previousClose ?? meta.chartPreviousClose);
        if (Number.isFinite(price) && price > 0) {
          return price;
        }
      }
    } catch (e) {
      // try next host
    }
  }
  return null;
}

async function fetchTwsePrice(rawSymbol) {
  const base = String(rawSymbol || '').trim().toUpperCase().replace(/\.TW(O)?$/i, '');
  if (!base) return null;
  try {
    const exCh = `tse_${base}.tw|otc_${base}.tw`;
    const res = await fetch(
      `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`,
      {
        headers: {
          'User-Agent': BROWSER_UA,
          'Accept': 'application/json',
          'Referer': 'https://mis.twse.com.tw/'
        },
        cf: { cacheTtl: 60, cacheEverything: true }
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const list = (data && data.msgArray) || [];
    for (const row of list) {
      const candidates = [row.z, row.y, row.o];
      for (const c of candidates) {
        const num = Number(c);
        if (Number.isFinite(num) && num > 0) return num;
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

async function handleQuotes(url) {
  const rawItems = (url.searchParams.get('items') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const items = rawItems.slice(0, 40);
  const prices = {};

  await Promise.all(
    items.map(async (item) => {
      const idx = item.indexOf(':');
      const market = idx > 0 ? item.slice(0, idx).toUpperCase() : 'US';
      const symbol = idx > 0 ? item.slice(idx + 1).toUpperCase() : item.toUpperCase();
      const candidates = toYahooCandidates(market, symbol);
      let found = null;
      for (const ticker of candidates) {
        found = await fetchYahooPrice(ticker);
        if (found !== null) break;
      }
      if (found === null && market === 'TW') {
        found = await fetchTwsePrice(symbol);
      }
      if (found !== null) {
        prices[`${market}:${symbol}`] = found;
      }
    })
  );

  return new Response(
    JSON.stringify({ ok: true, updatedAt: new Date().toISOString(), prices }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60'
      }
    }
  );
}
