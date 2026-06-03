/**
 * SSE Stream Rewriter — example main-scope plugin for api.network.transformStream.
 *
 * Demonstrates the only streaming-safe way to REWRITE a streaming response:
 *   - The transform function runs IN THE PAGE (main world). It is given each
 *     SSE event ("data: {...}\n\n") and returns a replacement (or null to drop,
 *     or undefined to pass through) — the page receives the modified token
 *     stream incrementally, so streaming is preserved.
 *   - It also reports each observed token back to this plugin via ctx.emit(...),
 *     which arrives in `onEmit` below (running here in the main process).
 *
 * Requirements:
 *   - manifest scope must be "main" (transformStream is main-scope only).
 *   - Enable the feature:  desktop-proxy config set cdpStreamTransform true
 *
 * The demo rewrite replaces the word "cat" with "dog" in assistant tokens for
 * OpenAI-style (choices[].delta.content) and Anthropic-style (delta.text)
 * Server-Sent Event chunks. Flip REWRITE to false inside the transform to
 * observe-only.
 */

// Runs IN THE PAGE — must be self-contained (no closure over plugin scope).
function rewriteSseEvent(chunk, ctx) {
  var REWRITE = true; // set false to only observe (no modification)
  if (typeof chunk !== "string" || chunk.indexOf("data:") === -1) return chunk;

  var lines = chunk.split("\n");
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.indexOf("data:") !== 0) {
      out.push(line);
      continue;
    }
    var payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") {
      out.push(line);
      continue;
    }
    try {
      var obj = JSON.parse(payload);
      var text = null;
      var set = null;
      if (obj.choices && obj.choices[0] && obj.choices[0].delta && typeof obj.choices[0].delta.content === "string") {
        text = obj.choices[0].delta.content;
        set = function (v) { obj.choices[0].delta.content = v; };
      } else if (obj.delta && typeof obj.delta.text === "string") {
        text = obj.delta.text;
        set = function (v) { obj.delta.text = v; };
      }
      if (text !== null) {
        try { ctx.emit({ text: text }); } catch (e) {}
        if (REWRITE && set) set(text.replace(/cat/gi, "dog"));
      }
      out.push("data: " + JSON.stringify(obj));
    } catch (e) {
      out.push(line); // not JSON we understand — leave untouched
    }
  }
  return out.join("\n");
}

// AI streaming endpoints (substring match against the request URL).
var STREAM_URLS = [
  "chat/completions", // OpenAI / DeepSeek / many OpenAI-compatible APIs
  "v1/messages", // Anthropic
  "generativelanguage", // Google AI (streamGenerateContent)
];

var MAX_TOKENS = 4000;

module.exports = {
  /** @param {import('@desktop-proxy/plugin-sdk').PluginAPI} api */
  start(api) {
    var captured = [];
    var flushTimer = null;

    function scheduleFlush() {
      if (flushTimer) return;
      flushTimer = setTimeout(function () {
        flushTimer = null;
        try { api.storage.set("lastStream", captured.join("")); } catch (e) {}
      }, 500);
    }

    var unsubscribe = api.network.transformStream(
      { urls: STREAM_URLS },
      rewriteSseEvent,
      {
        mode: "sse",
        onEmit: function (data) {
          if (!data || typeof data.text !== "string") return;
          captured.push(data.text);
          if (captured.length > MAX_TOKENS) captured.splice(0, captured.length - MAX_TOKENS);
          if (captured.length % 25 === 0) {
            api.log.info("[sse-rewriter] captured " + captured.length + " tokens");
          }
          scheduleFlush();
        },
      },
    );

    this._unsubscribe = unsubscribe;
    this._flush = function () {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      try { api.storage.set("lastStream", captured.join("")); } catch (e) {}
    };

    api.log.info("[sse-rewriter] started (enable with: config set cdpStreamTransform true)");
  },

  stop() {
    try { if (this._unsubscribe) this._unsubscribe(); } catch (e) {}
    try { if (this._flush) this._flush(); } catch (e) {}
  },
};
