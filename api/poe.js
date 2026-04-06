export const config = { runtime: 'edge' };

const POE_API_BASE = 'https://api.poe.com/bot';
const PROTOCOL_VERSION = '1';

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

  const { bot, query, parameters = {}, conversation_id } = body;
  if (!bot || !query) return jsonError('Missing required fields: bot, query', 400);

  const convId = conversation_id || crypto.randomUUID();
  const msgId  = crypto.randomUUID();

  // Match exactly what fastapi-poe Python client sends
  const poePayload = {
    version: PROTOCOL_VERSION,
    type: 'query',
    query: [
      {
        role: 'user',
        content: query,
        content_type: 'text/markdown',
        timestamp: 0,
        message_id: '',
        feedback: [],
        attachments: [],
      },
    ],
    user_id: '',
    conversation_id: convId,
    message_id: msgId,
  };

  // Media-specific parameters that some Poe bots accept
  if (parameters.music_length_ms !== undefined) poePayload.music_length_ms = parameters.music_length_ms;
  if (parameters.voice           !== undefined) poePayload.voice           = parameters.voice;
  if (parameters.aspect_ratio    !== undefined) poePayload.aspect_ratio    = parameters.aspect_ratio;
  if (parameters.image_only      !== undefined) poePayload.image_only      = parameters.image_only;
  if (parameters.duration        !== undefined) poePayload.duration        = parameters.duration;
  if (parameters.size            !== undefined) poePayload.size            = parameters.size;

  let poeRes;
  try {
    poeRes = await fetch(`${POE_API_BASE}/${encodeURIComponent(bot)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(poePayload),
    });
  } catch (err) {
    return jsonError(`Network error reaching Poe: ${err.message}`, 502);
  }

  const ct = poeRes.headers.get('content-type') || '';

  if (!ct.includes('text/event-stream')) {
    let raw = '';
    try { raw = await poeRes.text(); } catch { raw = '(unreadable)'; }
    // Strip HTML tags so the error is readable
    const clean = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    return jsonError(
      `Poe ${poeRes.status} for bot "${bot}": ${clean || '(empty body)'}`,
      poeRes.status >= 400 ? poeRes.status : 502,
    );
  }

  // Pipe the SSE stream straight back to the browser
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
      await writer.write(encoder.encode(
        `event: error\ndata: ${JSON.stringify({ text: e.message })}\n\n`,
      ));
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
