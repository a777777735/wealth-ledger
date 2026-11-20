export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/quotes') {
      return handleQuotes(url);
    }

    return env.ASSETS.fetch(request);
  }
};

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
        `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; WealthLedgerBot/1.0)',
            'Accept': 'application/json'
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
      for (const ticker of candidates) {
        const p = await fetchYahooPrice(ticker);
        if (p !== null) {
          prices[`${market}:${symbol}`] = p;
          break;
        }
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
