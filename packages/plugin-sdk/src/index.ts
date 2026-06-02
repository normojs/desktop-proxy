/**
 * desktop-proxy Plugin SDK
 *
 * TypeScript type definitions for the Plugin API available to plugins
 * running in the desktop-proxy injection framework.
 */

// ── Plugin Manifest ──────────────────────────────────────────────────────────

export interface PluginManifest {
  /** Unique reverse-domain identifier (e.g. "com.example.my-plugin") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Semantic version */
  version: string;
  /** Short description */
  description: string;
  /** Plugin author */
  author?: string;
  /** Entry point file relative to plugin root */
  main: string;
  /** Execution scope */
  scope: "main" | "renderer" | "both";
  /** Icon URL (data: or https:) */
  iconUrl?: string;
  /** GitHub repository (owner/repo) for update checks */
  githubRepo?: string;
  /** Minimum desktop-proxy version required */
  minDesktopProxyVersion?: string;
  /** Capabilities the plugin requests (e.g. "cdp"). Gates powerful APIs. */
  permissions?: string[];
}

// ── Plugin API (available to plugins at runtime) ─────────────────────────────

export interface PluginLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface PluginStorage {
  get<T = unknown>(key: string, defaultValue?: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
}

export interface SettingsSection {
  id: string;
  title: string;
  render(root: HTMLElement): void | (() => void);
}

export interface SettingsPage {
  id: string;
  title: string;
  iconSvg?: string;
  description?: string;
  render(root: HTMLElement): void | (() => void);
}

export type UnregisterHandle = { unregister(): void };

export interface PluginSettings {
  registerSection(section: SettingsSection): UnregisterHandle;
  registerPage(page: SettingsPage): UnregisterHandle;
}

export interface ReactAPI {
  /** Get the React fiber node for a DOM node */
  getFiber(node: Node): unknown;
  /** Walk up the fiber tree to find an owner by component name */
  findOwnerByName(node: Node, name: string): unknown;
  /** Wait for a DOM element to appear (MutationObserver-based) */
  waitForElement(selector: string, timeoutMs?: number): Promise<Element>;
}

export type UnsubscribeFn = () => void;

export interface PluginIPC {
  on(channel: string, handler: (...args: unknown[]) => void): UnsubscribeFn;
  send(channel: string, ...args: unknown[]): void;
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
}

// ── Network Interception (primary use case) ──────────────────────────────────

export interface NetworkRequest {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  timestamp: number;
  /** Type discriminator */
  _type: "fetch" | "xhr";
}

export interface NetworkResponse {
  id: string;
  requestId: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  timestamp: number;
}

export type NetworkRequestHandler = (request: NetworkRequest) => NetworkRequest | void | Promise<NetworkRequest | void>;
export type NetworkResponseHandler = (response: NetworkResponse) => NetworkResponse | void | Promise<NetworkResponse | void>;

export interface PluginNetwork {
  onRequest(handler: NetworkRequestHandler): UnsubscribeFn;
  onResponse(handler: NetworkResponseHandler): UnsubscribeFn;
}

// ── Sandboxed Filesystem ─────────────────────────────────────────────────────

export type FileEncoding = "utf8" | "base64";

export interface PluginFileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  mtimeMs: number;
}

/**
 * Sandboxed filesystem access. All paths are relative to (and confined within)
 * the plugin's private data directory; paths that escape it are rejected. Use
 * "base64" encoding for binary data.
 */
export interface PluginFS {
  read(path: string, encoding?: FileEncoding): Promise<string>;
  write(path: string, data: string, encoding?: FileEncoding): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path?: string): Promise<string[]>;
  delete(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<PluginFileStat>;
}

// ── Chrome DevTools Protocol (CDP) ───────────────────────────────────────────

export interface CDPEvaluateOptions {
  /** Await a returned promise before resolving (default true). */
  awaitPromise?: boolean;
  /** Return the value by value rather than a remote object handle (default true). */
  returnByValue?: boolean;
}

/**
 * Low-level Chrome DevTools Protocol access for the plugin's own renderer.
 * Requires the "cdp" permission in the plugin manifest. Backed by Electron's
 * in-process `webContents.debugger` (no remote debugging port).
 *
 * Remember to enable the relevant CDP domain (e.g. `send("Network.enable")`)
 * before its events will be delivered to `on(...)`.
 */
export interface PluginCDP {
  attach(): Promise<void>;
  detach(): Promise<void>;
  isAttached(): Promise<boolean>;
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: string, handler: (params: unknown) => void): UnsubscribeFn;
  /** Convenience wrapper around `Runtime.evaluate` (runs in the page's main world). */
  evaluate<T = unknown>(expression: string, options?: CDPEvaluateOptions): Promise<T>;
}

// ── App Info ─────────────────────────────────────────────────────────────────

export interface AppInfo {
  name: string;
  version: string;
  electronVersion: string;
  platform: string;
  runtimeDir: string;
  userRoot: string;
}

export interface WindowInfo {
  id: number;
  title: string;
  url: string;
  focused: boolean;
}

export interface PluginApp {
  getInfo(): Promise<AppInfo>;
  getWindows(): Promise<WindowInfo[]>;
}

// ── Full Plugin API ──────────────────────────────────────────────────────────

export interface PluginAPI {
  manifest: PluginManifest;
  process: "main" | "renderer";

  log: PluginLogger;
  storage: PluginStorage;
  settings: PluginSettings;
  react: ReactAPI;
  ipc: PluginIPC;
  network: PluginNetwork;
  fs: PluginFS;
  cdp: PluginCDP;
  app: PluginApp;
}

// ── Plugin Module Shape ──────────────────────────────────────────────────────

export interface PluginModule {
  start(api: PluginAPI): void | Promise<void>;
  stop?(): void | Promise<void>;
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateManifest(m: unknown): { valid: true; manifest: PluginManifest } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (!m || typeof m !== "object") return { valid: false, errors: ["manifest must be an object"] };

  const manifest = m as Record<string, unknown>;

  if (typeof manifest.id !== "string" || !manifest.id) errors.push("id must be a non-empty string");
  if (typeof manifest.name !== "string" || !manifest.name) errors.push("name must be a non-empty string");
  if (typeof manifest.version !== "string" || !manifest.version) errors.push("version must be a non-empty string");
  if (typeof manifest.main !== "string" || !manifest.main) errors.push("main must be a non-empty string");
  if (!["main", "renderer", "both"].includes(manifest.scope as string)) errors.push('scope must be "main", "renderer", or "both"');
  if (manifest.permissions !== undefined && (!Array.isArray(manifest.permissions) || manifest.permissions.some((p) => typeof p !== "string"))) {
    errors.push("permissions must be an array of strings");
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, manifest: m as PluginManifest };
}
