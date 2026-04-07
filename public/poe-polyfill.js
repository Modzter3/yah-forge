/**
 * window.Poe polyfill — uses Poe's OpenAI-compatible API via /api/poe proxy.
 *
 * Poe's OpenAI SSE format:
 *   data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}
 *   data: [DONE]
 *
 * Delivers results in the shape the app expects:
 *   handler({ responses: [{ status, content, attachments, statusText }] })
 */
(function () {
  if (window.Poe) return;

  const API_ROUTE = '/api/poe';
  const handlers  = {};

  // ── result shape ─────────────────────────────────────────────
  function wrap(status, content, attachments, statusText) {
    return {
      responses: [{
        status,
        content:     content     || '',
        attachments: attachments || [],
        statusText:  statusText  || '',
      }],
    };
  }

  // ── query helpers ─────────────────────────────────────────────
  function parseRepeat(query) {
    const m = query.match(/^\/repeat\s+(\d+)\s+/i);
    if (m) return { count: parseInt(m[1], 10), query: query.slice(m[0].length) };
    return { count: 1, query };
  }

  function extractBot(query) {
    const m = query.match(/^@([\w\-\.]+)\s*/);
    if (m) return { bot: m[1], prompt: query.slice(m[0].length) };
    return { bot: null, prompt: query };
  }

  // ── SSE reader — yields raw data payloads ────────────────────
  async function* readSse(stream) {
    const reader  = stream.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data:')) {
          yield trimmed.slice(5).trim();
        }
      }
    }
    if (buf.trim().startsWith('data:')) yield buf.trim().slice(5).trim();
  }

  // ── open proxy stream ─────────────────────────────────────────
  async function openStream(bot, prompt, parameters) {
    const res = await fetch(API_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot, query: prompt, parameters }),
    });
    if (!res.ok) {
      let msg;
      try { msg = (await res.json()).error; } catch { msg = await res.text(); }
      throw new Error(msg || `HTTP ${res.status}`);
    }
    return res;
  }

  // ── extract text delta from OpenAI chunk ─────────────────────
  function deltaText(parsed) {
    try { return parsed.choices[0].delta.content || ''; } catch { return ''; }
  }
  function isFinished(parsed) {
    try { return parsed.choices[0].finish_reason != null; } catch { return false; }
  }

  // ── non-streaming: accumulate full response ───────────────────
  async function callPoe(bot, prompt, parameters) {
    const res = await openStream(bot, prompt, parameters);
    let text = '';

    for await (const raw of readSse(res.body)) {
      if (raw === '[DONE]') break;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      if (parsed.error) throw new Error(parsed.error.message || parsed.error);
      text += deltaText(parsed);
    }

    return { status: 'complete', content: text, attachments: [] };
  }

  // ── streaming: fire handler on each delta ────────────────────
  async function callPoeStreaming(bot, prompt, parameters, handlerFn) {
    const res = await openStream(bot, prompt, parameters);
    let text = '';

    for await (const raw of readSse(res.body)) {
      if (raw === '[DONE]') break;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      if (parsed.error) throw new Error(parsed.error.message || parsed.error);
      const delta = deltaText(parsed);
      if (delta) {
        text += delta;
        handlerFn(wrap('incomplete', text, []));
      }
      if (isFinished(parsed)) break;
    }

    handlerFn(wrap('complete', text, []));
  }

  // ── Public API ────────────────────────────────────────────────
  window.Poe = {
    registerHandler(name, fn) {
      handlers[name] = fn;
    },

    sendUserMessage(rawQuery, options = {}) {
      const { handler: handlerName, stream = false, parameters = {} } = options;
      const { count, query: cleanQuery } = parseRepeat(rawQuery);
      const { bot, prompt } = extractBot(cleanQuery);

      if (!bot) return Promise.reject(new Error('No bot specified (@BotName required)'));

      const handlerFn = handlers[handlerName];

      return new Promise((resolve, reject) => {
        if (stream && count === 1) {
          callPoeStreaming(bot, prompt, parameters, handlerFn)
            .then(resolve)
            .catch((err) => {
              if (handlerFn) handlerFn(wrap('error', '', [], err.message));
              reject(err);
            });
        } else {
          const tasks = Array.from({ length: count }, () => callPoe(bot, prompt, parameters));
          Promise.allSettled(tasks).then((results) => {
            for (const r of results) {
              if (r.status === 'fulfilled') {
                if (handlerFn) handlerFn(wrap('complete', r.value.content, r.value.attachments));
              } else {
                if (handlerFn) handlerFn(wrap('error', '', [], r.reason?.message || 'Unknown error'));
              }
            }
            resolve();
          });
        }
      });
    },
  };
})();
