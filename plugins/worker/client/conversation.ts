/**
 * Incremental JSONL reader that turns one run's raw `events.log` pages into readable
 * conversation rows for the plugin UI. It is deliberately client-side: the server keeps only
 * the raw log pages it already serves, with no conversation aggregation, cache, or mapping.
 *
 * Input arrives as the server's 64 KiB pages. A page is UTF-8 safe but may end in the middle of
 * a line, so the trailing partial line is kept and only complete lines are parsed; `flush`
 * parses the last line when the run reached terminal EOF. Each line is parsed once and unknown
 * shapes are ignored, leaving them only in the raw event view.
 *
 * Shapes are the ones the engines really emit:
 * - Pi JSON mode (`JsonAgentSessionEvent`): `message_start`/`message_end` carry the message,
 *   `message_update` carries only `assistantMessageEvent` with `contentIndex` and
 *   `text_*`/`thinking_*`/`toolcall_*` deltas, and tool execution reports `start`/`update`/`end`.
 * - Codex `codex exec --json` items: agent_message, reasoning, command_execution, file_change,
 *   mcp_tool_call, web_search, todo_list, error.
 * - DSH headless: `text`/`thinking` chunks, `status` phases, `tool_call`/`tool_result`, `final`
 *   emitted after `turn_end` with the same text the stream already produced.
 */

import type {
  WorkerConversationMessage,
  WorkerType,
} from "../shared/contracts.js";

/** Streaming reader fed with consecutive log pages of one run. */
export type ConversationStream = {
  push(chunk: string): void;
  /** Parses the trailing partial line; only valid once the run reached terminal EOF. */
  flush(): void;
  messages(): WorkerConversationMessage[];
};

type RowPatch = Omit<WorkerConversationMessage, "id">;

type Handler = (event: Record<string, unknown>) => void;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Structured payloads are already parsed JSON, so this cannot meet a cycle. */
function flat(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value, null, 2);
}

/** Concatenates the text blocks of a provider content array. */
function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const entry of value) {
    const block = object(entry);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string")
      parts.push(block.text);
    else if (block.type === "content" && typeof block.content === "string")
      parts.push(block.content);
  }
  return parts.length ? parts.join("\n") : undefined;
}

/**
 * Readable tool output. Both Pi and Codex wrap results as `{ content: [...] }`; the text
 * blocks are extracted first so a result is never shown as one JSON blob.
 */
function toolContent(value: unknown): string | undefined {
  const record = object(value);
  return (
    (record ? contentText(record.content) : undefined) ??
    (record ? contentText(record.structured_content) : undefined) ??
    flat(value)
  );
}

/** Stable, upsert-able row store: one provider id may be updated multiple times. */
class Rows {
  private list: WorkerConversationMessage[] = [];
  private offset = new Map<string, number>();

  upsert(id: string, patch: RowPatch): void {
    const at = this.offset.get(id);
    if (at === undefined) {
      this.offset.set(id, this.list.length);
      this.list.push({ id, ...patch });
      return;
    }
    this.list[at] = { ...this.list[at]!, ...patch };
  }

  text(id: string): string {
    const at = this.offset.get(id);
    return at === undefined ? "" : this.list[at]!.text;
  }

  messages(): WorkerConversationMessage[] {
    return this.list.slice();
  }
}

/** Pi JSON mode: streaming deltas, authoritative message_end, tool execution lifecycle. */
function piHandler(rows: Rows): Handler {
  let current: string | null = null;
  let created = 0;
  let errors = 0;
  return (event) => {
    const kind = event.type;
    if (kind === "error") {
      rows.upsert("pi-error-" + errors++, {
        role: "error",
        text: string(event.message) ?? "Pi 报告错误",
      });
      return;
    }
    if (kind === "message_start" || kind === "message_end") {
      const message = object(event.message);
      if (!message) return;
      const base =
        string(message.id) ??
        current ??
        (current = "pi-msg-" + created++);
      if (kind === "message_start") current = base;
      else current = null;
      applyPiMessage(rows, message, base, kind === "message_end");
      return;
    }
    // JSON mode drops the cumulative message snapshot; deltas build the same row.
    if (kind === "message_update") {
      const update = object(event.assistantMessageEvent);
      if (!update) return;
      applyPiUpdate(
        rows,
        update,
        current ?? (current = "pi-msg-" + created++),
      );
      return;
    }
    if (
      kind === "tool_execution_start" ||
      kind === "tool_execution_update" ||
      kind === "tool_execution_end"
    ) {
      const toolId = string(event.toolCallId);
      if (!toolId) return;
      const done = kind === "tool_execution_end";
      const patch: RowPatch = { role: "tool", text: "", toolId, streaming: !done };
      const name = string(event.toolName);
      if (name) patch.toolName = name;
      const input = object(event.args);
      if (input) patch.toolInput = input;
      if (kind === "tool_execution_update") {
        const partial = toolContent(event.partialResult);
        if (partial !== undefined) patch.toolOutput = partial;
      } else if (done) {
        const output = toolContent(event.result);
        if (output !== undefined) patch.toolOutput = output;
        if (event.isError === true) patch.isError = true;
      }
      rows.upsert("pi-tool-" + toolId, patch);
    }
    // turn_end / agent_end replay the same messages (agent_end re-sends the whole turn), so
    // they are not parsed: the same rows already came from message_end.
  };
}

function applyPiUpdate(
  rows: Rows,
  update: Record<string, unknown>,
  base: string,
): void {
  const type = update.type;
  const index = typeof update.contentIndex === "number" ? update.contentIndex : 0;
  const id = base + ":" + index;
  if (type === "text_start") {
    rows.upsert(id, { role: "assistant", text: "", streaming: true });
    return;
  }
  if (type === "text_delta") {
    rows.upsert(id, {
      role: "assistant",
      text: rows.text(id) + (string(update.delta) ?? ""),
      streaming: true,
    });
    return;
  }
  if (type === "text_end") {
    rows.upsert(id, {
      role: "assistant",
      text: typeof update.content === "string" ? update.content : rows.text(id),
      streaming: false,
    });
    return;
  }
  if (type === "thinking_start") {
    rows.upsert(id, { role: "assistant", text: "", thinking: true, streaming: true });
    return;
  }
  if (type === "thinking_delta") {
    rows.upsert(id, {
      role: "assistant",
      text: rows.text(id) + (string(update.delta) ?? ""),
      thinking: true,
      streaming: true,
    });
    return;
  }
  if (type === "thinking_end") {
    rows.upsert(id, {
      role: "assistant",
      text:
        typeof update.content === "string" ? update.content : rows.text(id),
      thinking: true,
      streaming: false,
    });
    return;
  }
  if (type === "toolcall_start" || type === "toolcall_end") {
    const call = type === "toolcall_end" ? object(update.toolCall) : null;
    const toolId =
      (call ? string(call.id) : undefined) ?? string(update.id) ?? id;
    const patch: RowPatch = {
      role: "tool",
      text: "",
      toolId,
      streaming: type === "toolcall_start",
    };
    const name =
      (call ? string(call.name) : undefined) ?? string(update.toolName);
    if (name) patch.toolName = name;
    const input = call ? object(call.arguments) : null;
    if (input) patch.toolInput = input;
    rows.upsert("pi-tool-" + toolId, patch);
  }
  // toolcall_delta carries JSON argument fragments; toolcall_end and tool_execution_start
  // provide the parsed arguments, so a partial fragment is never rendered as input.
}

function applyPiMessage(
  rows: Rows,
  message: Record<string, unknown>,
  base: string,
  final: boolean,
): void {
  const role = message.role;
  if (role === "toolResult") {
    const toolId = string(message.toolCallId) ?? string(message.toolName) ?? base;
    const patch: RowPatch = { role: "tool", text: "", toolId, streaming: false };
    const name = string(message.toolName);
    if (name) patch.toolName = name;
    const output = contentText(message.content);
    if (output !== undefined) patch.toolOutput = output;
    if (message.isError === true) patch.isError = true;
    rows.upsert("pi-tool-" + toolId, patch);
    return;
  }
  // system/developer initialization (including the very large preamble) is not a turn.
  if (role !== "assistant" && role !== "user") return;
  const content = Array.isArray(message.content) ? message.content : [];
  content.forEach((raw, index) => {
    const block = object(raw);
    if (!block) return;
    const id = base + ":" + index;
    if (block.type === "toolCall") {
      const toolId = string(block.id) ?? id;
      const patch: RowPatch = {
        role: "tool",
        text: "",
        toolId,
        streaming: !final,
      };
      const name = string(block.name);
      if (name) patch.toolName = name;
      const input = object(block.arguments);
      if (input) patch.toolInput = input;
      rows.upsert("pi-tool-" + toolId, patch);
      return;
    }
    const rowRole = role === "assistant" ? "assistant" : "user";
    if (block.type === "thinking") {
      rows.upsert(id, {
        role: rowRole,
        text: typeof block.thinking === "string" ? block.thinking : "",
        thinking: true,
        streaming: !final,
      });
      return;
    }
    if (block.type !== "text") return;
    rows.upsert(id, {
      role: rowRole,
      text: typeof block.text === "string" ? block.text : "",
      streaming: !final,
    });
  });
}

/** Codex exec JSONL items, keyed by the real item id. */
function codexHandler(rows: Rows): Handler {
  let errors = 0;
  const report = (value: unknown) => {
    const record = object(value);
    rows.upsert("codex-error-" + errors++, {
      role: "error",
      text:
        (record ? string(record.message) : undefined) ??
        string(value) ??
        "Codex 报告错误",
    });
  };
  return (event) => {
    const kind = event.type;
    if (
      kind === "item.started" ||
      kind === "item.updated" ||
      kind === "item.completed"
    ) {
      const item = object(event.item);
      const id = item ? string(item.id) : undefined;
      if (!item || !id) return;
      const streaming = kind !== "item.completed";
      if (item.type === "agent_message") {
        const text = string(item.text);
        if (text === undefined) return;
        rows.upsert("codex-msg-" + id, {
          role: "assistant",
          text,
          streaming,
        });
        return;
      }
      if (item.type === "reasoning") {
        const text = string(item.text);
        if (text === undefined) return;
        rows.upsert("codex-reasoning-" + id, {
          role: "assistant",
          text,
          thinking: true,
          streaming,
        });
        return;
      }
      if (item.type === "error") {
        report(item.message);
        return;
      }
      const patch: RowPatch = { role: "tool", text: "", toolId: id, streaming };
      if (item.type === "command_execution") {
        patch.toolName = "command_execution";
        const command = string(item.command);
        if (command) patch.toolInput = { command };
        const output = string(item.aggregated_output);
        if (output !== undefined) patch.toolOutput = output;
        const exit = item.exit_code;
        if (
          item.status === "failed" ||
          (typeof exit === "number" && exit !== 0)
        )
          patch.isError = true;
      } else if (item.type === "file_change") {
        patch.toolName = "file_change";
        const changes = Array.isArray(item.changes) ? item.changes : [];
        if (changes.length) patch.toolInput = { changes };
        const summary = changes
          .map((entry) => {
            const change = object(entry);
            if (!change) return null;
            const path = string(change.path);
            if (!path) return null;
            return string(change.kind) + " " + path;
          })
          .filter((line): line is string => line !== null)
          .join("\n");
        if (summary) patch.toolOutput = summary;
        if (item.status === "failed") patch.isError = true;
      } else if (item.type === "mcp_tool_call") {
        const server = string(item.server);
        const tool = string(item.tool);
        patch.toolName = [server, tool].filter(Boolean).join("/") || "mcp_tool_call";
        const input = object(item.arguments);
        if (input) patch.toolInput = input;
        const failure = object(item.error);
        const output = failure
          ? string(failure.message)
          : toolContent(item.result);
        if (output !== undefined) patch.toolOutput = output;
        if (failure || item.status === "failed") patch.isError = true;
      } else if (item.type === "web_search") {
        patch.toolName = "web_search";
        const query = string(item.query);
        if (query) patch.toolInput = { query };
      } else if (item.type === "todo_list") {
        patch.toolName = "todo_list";
        const todos = Array.isArray(item.items) ? item.items : [];
        if (todos.length) patch.toolInput = { items: todos };
        const plan = todos
          .map((entry) => {
            const todo = object(entry);
            if (!todo) return null;
            const text = string(todo.text);
            if (!text) return null;
            return (todo.completed === true ? "[x] " : "[ ] ") + text;
          })
          .filter((line): line is string => line !== null)
          .join("\n");
        if (plan) patch.toolOutput = plan;
      } else {
        return;
      }
      rows.upsert("codex-tool-" + id, patch);
      return;
    }
    if (kind === "error") report(event.message);
    else if (kind === "turn.failed") report(event.error);
  };
}

/**
 * DSH headless JSONL. `final` arrives after `turn_end` with the same text the last step
 * streamed, so the closed text row keeps its identity until `final` replaces it.
 */
function dshHandler(rows: Rows): Handler {
  let textRow: string | null = null;
  let lastText: string | null = null;
  let thinkingRow: string | null = null;
  let steps = 0;
  let errors = 0;
  const closeThinking = () => {
    if (!thinkingRow) return;
    rows.upsert(thinkingRow, {
      role: "assistant",
      text: rows.text(thinkingRow),
      thinking: true,
      streaming: false,
    });
    thinkingRow = null;
  };
  const closeText = () => {
    if (!textRow) return;
    rows.upsert(textRow, {
      role: "assistant",
      text: rows.text(textRow),
      streaming: false,
    });
    lastText = textRow;
    textRow = null;
  };
  return (event) => {
    const kind = event.type;
    if (kind === "text" && typeof event.text === "string") {
      closeThinking();
      if (!textRow) {
        lastText = null;
        textRow = "dsh-text-" + steps++;
      }
      rows.upsert(textRow, {
        role: "assistant",
        text: rows.text(textRow) + event.text,
        streaming: true,
      });
      return;
    }
    if (kind === "thinking" && typeof event.text === "string") {
      const id = thinkingRow ?? (thinkingRow = "dsh-thinking-" + steps++);
      rows.upsert(id, {
        role: "assistant",
        text: rows.text(id) + event.text,
        thinking: true,
        streaming: true,
      });
      return;
    }
    if (kind === "final") {
      closeThinking();
      const body = typeof event.text === "string" ? event.text : undefined;
      if (textRow) {
        rows.upsert(textRow, {
          role: "assistant",
          text: body ?? rows.text(textRow),
          streaming: false,
        });
      } else if (
        lastText &&
        body !== undefined &&
        (body === rows.text(lastText) ||
          body.startsWith(rows.text(lastText)) ||
          rows.text(lastText).startsWith(body))
      ) {
        // Same or extended text of the row that was just streamed: replace it, never add a copy.
        rows.upsert(lastText, {
          role: "assistant",
          text: body,
          streaming: false,
        });
      } else if (body) {
        rows.upsert("dsh-text-" + steps++, {
          role: "assistant",
          text: body,
          streaming: false,
        });
      }
      textRow = null;
      lastText = null;
      return;
    }
    if (kind === "tool_call" || kind === "tool_result") {
      closeThinking();
      closeText();
      const toolId = string(event.callId) ?? string(event.toolCallId);
      if (!toolId) return;
      const result = kind === "tool_result";
      const patch: RowPatch = { role: "tool", text: "", toolId, streaming: !result };
      const name = string(event.tool) ?? string(event.title);
      if (name) patch.toolName = name;
      if (result) {
        const output = flat(event.result);
        if (output !== undefined) patch.toolOutput = output;
        if (event.status === "failed" || event.status === "error")
          patch.isError = true;
      } else {
        const input = object(event.input) ?? object(event.arguments);
        if (input) patch.toolInput = input;
      }
      rows.upsert("dsh-tool-" + toolId, patch);
      return;
    }
    if (kind === "error") {
      rows.upsert("dsh-error-" + errors++, {
        role: "error",
        text: string(event.message) ?? string(event.error) ?? "DSH 报告错误",
      });
      return;
    }
    // A step boundary ends the streamed chunk but keeps the row for the following `final`.
    if (
      kind === "status" &&
      (event.phase === "step_end" || event.phase === "turn_end")
    ) {
      closeThinking();
      closeText();
    }
    // session/init/status/usage stay in the raw event view only.
  };
}

function handlerFor(type: WorkerType, rows: Rows): Handler {
  if (type === "pi") return piHandler(rows);
  if (type === "codex") return codexHandler(rows);
  return dshHandler(rows);
}

function parseLine(line: string, handle: Handler): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    // A malformed line stays visible in the raw event view only.
    return;
  }
  const event = object(value);
  if (event) handle(event);
}

/** Creates the reader for one run's event stream; each page is fed with `push`. */
export function createConversationStream(type: WorkerType): ConversationStream {
  const rows = new Rows();
  const handle = handlerFor(type, rows);
  let pending = "";
  return {
    push(chunk) {
      pending += chunk;
      let at = pending.indexOf("\n");
      while (at >= 0) {
        parseLine(pending.slice(0, at), handle);
        pending = pending.slice(at + 1);
        at = pending.indexOf("\n");
      }
    },
    flush() {
      const line = pending;
      pending = "";
      parseLine(line, handle);
    },
    messages: () => rows.messages(),
  };
}
