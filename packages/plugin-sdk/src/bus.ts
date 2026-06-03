/**
 * Transport-agnostic message bus (framework internal).
 *
 * One protocol for events (pub/sub) and RPC (request/reply), carried over any
 * transport: Electron IPC in-app, NATS for remote/phone. The main-process router
 * attaches BOTH transports and bridges between them; renderer/phone routers are
 * leaves with a single transport. See docs/architecture-remote-bus.md.
 */

export type Envelope =
  | { kind: "event"; topic: string; data: unknown; src?: string }
  | { kind: "req"; id: string; method: string; params: unknown; src?: string }
  | { kind: "res"; id: string; ok: boolean; result?: unknown; error?: string; src?: string };

export interface BusTransport {
  /** Send an envelope. `target` optionally selects a specific peer. */
  send(env: Envelope, target?: string): void;
  /** Register the router's inbound handler (called once by the router). */
  setReceiver(fn: (env: Envelope, source: string) => void): void;
}

export type RpcHandler = (params: unknown, ctx: BusContext) => unknown | Promise<unknown>;
export type EventHandler = (data: unknown, ctx: BusContext) => void;

export interface BusContext {
  /** Transport the message arrived on ("local" for in-process publishes). */
  source: string;
}

export interface BusRouterOptions {
  /** Default RPC timeout in ms (0 = no timeout). */
  requestTimeoutMs?: number;
  /** Generate envelope ids (override for deterministic tests). */
  genId?: () => string;
  /**
   * Gate inbound messages from a transport (ACL). Return false to drop. Applied
   * to messages whose `source` is a real transport (not "local").
   */
  canReceive?: (env: Envelope, source: string) => boolean;
  /**
   * Hub mode: re-fan inbound events out to all transports (each transport
   * excludes the origin peer via `env.src`). The main process is the hub;
   * renderer/phone routers are leaves (default false) and never re-forward.
   */
  bridge?: boolean;
}

export interface BusRouter {
  addTransport(name: string, transport: BusTransport): void;
  removeTransport(name: string): void;
  /** Register an RPC handler for `method` (last registration wins). */
  handle(method: string, fn: RpcHandler): () => void;
  /** Call an RPC `method`; resolves with the result or rejects on error/timeout. */
  request<T = unknown>(method: string, params?: unknown, target?: string): Promise<T>;
  /** Publish an event to local subscribers and out across transports. */
  publish(topic: string, data?: unknown): void;
  /** Subscribe to an event `topic`. */
  subscribe(topic: string, fn: EventHandler): () => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

let counter = 0;
function defaultGenId(): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function createBusRouter(options: BusRouterOptions = {}): BusRouter {
  const timeout = options.requestTimeoutMs ?? 15000;
  const genId = options.genId ?? defaultGenId;
  const canReceive = options.canReceive;
  const bridge = options.bridge === true;

  const transports = new Map<string, BusTransport>();
  const handlers = new Map<string, RpcHandler>();
  const subs = new Map<string, Set<EventHandler>>();
  const pending = new Map<string, Pending>();

  function sendAll(env: Envelope): void {
    for (const [, t] of transports) {
      try {
        t.send(env);
      } catch {
        /* a dead transport must not break others */
      }
    }
  }

  function deliverEvent(topic: string, data: unknown, source: string): void {
    const set = subs.get(topic);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(data, { source });
      } catch {
        /* handler error */
      }
    }
  }

  async function onRequest(env: Extract<Envelope, { kind: "req" }>, source: string): Promise<void> {
    const handler = handlers.get(env.method);
    let res: Envelope;
    if (!handler) {
      res = { kind: "res", id: env.id, ok: false, error: `no handler for "${env.method}"` };
    } else {
      try {
        const result = await handler(env.params, { source });
        res = { kind: "res", id: env.id, ok: true, result };
      } catch (e) {
        res = { kind: "res", id: env.id, ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    // Reply back on the same transport the request came in on.
    const t = transports.get(source);
    if (t) {
      try {
        t.send(res, env.src);
      } catch {
        /* ignore */
      }
    }
  }

  function onMessage(env: Envelope, source: string): void {
    if (canReceive && source !== "local" && !canReceive(env, source)) return;

    if (env.kind === "event") {
      deliverEvent(env.topic, env.data, source);
      // Hub fans out to peers/other transports; each transport excludes env.src.
      if (bridge) sendAll(env);
      return;
    }
    if (env.kind === "req") {
      // Serve locally; onRequest replies with an error if there is no handler.
      void onRequest(env, source);
      return;
    }
    // res — match a pending request (responses are point-to-point to the caller).
    const p = pending.get(env.id);
    if (p) {
      pending.delete(env.id);
      if (p.timer) clearTimeout(p.timer);
      if (env.ok) p.resolve(env.result);
      else p.reject(new Error(env.error ?? "request failed"));
    }
  }

  return {
    addTransport(name, transport) {
      transports.set(name, transport);
      transport.setReceiver((env, src) => onMessage(env, src || name));
    },

    removeTransport(name) {
      const t = transports.get(name);
      if (t) {
        try {
          t.setReceiver(() => {});
        } catch {
          /* ignore */
        }
        transports.delete(name);
      }
    },

    handle(method, fn) {
      handlers.set(method, fn);
      return () => {
        if (handlers.get(method) === fn) handlers.delete(method);
      };
    },

    request<T>(method: string, params?: unknown, target?: string): Promise<T> {
      const id = genId();
      const env: Envelope = { kind: "req", id, method, params };
      return new Promise<T>((resolve, reject) => {
        const timer = timeout > 0 ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`request "${method}" timed out`));
        }, timeout) : null;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        // A local handler short-circuits — run it directly, resolve the pending
        // (no transport round-trip / reply needed).
        const local = handlers.get(method);
        if (local) {
          Promise.resolve()
            .then(() => local(params, { source: "local" }))
            .then(
              (result) => {
                const p = pending.get(id);
                if (p) {
                  pending.delete(id);
                  if (p.timer) clearTimeout(p.timer);
                  p.resolve(result);
                }
              },
              (e: unknown) => {
                const p = pending.get(id);
                if (p) {
                  pending.delete(id);
                  if (p.timer) clearTimeout(p.timer);
                  p.reject(e instanceof Error ? e : new Error(String(e)));
                }
              },
            );
          return;
        }
        if (target) {
          const t = transports.get(target);
          if (!t) {
            pending.delete(id);
            if (timer) clearTimeout(timer);
            reject(new Error(`no transport "${target}"`));
            return;
          }
          t.send(env);
        } else {
          sendAll(env);
        }
      });
    },

    publish(topic, data) {
      deliverEvent(topic, data, "local");
      sendAll({ kind: "event", topic, data });
    },

    subscribe(topic, fn) {
      let set = subs.get(topic);
      if (!set) {
        set = new Set();
        subs.set(topic, set);
      }
      set.add(fn);
      return () => {
        subs.get(topic)?.delete(fn);
      };
    },
  };
}
