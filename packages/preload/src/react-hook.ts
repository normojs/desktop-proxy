/**
 * React DevTools hook installer.
 *
 * Installs a __REACT_DEVTOOLS_GLOBAL_HOOK__ before the app's React bundle
 * loads, capturing the renderer reference. This allows plugins to walk the
 * React fiber tree via api.react.getFiber() and findOwnerByName().
 */

interface ReactRenderer {
  rendererPackageName?: string;
  version?: string;
  findFiberByHostInstance?: (node: Node) => unknown;
  findHostInstanceByFiber?: (fiber: unknown) => Node | null;
}

interface ReactHook {
  supportsFiber: boolean;
  renderers: Map<number, ReactRenderer>;
  inject(renderer: ReactRenderer): number;
  on(event: string, fn: (...args: unknown[]) => void): void;
  off(event: string, fn: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  onCommitFiberRoot(): void;
  onCommitFiberUnmount(): void;
  onScheduleFiberRoot(): void;
  checkDCE(): void;
}

// Extend Window interface
declare global {
  interface Window {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactHook;
    __desktop_proxy__?: {
      hook: ReactHook;
      renderers: Map<number, ReactRenderer>;
    };
  }
}

// Renderers are tracked in module scope so fiber lookups work even in stealth
// mode (where we avoid exposing window.__desktop_proxy__).
let installedRenderers: Map<number, ReactRenderer> | null = null;

export function installReactHook(stealth = false): void {
  // Don't overwrite if already installed (e.g. by real React DevTools)
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    installedRenderers = window.__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers ?? installedRenderers;
    return;
  }

  const renderers = new Map<number, ReactRenderer>();
  installedRenderers = renderers;
  let nextId = 1;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  const hook: ReactHook = {
    supportsFiber: true,
    renderers,

    inject(renderer: ReactRenderer): number {
      const id = nextId++;
      renderers.set(id, renderer);
      return id;
    },

    on(event: string, fn: (...args: unknown[]) => void): void {
      let s = listeners.get(event);
      if (!s) listeners.set(event, (s = new Set()));
      s.add(fn);
    },

    off(event: string, fn: (...args: unknown[]) => void): void {
      listeners.get(event)?.delete(fn);
    },

    emit(event: string, ...args: unknown[]): void {
      listeners.get(event)?.forEach((fn) => fn(...args));
    },

    onCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  };

  Object.defineProperty(window, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: hook,
  });

  // The DevTools hook itself is indistinguishable from real React DevTools, so
  // it stays. Our own marker global is only exposed outside stealth mode.
  if (!stealth) {
    window.__desktop_proxy__ = { hook, renderers };
  }
}

/**
 * Resolve the React fiber for a DOM node, if any renderer has one.
 */
export function fiberForNode(node: Node): unknown {
  const renderers = installedRenderers ?? window.__desktop_proxy__?.renderers;
  if (renderers) {
    for (const r of renderers.values()) {
      const fiber = r.findFiberByHostInstance?.(node);
      if (fiber) return fiber;
    }
  }

  // Fallback: read the React internal property directly from the DOM node.
  for (const key of Object.keys(node)) {
    if (key.startsWith("__reactFiber")) return (node as unknown as Record<string, unknown>)[key];
  }

  return null;
}
