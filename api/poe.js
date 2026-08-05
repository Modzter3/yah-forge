export const config = { runtime: 'edge' };

const POE_CHAT_URL = 'https://api.poe.com/v1/chat/completions';

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== 'POST') {
    return jsonError('Method not allowed', 405);
  }

  const apiKey = process.env.POE_API_KEY;
  if (!apiKey) {
    return jsonError('POE_API_KEY is not set in Vercel environment variables', 500);
  }

  let body;
  try { body = await req.json(); }
  catch { return jsonError('Invalid JSON body', 400); }

  const { bot, query, parameters = {} } = body;
  if (!bot || !query) return jsonError('Missing required fields: bot, query', 400);

  const payload = {
    messages: [{ role: 'user', content: query }],
    stream: true,
  };

  if (parameters.thinking_budget  !== undefined) payload.thinking_budget  = parameters.thinking_budget;
  if (parameters.thinking_level   !== undefined) payload.thinking_level   = parameters.thinking_level;
  if (parameters.reasoning_effort !== undefined) payload.reasoning_effort = parameters.reasoning_effort;
  if (parameters.web_search       !== undefined) payload.web_search       = parameters.web_search;
  if (parameters.aspect_ratio     !== undefined) payload.aspect_ratio     = parameters.aspect_ratio;
  if (parameters.image_only       !== undefined) payload.image_only       = parameters.image_only;
  if (parameters.duration         !== undefined) payload.duration         = parameters.duration;
  if (parameters.size             !== undefined) payload.size             = parameters.size;
  if (parameters.voice            !== undefined) payload.voice            = parameters.voice;
  if (parameters.music_length_ms  !== undefined) payload.music_length_ms  = parameters.music_length_ms;

  const candidates = modelCandidates(bot);
  let poeRes = null;
  let modelUsed = null;
  let lastError = null;

  for (const model of candidates) {
    let res;
    try {
      res = await fetch(POE_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://yah-forge.vercel.app',
          'X-Title': "YAH's Word Forge",
        },
        body: JSON.stringify({ ...payload, model }),
      });
    } catch (err) {
      return jsonError(`Network error reaching Poe: ${err.message}`, 502);
    }

    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('text/event-stream')) {
      poeRes = res;
      modelUsed = model;
      break;
    }

    let raw = '';
    try { raw = await res.text(); } catch { raw = '(unreadable)'; }
    let clean = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    try {
      const j = JSON.parse(raw);
      clean = j.error?.message || j.message || clean;
    } catch { /* keep clean as-is */ }

    lastError = {
      status: res.status,
      clean,
      model,
    };

    if (isModelNotFound(res.status, clean) && model !== candidates[candidates.length - 1]) {
      continue;
    }

    return jsonError(
      formatPoeError(bot, model, clean, res.status),
      res.status >= 400 ? res.status : 502,
    );
  }

  if (!poeRes) {
    const e = lastError || {};
    return jsonError(
      formatPoeError(bot, e.model || candidates[0], e.clean || 'Model not found', e.status || 404),
      e.status >= 400 ? e.status : 404,
    );
  }

  const { readable, writable } = new TransformStream();
  const writer  = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      const reader  = poeRes.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) await writer.write(encoder.encode(l + '\n'));
      }
      if (buf) await writer.write(encoder.encode(buf + '\n'));
    } catch (e) {
      await writer.write(encoder.encode(`data: {"error":"${e.message}"}\n\n`));
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      ...(modelUsed && modelUsed !== bot ? { 'X-Poe-Model-Used': modelUsed } : {}),
    },
  });
}

/**
 * Poe model IDs are inconsistent across families:
 * - Claude/Gemini/Grok bots: Title-Case handles (Claude-Sonnet-5, Gemini-3.1-Pro)
 * - GPT bots: lowercase slugs (gpt-5.4, gpt-5.6-sol) per Poe API samples
 */
function normalizePoeModel(bot) {
  const raw = String(bot || '').trim();
  if (!raw) return raw;
  const lower = raw.toLowerCase();

  const aliases = {
    'muse-spark-1.1': 'muse-spark-1-1',
    'muse-spark-1-1': 'muse-spark-1-1',
  };
  if (aliases[lower]) return aliases[lower];

  if (/^gpt-/i.test(raw)) return lower;

  if (/^(claude|gemini|grok|deepseek|llama|mistral)-/i.test(raw)) {
    return raw.split('-').map((part) => {
      if (/^[\d.]+/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }).join('-');
  }

  return raw;
}

function modelCandidates(bot) {
  const raw = String(bot || '').trim();
  const primary = normalizePoeModel(raw);
  const lower = raw.toLowerCase();
  const titled = raw.split('-').map((part) => {
    if (/^[\d.]+/.test(part)) return part;
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }).join('-');

  const out = [];
  for (const id of [primary, raw, titled, lower]) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function isModelNotFound(status, message) {
  if (status === 404) return true;
  return /not\s*found|does\s*not\s*exist|unknown\s*model|invalid\s*model/i.test(String(message || ''));
}

function formatPoeError(bot, model, clean, status) {
  const tried = model !== bot ? `bot: ${model} (from ${bot})` : `bot: ${model}`;
  return `Poe ${status} (${tried}): ${clean || '(empty)'}`;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonError(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}
