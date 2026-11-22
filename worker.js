const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/') && request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === '/api/quotes') {
      return withCors(await handleQuotes(url));
    }

    if (url.pathname === '/api/fx') {
      return withCors(await handleFx(url));
    }

    if (url.pathname === '/api/ai/status') {
      return withCors(handleAiStatus(env));
    }

    if (url.pathname === '/api/ai') {
      return withCors(await handleAiProxy(request, env));
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

async function handleFx(url) {
  const rawList = (url.searchParams.get('currencies') || 'USD,JPY,HKD,CNY')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter((x) => /^[A-Z]{3}$/.test(x) && x !== 'TWD');
  const codes = [...new Set(rawList.length ? rawList : ['USD', 'JPY', 'HKD', 'CNY'])].slice(0, 25);

  const rates = {};
  let source = 'yahoo';

  await Promise.all(
    codes.map(async (code) => {
      const p = await fetchYahooPrice(`${code}TWD=X`);
      if (p !== null && p > 0) {
        rates[code] = Number(p.toFixed(6));
      }
    })
  );

  // Fallback to open.er-api.com (supports 160+ world currencies) for any missing currency
  if (Object.keys(rates).length < codes.length) {
    try {
      const res = await fetch('https://open.er-api.com/v6/latest/TWD', {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      if (res.ok) {
        const json = await res.json();
        if (json && json.rates) {
          for (const code of codes) {
            if (!rates[code] && json.rates[code] > 0) {
              rates[code] = Number((1 / json.rates[code]).toFixed(6));
            }
          }
          if (Object.keys(rates).length > 0) {
            source = 'yahoo+er-api';
          }
        }
      }
    } catch (e) {
      // ignore
    }
  }

  return new Response(
    JSON.stringify({ ok: Object.keys(rates).length > 0, source, updatedAt: new Date().toISOString(), rates }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60'
      }
    }
  );
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

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function handleAiStatus(env) {
  return jsonResp({
    ok: true,
    hasServerKey: {
      gemini: Boolean(env && env.GEMINI_API_KEY),
      openai: Boolean(env && env.OPENAI_API_KEY),
      anthropic: Boolean(env && env.ANTHROPIC_API_KEY),
      custom: Boolean(env && env.CUSTOM_AI_API_KEY)
    }
  });
}

async function handleAiProxy(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'POST') {
    return jsonResp({ ok: false, error: '僅支援 POST 請求' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResp({ ok: false, error: '請求 JSON 格式錯誤' }, 400);
  }

  const provider = String(body.provider || 'gemini').toLowerCase().trim();
  const userKey = String(body.apiKey || '').trim();
  const systemPrompt = String(body.systemPrompt || '').trim();
  const prompt = String(body.prompt || '').trim();
  const expectJson = body.expectJson !== false;
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 6) : [];

  if (!prompt && attachments.length === 0) {
    return jsonResp({ ok: false, error: '請提供文字內容或附件' }, 400);
  }

  const envKeyMap = {
    gemini: env && env.GEMINI_API_KEY,
    openai: env && env.OPENAI_API_KEY,
    anthropic: env && env.ANTHROPIC_API_KEY,
    custom: env && env.CUSTOM_AI_API_KEY
  };
  const apiKey = userKey || String(envKeyMap[provider] || '').trim();

  if (!apiKey && provider !== 'custom') {
    return jsonResp({ ok: false, error: '尚未填寫 API Key，請先至「匯率與備份 → AI 模型設定」填寫金鑰' }, 400);
  }

  try {
    let text = '';
    let usedModel = '';

    if (provider === 'gemini') {
      const reqModel = String(body.model || '').trim();
      const primary = (!reqModel || reqModel === 'gemini-2.5-flash') ? 'gemini-3.8-flash' : reqModel;
      const gRes = await callGemini({ apiKey, model: primary, systemPrompt, prompt, attachments, expectJson });
      text = gRes.text;
      usedModel = gRes.model;
    } else if (provider === 'anthropic') {
      usedModel = String(body.model || 'claude-sonnet-4-20250514').trim();
      text = await callAnthropic({ apiKey, model: usedModel, systemPrompt, prompt, attachments });
    } else if (provider === 'openai' || provider === 'custom') {
      const baseUrl = provider === 'openai'
        ? 'https://api.openai.com/v1'
        : String(body.baseUrl || (env && env.CUSTOM_AI_BASE_URL) || '').trim();
      if (!baseUrl) {
        return jsonResp({ ok: false, error: '自訂模式請填寫 API Base URL（例如 https://openrouter.ai/api/v1）' }, 400);
      }
      if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(baseUrl)) {
        return jsonResp({ ok: false, error: '自訂 Base URL 必須使用 https://（本機測試限 localhost）' }, 400);
      }
      usedModel = String(body.model || (provider === 'openai' ? 'gpt-4o-mini' : '')).trim();
      if (!usedModel) {
        return jsonResp({ ok: false, error: '自訂模式請填寫模型名稱（Model ID）' }, 400);
      }
      const hasPdf = attachments.some((a) => String(a.mimeType || '').includes('pdf'));
      if (hasPdf) {
        return jsonResp({ ok: false, error: 'OpenAI／自訂端點不支援直接上傳 PDF，請改選 Google Gemini 或 Anthropic Claude，或改用截圖／複製文字貼上' }, 400);
      }
      text = await callOpenAICompat({ apiKey, baseUrl, model: usedModel, systemPrompt, prompt, attachments, expectJson, provider });
    } else {
      return jsonResp({ ok: false, error: `不支援的 AI 供應商：${provider}` }, 400);
    }

    return jsonResp({ ok: true, provider, model: usedModel, text });
  } catch (err) {
    return jsonResp({ ok: false, error: err && err.message ? err.message : 'AI 呼叫失敗' }, 502);
  }
}

async function callGemini({ apiKey, model, systemPrompt, prompt, attachments, expectJson }) {
  const parts = [];
  if (prompt) parts.push({ text: prompt });
  for (const att of attachments) {
    if (att && att.base64 && att.mimeType) {
      parts.push({
        inline_data: {
          mime_type: String(att.mimeType),
          data: String(att.base64)
        }
      });
    }
  }
  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.1
    }
  };
  if (systemPrompt) {
    payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  if (expectJson) {
    payload.generationConfig.responseMimeType = 'application/json';
  }

  const candidates = [...new Set([model, 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-latest'])];
  let primaryErr = '';
  let lastErr = 'Gemini API 暫時繁忙，請稍後再試';

  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const maxAttempts = i === 0 ? 2 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 900));
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const cand = data && data.candidates && data.candidates[0];
        const outParts = cand && cand.content && cand.content.parts;
        const text = Array.isArray(outParts) ? outParts.map((p) => p.text || '').join('') : '';
        if (text) return { text, model: m };
        lastErr = 'Gemini 未回傳任何文字內容';
        continue;
      }
      const errMsg = (data && data.error && data.error.message) || `Gemini API 錯誤 (${res.status})`;
      if (i === 0 && !primaryErr) primaryErr = errMsg;
      lastErr = errMsg;
      // Do not retry/fallback on auth errors (401, 403)
      if (res.status === 401 || res.status === 403) {
        throw new Error(errMsg);
      }
      if (res.status !== 503 && res.status !== 429 && res.status !== 404) {
        throw new Error(errMsg);
      }
    }
  }
  throw new Error(primaryErr || lastErr);
}

async function callOpenAICompat({ apiKey, baseUrl, model, systemPrompt, prompt, attachments, expectJson, provider }) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  if (attachments.length > 0) {
    const content = [];
    if (prompt) content.push({ type: 'text', text: prompt });
    for (const att of attachments) {
      if (att && att.base64 && att.mimeType) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${att.mimeType};base64,${att.base64}` }
        });
      }
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: prompt });
  }

  const payload = {
    model,
    messages,
    temperature: 0.1
  };
  if (expectJson && provider === 'openai') {
    payload.response_format = { type: 'json_object' };
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const endpoint = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `API 錯誤 (${res.status})`;
    throw new Error(msg);
  }
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('模型未回傳任何文字內容');
  return String(text);
}

async function callAnthropic({ apiKey, model, systemPrompt, prompt, attachments }) {
  const content = [];
  for (const att of attachments) {
    if (!att || !att.base64 || !att.mimeType) continue;
    if (String(att.mimeType).includes('pdf')) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: String(att.base64) }
      });
    } else {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: String(att.mimeType), data: String(att.base64) }
      });
    }
  }
  if (prompt) content.push({ type: 'text', text: prompt });

  const payload = {
    model,
    max_tokens: 4096,
    temperature: 0.1,
    messages: [{ role: 'user', content }]
  };
  if (systemPrompt) payload.system = systemPrompt;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `Anthropic API 錯誤 (${res.status})`;
    throw new Error(msg);
  }
  const blocks = Array.isArray(data && data.content) ? data.content : [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  if (!text) throw new Error('Claude 未回傳任何文字內容');
  return text;
}
