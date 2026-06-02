/**
 * Stealth helpers for the renderer.
 *
 * When stealth mode is on, the framework minimizes its detectable footprint in
 * the page. The most common detection vector is `fn.toString()` on a patched
 * built-in (e.g. `window.fetch`) returning our JS source instead of
 * `[native code]`. `maskAsNative()` makes a patched function report a
 * native-looking source by installing a single `Function.prototype.toString`
 * shim that consults a registry of masked functions.
 */

type AnyFn = (...args: unknown[]) => unknown;

const nativeFunctionToString = Function.prototype.toString;
const maskedSources = new WeakMap<object, string>();
let toStringPatched = false;

function ensureToStringPatched(): void {
  if (toStringPatched) return;
  toStringPatched = true;

  const patched = function (this: unknown): string {
    if (this && maskedSources.has(this as object)) {
      return maskedSources.get(this as object) as string;
    }
    return nativeFunctionToString.call(this);
  };

  // The shim must also report itself as native.
  maskedSources.set(patched, "function toString() { [native code] }");
  Function.prototype.toString = patched as typeof Function.prototype.toString;
}

/** Make `fn.toString()` report a native-looking source for `name`. */
export function maskAsNative(fn: AnyFn, name: string): void {
  maskedSources.set(fn, `function ${name}() { [native code] }`);
  ensureToStringPatched();
}
