export const config = { runtime: 'edge' };

const POE_API_BASE = 'https://api.poe.com/bot';

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== 'POST') {
    return jsonError('Method not allowed', 405);
  }

  const apiKey = process.env.POE_API_KEY;
  if (!apiKey) {
    return jsonError('POE_API_KEY is not configured in environment variables', 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { bot, query, parameters = {}, conversation_id } = body;

  if (!bot || !query) {
    return jsonError('Missing required fields: bot, query', 400);
  }

  const convId = conversation_id || crypto.randomUUID();
  const msgId  = crypto.randomUUID();

  // Poe protocol payload — only standard fields at the top level
  const poePayload = {
    version: '1',
    type: 'query',
    query: [
      {
        role: 'user',
        content: query,
        content_type: 'text/markdown',
        timestamp: Date.now() * 1000, // microseconds
        message_id: msgId,
        feedback: [],
        attachments: [],
      },
    ],
    user_id: '',
    conversation_id: convId,
    message_id: msgId,
  };

  // Bot-specific parameters go in bot_query_id / metadata — pass only recognised ones
  if (parameters.music_length_ms !== undefined) poePayload.music_length_ms = parameters.music_length_ms;
  if (parameters.voice            !== undefined) poePayload.voice            = parameters.voice;
  if (parameters.aspect_ratio     !== undefined) poePayload.aspect_ratio     = parameters.aspect_ratio;
  if (parameters.image_only       !== undefined) poePayload.image_only       = parameters.image_only;
  if (parameters.duration         !== undefined) poePayload.duration         = parameters.duration;
  if (parameters.size             !== undefined) poePayload.size             = parameters.size;

  let poeResponse;
  try {
    poeResponse = await fetch(`${POE_API_BASE}/${encodeURIComponent(bot)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(poePayload),
    });
  } catch (err) {
    return jsonError(`Network error contacting Poe: ${err.message}`, 502);
  }

  const contentType = poeResponse.headers.get('content-type') || '';

  if (!contentType.includes('text/event-stream')) {
    let errorText;
    try { errorText = await poeResponse.text(); } catch { errorText = '(unreadable)'; }
    if (errorText.length > 800) errorText = errorText.slice(0, 800) + '…';
    // Strip HTML tags for readability
    errorText = errorText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return jsonError(`Poe API ${poeResponse.status}: ${errorText}`, poeResponse.status >= 400 ? poeResponse.status : 502);
  }

  // Stream SSE back to client
  const { readable, writable } = new TransformStream();
  const writer  = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      const reader  = poeResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          await writer.write(encoder.encode(line + '\n'));
        }
      }
      if (buffer) await writer.write(encoder.encode(buffer + '\n'));
    } catch (err) {
      await writer.write(encoder.encode(
        `data: ${JSON.stringify({ type: 'error', allow_retry: false, text: err.message })}\n\n`
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
