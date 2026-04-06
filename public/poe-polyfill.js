/**
 * window.Poe polyfill for Vercel deployment.
 *
 * Replaces the Poe in-app SDK with fetch calls to /api/poe,
 * implementing registerHandler + sendUserMessage with full SSE streaming,
 * /repeat N support, and file_attachment (media) handling.
 */
(function () {
  if (window.Poe) return; // Already provided by native Poe environment

  const API_ROUTE = '/api/poe';
  const handlers = {};

  // ----- helpers -----

  function parseRepeat(query) {
    const m = query.match(/^\/repeat\s+(\d+)\s+/i);
    if (m) {
      return { count: parseInt(m[1], 10), query: query.slice(m[0].length) };
    }
    return { count: 1, query };
  }

  function extractBot(query) {
    const m = query.match(/^@([\w\-\.]+)\s*/);
    if (m) return { bot: m[1], prompt: query.slice(m[0].length) };
    return { bot: null, prompt: query };
  }

  /** Call /api/poe once and accumulate SSE events into a result object. */
  async function callPoe(bot, prompt, parameters) {
    const res = await fetch(API_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot, query: prompt, parameters }),
    });

    if (!res.ok) {
      let errMsg;
      try { errMsg = (await res.json()).error; } catch { errMsg = await res.text(); }
      throw new Error(errMsg || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let textAccum = '';
    const attachments = [];
    let isSuggestedReply = false;

    function parseLine(line) {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') return;

      let ev;
      try { ev = JSON.parse(raw); } catch { return; }

      if (ev.type === 'text' || ev.type === 'text_created' || ev.type === 'text_delta') {
        textAccum += ev.text ?? ev.delta ?? '';
      } else if (ev.type === 'replace_response') {
        textAccum = ev.text ?? '';
      } else if (ev.type === 'file_attachment') {
        attachments.push({
          url: ev.url,
          content_type: ev.content_type || '',
          name: ev.name || '',
        });
      } else if (ev.type === 'suggested_reply') {
        isSuggestedReply = true;
      } else if (ev.type === 'error') {
        throw new Error(ev.text || 'Poe returned an error event');
      } else if (ev.type === 'done') {
        // stream finished cleanly
      }
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        parseLine(line.trim());
      }
    }
    if (buffer) parseLine(buffer.trim());

    return {
      status: 'complete',
      content: textAccum,
      attachments,
      isSuggestedReply,
    };
  }

  /** Call /api/poe and stream partial results to handler (stream:true). */
  async function callPoeStreaming(bot, prompt, parameters, handlerName) {
    const handler = handlers[handlerName];
    if (!handler) throw new Error(`No handler registered: ${handlerName}`);

    const res = await fetch(API_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot, query: prompt, parameters }),
    });

    if (!res.ok) {
      let errMsg;
      try { errMsg = (await res.json()).error; } catch { errMsg = await res.text(); }
      throw new Error(errMsg || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let textAccum = '';
    const attachments = [];

    function handleEvent(ev) {
      if (ev.type === 'text' || ev.type === 'text_created' || ev.type === 'text_delta') {
        textAccum += ev.text ?? ev.delta ?? '';
        handler({ status: 'incomplete', content: textAccum, attachments });
      } else if (ev.type === 'replace_response') {
        textAccum = ev.text ?? '';
        handler({ status: 'incomplete', content: textAccum, attachments });
      } else if (ev.type === 'file_attachment') {
        attachments.push({
          url: ev.url,
          content_type: ev.content_type || '',
          name: ev.name || '',
        });
      } else if (ev.type === 'done') {
        handler({ status: 'complete', content: textAccum, attachments });
      } else if (ev.type === 'error') {
        throw new Error(ev.text || 'Poe streaming error');
      }
    }

    function parseLine(line) {
      if (!line.startsWith('data:')) return;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') return;
      let ev;
      try { ev = JSON.parse(raw); } catch { return; }
      handleEvent(ev);
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        parseLine(line.trim());
      }
    }
    if (buffer) parseLine(buffer.trim());

    // Ensure we always fire a final complete event
    handler({ status: 'complete', content: textAccum, attachments });
  }

  // ----- Public API -----

  window.Poe = {
    registerHandler(name, fn) {
      handlers[name] = fn;
    },

    sendUserMessage(rawQuery, options = {}) {
      const {
        handler: handlerName,
        stream = false,
        parameters = {},
      } = options;

      // Parse /repeat N prefix
      const { count, query: cleanQuery } = parseRepeat(rawQuery);
      const { bot, prompt } = extractBot(cleanQuery);

      if (!bot) {
        return Promise.reject(new Error('No bot specified in query (expected @BotName)'));
      }

      const handler = handlers[handlerName];

      return new Promise((resolve, reject) => {
        if (stream && count === 1) {
          // Streaming single call
          callPoeStreaming(bot, prompt, parameters, handlerName)
            .then(resolve)
            .catch((err) => {
              if (handler) handler({ status: 'error', content: err.message, attachments: [] });
              reject(err);
            });
        } else {
          // Non-streaming (or repeat N parallel calls)
          const tasks = Array.from({ length: count }, () => callPoe(bot, prompt, parameters));

          Promise.allSettled(tasks).then((results) => {
            for (const r of results) {
              if (r.status === 'fulfilled') {
                if (handler) handler(r.value);
              } else {
                if (handler) handler({ status: 'error', content: r.reason?.message || 'Unknown error', attachments: [] });
              }
            }
            resolve();
          });
        }
      });
    },
  };
})();
