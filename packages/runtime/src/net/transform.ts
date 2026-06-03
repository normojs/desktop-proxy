/**
 * In-flight request transforms for the relay (the "control" half).
 *
 * Before forwarding, the relay can reshape the model request: inject/override the
 * system prompt, append rules, and override sampling params. This is protocol-aware
 * so it works whether the client speaks the Responses API (`instructions`) or Chat
 * Completions (`messages` with a system role). Applied to the *original* body
 * before any Responses↔chat translation, so it carries through either path.
 *
 * Pure functions only (unit tested); the relay wires them into the request path.
 */

export interface RelayTransforms {
  /** Inject or override the system prompt. mode defaults to "append". */
  systemPrompt?: { mode?: "prepend" | "append" | "replace"; text: string };
  /** Extra rules appended to the system prompt (rendered as a bullet list). */
  rules?: string[];
  /** Override top-level body params on the forwarded request (e.g. temperature). */
  params?: Record<string, unknown>;
}

export function transformsActive(t?: RelayTransforms): boolean {
  return !!t && !!(t.systemPrompt?.text || (t.rules && t.rules.length > 0) || (t.params && Object.keys(t.params).length > 0));
}

function combinedSystemText(t: RelayTransforms): string {
  const parts: string[] = [];
  if (t.systemPrompt?.text) parts.push(t.systemPrompt.text);
  if (t.rules && t.rules.length > 0) parts.push(t.rules.map((r) => `- ${r}`).join("\n"));
  return parts.join("\n\n");
}

function merge(existing: string, text: string, mode: "prepend" | "append" | "replace"): string {
  if (mode === "replace" || !existing) return text;
  return mode === "prepend" ? `${text}\n\n${existing}` : `${existing}\n\n${text}`;
}

/**
 * Inject system-prompt/rules into a request body (Chat `messages` or Responses
 * `instructions`). Returns a shallow copy; the original is untouched.
 */
export function applySystemTransforms(
  body: Record<string, unknown>,
  t?: RelayTransforms,
): Record<string, unknown> {
  if (!t || (!t.systemPrompt?.text && !(t.rules && t.rules.length > 0))) return body;
  const text = combinedSystemText(t);
  if (!text) return body;
  const mode = t.systemPrompt?.mode ?? "append";
  const out = { ...body };

  // Chat Completions: a system-role message.
  if (Array.isArray(out.messages)) {
    const messages = (out.messages as Array<Record<string, unknown>>).map((m) => ({ ...m }));
    const idx = messages.findIndex((m) => m.role === "system");
    if (idx >= 0) {
      const existing = typeof messages[idx].content === "string" ? (messages[idx].content as string) : "";
      messages[idx].content = merge(existing, text, mode);
    } else {
      messages.unshift({ role: "system", content: text });
    }
    out.messages = messages;
    return out;
  }

  // Responses API: the `instructions` string.
  if (typeof out.instructions === "string" || "input" in out) {
    const existing = typeof out.instructions === "string" ? out.instructions : "";
    out.instructions = merge(existing, text, mode);
    return out;
  }
  return out;
}

/** Override top-level params (temperature, top_p, …) on the forwarded body. */
export function applyParams(body: Record<string, unknown>, t?: RelayTransforms): Record<string, unknown> {
  if (!t?.params || Object.keys(t.params).length === 0) return body;
  return { ...body, ...t.params };
}
