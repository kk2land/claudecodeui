import assert from "node:assert/strict";
import test from "node:test";
import { createConversationStream } from "../client/conversation.js";

function line(event: unknown): string {
  return JSON.stringify(event) + "\n";
}

function rowsOf(type: "pi" | "codex" | "dsh" | "agy", events: unknown[]) {
  const stream = createConversationStream(type);
  for (const event of events) stream.push(line(event));
  stream.flush();
  return stream.messages();
}

test("Pi builds one row from streaming deltas, before message_end arrives", () => {
  const stream = createConversationStream("pi");
  stream.push(line({ type: "message_start", message: { role: "assistant", content: [] } }));
  stream.push(
    line({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    }),
  );
  stream.push(
    line({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ab" },
    }),
  );
  const streaming = stream.messages();
  assert.equal(streaming.length, 1);
  assert.equal(streaming[0]!.text, "ab");
  assert.equal(streaming[0]!.streaming, true);

  stream.push(
    line({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "cd" },
    }),
  );
  stream.push(
    line({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "abcd" },
    }),
  );
  assert.equal(stream.messages()[0]!.text, "abcd");
  assert.equal(stream.messages()[0]!.streaming, false);

  stream.push(
    line({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "abcd" }],
      },
    }),
  );
  assert.equal(stream.messages().length, 1);
  assert.equal(stream.messages()[0]!.text, "abcd");
});

test("Pi keeps thinking deltas as a readable thinking row", () => {
  const rows = rowsOf("pi", [
    {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "先看",
      },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "先看目录",
      },
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.thinking, true);
  assert.equal(rows[0]!.text, "先看目录");
  assert.equal(rows[0]!.streaming, false);
});

test("Pi drops system initialization and the replayed turn/agent messages", () => {
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "pi answer" }],
  };
  const rows = rowsOf("pi", [
    {
      type: "message_start",
      message: { role: "system", content: [], sections: {}, toolsAdded: [] },
    },
    { type: "message_end", message: { role: "system", sections: {} } },
    { type: "message_start", message: { role: "assistant", content: [] } },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "pi answer",
      },
    },
    { type: "message_end", message: assistant },
    { type: "turn_end", message: assistant },
    {
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "system", content: [] },
        { role: "user", content: [{ type: "text", text: "做吧" }] },
        assistant,
      ],
    },
  ]);
  assert.equal(rows.filter((row) => row.role === "assistant").length, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.text, "pi answer");
});

test("Pi shows a running tool, its partial output, and a readable result", () => {
  const stream = createConversationStream("pi");
  stream.push(
    line({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "先看一下" },
          { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    }),
  );
  stream.push(
    line({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "ls" },
    }),
  );
  let tool = stream.messages().find((row) => row.role === "tool")!;
  assert.equal(tool.toolName, "Bash");
  assert.deepEqual(tool.toolInput, { command: "ls" });
  assert.equal(tool.streaming, true);
  assert.equal(stream.messages().find((row) => row.role === "assistant")!.text, "先看一下");

  stream.push(
    line({
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "ls" },
      partialResult: { content: [{ type: "text", text: "a.txt" }] },
    }),
  );
  tool = stream.messages().find((row) => row.role === "tool")!;
  assert.equal(tool.toolName, "Bash");
  assert.equal(tool.toolOutput, "a.txt");
  assert.equal(stream.messages().filter((row) => row.role === "tool").length, 1);

  stream.push(
    line({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok" }], details: {} },
      isError: false,
    }),
  );
  tool = stream.messages().find((row) => row.role === "tool")!;
  assert.equal(tool.toolName, "Bash");
  assert.equal(tool.toolOutput, "ok");
  assert.equal(tool.streaming, false);
  assert.equal(tool.isError, undefined);
});

test("Pi keeps toolResult messages paired with their tool call", () => {
  const rows = rowsOf("pi", [
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c2", name: "read", arguments: { file: "a" } },
        ],
      },
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "c2",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "not found" }],
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c3",
            name: "custom",
            arguments: { CommandLine: "keep me" },
          },
        ],
      },
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "c3",
        toolName: "custom",
        content: [{ type: "text", text: "ok" }],
      },
    },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.toolId, "c2");
  assert.equal(rows[0]!.toolOutput, "not found");
  assert.equal(rows[0]!.isError, true);
  assert.equal(rows[1]!.toolName, "custom");
  assert.deepEqual(rows[1]!.toolInput, { CommandLine: "keep me" });
});

test("DSH folds the trailing final into the last streamed step instead of adding a row", () => {
  const rows = rowsOf("dsh", [
    { type: "session", sessionId: "s-1" },
    { type: "status", phase: "turn_start" },
    { type: "status", phase: "step_start" },
    { type: "thinking", text: "先看目录" },
    { type: "tool_call", callId: "k1", tool: "bash", input: { command: "ls" } },
    { type: "tool_result", callId: "k1", status: "ok", result: "out" },
    { type: "status", phase: "step_end" },
    { type: "status", phase: "step_start" },
    { type: "text", text: "a" },
    { type: "status", phase: "step_end" },
    { type: "status", phase: "turn_end" },
    { type: "final", text: "a" },
  ]);
  const answers = rows.filter((row) => row.role === "assistant" && !row.thinking);
  assert.equal(answers.length, 1, JSON.stringify(rows));
  assert.equal(answers[0]!.text, "a");
  assert.equal(answers[0]!.streaming, false);
  const thinking = rows.filter((row) => row.thinking);
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0]!.text, "先看目录");
  const tool = rows.find((row) => row.role === "tool")!;
  assert.equal(tool.toolName, "bash");
  assert.deepEqual(tool.toolInput, { command: "ls" });
  assert.equal(tool.toolOutput, "out");
  assert.equal(tool.streaming, false);
});

test("DSH gives each step its own text row and only overrides the last one", () => {
  const rows = rowsOf("dsh", [
    { type: "status", phase: "step_start" },
    { type: "text", text: "第一段" },
    { type: "status", phase: "step_end" },
    { type: "status", phase: "step_start" },
    { type: "text", text: "第二段" },
    { type: "status", phase: "step_end" },
    { type: "status", phase: "turn_end" },
    { type: "final", text: "第二段" },
  ]);
  const answers = rows.filter((row) => row.role === "assistant");
  assert.deepEqual(
    answers.map((row) => row.text),
    ["第一段", "第二段"],
  );
  assert.ok(answers.every((row) => row.streaming === false));
});

test("DSH marks a failed tool result and reports its error event", () => {
  const rows = rowsOf("dsh", [
    { type: "tool_call", callId: "k2", tool: "bash", input: { command: "nope" } },
    { type: "tool_result", callId: "k2", status: "failed", result: "boom" },
    { type: "error", message: "dsh failed" },
  ]);
  const tool = rows.find((row) => row.role === "tool")!;
  assert.equal(tool.toolOutput, "boom");
  assert.equal(tool.isError, true);
  const error = rows.find((row) => row.role === "error")!;
  assert.equal(error.text, "dsh failed");
});

test("Codex renders every readable exec item type", () => {
  const rows = rowsOf("codex", [
    { type: "thread.started", thread_id: "t-1" },
    {
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "codex answer" },
    },
    {
      type: "item.completed",
      item: { id: "i2", type: "reasoning", text: "thinking aloud" },
    },
    {
      type: "item.started",
      item: {
        id: "i3",
        type: "command_execution",
        command: "ls",
        aggregated_output: "",
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "i3",
        type: "command_execution",
        command: "ls",
        aggregated_output: "a.txt",
        exit_code: 1,
        status: "failed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "i4",
        type: "file_change",
        changes: [{ path: "a.ts", kind: "update" }],
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: {
        id: "i5",
        type: "mcp_tool_call",
        server: "srv",
        tool: "search",
        arguments: { q: "x" },
        result: { content: [{ type: "text", text: "hit" }], structured_content: {} },
        status: "completed",
      },
    },
    {
      type: "item.completed",
      item: { id: "i6", type: "web_search", query: "docs" },
    },
    {
      type: "item.completed",
      item: {
        id: "i7",
        type: "todo_list",
        items: [
          { text: "read", completed: true },
          { text: "write", completed: false },
        ],
      },
    },
    { type: "item.completed", item: { id: "i8", type: "error", message: "item failed" } },
  ]);
  assert.equal(rows.find((row) => row.id === "codex-msg-i1")!.text, "codex answer");
  const reasoning = rows.find((row) => row.id === "codex-reasoning-i2")!;
  assert.equal(reasoning.thinking, true);
  assert.equal(reasoning.text, "thinking aloud");
  const command = rows.find((row) => row.id === "codex-tool-i3")!;
  assert.equal(command.toolName, "Bash");
  assert.deepEqual(command.toolInput, { command: "ls" });
  assert.equal(command.toolOutput, "a.txt");
  assert.equal(command.isError, true);
  assert.equal(command.streaming, false);
  const file = rows.find((row) => row.id === "codex-tool-i4")!;
  assert.equal(file.toolName, "file_change");
  assert.equal(file.toolOutput, "update a.ts");
  assert.equal(file.isError, undefined);
  const mcp = rows.find((row) => row.id === "codex-tool-i5")!;
  assert.equal(mcp.toolName, "srv/search");
  assert.deepEqual(mcp.toolInput, { q: "x" });
  assert.equal(mcp.toolOutput, "hit");
  const search = rows.find((row) => row.id === "codex-tool-i6")!;
  assert.deepEqual(search.toolInput, { query: "docs" });
  const todo = rows.find((row) => row.id === "codex-tool-i7")!;
  assert.equal(todo.toolOutput, "[x] read\n[ ] write");
  const itemError = rows.find((row) => row.role === "error")!;
  assert.equal(itemError.text, "item failed");
  assert.equal(rows.filter((row) => row.role === "tool").length, 5);
});

test("a JSON line split across pages is parsed once, and the last line needs flush", () => {
  const text =
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "跨页中文内容" }],
      },
    }) +
    "\n" +
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "最后一页" }] },
    });
  const cut = text.indexOf("跨页") + 1;
  const stream = createConversationStream("pi");
  stream.push(text.slice(0, cut));
  assert.equal(stream.messages().length, 0, "a half line is held back");
  stream.push(text.slice(cut));
  assert.equal(stream.messages().length, 1, "complete lines parse once");
  stream.flush();
  const rows = stream.messages();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.text, "跨页中文内容");
  assert.equal(rows[1]!.text, "最后一页");
});

test("long conversations keep every row instead of trimming the oldest", () => {
  const events = [];
  for (let index = 0; index < 2500; index += 1)
    events.push({
      type: "message_end",
      message: {
        id: "m" + index,
        role: "assistant",
        content: [{ type: "text", text: "row " + index }],
      },
    });
  const rows = rowsOf("pi", events);
  assert.equal(rows.length, 2500);
  assert.equal(rows[0]!.text, "row 0");
});

test("agy renders streamed text once, a tool lifecycle, and the final result", () => {
  const rows = rowsOf("agy", [
    {
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "agy ",
      },
    },
    {
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        step_type: "agent_response",
        text_delta: "answer",
      },
    },
    {
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { parameters: { CommandLine: "echo hi" } },
      },
    },
    {
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "DONE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: {
          parameters: { CommandLine: "echo hi" },
          output: "hi",
        },
      },
    },
    {
      event: "result",
      result: { status: "SUCCESS", response: "agy answer" },
    },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.role),
    ["assistant", "tool"],
  );
  assert.equal(rows[0]!.text, "agy answer");
  assert.equal(rows[0]!.streaming, false);
  assert.equal(rows[1]!.toolName, "Bash");
  assert.deepEqual(rows[1]!.toolInput, { command: "echo hi" });
  assert.equal(rows[1]!.toolOutput, "hi");
  assert.equal(rows[1]!.streaming, false);
});

test("agy shows denied actions and result errors as error rows", () => {
  const rows = rowsOf("agy", [
    {
      event: "result",
      result: {
        status: "SUCCESS",
        response: "",
        denied_actions: [{ action: "write_file" }],
      },
    },
    {
      event: "result",
      result: { status: "ERROR", error: "invalid model selection" },
    },
  ]);
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.text, /write_file/);
  assert.match(rows[1]!.text, /invalid model selection/);
});

test("Pi ACP suppresses startupInfo, streams thought/text, pairs tool updates, and reports errors", () => {
  const rows = rowsOf("pi", [
    {
      protocol: "acp",
      type: "acp_session",
      action: "new",
      sessionId: "s-acp-1",
      cwd: "/tmp/p",
      configOptions: [],
      startupInfo: "pi v1.6.0\n---\n",
    },
    {
      protocol: "acp",
      type: "acp_update",
      sessionId: "s-acp-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "pi v1.6.0\n---\n" },
      },
    },
    {
      protocol: "acp",
      type: "acp_update",
      sessionId: "s-acp-1",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "先分析" },
      },
    },
    {
      protocol: "acp",
      type: "acp_update",
      sessionId: "s-acp-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "echo hi",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "echo hi" },
      },
    },
    {
      protocol: "acp",
      type: "acp_update",
      sessionId: "s-acp-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "hi\n" } }],
      },
    },
    {
      protocol: "acp",
      type: "acp_update",
      sessionId: "s-acp-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "完成" },
      },
    },
    {
      protocol: "acp",
      type: "acp_update",
      sessionId: "s-acp-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "了" },
      },
    },
    {
      protocol: "acp",
      type: "acp_prompt_result",
      sessionId: "s-acp-1",
      stopReason: "end_turn",
      result: { stopReason: "end_turn" },
    },
    {
      protocol: "acp",
      type: "acp_error",
      stage: "session/set_config_option",
      code: "ACP_CONFIG_UNSUPPORTED",
      message: "ACP 不支持配置 thought_level=max",
    },
  ]);
  assert.equal(rows.length, 4);
  assert.equal(rows[0]!.thinking, true);
  assert.equal(rows[0]!.text, "先分析");
  assert.equal(rows[0]!.streaming, false);
  assert.equal(rows[1]!.role, "tool");
  assert.equal(rows[1]!.toolName, "Bash");
  assert.deepEqual(rows[1]!.toolInput, { command: "echo hi" });
  assert.equal(rows[1]!.toolOutput, "hi\n");
  assert.equal(rows[1]!.streaming, false);
  assert.equal(rows[2]!.role, "assistant");
  assert.equal(rows[2]!.text, "完成了");
  assert.equal(rows[2]!.streaming, false);
  assert.equal(rows[3]!.role, "error");
  assert.match(rows[3]!.text, /thought_level=max/);
});

test("ACP maps execute calls to Bash and leaves other tools on their own title", () => {
  const rows = rowsOf("pi", [
    {
      protocol: "acp",
      type: "acp_update",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-fail",
        title: "bash -lc pwd --physical",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "pwd --physical" },
      },
    },
    {
      protocol: "acp",
      type: "acp_update",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-fail",
        title: "pwd",
        kind: "execute",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "denied" } }],
      },
    },
    {
      protocol: "acp",
      type: "acp_update",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-read",
        title: "Read a.ts",
        kind: "read",
        status: "completed",
        rawInput: { path: "a.ts" },
      },
    },
    {
      protocol: "acp",
      type: "acp_update",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-read",
        title: "Read b.ts",
        status: "completed",
        rawInput: { path: "b.ts" },
      },
    },
  ]);
  const failed = rows.find((row) => row.toolId === "tc-fail")!;
  assert.equal(failed.toolName, "Bash");
  assert.deepEqual(failed.toolInput, { command: "pwd --physical" });
  assert.equal(failed.toolOutput, "denied");
  assert.equal(failed.isError, true);
  assert.equal(failed.streaming, false);
  const read = rows.find((row) => row.toolId === "tc-read")!;
  assert.equal(read.toolName, "Read b.ts");
  assert.deepEqual(read.toolInput, { path: "b.ts" });
});

test("agy ACP runs reuse the ACP conversation handler while legacy history stays intact", () => {
  const rows = rowsOf("agy", [
    {
      protocol: "acp",
      type: "acp_session",
      action: "resume",
      sessionId: "agy-conversation-1",
      cwd: "/tmp/agy",
      configOptions: [],
      startupInfo: null,
    },
    {
      protocol: "acp",
      type: "acp_update",
      sessionId: "agy-conversation-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "agy acp answer" },
      },
    },
    {
      protocol: "acp",
      type: "acp_prompt_result",
      sessionId: "agy-conversation-1",
      stopReason: "end_turn",
      result: { stopReason: "end_turn" },
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.role, "assistant");
  assert.equal(rows[0]!.text, "agy acp answer");
  assert.equal(rows[0]!.streaming, false);
});
