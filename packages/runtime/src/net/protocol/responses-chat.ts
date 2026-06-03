/**
 * Protocol adapter: OpenAI **Responses API** ↔ **Chat Completions**.
 *
 * Why: modern Codex only speaks the Responses API (`/v1/responses`), but most
 * OpenAI-compatible backends (DeepSeek, many relays, local servers) only speak
 * Chat Completions (`/v1/chat/completions`). This module translates a Responses
 * request into a Chat request, and streams the Chat SSE response back as the
 * Responses event stream Codex expects.
 *
 * Phase 1 covers the common agent path: system/user/assistant messages, function
 * tool-calls, and usage. Reasoning summaries, apply_patch and custom-tool
 * encodings (handled by CodexPlusPlus's much larger protocol_proxy) are TODO and
 * can be layered on without changing this module's shape.
 *
 * The event schema mirrors CodexPlusPlus's `protocol_proxy.rs` so Codex's strict
 * Responses parser accepts it. Pure + stateful-streaming; unit-tested.
 */

type Json = Record<string, unknown>;

// ── Request: Responses → Chat Completions ────────────────────────────────────

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const p = part as Json;
        if (typeof p?.text === "string") return p.text;
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object" && typeof (content as Json).text === "string") {
    return (content as Json).text as string;
  }
  return "";
}

function roleFor(role: unknown): string {
  const r = String(role ?? "user");
  if (r === "developer" || r === "system") return "system";
  return r;
}

/** Convert a Responses `input` (array of items, or a string) into chat messages. */
function inputToMessages(input: unknown, messages: Json[]): void {
  if (typeof input === "string") {
    if (input) messages.push({ role: "user", content: input });
    return;
  }
  if (!Array.isArray(input)) return;
  for (const raw of input) {
    const item = raw as Json;
    const type = item?.type as string | undefined;
    if (type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: String(item.call_id ?? item.id ?? ""),
            type: "function",
            function: { name: String(item.name ?? ""), arguments: String(item.arguments ?? "") },
          },
        ],
      });
    } else if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id ?? item.id ?? ""),
        content: textOf(item.output),
      });
    } else if (type === "message" || item.role) {
      messages.push({ role: roleFor(item.role), content: textOf(item.content) });
    }
  }
}

/** Convert Responses tools (`{type:"function", name, ...}`) to chat tools. */
function toolsToChat(tools: unknown): Json[] {
  if (!Array.isArray(tools)) return [];
  const out: Json[] = [];
  for (const raw of tools) {
    const t = raw as Json;
    if (t?.type === "function" && typeof t.name === "string") {
      out.push({
        type: "function",
        function: {
          name: t.name,
          ...(typeof t.description === "string" ? { description: t.description } : {}),
          parameters: t.parameters ?? { type: "object", properties: {} },
        },
      });
    }
  }
  return out;
}

/** Translate a Responses request body into a Chat Completions request body. */
export function responsesToChat(body: Json): Json {
  const out: Json = {};
  if (body.model !== undefined) out.model = body.model;

  const messages: Json[] = [];
  const instructions = textOf(body.instructions);
  if (instructions) messages.push({ role: "system", content: instructions });
  inputToMessages(body.input, messages);
  out.messages = messages;

  if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  for (const k of ["temperature", "top_p", "stream"] as const) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  if (body.stream === true) {
    out.stream_options = { ...((body.stream_options as Json) ?? {}), include_usage: true };
  }

  const tools = toolsToChat(body.tools);
  if (tools.length > 0) {
    out.tools = tools;
    if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
    if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  }
  return out;
}

// ── Response stream: Chat SSE → Responses SSE ────────────────────────────────

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Map a chat `usage` object to the Responses `usage` shape. */
export function chatUsageToResponses(usage: Json | undefined): Json {
  const u = usage ?? {};
  const input = num(u.prompt_tokens) || num(u.input_tokens);
  const output = num(u.completion_tokens) || num(u.output_tokens);
  const cached = num((u.prompt_tokens_details as Json | undefined)?.cached_tokens);
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: num(u.total_tokens) || input + output,
  };
}

function sse(event: string, data: Json): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responseId(chatId: string | undefined): string {
  const id = chatId || "compat";
  return id.startsWith("resp_") ? id : `resp_${id}`;
}

interface ToolState {
  added: boolean;
  outputIndex: number;
  itemId: string;
  callId: string;
  name: string;
  args: string;
}

/**
 * Streaming converter: feed raw Chat Completions SSE text via `push()`, get back
 * Responses SSE text; call `finish()` at the end. Buffers partial lines.
 */
export class ResponsesStreamConverter {
  private buf = "";
  private started = false;
  private completed = false;
  private respId = "resp_compat";
  private model = "";
  private createdAt = Math.floor(Date.now() / 1000);
  private nextIndex = 0;
  private usage: Json | null = null;
  private finishReason: string | null = null;
  // reasoning item (for reasoner models that stream `reasoning_content`)
  private reasoningAdded = false;
  private reasoningDone = false;
  private reasoningIndex = 0;
  private reasoningItemId = "";
  private reasoning = "";
  // assistant text item
  private textAdded = false;
  private textDone = false;
  private textIndex = 0;
  private textItemId = "";
  private text = "";
  private tools = new Map<number, ToolState>();
  private outputItems: Array<[number, Json]> = [];

  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    let idx: number;
    // Process complete SSE records (separated by a blank line).
    while ((idx = this.indexOfDelim()) >= 0) {
      const record = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + (this.buf.startsWith("\r\n\r\n", idx) ? 4 : 2));
      out += this.handleRecord(record);
    }
    return out;
  }

  finish(): string {
    let out = "";
    if (this.buf.trim()) {
      out += this.handleRecord(this.buf);
      this.buf = "";
    }
    out += this.finalize();
    return out;
  }

  private indexOfDelim(): number {
    const lf = this.buf.indexOf("\n\n");
    const crlf = this.buf.indexOf("\r\n\r\n");
    if (lf < 0) return crlf;
    if (crlf < 0) return lf;
    return Math.min(lf, crlf);
  }

  private handleRecord(record: string): string {
    // Extract the data: payload from an SSE record (ignore event:/id: lines).
    const dataLines = record
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return "";
    const payload = dataLines.join("");
    if (!payload || payload === "[DONE]") return "";
    let chunk: Json;
    try {
      chunk = JSON.parse(payload) as Json;
    } catch {
      return "";
    }
    return this.handleChunk(chunk);
  }

  private base(status: string, output: Json[]): Json {
    return {
      id: this.respId,
      object: "response",
      created_at: this.createdAt,
      status,
      model: this.model,
      output,
      usage: this.usage ?? chatUsageToResponses(undefined),
    };
  }

  private ensureStarted(): string {
    if (this.started) return "";
    this.started = true;
    return (
      sse("response.created", { type: "response.created", response: this.base("in_progress", []) }) +
      sse("response.in_progress", { type: "response.in_progress", response: this.base("in_progress", []) })
    );
  }

  private handleChunk(chunk: Json): string {
    let out = "";
    if (typeof chunk.id === "string") this.respId = responseId(chunk.id);
    if (typeof chunk.model === "string" && chunk.model) this.model = chunk.model;
    if (typeof chunk.created === "number") this.createdAt = chunk.created;
    out += this.ensureStarted();

    if (chunk.usage && typeof chunk.usage === "object") {
      this.usage = chatUsageToResponses(chunk.usage as Json);
    }

    const choice = (chunk.choices as Json[] | undefined)?.[0];
    if (choice) {
      const delta = choice.delta as Json | undefined;
      if (delta) {
        // Reasoner models (e.g. deepseek-reasoner) stream reasoning separately.
        const rc = typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string"
            ? delta.reasoning
            : "";
        if (rc) out += this.pushReasoning(rc);
        const content = delta.content;
        if (typeof content === "string" && content) out += this.pushText(content);
        const toolCalls = delta.tool_calls as Json[] | undefined;
        if (Array.isArray(toolCalls)) {
          out += this.finalizeReasoning();
          for (const tc of toolCalls) out += this.pushToolCall(tc);
        }
      }
      if (typeof choice.finish_reason === "string") this.finishReason = choice.finish_reason;
    }
    return out;
  }

  private pushReasoning(delta: string): string {
    let out = "";
    if (!this.reasoningAdded) {
      this.reasoningAdded = true;
      this.reasoningIndex = this.nextIndex++;
      this.reasoningItemId = `rs_${this.respId}`;
      out += sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: this.reasoningIndex,
        item: { id: this.reasoningItemId, type: "reasoning", status: "in_progress", reasoning_content: "", summary: [] },
      });
      out += sse("response.reasoning_summary_part.added", {
        type: "response.reasoning_summary_part.added",
        item_id: this.reasoningItemId,
        output_index: this.reasoningIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
    }
    this.reasoning += delta;
    out += sse("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: this.reasoningItemId,
      output_index: this.reasoningIndex,
      summary_index: 0,
      delta,
    });
    return out;
  }

  private finalizeReasoning(): string {
    if (!this.reasoningAdded || this.reasoningDone) return "";
    this.reasoningDone = true;
    const item: Json = {
      id: this.reasoningItemId,
      type: "reasoning",
      reasoning_content: this.reasoning,
      summary: [{ type: "summary_text", text: this.reasoning }],
    };
    this.outputItems.push([this.reasoningIndex, item]);
    return (
      sse("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        item_id: this.reasoningItemId,
        output_index: this.reasoningIndex,
        summary_index: 0,
        text: this.reasoning,
      }) +
      sse("response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        item_id: this.reasoningItemId,
        output_index: this.reasoningIndex,
        summary_index: 0,
        part: { type: "summary_text", text: this.reasoning },
      }) +
      sse("response.output_item.done", { type: "response.output_item.done", output_index: this.reasoningIndex, item })
    );
  }

  private pushText(delta: string): string {
    let out = this.finalizeReasoning(); // reasoning precedes the answer
    if (!this.textAdded) {
      this.textAdded = true;
      this.textIndex = this.nextIndex++;
      this.textItemId = `${this.respId}_msg`;
      out += sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: this.textIndex,
        item: { id: this.textItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      out += sse("response.content_part.added", {
        type: "response.content_part.added",
        item_id: this.textItemId,
        output_index: this.textIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    this.text += delta;
    out += sse("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: this.textItemId,
      output_index: this.textIndex,
      content_index: 0,
      delta,
    });
    return out;
  }

  private pushToolCall(tc: Json): string {
    let out = "";
    const chatIndex = num(tc.index);
    let state = this.tools.get(chatIndex);
    if (!state) {
      state = { added: false, outputIndex: 0, itemId: "", callId: "", name: "", args: "" };
      this.tools.set(chatIndex, state);
    }
    if (typeof tc.id === "string") state.callId = tc.id;
    const fn = tc.function as Json | undefined;
    if (typeof fn?.name === "string") state.name = fn.name;
    const argsDelta = typeof fn?.arguments === "string" ? fn.arguments : "";

    if (!state.added && (state.callId || state.name)) {
      state.added = true;
      state.outputIndex = this.nextIndex++;
      if (!state.callId) state.callId = `call_${chatIndex}`;
      if (!state.name) state.name = "unknown_tool";
      state.itemId = `fc_${state.callId}`;
      out += sse("response.output_item.added", {
        type: "response.output_item.added",
        output_index: state.outputIndex,
        item: { id: state.itemId, type: "function_call", status: "in_progress", name: state.name, call_id: state.callId, arguments: "" },
      });
    }
    if (argsDelta && state.added) {
      state.args += argsDelta;
      out += sse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta: argsDelta,
      });
    }
    return out;
  }

  private finalize(): string {
    if (this.completed) return "";
    let out = this.ensureStarted();
    out += this.finalizeReasoning();

    if (this.textAdded && !this.textDone) {
      this.textDone = true;
      const item: Json = {
        id: this.textItemId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: this.text, annotations: [] }],
      };
      this.outputItems.push([this.textIndex, item]);
      out += sse("response.output_text.done", {
        type: "response.output_text.done",
        item_id: this.textItemId,
        output_index: this.textIndex,
        content_index: 0,
        text: this.text,
      });
      out += sse("response.content_part.done", {
        type: "response.content_part.done",
        item_id: this.textItemId,
        output_index: this.textIndex,
        content_index: 0,
        part: { type: "output_text", text: this.text, annotations: [] },
      });
      out += sse("response.output_item.done", { type: "response.output_item.done", output_index: this.textIndex, item });
    }

    for (const [, state] of this.tools) {
      if (!state.added) continue;
      const item: Json = {
        id: state.itemId,
        type: "function_call",
        status: "completed",
        name: state.name,
        call_id: state.callId,
        arguments: state.args,
      };
      this.outputItems.push([state.outputIndex, item]);
      out += sse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: state.itemId,
        output_index: state.outputIndex,
        arguments: state.args,
      });
      out += sse("response.output_item.done", { type: "response.output_item.done", output_index: state.outputIndex, item });
    }

    const status = this.finishReason === "length" ? "incomplete" : "completed";
    const output = this.outputItems.sort((a, b) => a[0] - b[0]).map(([, item]) => item);
    const response = this.base(status, output);
    if (status === "incomplete") response.incomplete_details = { reason: "max_output_tokens" };
    out += sse("response.completed", { type: "response.completed", response });
    out += "data: [DONE]\n\n";
    this.completed = true;
    return out;
  }
}
