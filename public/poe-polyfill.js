/**
 * window.Poe polyfill for Vercel deployment.
 *
 * Poe SSE format uses the `event:` field for the event type:
 *   event: text
 *   data: {"text": "hello"}
 *
 * The polyfill buffers lines, assembles full SSE events (event + data),
 * then delivers results in the shape the app expects:
 *   handler({ responses: [{ status, content, attachments, statusText }] })
 */
(function () {
  if (window.Poe) return;

  const API_ROUTE = '/api/poe';
  const handlers = {};

  // ── result shape helper ───────────────────────────────────────
  function wrap(status, content, attachments, statusText) {
    return {
      responses: [{
        status,
        content: content || '',
        attachments: attachments || [],
        statusText: statusText || '',
      }],
    };
  }

  // ── query string helpers ──────────────────────────────────────
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

  // ── SSE parser ────────────────────────────────────────────────
  // Yields complete { event, data } objects from a ReadableStream.
  async function* parseSse(stream) {
    const reader  = stream.getReader();
    const decoder = new TextDecoder();
    let buffer    = '';
    let eventType = 'message';
    let dataLines = [];

    function flush() {
      if (!dataLines.length) return null;
      const ev   = { event: eventType, data: dataLines.join('\n') };
      eventType  = 'message';
      dataLines  = [];
      return ev;
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const ev = flush();
        if (ev) yield ev;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const raw of lines) {
        const line = raw.trimEnd();
        if (line === '') {
          const ev = flush();
          if (ev) yield ev;
        } else if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
        // ignore id: and retry: lines
      }
    }
  }

  // ── open a stream to the proxy ────────────────────────────────
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

  // ── non-streaming: accumulate and return ─────────────────────
  async function callPoe(bot, prompt, parameters) {
    const res = await openStream(bot, prompt, parameters);
    let text = '';
    const attachments = [];

    for await (const { event, data } of parseSse(res.body)) {
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      if (event === 'text') {
        text += parsed.text || '';
      } else if (event === 'replace_response') {
        text = parsed.text || '';
      } else if (event === 'file_attachment') {
        attachments.push({ url: parsed.url, content_type: parsed.content_type || '', name: parsed.name || '' });
      } else if (event === 'error') {
        throw new Error(parsed.text || 'Poe error');
      }
      // 'done' — just stop
    }

    return { status: 'complete', content: text, attachments };
  }

  // ── streaming: fire handler incrementally ────────────────────
  async function callPoeStreaming(bot, prompt, parameters, handlerFn) {
    const res = await openStream(bot, prompt, parameters);
    let text = '';
    const attachments = [];

    for await (const { event, data } of parseSse(res.body)) {
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }

      if (event === 'text') {
        text += parsed.text || '';
        handlerFn(wrap('incomplete', text, attachments));
      } else if (event === 'replace_response') {
        text = parsed.text || '';
        handlerFn(wrap('incomplete', text, attachments));
      } else if (event === 'file_attachment') {
        attachments.push({ url: parsed.url, content_type: parsed.content_type || '', name: parsed.name || '' });
      } else if (event === 'error') {
        throw new Error(parsed.text || 'Poe streaming error');
      } else if (event === 'done') {
        break;
      }
    }

    handlerFn(wrap('complete', text, attachments));
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
