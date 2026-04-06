/**
 * window.Poe polyfill for Vercel deployment.
 *
 * Wraps /api/poe SSE streaming to match the native Poe SDK shape:
 *   handler({ responses: [{ status, content, attachments, statusText }] })
 */
(function () {
  if (window.Poe) return;

  const API_ROUTE = '/api/poe';
  const handlers = {};

  // ── helpers ──────────────────────────────────────────────────

  function wrap(status, content, attachments, statusText) {
    return { responses: [{ status, content: content || '', attachments: attachments || [], statusText: statusText || '' }] };
  }

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

  function makeLineReader(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    return async function* () {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) { yield buffer; buffer = ''; }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) yield line;
      }
    };
  }

  function parseEvent(line) {
    if (!line.startsWith('data:')) return null;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  // ── non-streaming single call ─────────────────────────────────

  async function callPoe(bot, prompt, parameters) {
    const res = await openStream(bot, prompt, parameters);
    const lines = makeLineReader(res);
    let text = '';
    const attachments = [];

    for await (const line of lines()) {
      const ev = parseEvent(line);
      if (!ev) continue;
      if (ev.type === 'text' || ev.type === 'text_created' || ev.type === 'text_delta') {
        text += ev.text ?? ev.delta ?? '';
      } else if (ev.type === 'replace_response') {
        text = ev.text ?? '';
      } else if (ev.type === 'file_attachment') {
        attachments.push({ url: ev.url, content_type: ev.content_type || '', name: ev.name || '' });
      } else if (ev.type === 'error') {
        throw new Error(ev.text || 'Poe error event');
      }
    }

    return { status: 'complete', content: text, attachments };
  }

  // ── streaming call (fires handler incrementally) ──────────────

  async function callPoeStreaming(bot, prompt, parameters, handlerFn) {
    const res = await openStream(bot, prompt, parameters);
    const lines = makeLineReader(res);
    let text = '';
    const attachments = [];

    for await (const line of lines()) {
      const ev = parseEvent(line);
      if (!ev) continue;

      if (ev.type === 'text' || ev.type === 'text_created' || ev.type === 'text_delta') {
        text += ev.text ?? ev.delta ?? '';
        handlerFn(wrap('incomplete', text, attachments));
      } else if (ev.type === 'replace_response') {
        text = ev.text ?? '';
        handlerFn(wrap('incomplete', text, attachments));
      } else if (ev.type === 'file_attachment') {
        attachments.push({ url: ev.url, content_type: ev.content_type || '', name: ev.name || '' });
      } else if (ev.type === 'error') {
        throw new Error(ev.text || 'Poe streaming error');
      } else if (ev.type === 'done') {
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
