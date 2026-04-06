export const config = { runtime: 'edge' };

const POE_API_BASE = 'https://api.poe.com/bot';

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(),
    });
  }

  if (req.method !== 'POST') {
    return jsonError('Method not allowed', 405);
  }

  const apiKey = process.env.POE_API_KEY;
  if (!apiKey) {
    return jsonError('POE_API_KEY environment variable is not set', 500);
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

  // Build the Poe API request payload
  const poePayload = {
    version: '1',
    type: 'query',
    query: [{ role: 'user', content: query }],
    conversation_id: conversation_id || crypto.randomUUID(),
    message_id: crypto.randomUUID(),
    ...buildPoeParameters(parameters),
  };

  let poeResponse;
  try {
    poeResponse = await fetch(`${POE_API_BASE}/${encodeURIComponent(bot)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(poePayload),
    });
  } catch (err) {
    return jsonError(`Network error contacting Poe API: ${err.message}`, 502);
  }

  // Check if Poe returned an error (non-SSE response)
  const contentType = poeResponse.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    let errorText = await poeResponse.text();
    // Truncate HTML error pages
    if (errorText.length > 500) {
      errorText = errorText.slice(0, 500) + '…';
    }
    return jsonError(`Poe API error (${poeResponse.status}): ${errorText}`, poeResponse.status >= 400 ? poeResponse.status : 502);
  }

  // Stream the SSE response back to the client
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      const reader = poeResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
          // Forward the raw SSE lines
          await writer.write(encoder.encode(line + '\n'));
        }
      }

      // Flush any remaining buffer
      if (buffer) {
        await writer.write(encoder.encode(buffer + '\n'));
      }
    } catch (err) {
      const errEvent = `data: ${JSON.stringify({ type: 'error', allow_retry: false, text: err.message })}\n\n`;
      await writer.write(encoder.encode(errEvent));
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

function buildPoeParameters(params) {
  const result = {};

  if (params.thinking_budget !== undefined) {
    result.thinking_budget = params.thinking_budget;
  }
  if (params.web_search !== undefined) {
    result.allow_attachments = params.web_search;
  }
  if (params.reasoning_effort !== undefined) {
    result.reasoning_effort = params.reasoning_effort;
  }
  if (params.voice !== undefined) {
    result.voice = params.voice;
  }
  if (params.music_length_ms !== undefined) {
    result.music_length_ms = params.music_length_ms;
  }
  if (params.aspect_ratio !== undefined) {
    result.aspect_ratio = params.aspect_ratio;
  }
  if (params.image_only !== undefined) {
    result.image_only = params.image_only;
  }
  if (params.duration !== undefined) {
    result.duration = params.duration;
  }
  if (params.size !== undefined) {
    result.size = params.size;
  }

  return result;
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
