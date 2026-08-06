/**
 * window.Poe compatibility polyfill backed by /api/ai.
 *
 * This keeps the existing frontend calls unchanged while routing requests
 * to your own API provider(s) configured on the backend.
 */
(function () {
  if (window.Poe) return;

  const API_ROUTE = '/api/ai';
  const handlers  = {};

  function wrap(status, content, attachments, statusText) {
    return {
      responses: [{
        status,
        content:     content     || '',
        attachments: attachments || [],
        statusText:  statusText  || '',
        messageId:   'forge-' + Date.now() + '-' + Math.random().toString(36).slice(2, 9),
      }],
    };
  }

  function parseRepeat(query) {
    const m = query.match(/^\/repeat\s+(\d+)\s+/i);
    if (m) return { count: parseInt(m[1], 10), query: query.slice(m[0].length) };
    return { count: 1, query };
  }

  function extractBot(query) {
    // Allow slashes so OpenRouter model IDs like google/gemini-2.5-pro are captured whole
    const m = query.match(/^@([\w\-\.\/]+)\s*/);
    if (m) return { bot: m[1], prompt: query.slice(m[0].length) };
    return { bot: null, prompt: query };
  }

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

  function deltaText(parsed) {
    try { return parsed.choices[0].delta.content || ''; } catch { return ''; }
  }

  function isFinished(parsed) {
    try { return parsed.choices[0].finish_reason != null; } catch { return false; }
  }

  function extractAttachments(text) {
    if (!text) return { text: '', attachments: [] };
    const trimmed = String(text).trim();
    if (!trimmed) return { text: '', attachments: [] };

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && Array.isArray(parsed.attachments)) {
        const attachments = parsed.attachments
          .filter(function (a) { return a && typeof a.url === 'string'; })
          .map(function (a) { return { url: a.url, content_type: a.content_type || '' }; });
        const bodyText = typeof parsed.text === 'string' ? parsed.text : '';
        return { text: bodyText, attachments };
      }
    } catch (_) {}

    if (/^https?:\/\/\S+\.(png|jpe?g|webp|gif|mp4|webm|mp3|wav|m4a)(\?\S*)?$/i.test(trimmed)) {
      return { text: '', attachments: [{ url: trimmed }] };
    }

    return { text, attachments: [] };
  }

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

    const out = extractAttachments(text);
    return { status: 'complete', content: out.text, attachments: out.attachments };
  }

  async function callPoeStreaming(bot, prompt, parameters, handlerFn) {
    const res = await openStream(bot, prompt, parameters);
    let text = '';
    let finished = false;
    let streamError = null;

    try {
      for await (const raw of readSse(res.body)) {
        if (raw === '[DONE]') break;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }
        if (parsed.error) {
          streamError = new Error(parsed.error.message || parsed.error);
          break;
        }
        const delta = deltaText(parsed);
        if (delta) {
          text += delta;
          if (handlerFn) handlerFn(wrap('incomplete', text, []));
        }
        if (isFinished(parsed)) {
          finished = true;
          break;
        }
      }
    } catch (err) {
      streamError = err;
    }

    const out = extractAttachments(text);
    if (streamError) {
      if (out.text && handlerFn) handlerFn(wrap('complete', out.text, out.attachments));
      else if (handlerFn) handlerFn(wrap('error', '', [], streamError.message || String(streamError)));
      return;
    }

    if (!finished && out.text && handlerFn) handlerFn(wrap('complete', out.text, out.attachments));
    else if (!finished && handlerFn) handlerFn(wrap('error', '', [], 'Stream ended without a response'));
    else if (handlerFn) handlerFn(wrap('complete', out.text, out.attachments));
  }

  const apiCompat = {
    registerHandler(name, fn) {
      handlers[name] = fn;
    },

    sendUserMessage(rawQuery, options = {}) {
      const { handler: handlerName, stream = false, parameters = {} } = options;
      const { count, query: cleanQuery } = parseRepeat(rawQuery);
      const { bot, prompt } = extractBot(cleanQuery);

      if (!bot) return Promise.reject(new Error('No model specified (@ModelId required)'));

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

  window.Poe = apiCompat;
  if (!window.AI) window.AI = apiCompat;
})();
