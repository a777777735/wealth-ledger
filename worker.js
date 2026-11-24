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

    if (url.pathname === '/api/ai/models') {
      return withCors(await handleAiModels(request, env));
    }

    if (url.pathname === '/api/ai/openrouter-exchange') {
      return withCors(await handleOpenRouterExchange(request));
    }

    if (url.pathname === '/api/ai/cf-access/status') {
      return withCors(await handleCfAccessStatus(request, env));
    }

    if (url.pathname === '/api/ai/cf-access/request') {
      return withCors(await handleCfAccessRequest(request, env));
    }

    if (url.pathname === '/api/ai/cf-access/decide') {
      return withCors(await handleCfAccessDecide(request, env));
    }

    if (url.pathname === '/api/ai') {
      return withCors(await handleAiProxy(request, env));
    }

    const assetRes = await env.ASSETS.fetch(request);
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/sw.js') {
      const headers = new Headers(assetRes.headers);
      headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      return new Response(assetRes.body, { status: assetRes.status, statusText: assetRes.statusText, headers });
    }
    return assetRes;
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
      cloudflare: Boolean(env && env.AI),
      groq: Boolean(env && env.GROQ_API_KEY),
      openrouter: Boolean(env && env.OPENROUTER_API_KEY),
      mistral: Boolean(env && env.MISTRAL_API_KEY),
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
  const userEmail = String(body.userEmail || '').toLowerCase().trim();
  const systemPrompt = String(body.systemPrompt || '').trim();
  const prompt = String(body.prompt || '').trim();
  const expectJson = body.expectJson !== false;
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 6) : [];

  if (!prompt && attachments.length === 0) {
    return jsonResp({ ok: false, error: '請提供文字內容或附件' }, 400);
  }

  const envKeyMap = {
    groq: env && env.GROQ_API_KEY,
    openrouter: env && env.OPENROUTER_API_KEY,
    mistral: env && env.MISTRAL_API_KEY,
    gemini: env && env.GEMINI_API_KEY,
    openai: env && env.OPENAI_API_KEY,
    anthropic: env && env.ANTHROPIC_API_KEY,
    custom: env && env.CUSTOM_AI_API_KEY
  };
  const apiKey = userKey || String(envKeyMap[provider] || '').trim();

  if (!apiKey && provider !== 'custom' && provider !== 'cloudflare') {
    return jsonResp({ ok: false, error: '尚未填寫 API Key，請先至「匯率與備份 → AI 模型設定」填寫金鑰或使用一鍵連結 OpenRouter' }, 400);
  }

  try {
    const tStart = Date.now();
    let text = '';
    let usedModel = '';

    if (provider === 'cloudflare') {
      if (!env || !env.AI) {
        return jsonResp({ ok: false, error: '此站尚未啟用 Cloudflare Workers AI 綁定' }, 400);
      }
      const idToken = extractBearerToken(request, body);
      const access = await checkCfAiAccess(idToken, env);
      if (!access.allowed) {
        return jsonResp({ ok: false, error: access.reason || 'Cloudflare Workers AI 需向站長申請並經同意後方可使用' }, 403);
      }
      const hasPdf = attachments.some((a) => String(a.mimeType || '').includes('pdf'));
      if (hasPdf) {
        return jsonResp({ ok: false, error: 'Cloudflare Workers AI 不支援直接上傳 PDF，請改用截圖或 Google Gemini' }, 400);
      }
      const cfRes = await callCloudflareAI({ env, model: String(body.model || '').trim(), systemPrompt, prompt, attachments });
      text = cfRes.text;
      usedModel = cfRes.model;
    } else if (provider === 'gemini') {
      const reqModel = String(body.model || '').trim();
      const primary = (!reqModel || reqModel === 'gemini-2.5-flash') ? 'gemini-3.8-flash' : reqModel;
      const gRes = await callGemini({ apiKey, model: primary, systemPrompt, prompt, attachments, expectJson });
      text = gRes.text;
      usedModel = gRes.model;
    } else if (provider === 'anthropic') {
      usedModel = String(body.model || 'claude-sonnet-4-20250514').trim();
      text = await callAnthropic({ apiKey, model: usedModel, systemPrompt, prompt, attachments });
    } else if (['openai', 'groq', 'openrouter', 'mistral', 'custom'].includes(provider)) {
      const presetBaseUrls = {
        openai: 'https://api.openai.com/v1',
        groq: 'https://api.groq.com/openai/v1',
        openrouter: 'https://openrouter.ai/api/v1',
        mistral: 'https://api.mistral.ai/v1'
      };
      const hasImg = attachments.some((a) => String(a && a.mimeType || '').startsWith('image/'));
      const presetDefaults = {
        openai: 'gpt-4o-mini',
        groq: hasImg ? 'qwen/qwen3.8-27b' : 'llama-3.3-70b-versatile',
        openrouter: hasImg ? 'nvidia/nemotron-3.5-super-vl:free' : 'meta-llama/llama-3.3-70b-instruct:free',
        mistral: hasImg ? 'pixtral-12b-2409' : 'mistral-small-latest'
      };
      const presetFallbacks = {
        groq: hasImg ? [] : ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
        openrouter: hasImg
          ? ['google/gemma-3-27b-it:free', 'mistralai/mistral-small-3.1-24b-instruct:free', 'qwen/qwen2.5-vl-32b-instruct:free']
          : ['google/gemma-3-27b-it:free', 'mistralai/mistral-small-3.1-24b-instruct:free', 'openrouter/free'],
        mistral: ['pixtral-12b-2409']
      };
      const baseUrl = provider === 'custom'
        ? String(body.baseUrl || (env && env.CUSTOM_AI_BASE_URL) || '').trim()
        : presetBaseUrls[provider];
      if (!baseUrl) {
        return jsonResp({ ok: false, error: '自訂模式請填寫 API Base URL（例如 https://openrouter.ai/api/v1）' }, 400);
      }
      if (!/^https:\/\//i.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(baseUrl)) {
        return jsonResp({ ok: false, error: '自訂 Base URL 必須使用 https://（本機測試限 localhost）' }, 400);
      }
      let primaryModel = String(body.model || presetDefaults[provider] || '').trim();
      if (provider === 'groq') {
        if (/llama-4-(scout|maverick)/i.test(primaryModel) || (hasImg && /gpt-oss|llama-3\.[13]|deepseek|qwq|qwen3-32b|kimi/i.test(primaryModel))) {
          primaryModel = 'qwen/qwen3.8-27b';
        } else if (!hasImg && /qwen3\.8-27b/i.test(primaryModel)) {
          // qwen/qwen3.8-27b has a tight 7,000 ITPM free limit on Groq; use higher-TPM llama-3.3-70b-versatile for text-only
          primaryModel = 'llama-3.3-70b-versatile';
        }
      }
      if (provider === 'openrouter') {
        if (/qwen2\.5-vl-72b-instruct:free/i.test(primaryModel) || (hasImg && primaryModel === 'openrouter/free')) {
          primaryModel = hasImg ? 'nvidia/nemotron-3.5-super-vl:free' : 'meta-llama/llama-3.3-70b-instruct:free';
        } else if (!hasImg && primaryModel === 'openrouter/free') {
          // openrouter/free often routes to reasoning models that return empty content; try stable non-reasoning free models first
          primaryModel = 'meta-llama/llama-3.3-70b-instruct:free';
        }
      }
      if (hasImg && provider === 'mistral' && /mistral-small|open-mistral|codestral/i.test(primaryModel)) {
        primaryModel = 'pixtral-12b-2409';
      }
      if (!primaryModel) {
        return jsonResp({ ok: false, error: '自訂模式請填寫模型名稱（Model ID）' }, 400);
      }
      const hasPdf = attachments.some((a) => String(a.mimeType || '').includes('pdf'));
      if (hasPdf) {
        return jsonResp({ ok: false, error: '此供應商不支援直接上傳 PDF，請改選 Google Gemini 或 Anthropic Claude，或改用截圖／複製文字貼上' }, 400);
      }
      const oRes = await callOpenAICompat({
        apiKey,
        baseUrl,
        model: primaryModel,
        fallbackModels: presetFallbacks[provider] || [],
        systemPrompt,
        prompt,
        attachments,
        expectJson,
        provider
      });
      text = oRes.text;
      usedModel = oRes.model;
    } else {
      return jsonResp({ ok: false, error: `不支援的 AI 供應商：${provider}` }, 400);
    }

    return jsonResp({ ok: true, provider, model: usedModel, text, upstreamMs: Date.now() - tStart });
  } catch (err) {
    return jsonResp({ ok: false, error: err && err.message ? err.message : 'AI 呼叫失敗' }, 502);
  }
}

function makeTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
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
      temperature: 0.1,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };
  if (systemPrompt) {
    payload.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  if (expectJson) {
    payload.generationConfig.responseMimeType = 'application/json';
  }

  const timeoutMs = attachments.length > 0 ? 18000 : 12000;
  const candidates = [...new Set([model, 'gemini-flash-latest'])];
  let primaryErr = '';
  let lastErr = 'Gemini API 暫時繁忙，建議改用 Groq 免費高速 Key';

  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    let useThinkingCfg = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const reqBody = useThinkingCfg
        ? payload
        : { ...payload, generationConfig: { temperature: payload.generationConfig.temperature, maxOutputTokens: 2048, ...(expectJson ? { responseMimeType: 'application/json' } : {}) } };
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
          signal: makeTimeoutSignal(timeoutMs)
        });
      } catch (netErr) {
        lastErr = `Gemini 伺服器回應逾時（>${Math.round(timeoutMs / 1000)}秒），建議改用 Groq 免費高速 Key`;
        if (i === 0 && !primaryErr) primaryErr = lastErr;
        break;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const cand = data && data.candidates && data.candidates[0];
        const outParts = cand && cand.content && cand.content.parts;
        const text = Array.isArray(outParts) ? outParts.map((p) => p.text || '').join('') : '';
        if (text) return { text, model: m };
        lastErr = 'Gemini 未回傳任何文字內容';
        break;
      }
      const errMsg = (data && data.error && data.error.message) || `Gemini API 錯誤 (${res.status})`;
      // If a model does not support thinkingConfig, retry immediately without it
      if (res.status === 400 && useThinkingCfg && /thinking/i.test(errMsg)) {
        useThinkingCfg = false;
        continue;
      }
      if (i === 0 && !primaryErr) primaryErr = errMsg;
      lastErr = errMsg;
      if (res.status === 401 || res.status === 403) {
        throw new Error(errMsg);
      }
      if (res.status !== 503 && res.status !== 429 && res.status !== 404) {
        throw new Error(errMsg);
      }
      break;
    }
  }
  throw new Error(primaryErr || lastErr);
}

async function callOpenAICompat({ apiKey, baseUrl, model, fallbackModels = [], systemPrompt, prompt, attachments, expectJson, provider }) {
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

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const endpoint = cleanBase.endsWith('/chat/completions') ? cleanBase : `${cleanBase}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = 'https://wealth-ledger.pages.dev';
    headers['X-Title'] = 'Wealth Ledger';
  }

  const timeoutMs = attachments.length > 0 ? 18000 : 12000;
  const candidates = [...new Set([model, ...fallbackModels].filter(Boolean))];
  let primaryErr = '';
  let lastErr = 'API 呼叫失敗';

  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const payload = {
      model: m,
      messages,
      temperature: 0.1,
      max_tokens: 2048
    };
    if (expectJson && (provider === 'openai' || (provider === 'groq' && attachments.length === 0))) {
      payload.response_format = { type: 'json_object' };
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: makeTimeoutSignal(timeoutMs)
        });
      } catch (netErr) {
        lastErr = `${provider} 回應逾時（>${Math.round(timeoutMs / 1000)}秒）`;
        if (i === 0 && !primaryErr) primaryErr = lastErr;
        break;
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const msgObj = data && data.choices && data.choices[0] && data.choices[0].message;
        const text = msgObj && msgObj.content ? String(msgObj.content).trim() : '';
        if (text) return { text, model: m };
        lastErr = '模型未回傳任何文字內容';
        break;
      }
      const msg = (data && data.error && data.error.message) || `API 錯誤 (${res.status})`;
      // Retry once after 1.25s on 429 burst limit (e.g. Mistral 1 RPS free tier), but NOT on quota/ITPM/too-large errors
      if (res.status === 429 && attempt === 0 && !/quota|credit|daily|insufficient|ITPM|too large|tokens per minute/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 1250));
        continue;
      }
      if (i === 0 && !primaryErr) primaryErr = msg;
      lastErr = msg;
      if (res.status === 401 || res.status === 403) {
        throw new Error(msg);
      }
      // Allow falling back to next candidate on 400 when attachments are sent (e.g. model doesn't support vision)
      if (res.status === 400 && attachments.length > 0 && i + 1 < candidates.length) {
        break;
      }
      // Allow falling back to next candidate on 413 (ITPM / payload too large), 429, 503, 404
      if (res.status !== 413 && res.status !== 429 && res.status !== 503 && res.status !== 404) {
        throw new Error(msg);
      }
      break;
    }
  }
  throw new Error(primaryErr && lastErr && lastErr !== primaryErr ? `${primaryErr}（備援亦失敗：${lastErr}）` : (primaryErr || lastErr));
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

async function handleAiModels(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return jsonResp({ ok: false, error: '僅支援 POST 請求' }, 405);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResp({ ok: false, error: '請求 JSON 格式錯誤' }, 400);
  }

  const provider = String(body.provider || 'groq').toLowerCase().trim();
  const envKeyMap = {
    groq: env && env.GROQ_API_KEY,
    openrouter: env && env.OPENROUTER_API_KEY,
    mistral: env && env.MISTRAL_API_KEY,
    gemini: env && env.GEMINI_API_KEY,
    openai: env && env.OPENAI_API_KEY,
    anthropic: env && env.ANTHROPIC_API_KEY,
    custom: env && env.CUSTOM_AI_API_KEY
  };
  const apiKey = String(body.apiKey || envKeyMap[provider] || '').trim();
  const customBaseUrl = String(body.baseUrl || (env && env.CUSTOM_AI_BASE_URL) || '').trim();

  try {
    let models = [];

    if (provider === 'cloudflare') {
      models = [
        { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: '@cf/meta/llama-4-scout-17b-16e-instruct [圖+文・推薦]' },
        { id: '@cf/meta/llama-3.2-11b-vision-instruct', label: '@cf/meta/llama-3.2-11b-vision-instruct [圖+文]' },
        { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: '@cf/meta/llama-3.3-70b-instruct-fp8-fast [純文字極速]' },
        { id: '@cf/meta/llama-3.1-8b-instruct-fast', label: '@cf/meta/llama-3.1-8b-instruct-fast [輕量超快]' }
      ];
    } else if (provider === 'openrouter') {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch('https://openrouter.ai/api/v1/models', { headers, signal: makeTimeoutSignal(10000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error && data.error.message) || `OpenRouter 錯誤 (${res.status})`);
      const list = Array.isArray(data && data.data) ? data.data : [];
      const freeModels = list
        .filter((m) => m && m.id && (String(m.id).endsWith(':free') || (m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)))
        .map((m) => {
          const isVision = JSON.stringify(m.architecture || '').toLowerCase().includes('image');
          return {
            id: String(m.id),
            label: `${m.id}${isVision ? ' [圖+文]' : ''}`,
            score: (m.id === 'openrouter/free' ? 100 : 0) + (isVision ? 20 : 0)
          };
        })
        .sort((a, b) => b.score - a.score);
      const hasRouter = freeModels.some((m) => m.id === 'openrouter/free');
      models = [
        ...(hasRouter ? [] : [{ id: 'openrouter/free', label: 'openrouter/free [官方自動免費路由]' }]),
        ...freeModels.slice(0, 20).map(({ id, label }) => ({ id, label }))
      ];
    } else if (provider === 'gemini') {
      if (!apiKey) return jsonResp({ ok: false, error: '查詢 Google Gemini 最新模型需要填入 API Key' }, 400);
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
        signal: makeTimeoutSignal(10000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error && data.error.message) || `Gemini 錯誤 (${res.status})`);
      const list = Array.isArray(data && data.models) ? data.models : [];
      models = list
        .filter((m) => m && m.name && Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => String(m.name).replace(/^models\//, ''))
        .filter((id) => /gemini/i.test(id) && !/(embedding|aqa|tts|audio|image-generation|veo|lyria|robotics)/i.test(id))
        .map((id) => {
          let score = 0;
          if (/flash/i.test(id)) score += 30;
          if (/3\./.test(id)) score += 25;
          if (/latest/i.test(id)) score += 10;
          if (/lite/i.test(id)) score -= 5;
          if (/exp|preview/i.test(id)) score -= 3;
          return { id, label: id, score };
        })
        .sort((a, b) => b.score - a.score || b.id.localeCompare(a.id))
        .slice(0, 20)
        .map(({ id, label }) => ({ id, label }));
    } else if (provider === 'anthropic') {
      if (!apiKey) return jsonResp({ ok: false, error: '查詢 Anthropic 最新模型需要填入 API Key' }, 400);
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: makeTimeoutSignal(10000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error && data.error.message) || `Anthropic 錯誤 (${res.status})`);
      const list = Array.isArray(data && data.data) ? data.data : [];
      models = list.map((m) => ({ id: String(m.id), label: String(m.display_name ? `${m.id} (${m.display_name})` : m.id) })).slice(0, 20);
    } else {
      const presetBaseUrls = {
        groq: 'https://api.groq.com/openai/v1',
        mistral: 'https://api.mistral.ai/v1',
        openai: 'https://api.openai.com/v1'
      };
      const baseUrl = provider === 'custom' ? customBaseUrl : presetBaseUrls[provider];
      if (!baseUrl) return jsonResp({ ok: false, error: '請先填寫 API Base URL' }, 400);
      if (!apiKey && provider !== 'custom') return jsonResp({ ok: false, error: `查詢 ${provider} 最新模型需要填入 API Key` }, 400);
      const endpoint = baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/models';
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const res = await fetch(endpoint, { headers, signal: makeTimeoutSignal(10000) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error && data.error.message) || `API 錯誤 (${res.status})`);
      const list = Array.isArray(data && data.data) ? data.data : [];
      models = list
        .map((m) => String((m && m.id) || '').trim())
        .filter((id) => id && !/(whisper|tts|orpheus|guard|embed|moderation|dall-e|sora|audio|realtime|transcribe|rerank)/i.test(id))
        .map((id) => {
          let score = 0;
          if (provider === 'groq') {
            if (/qwen.*3\.\d|vl|vision/i.test(id)) score += 40;
            if (/gpt-oss-120b/i.test(id)) score += 30;
            if (/gpt-oss-20b/i.test(id)) score += 20;
          } else if (provider === 'mistral') {
            if (/mistral-small-latest/i.test(id)) score += 40;
            if (/pixtral/i.test(id)) score += 30;
          } else if (provider === 'openai') {
            if (/gpt-4o-mini|gpt-4\.1-mini|gpt-5-mini/i.test(id)) score += 40;
            if (/gpt-4\.1|gpt-4o|gpt-5/i.test(id)) score += 20;
          }
          return { id, label: id, score };
        })
        .sort((a, b) => b.score - a.score || b.id.localeCompare(a.id))
        .slice(0, 25)
        .map(({ id, label }) => ({ id, label }));
    }

    if (models.length === 0) {
      return jsonResp({ ok: false, error: '未取得任何可用聊天模型，請確認 API Key 或權限' }, 404);
    }
    return jsonResp({
      ok: true,
      provider,
      recommended: models[0].id,
      models
    });
  } catch (err) {
    return jsonResp({ ok: false, error: (err && err.message) || '取得線上模型清單失敗' }, 502);
  }
}

async function callCloudflareAI({ env, model, systemPrompt, prompt, attachments = [] }) {
  const hasImg = attachments.length > 0;
  const candidates = hasImg
    ? [...new Set([model, '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.2-11b-vision-instruct'].filter(Boolean))]
    : [...new Set([model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.1-8b-instruct-fast'].filter(Boolean))];

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (hasImg) {
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

  let lastErr = 'Cloudflare Workers AI 呼叫失敗';
  for (const m of candidates) {
    try {
      const out = await env.AI.run(m, { messages, max_tokens: 2048, temperature: 0.1 });
      const text = (out && typeof out.response === 'string' && out.response)
        || (out && out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content)
        || '';
      if (text) return { text: String(text), model: m };
    } catch (err) {
      lastErr = (err && err.message) || lastErr;
    }
  }
  throw new Error(lastErr);
}

async function handleOpenRouterExchange(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return jsonResp({ ok: false, error: '僅支援 POST 請求' }, 405);
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResp({ ok: false, error: '請求 JSON 格式錯誤' }, 400);
  }
  const code = String(body.code || '').trim();
  const codeVerifier = String(body.code_verifier || '').trim();
  if (!code || !codeVerifier) {
    return jsonResp({ ok: false, error: '缺少授權碼或驗證碼' }, 400);
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: 'S256'
      }),
      signal: makeTimeoutSignal(12000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || !data.key) {
      throw new Error((data && (data.error || data.message)) || `OpenRouter 授權交換失敗 (${res.status})`);
    }
    return jsonResp({ ok: true, key: String(data.key) });
  } catch (err) {
    return jsonResp({ ok: false, error: (err && err.message) || 'OpenRouter 授權交換失敗' }, 502);
  }
}

const DEFAULT_FIREBASE_PROJECT_ID = 'wealth-ledger-5ee42';
const DEFAULT_FIREBASE_API_KEY = 'AIzaSyCDv2Xn_XLJ0irvq2W_TdTlPNI8exIndYM';

function extractBearerToken(request, body) {
  const auth = String(request.headers.get('Authorization') || '').trim();
  if (/^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim();
  }
  return String((body && body.firebaseIdToken) || '').trim();
}

function getCfAdminEmails(env) {
  const raw = String((env && (env.CF_AI_ADMIN_EMAIL || env.CF_AI_ADMIN_EMAILS)) || '').trim();
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function getCfStaticAllowedEmails(env) {
  const raw = String((env && env.CF_AI_ALLOWED_EMAILS) || '').trim();
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function verifyFirebaseIdToken(idToken, env) {
  if (!idToken) return null;
  const apiKey = String((env && env.FIREBASE_API_KEY) || DEFAULT_FIREBASE_API_KEY).trim();
  try {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
      signal: makeTimeoutSignal(8000)
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const u = data && Array.isArray(data.users) && data.users[0];
    if (!u || !u.localId) return null;
    return {
      uid: String(u.localId),
      email: String(u.email || '').toLowerCase().trim(),
      displayName: String(u.displayName || '').trim()
    };
  } catch (e) {
    return null;
  }
}

async function computeCfApprovalSig(env, uid, email) {
  const secretSeed = String(
    (env && env.CF_AI_SIGNING_SECRET)
    || (env && (env.CF_AI_ADMIN_EMAIL || env.CF_AI_ADMIN_EMAILS))
    || ''
  ).trim();
  if (!secretSeed || !uid || !email) return '';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(`wealth-ledger-cf-ai-v1::${secretSeed}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(`${uid}:${email.toLowerCase().trim()}:approved`));
  return Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fsBaseUrl(env) {
  const projectId = String((env && env.FIREBASE_PROJECT_ID) || DEFAULT_FIREBASE_PROJECT_ID).trim();
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
}

function fsParseCfDoc(doc) {
  if (!doc || !doc.fields) return null;
  const f = doc.fields;
  const str = (k) => (f[k] && typeof f[k].stringValue === 'string' ? f[k].stringValue : '');
  const num = (k) => (f[k] && f[k].integerValue !== undefined ? Number(f[k].integerValue) : 0);
  const nameParts = String(doc.name || '').split('/');
  const uidFromName = nameParts[nameParts.length - 1] || '';
  return {
    uid: str('uid') || uidFromName,
    email: str('email').toLowerCase(),
    displayName: str('displayName'),
    note: str('note'),
    status: str('status') || 'pending',
    requestedAt: num('requestedAt'),
    decidedAt: num('decidedAt'),
    decidedBy: str('decidedBy'),
    approvalSig: str('approvalSig')
  };
}

function fsSanitizeForClient(rec) {
  if (!rec) return null;
  return {
    uid: rec.uid,
    email: rec.email,
    displayName: rec.displayName,
    note: rec.note,
    status: rec.status,
    requestedAt: rec.requestedAt,
    decidedAt: rec.decidedAt,
    decidedBy: rec.decidedBy
  };
}

async function fsGetCfRequest(uid, idToken, env) {
  const url = `${fsBaseUrl(env)}/cf_ai_requests/${encodeURIComponent(uid)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
    signal: makeTimeoutSignal(8000)
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const doc = await res.json().catch(() => null);
  return fsParseCfDoc(doc);
}

async function fsListCfRequests(idToken, env) {
  const url = `${fsBaseUrl(env)}/cf_ai_requests?pageSize=200`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${idToken}` },
    signal: makeTimeoutSignal(8000)
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => null);
  const docs = (data && Array.isArray(data.documents)) ? data.documents : [];
  const list = docs.map(fsParseCfDoc).filter(Boolean);
  const rank = { pending: 0, approved: 1, rejected: 2 };
  list.sort((a, b) => ((rank[a.status] ?? 9) - (rank[b.status] ?? 9)) || ((b.requestedAt || 0) - (a.requestedAt || 0)));
  return list;
}

async function fsWriteCfRequest(uid, rec, idToken, env) {
  const url = `${fsBaseUrl(env)}/cf_ai_requests/${encodeURIComponent(uid)}`;
  const payload = {
    fields: {
      uid: { stringValue: String(rec.uid || uid) },
      email: { stringValue: String(rec.email || '').toLowerCase() },
      displayName: { stringValue: String(rec.displayName || '') },
      note: { stringValue: String(rec.note || '') },
      status: { stringValue: String(rec.status || 'pending') },
      requestedAt: { integerValue: String(Math.floor(rec.requestedAt || Date.now())) },
      decidedAt: { integerValue: String(Math.floor(rec.decidedAt || 0)) },
      decidedBy: { stringValue: String(rec.decidedBy || '') },
      approvalSig: { stringValue: String(rec.approvalSig || '') }
    }
  };
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify(payload),
    signal: makeTimeoutSignal(8000)
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Firestore 寫入失敗 (${res.status})：${errText.slice(0, 120)}`);
  }
  return true;
}

async function checkCfAiAccess(idToken, env) {
  const hasAiBinding = Boolean(env && env.AI);
  const admins = getCfAdminEmails(env);
  const staticAllowed = getCfStaticAllowedEmails(env);
  const configured = admins.length > 0 || staticAllowed.length > 0;

  if (!hasAiBinding) {
    return { allowed: false, hasAiBinding: false, configured, isAdmin: false, status: 'disabled', reason: '此站尚未啟用 Cloudflare Workers AI 綁定' };
  }
  if (!configured) {
    return {
      allowed: false,
      hasAiBinding: true,
      configured: false,
      isAdmin: false,
      status: 'unconfigured',
      reason: '站長尚未在 Cloudflare 環境變數設定 CF_AI_ADMIN_EMAIL，為保護額度目前已預設鎖定 Cloudflare Workers AI'
    };
  }
  const user = await verifyFirebaseIdToken(idToken, env);
  if (!user || !user.email) {
    return {
      allowed: false,
      hasAiBinding: true,
      configured: true,
      isAdmin: false,
      status: 'unauthenticated',
      reason: 'Cloudflare Workers AI 僅限向站長申請並經同意的帳號使用，請先登入 Google 帳號並送出申請'
    };
  }
  if (admins.includes(user.email)) {
    return { allowed: true, hasAiBinding: true, configured: true, isAdmin: true, status: 'admin', user };
  }
  if (staticAllowed.includes(user.email)) {
    return { allowed: true, hasAiBinding: true, configured: true, isAdmin: false, status: 'approved', user };
  }
  const doc = await fsGetCfRequest(user.uid, idToken, env);
  if (doc && doc.status === 'approved') {
    const expectedSig = await computeCfApprovalSig(env, user.uid, user.email);
    if (expectedSig && doc.approvalSig === expectedSig) {
      return { allowed: true, hasAiBinding: true, configured: true, isAdmin: false, status: 'approved', user, request: doc };
    }
  }
  const st = (doc && doc.status === 'approved') ? 'none' : ((doc && doc.status) || 'none');
  const reason = st === 'pending'
    ? '你的 Cloudflare Workers AI 申請正在等待站長審核同意，請稍候（這期間可先用「⚡ 一鍵連結 OpenRouter」免費額度）'
    : (st === 'rejected'
      ? '你的 Cloudflare Workers AI 申請未獲同意，請改用「⚡ 一鍵連結 OpenRouter」或自己的免費 API Key'
      : 'Cloudflare Workers AI 僅限向站長申請並經同意的使用者使用，請至「設定 → AI 智慧匯入」點擊申請');
  return { allowed: false, hasAiBinding: true, configured: true, isAdmin: false, status: st, user, request: doc, reason };
}

async function handleCfAccessStatus(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return jsonResp({ ok: false, error: '僅支援 POST 請求' }, 405);
  const body = await request.json().catch(() => ({}));
  const idToken = extractBearerToken(request, body);
  const access = await checkCfAiAccess(idToken, env);
  let requests = [];
  if (access.isAdmin && idToken) {
    const all = await fsListCfRequests(idToken, env);
    requests = all.map(fsSanitizeForClient);
  }
  return jsonResp({
    ok: true,
    hasAiBinding: access.hasAiBinding,
    configured: access.configured,
    isAdmin: access.isAdmin,
    allowed: access.allowed,
    status: access.status,
    reason: access.reason || '',
    request: fsSanitizeForClient(access.request),
    requests
  });
}

async function handleCfAccessRequest(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return jsonResp({ ok: false, error: '僅支援 POST 請求' }, 405);
  const body = await request.json().catch(() => ({}));
  const idToken = extractBearerToken(request, body);
  const access = await checkCfAiAccess(idToken, env);
  if (!access.configured) {
    return jsonResp({ ok: false, error: access.reason }, 400);
  }
  if (!access.user) {
    return jsonResp({ ok: false, error: '請先登入 Google 帳號才能送出申請' }, 401);
  }
  if (access.allowed) {
    return jsonResp({ ok: true, status: access.status, message: '你已擁有 Cloudflare Workers AI 使用權限' });
  }
  const note = String(body.note || '').trim().slice(0, 120);
  try {
    await fsWriteCfRequest(access.user.uid, {
      uid: access.user.uid,
      email: access.user.email,
      displayName: access.user.displayName,
      note,
      status: 'pending',
      requestedAt: Date.now(),
      decidedAt: 0,
      decidedBy: '',
      approvalSig: ''
    }, idToken, env);
    return jsonResp({ ok: true, status: 'pending', message: '已送出申請，請等待站長同意！' });
  } catch (err) {
    return jsonResp({ ok: false, error: (err && err.message) || '送出申請失敗' }, 502);
  }
}

async function handleCfAccessDecide(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return jsonResp({ ok: false, error: '僅支援 POST 請求' }, 405);
  const body = await request.json().catch(() => ({}));
  const idToken = extractBearerToken(request, body);
  const caller = await verifyFirebaseIdToken(idToken, env);
  const admins = getCfAdminEmails(env);
  if (!caller || !admins.includes(caller.email)) {
    return jsonResp({ ok: false, error: '只有站長可以審核 Cloudflare Workers AI 使用申請' }, 403);
  }
  const targetUid = String(body.targetUid || '').trim();
  const decision = String(body.decision || '').trim();
  if (!targetUid || !['approved', 'rejected'].includes(decision)) {
    return jsonResp({ ok: false, error: '缺少申請者 UID 或無效的審核動作' }, 400);
  }
  const existing = await fsGetCfRequest(targetUid, idToken, env);
  if (!existing) {
    return jsonResp({ ok: false, error: '找不到該筆申請紀錄' }, 404);
  }
  const approvalSig = decision === 'approved'
    ? await computeCfApprovalSig(env, targetUid, existing.email)
    : '';
  try {
    await fsWriteCfRequest(targetUid, {
      ...existing,
      status: decision,
      decidedAt: Date.now(),
      decidedBy: caller.email,
      approvalSig
    }, idToken, env);
    return jsonResp({ ok: true, targetUid, decision });
  } catch (err) {
    return jsonResp({ ok: false, error: (err && err.message) || '更新審核狀態失敗' }, 502);
  }
}



