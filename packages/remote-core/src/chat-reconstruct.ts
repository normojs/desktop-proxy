/**
 * Reconstruct the IDE's conversation from captured relay traffic (pure).
 *
 * Each model request carries the full message history, so the fullest request in a
 * conversation reconstructs the whole thread. We group requests into sessions by a
 * stable key (system + first user text), then expose turns (user/assistant/tool +
 * tool calls) plus aggregate cost/tokens. IDE-agnostic; Codex-first.
 */

export interface TrafficLike {
  startedDateTime?: string;
  model?: string;
  /** JSON request body: chat `{messages}` or Responses `{instructions,input}`. */
  reqBody?: string | null;
  usage?: { totalTokens?: number; costUsd?: number } | null;
  status?: number;
}

export interface ToolCall {
  name: string;
  args?: string;
}

export interface Turn {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  toolCalls?: ToolCall[];
}

export interface Session {
  key: string;
  title: string;
  model?: string;
  turns: Turn[];
  lastActivity?: string;
  turnCount: number;
  totalTokens: number;
  totalCostUsd: number;
  requestCount: number;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((seg) => {
        const r = seg as Record<string, unknown>;
        return typeof r?.text === "string" ? r.text : "";
      })
      .join("");
  }
  return "";
}

function toolCallsOf(m: Record<string, unknown>): ToolCall[] | undefined {
  const tcs = m.tool_calls;
  if (Array.isArray(tcs) && tcs.length > 0) {
    return tcs.map((t) => {
      const fn = (t as Record<string, unknown>).function as Record<string, unknown> | undefined;
      return { name: String(fn?.name ?? (t as Record<string, unknown>).name ?? "tool"), args: fn?.arguments as string | undefined };
    });
  }
  return undefined;
}

/** Parse a request body's message history into turns. */
export function parseTurns(reqBody: string | null | undefined): Turn[] {
  if (!reqBody) return [];
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(reqBody) as Record<string, unknown>;
  } catch {
    return [];
  }
  const turns: Turn[] = [];

  if (Array.isArray(body.messages)) {
    for (const raw of body.messages) {
      const m = raw as Record<string, unknown>;
      const role = (m.role as Turn["role"]) ?? "user";
      turns.push({ role, text: textOf(m.content), toolCalls: toolCallsOf(m) });
    }
    return turns;
  }

  if (typeof body.instructions === "string" && body.instructions) {
    turns.push({ role: "system", text: body.instructions });
  }
  if (Array.isArray(body.input)) {
    for (const raw of body.input) {
      const it = raw as Record<string, unknown>;
      const type = it.type as string | undefined;
      if (type === "function_call") {
        turns.push({ role: "assistant", text: "", toolCalls: [{ name: String(it.name ?? "tool"), args: it.arguments as string | undefined }] });
      } else if (type === "function_call_output") {
        turns.push({ role: "tool", text: textOf(it.output) });
      } else if (type === "reasoning") {
        // skip in the turn list (reasoning is shown separately)
      } else {
        const role = (it.role as Turn["role"]) ?? "user";
        turns.push({ role, text: textOf(it.content) });
      }
    }
  }
  return turns;
}

function firstText(turns: Turn[], role: Turn["role"]): string {
  for (const t of turns) if (t.role === role && t.text) return t.text;
  return "";
}

/** Small stable string hash (djb2) for grouping. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function sessionKey(turns: Turn[]): string {
  const sys = firstText(turns, "system").slice(0, 200);
  const user = firstText(turns, "user").slice(0, 200);
  return hash(`${sys}\u0000${user}`);
}

/** Group traffic into sessions, newest first; each session uses its fullest request. */
export function reconstructSessions(entries: TrafficLike[]): Session[] {
  const byKey = new Map<string, Session & { _maxTurns: number }>();

  for (const e of entries) {
    const turns = parseTurns(e.reqBody);
    if (turns.length === 0) continue;
    const key = sessionKey(turns);
    const tokens = e.usage?.totalTokens ?? 0;
    const cost = e.usage?.costUsd ?? 0;

    let s = byKey.get(key);
    if (!s) {
      s = {
        key,
        title: firstText(turns, "user").slice(0, 120) || "(untitled)",
        model: e.model,
        turns,
        lastActivity: e.startedDateTime,
        turnCount: turns.length,
        totalTokens: 0,
        totalCostUsd: 0,
        requestCount: 0,
        _maxTurns: turns.length,
      };
      byKey.set(key, s);
    }
    s.totalTokens += tokens;
    s.totalCostUsd += cost;
    s.requestCount += 1;
    if (e.model) s.model = e.model;
    if (e.startedDateTime && (!s.lastActivity || e.startedDateTime > s.lastActivity)) s.lastActivity = e.startedDateTime;
    if (turns.length >= s._maxTurns) {
      s._maxTurns = turns.length;
      s.turns = turns;
      s.turnCount = turns.length;
    }
  }

  return [...byKey.values()]
    .map(({ _maxTurns, ...s }) => s)
    .sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
}
