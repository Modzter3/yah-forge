export const config = { runtime: 'edge' };

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

  // Build OpenAI-compatible request — always stream so we can pipe SSE back
  const payload = {
    model: bot,
    messages: [{ role: 'user', content: query }],
    stream: true,
  };

  // Pass any supported model parameters through
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

  let poeRes;
  try {
    poeRes = await fetch('https://api.poe.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://yah-forge.vercel.app',
        'X-Title': "YAH's Word Forge",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return jsonError(`Network error reaching Poe: ${err.message}`, 502);
  }

  const ct = poeRes.headers.get('content-type') || '';

  if (!ct.includes('text/event-stream')) {
    let raw = '';
    try { raw = await poeRes.text(); } catch { raw = '(unreadable)'; }
    let clean = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    // Try to parse as JSON for a cleaner error message
    try {
      const j = JSON.parse(raw);
      clean = j.error?.message || j.message || clean;
    } catch { /* keep clean as-is */ }
    return jsonError(`Poe ${poeRes.status} (bot: ${bot}): ${clean || '(empty)'}`, poeRes.status >= 400 ? poeRes.status : 502);
  }

  // Pipe the OpenAI-format SSE stream straight back to the browser
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
    },
  });
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
