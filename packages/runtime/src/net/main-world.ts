/**
 * Main-world injector — hosts the page-side wrappers that can do what the CDP
 * Network/Fetch domains can't:
 *   - Streaming response transform (rewrite SSE/token streams without buffering).
 *   - Outbound WebSocket frame transform (rewrite/drop frames before send).
 *
 * Both wrappers live in the page's MAIN world (injected via CDP
 * Page.addScriptToEvaluateOnNewDocument). They share ONE pair of CDP bindings —
 * __dpEmit (page → main observations) and __dpReady (page asks main to push the
 * current registrations after each navigation) — because Runtime.addBinding
 * can't register the same name twice. So a single host attaches per webContents
 * and injects both wrappers together.
 *
 * Plugin transform functions run IN the page (pushed via Runtime.evaluate as
 * source), so they must be self-contained.
 */

import type { WebContents } from "electron";

import type { MainCDP } from "../cdp";
import type { TransformRegistration, WsTransformRegistration, RaceRegistration } from "../network";

type Logger = (level: string, ...args: unknown[]) => void;

export interface MainWorldDeps {
  streamRegs: () => TransformRegistration[];
  wsRegs: () => WsTransformRegistration[];
  raceRegs: () => RaceRegistration[];
  /** Route a page `emit(...)` back to the owning plugin (by registration id). */
  onEmit: (id: string, data: unknown) => void;
  log: Logger;
}

export interface MainWorldHost {
  attach(wc: WebContents): Promise<void>;
  registerStream(reg: TransformRegistration): void;
  registerWs(reg: WsTransformRegistration): void;
  registerRace(reg: RaceRegistration): void;
}

// Streaming-response wrapper: overrides fetch, pipes matched bodies through a
// TransformStream running the plugin fn per chunk / per SSE event. `\\n\\n` is
// the SSE boundary "\n\n". Calls __dpReady on init so main pushes transformers.
export const STREAM_WRAPPER_SOURCE = `(function(){
  if (window.__dpStreamWrapped) return;
  window.__dpStreamWrapped = true;
  var T = [];
  window.__dpRegisterTransform = function(id, urls, mode, src){
    try {
      var fn = (0, eval)("(" + src + ")");
      for (var i = 0; i < T.length; i++) { if (T[i].id === id) { T[i] = { id: id, urls: urls || [], mode: mode || "chunk", fn: fn }; return; } }
      T.push({ id: id, urls: urls || [], mode: mode || "chunk", fn: fn });
    } catch (e) {}
  };
  function pick(url){ for (var i = 0; i < T.length; i++){ var t = T[i]; for (var j = 0; j < t.urls.length; j++){ if (String(url).indexOf(t.urls[j]) >= 0) return t; } } return null; }
  function apply(t, chunk){
    try {
      var r = t.fn(chunk, { emit: function(d){ try { if (typeof __dpEmit === "function") __dpEmit(JSON.stringify({ id: t.id, data: d })); } catch (e) {} } });
      return r === undefined ? chunk : r;
    } catch (e) { return chunk; }
  }
  var of = window.fetch;
  if (typeof of === "function") {
    window.fetch = function(input, init){
      return of.apply(this, arguments).then(function(res){
        try {
          var url = (res && res.url) || (typeof input === "string" ? input : (input && input.url) || "");
          var t = pick(url);
          if (!t || !res || !res.body) return res;
          var dec = new TextDecoder(); var enc = new TextEncoder(); var buf = "";
          var ts = new TransformStream({
            transform: function(chunk, ctrl){
              var text = dec.decode(chunk, { stream: true });
              if (t.mode === "sse") {
                buf += text; var idx;
                while ((idx = buf.indexOf("\\n\\n")) >= 0) {
                  var evt = buf.slice(0, idx + 2); buf = buf.slice(idx + 2);
                  var out = apply(t, evt); if (out != null) ctrl.enqueue(enc.encode(out));
                }
              } else {
                var out2 = apply(t, text); if (out2 != null) ctrl.enqueue(enc.encode(out2));
              }
            },
            flush: function(ctrl){
              if (t.mode === "sse" && buf) { var out = apply(t, buf); if (out != null) ctrl.enqueue(enc.encode(out)); }
            }
          });
          res.body.pipeTo(ts.writable).catch(function(){});
          return new Response(ts.readable, { status: res.status, statusText: res.statusText, headers: res.headers });
        } catch (e) { return res; }
      });
    };
  }
  try { if (typeof __dpReady === "function") __dpReady(""); } catch (e) {}
})();`;

// Bidirectional WebSocket wrapper: overrides WebSocket.prototype.send (outbound)
// and the message-receiving paths (addEventListener("message") + onmessage,
// inbound). A matching socket's text frames run through the plugin fn (replace /
// drop / pass through); ctx.direction is "send" or "receive". Binary frames are
// left untouched. Inbound replacement rebuilds a MessageEvent (its data is
// read-only). Does NOT call __dpReady (the stream wrapper, injected alongside,
// already does).
export const WS_WRAPPER_SOURCE = `(function(){
  if (window.__dpWsWrapped) return;
  window.__dpWsWrapped = true;
  var W = [];
  window.__dpRegisterWs = function(id, urls, src){
    try {
      var fn = (0, eval)("(" + src + ")");
      for (var i = 0; i < W.length; i++) { if (W[i].id === id) { W[i] = { id: id, urls: urls || [], fn: fn }; return; } }
      W.push({ id: id, urls: urls || [], fn: fn });
    } catch (e) {}
  };
  function pick(url){ for (var i = 0; i < W.length; i++){ var t = W[i]; for (var j = 0; j < t.urls.length; j++){ if (String(url).indexOf(t.urls[j]) >= 0) return t; } } return null; }
  function applyWs(t, data, direction, url){
    try {
      return t.fn(data, { url: url, direction: direction, emit: function(d){ try { if (typeof __dpEmit === "function") __dpEmit(JSON.stringify({ id: t.id, data: d })); } catch (e) {} } });
    } catch (e) { return undefined; }
  }
  var WS = window.WebSocket;
  if (typeof WS !== "function" || !WS.prototype) return;

  // Outbound (page → server).
  var send = WS.prototype.send;
  if (typeof send === "function") {
    WS.prototype.send = function(data){
      try {
        if (typeof data === "string" && W.length) {
          var t = pick(this.url || "");
          if (t) {
            var r = applyWs(t, data, "send", this.url);
            if (r === null) return;                         // drop the frame
            if (r !== undefined) return send.call(this, r); // replace it
          }
        }
      } catch (e) {}
      return send.apply(this, arguments);
    };
  }

  // Inbound (server → page): returns a (possibly new) event, or null to drop.
  function incoming(self, ev){
    try {
      if (typeof ev.data === "string" && W.length) {
        var t = pick(self.url || "");
        if (t) {
          var r = applyWs(t, ev.data, "receive", self.url);
          if (r === null) return null;
          if (r !== undefined && r !== ev.data) {
            try {
              return new MessageEvent("message", { data: r, origin: ev.origin, lastEventId: ev.lastEventId, source: ev.source, ports: ev.ports });
            } catch (e) { return ev; }
          }
        }
      }
    } catch (e) {}
    return ev;
  }

  var origAdd = WS.prototype.addEventListener;
  if (typeof origAdd === "function") {
    WS.prototype.addEventListener = function(type, listener, opts){
      if (type === "message" && typeof listener === "function") {
        var self = this;
        var wrapped = function(ev){ var e2 = incoming(self, ev); if (e2 === null) return; return listener.call(this, e2); };
        try { listener.__dpRecvWrapped = wrapped; } catch (e) {}
        return origAdd.call(this, type, wrapped, opts);
      }
      return origAdd.call(this, type, listener, opts);
    };
    var origRemove = WS.prototype.removeEventListener;
    if (typeof origRemove === "function") {
      WS.prototype.removeEventListener = function(type, listener, opts){
        if (type === "message" && listener && listener.__dpRecvWrapped) return origRemove.call(this, type, listener.__dpRecvWrapped, opts);
        return origRemove.call(this, type, listener, opts);
      };
    }
  }

  try {
    var desc = Object.getOwnPropertyDescriptor(WS.prototype, "onmessage");
    if (desc && typeof desc.set === "function") {
      Object.defineProperty(WS.prototype, "onmessage", {
        configurable: true,
        enumerable: desc.enumerable,
        get: function(){ return desc.get ? desc.get.call(this) : undefined; },
        set: function(fn){
          if (typeof fn !== "function") return desc.set.call(this, fn);
          var self = this;
          desc.set.call(this, function(ev){ var e2 = incoming(self, ev); if (e2 === null) return; return fn.call(this, e2); });
        },
      });
    }
  } catch (e) {}
})();`;

// Request-racing wrapper (renderer): overrides fetch so a matched request is
// raced/failed-over across variants in the page; the first ACCEPTED response
// (by status+headers) streams through, losers are aborted. Mirrors the main
// `runRace` engine. Does NOT call __dpReady (the stream wrapper does).
export const RACE_WRAPPER_SOURCE = `(function(){
  if (window.__dpRaceWrapped) return;
  window.__dpRaceWrapped = true;
  var R = [];
  window.__dpRegisterRace = function(id, urls, mode, concurrency, perTimeout, totalTimeout, variantsSrc, acceptSrc){
    try {
      var variants = (0, eval)("(" + variantsSrc + ")");
      var accept = acceptSrc ? (0, eval)("(" + acceptSrc + ")") : function(s){ return s >= 200 && s < 300; };
      var reg = { id: id, urls: urls || [], mode: mode, concurrency: concurrency || 0, perTimeout: perTimeout || 0, totalTimeout: totalTimeout || 0, variants: variants, accept: accept };
      for (var i = 0; i < R.length; i++){ if (R[i].id === id){ R[i] = reg; return; } }
      R.push(reg);
    } catch (e) {}
  };
  function pick(url){ for (var i = 0; i < R.length; i++){ var t = R[i]; for (var j = 0; j < t.urls.length; j++){ if (String(url).indexOf(t.urls[j]) >= 0) return t; } } return null; }
  function emit(id, data){ try { if (typeof __dpEmit === "function") __dpEmit(JSON.stringify({ id: id, data: data })); } catch (e) {} }
  function headersToObj(h){ var o = {}; try { if (!h) return o; if (typeof h.forEach === "function"){ h.forEach(function(v, k){ o[k] = v; }); } else if (Array.isArray(h)){ for (var i=0;i<h.length;i++){ o[h[i][0]] = h[i][1]; } } else { for (var k in h){ o[k] = h[k]; } } } catch (e) {} return o; }
  var of = window.fetch;
  if (typeof of !== "function") return;
  window.fetch = function(input, init){
    var url = ""; try { url = (typeof input === "string") ? input : ((input && input.url) || ""); } catch (e) {}
    var t = pick(url);
    if (!t) return of.apply(this, arguments);
    var method, headers, body, variants;
    try {
      method = (init && init.method) || (input && input.method) || "GET";
      headers = headersToObj((init && init.headers) || (input && input.headers));
      body = (init && typeof init.body === "string") ? init.body : null;
      variants = t.variants({ method: method, url: url, headers: headers, body: body }) || [];
    } catch (e) { return of.apply(this, arguments); }
    if (!variants.length) return of.apply(this, arguments);
    var thisArg = this;
    return new Promise(function(resolve, reject){
      var cap = t.mode === "fallback" ? 1 : (t.concurrency > 0 ? t.concurrency : variants.length);
      var total = variants.length, next = 0, completed = 0;
      var settled = false, finished = false;
      var winner = null, lastResp = null, attempts = [], ctrls = [], startedAt = Date.now();
      var totalTimer = t.totalTimeout > 0 ? setTimeout(function(){ if (!settled){ settled = true; abortAll(); finish(); } }, t.totalTimeout) : null;
      function abortAll(){ for (var i=0;i<ctrls.length;i++){ try { ctrls[i].c.abort(); } catch (e) {} } }
      function abortOthers(keep){ for (var i=0;i<ctrls.length;i++){ if (ctrls[i].idx !== keep){ try { ctrls[i].c.abort(); } catch (e) {} } } }
      function cancel(res){ try { if (res && res.body && res.body.cancel) res.body.cancel(); } catch (e) {} }
      function finish(){
        if (finished) return; finished = true;
        if (totalTimer) clearTimeout(totalTimer);
        emit(t.id, { winnerIndex: winner ? winner.idx : null, attempts: attempts, totalMs: Date.now() - startedAt });
        if (winner) resolve(winner.res);
        else if (lastResp) resolve(lastResp.res);
        else reject(new Error("all race variants failed"));
      }
      function launch(){
        if (settled || next >= total) return;
        var idx = next++; var v = variants[idx];
        var c = new AbortController(); ctrls.push({ idx: idx, c: c });
        var perTimer = t.perTimeout > 0 ? setTimeout(function(){ try { c.abort(); } catch (e) {} }, t.perTimeout) : null;
        var t0 = Date.now();
        var vheaders = {}; for (var k in headers) vheaders[k] = headers[k]; if (v.headers){ for (var k2 in v.headers) vheaders[k2] = v.headers[k2]; }
        var vinit = { method: v.method || method, headers: vheaders, body: (v.body !== undefined ? v.body : body), signal: c.signal };
        of.call(thisArg, v.url || url, vinit).then(function(res){
          if (perTimer) clearTimeout(perTimer); completed++;
          var ok; try { ok = t.accept(res.status, headersToObj(res.headers)); } catch (e) { ok = res.status >= 200 && res.status < 300; }
          attempts.push({ index: idx, status: res.status, ok: ok, ms: Date.now() - t0 });
          if (settled){ cancel(res); return; }
          if (ok){ settled = true; winner = { idx: idx, res: res }; cancel(lastResp && lastResp.res); abortOthers(idx); finish(); return; }
          cancel(lastResp && lastResp.res); lastResp = { idx: idx, res: res };
          launch(); if (completed >= total) finish();
        }).catch(function(err){
          if (perTimer) clearTimeout(perTimer); completed++;
          attempts.push({ index: idx, status: null, ok: false, error: String(err), ms: Date.now() - t0 });
          if (!settled){ launch(); if (completed >= total) finish(); }
        });
      }
      var initial = Math.min(cap, total);
      for (var i = 0; i < initial; i++) launch();
    });
  };
})();`;

const INJECTED_SOURCE = STREAM_WRAPPER_SOURCE + "\n" + WS_WRAPPER_SOURCE + "\n" + RACE_WRAPPER_SOURCE;

export function createMainWorldHost(hub: MainCDP, deps: MainWorldDeps): MainWorldHost {
  const setup = new Map<number, WebContents>();

  function evalIn(wc: WebContents, expression: string, what: string): void {
    void hub.send(wc, "Runtime.evaluate", { expression }).catch((e) =>
      deps.log("warn", `main-world: ${what} failed:`, String(e)),
    );
  }

  function pushStream(wc: WebContents, reg: TransformRegistration): void {
    evalIn(
      wc,
      `window.__dpRegisterTransform(${JSON.stringify(reg.id)},${JSON.stringify(reg.urls)},${JSON.stringify(reg.mode)},${JSON.stringify(reg.source)})`,
      "register stream transform",
    );
  }

  function pushWs(wc: WebContents, reg: WsTransformRegistration): void {
    evalIn(
      wc,
      `window.__dpRegisterWs(${JSON.stringify(reg.id)},${JSON.stringify(reg.urls)},${JSON.stringify(reg.source)})`,
      "register ws transform",
    );
  }

  function pushRace(wc: WebContents, reg: RaceRegistration): void {
    const o = reg.opts;
    const expr = `window.__dpRegisterRace(${JSON.stringify(reg.id)},${JSON.stringify(reg.urls)},${JSON.stringify(o.mode ?? "race")},${JSON.stringify(o.concurrency ?? 0)},${JSON.stringify(o.perRequestTimeoutMs ?? 0)},${JSON.stringify(o.totalTimeoutMs ?? 0)},${JSON.stringify(reg.variantsSource)},${JSON.stringify(reg.acceptSource ?? "")})`;
    evalIn(wc, expr, "register race");
  }

  function pushAll(wc: WebContents): void {
    for (const reg of deps.streamRegs()) pushStream(wc, reg);
    for (const reg of deps.wsRegs()) pushWs(wc, reg);
    for (const reg of deps.raceRegs()) pushRace(wc, reg);
  }

  async function attach(wc: WebContents): Promise<void> {
    if (setup.has(wc.id)) return;
    setup.set(wc.id, wc);
    try {
      await hub.attach(wc);
      await hub.send(wc, "Page.enable");
      await hub.send(wc, "Runtime.addBinding", { name: "__dpEmit" });
      await hub.send(wc, "Runtime.addBinding", { name: "__dpReady" });
      await hub.send(wc, "Page.addScriptToEvaluateOnNewDocument", { source: INJECTED_SOURCE });
    } catch (e) {
      setup.delete(wc.id);
      deps.log("warn", `main-world: setup failed for wc ${wc.id}:`, String(e));
      return;
    }

    hub.onEvent(wc, (method, params) => {
      if (method !== "Runtime.bindingCalled") return;
      try {
        const name = (params as { name?: string }).name;
        if (name === "__dpReady") {
          pushAll(wc);
        } else if (name === "__dpEmit") {
          const payload = JSON.parse(String((params as { payload?: string }).payload ?? "{}")) as {
            id: string;
            data: unknown;
          };
          deps.onEmit(payload.id, payload.data);
        }
      } catch (e) {
        deps.log("warn", "main-world: binding error:", String(e));
      }
    });

    // Inject into the already-loaded document too (addScript only covers new ones).
    evalIn(wc, INJECTED_SOURCE, "inject wrappers");
    wc.once("destroyed", () => setup.delete(wc.id));
    deps.log("info", `main-world: attached to wc ${wc.id}`);
  }

  function registerStream(reg: TransformRegistration): void {
    for (const wc of setup.values()) if (!wc.isDestroyed()) pushStream(wc, reg);
  }

  function registerWs(reg: WsTransformRegistration): void {
    for (const wc of setup.values()) if (!wc.isDestroyed()) pushWs(wc, reg);
  }

  function registerRace(reg: RaceRegistration): void {
    for (const wc of setup.values()) if (!wc.isDestroyed()) pushRace(wc, reg);
  }

  return { attach, registerStream, registerWs, registerRace };
}
