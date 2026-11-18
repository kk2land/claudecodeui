import { describe, expect, it } from 'vitest';

import { shouldHideWorkerExec } from '@/modules/chat/utils/workerExecVisibility';
import type { ChatMessage, ToolResult } from '@/shared/types';

/** The persisted envelope Codex wraps a completed `exec` script's stdout in. */
const completed = (output = ''): string =>
  `Script completed\nWall time: 0.4 seconds\nOutput:\n${output}`;

/** A real Worker run record, as `worker_get`, `worker_start` and `worker_list` return it. */
const run = (status = 'completed', workerId = 'w1', runId = 'r1'): string =>
  `{"workerId":"${workerId}","runId":"${runId}","status":"${status}","cwd":"/repo"}`;

const workerCall = (tool: string, args: Record<string, string>) =>
  `tools.mcp__cloudcli_workers__${tool}(${JSON.stringify(args)})`;

const getCall = (workerId = 'w1') => workerCall('worker_get', { workerId });

const execMessage = (
  script: unknown,
  result: ToolResult | null = null,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  type: 'assistant',
  content: '',
  timestamp: '2026-01-01T00:00:00.000Z',
  isToolUse: true,
  toolName: 'exec',
  toolInput: script,
  toolResult: result,
  ...extra,
});

type Case = {
  name: string;
  message: ChatMessage;
  hidden: boolean;
};

const directCall = `await ${getCall()};`;

const cases: Case[] = [
  {
    name: 'hides a direct awaited worker_get whose output is a run record',
    message: execMessage(directCall, { content: completed(run()) }),
    hidden: true,
  },
  {
    name: 'hides the typical `const r = await …; text(r)` dispatch',
    message: execMessage(
      `const r = await ${getCall()};\ntext(r);`,
      { content: completed(`{"content":[{"type":"text","text":${JSON.stringify(run())}}],"isError":false}`) },
    ),
    hidden: true,
  },
  {
    name: 'hides a dispatch that projects a real Worker run out of the MCP text',
    message: execMessage(
      `const r = await ${getCall()};\nconst payload = JSON.parse(r.content[0].text);\ntext(JSON.stringify(payload.runs[0]));`,
      { content: completed(run()) },
    ),
    hidden: true,
  },
  {
    name: 'hides a top-level Promise.all batch printed as a JSON array',
    message: execMessage(
      `const results = await Promise.all([\n  ${getCall('w1')},\n  ${getCall('w2')},\n]);\ntext(JSON.stringify(results));`,
      {
        content: completed(`[${run('completed', 'w1', 'r1')},${run('running', 'w2', 'r2')}]`),
      },
    ),
    hidden: true,
  },
  {
    name: 'hides text(await …) whose output is a run record',
    message: execMessage(`text(await ${getCall()});`, { content: completed(run()) }),
    hidden: true,
  },
  {
    name: 'hides a complete run record that identifies itself by id instead of runId',
    message: execMessage(directCall, {
      content: completed('{"workerId":"w1","id":"r1","status":"completed"}'),
    }),
    hidden: true,
  },
  {
    name: 'keeps a completion that printed nothing',
    message: execMessage(directCall, { content: completed() }),
    hidden: false,
  },
  {
    name: 'keeps a Promise.allSettled batch that prints nothing',
    message: execMessage(
      `await Promise.allSettled([\n  ${getCall('w1')},\n  ${getCall('w2')},\n]);`,
      { content: completed() },
    ),
    hidden: false,
  },
  {
    name: 'hides MCP text content that wraps a real Worker run',
    message: execMessage(`const r = await ${getCall()};\ntext(JSON.stringify(r.content));`, {
      content: completed(`[{"type":"text","text":${JSON.stringify(run())}}]`),
    }),
    hidden: true,
  },
  {
    name: 'hides a live { code } call whose result wraps the completion in one JSON layer',
    message: execMessage(
      { code: `await ${getCall()};` },
      { content: JSON.stringify(completed(run())) },
    ),
    hidden: true,
  },
  {
    name: 'hides a live call whose script arrives as a JSON string',
    message: execMessage(JSON.stringify({ code: `await ${getCall()};` }), { content: completed(run()) }),
    hidden: true,
  },
  {
    name: 'hides a run record whose failed count is data rather than a status',
    message: execMessage(directCall, {
      content: completed(`{"workerId":"w1","runId":"r1","status":"completed","counts":{"failed":0,"pending":2}}`),
    }),
    hidden: true,
  },
  {
    name: 'hides a run record whose error field is empty',
    message: execMessage(directCall, {
      content: completed(`{"workerId":"w1","runId":"r1","status":"completed","error":""}`),
    }),
    hidden: true,
  },
  {
    name: 'hides a Worker record whose normal string fields carry no error',
    message: execMessage(directCall, {
      content: completed(`{"id":"w1","taskName":"review","latestRun":null,"cwd":"/repo","notes":"done"}`),
    }),
    hidden: true,
  },
  {
    name: 'hides a worker_ack receipt',
    message: execMessage(`await ${workerCall('worker_ack', { eventIds: 'e1' })};`, {
      content: completed('{"acknowledged":2}'),
    }),
    hidden: true,
  },
  {
    name: 'hides a worker_plan_save receipt',
    message: execMessage(`await ${workerCall('worker_plan_save', { content: 'plan' })};`, {
      content: completed('{"updatedAt":"2026-01-01T00:00:00.000Z"}'),
    }),
    hidden: true,
  },
  {
    name: 'hides a completion whose Wall time line has no colon',
    message: execMessage(directCall, {
      content: `Script completed\nWall time 1.2 seconds\nOutput:\n${run()}`,
    }),
    hidden: true,
  },
  {
    name: 'hides a CRLF completion with a colon wall time and no Output header',
    message: execMessage(directCall, {
      content: `Script completed\r\nWall time: 1:02\r\n${run()}`,
    }),
    hidden: true,
  },
  {
    name: 'keeps a dispatch that prints an unrelated object',
    message: execMessage(`await ${getCall()};\ntext(JSON.stringify({saved:1}));`, {
      content: completed('{"saved":1}'),
    }),
    hidden: false,
  },
  {
    name: 'keeps a Worker call that only sits in an unused function',
    message: execMessage(
      `function unused() { return ${getCall()}; }\ntext(JSON.stringify({saved:1}));`,
      { content: completed('{"saved":1}') },
    ),
    hidden: false,
  },
  {
    name: 'keeps a Worker call in a branch that does not run',
    message: execMessage(
      `if (false) { await ${getCall()}; }\ntext(JSON.stringify({saved:1}));`,
      { content: completed(run()) },
    ),
    hidden: false,
  },
  {
    name: 'keeps a Worker call after an early return',
    message: execMessage(`return;\nawait ${getCall()};`, { content: completed(run()) }),
    hidden: false,
  },
  {
    name: 'keeps a dispatch that also makes a non-Worker side effect',
    message: execMessage(`await ${getCall()};\nfetch('https://example.test');`, {
      content: completed(run()),
    }),
    hidden: false,
  },
  {
    name: 'keeps a script that mixes a Worker call with another MCP server',
    message: execMessage(
      `await ${getCall()};\nawait tools.mcp__filesystem__read_file({ path: '/tmp/x' });`,
      { content: completed(run()) },
    ),
    hidden: false,
  },
  {
    name: 'keeps a message-only object printed after a Worker call',
    message: execMessage(`await ${getCall()};\ntext(JSON.stringify({message:'worker not found'}));`, {
      content: completed('{"message":"worker not found"}'),
    }),
    hidden: false,
  },
  {
    name: 'keeps a message-only object wrapped in MCP text content',
    message: execMessage(`text((await ${getCall()}).content);`, {
      content: completed('[{"type":"text","text":"{\\"message\\":\\"worker not found\\"}"}]'),
    }),
    hidden: false,
  },
  {
    name: 'keeps plain-text output a script printed',
    message: execMessage(directCall, { content: completed('Worker w1 started') }),
    hidden: false,
  },
  {
    name: 'keeps a mixed output of a Worker record and plain text',
    message: execMessage(`await ${getCall()};\ntext(JSON.stringify({workerId:'w1',status:'completed'}));\nconsole.log('worker done');`, {
      content: completed(`${run()}\nworker done`),
    }),
    hidden: false,
  },
  {
    name: 'keeps a top-level JSON string payload',
    message: execMessage(directCall, { content: completed('"worker started"') }),
    hidden: false,
  },
  {
    name: 'keeps a top-level JSON array of plain text',
    message: execMessage(directCall, { content: completed('["worker started"]') }),
    hidden: false,
  },
  {
    name: 'keeps a JSON payload that reports isError',
    message: execMessage(directCall, { content: completed(`{"isError":true,"content":[]}`) }),
    hidden: false,
  },
  {
    name: 'keeps a run record whose status failed',
    message: execMessage(directCall, { content: completed(run('failed')) }),
    hidden: false,
  },
  {
    name: 'keeps a run record that exited non-zero',
    message: execMessage(directCall, { content: completed('{"workerId":"w1","status":"completed","exitCode":1}') }),
    hidden: false,
  },
  {
    name: 'keeps a run record reporting success:false',
    message: execMessage(directCall, {
      content: completed('{"workerId":"w1","status":"completed","success":false}'),
    }),
    hidden: false,
  },
  {
    name: 'keeps a run record carrying a real error message',
    message: execMessage(directCall, {
      content: completed('{"workerId":"w1","status":"completed","error":"worker not found"}'),
    }),
    hidden: false,
  },
  {
    name: 'keeps a JSON payload whose inner MCP text reports a failed run',
    message: execMessage(directCall, {
      content: completed(`[{"type":"text","text":${JSON.stringify(run('failed'))}}]`),
    }),
    hidden: false,
  },
  {
    name: 'keeps a JSON payload whose inner MCP text is a plain-text error',
    message: execMessage(directCall, {
      content: completed('[{"type":"text","text":"Error: worker exited before starting"}]'),
    }),
    hidden: false,
  },
  {
    name: 'keeps a call whose result has not arrived',
    message: execMessage(directCall),
    hidden: false,
  },
  {
    name: 'keeps a call whose result is an error',
    message: execMessage(directCall, { content: completed(run()), isError: true }),
    hidden: false,
  },
  {
    name: 'keeps a call whose status already failed',
    message: execMessage(directCall, { content: completed(run()) }, { toolStatus: 'failed' }),
    hidden: false,
  },
  {
    name: 'keeps a failed script envelope',
    message: execMessage(directCall, { content: 'Script failed in 0.2s\nWall time: 0.2 seconds\nOutput:\n{}' }),
    hidden: false,
  },
  {
    name: 'keeps a script that is still running',
    message: execMessage(directCall, {
      content: 'Script running with cell ID 7\nWall time: 0.2 seconds\nOutput:\n{}',
    }),
    hidden: false,
  },
  {
    name: 'keeps a completion header with an error suffix',
    message: execMessage(directCall, {
      content: 'Script completed with errors\nWall time: 0.4 seconds\nOutput:\n{}',
    }),
    hidden: false,
  },
  {
    name: 'keeps JSON output that has no completion header',
    message: execMessage(directCall, { content: run() }),
    hidden: false,
  },
  {
    name: 'keeps a live MCP result that has no completion header',
    message: execMessage(
      { code: directCall },
      { content: JSON.stringify({ content: [{ type: 'text', text: run() }], isError: false }) },
    ),
    hidden: false,
  },
  {
    name: 'keeps a non-string result',
    message: execMessage(directCall, { content: [{ type: 'text', text: run() }] }),
    hidden: false,
  },
  {
    name: 'keeps a script that only mentions tool names in comments and strings',
    message: execMessage(
      `// await ${getCall()};\nconst note = 'tools.mcp__cloudcli_workers__worker_get';\ntext(note);`,
      { content: completed(run()) },
    ),
    hidden: false,
  },
  {
    name: 'keeps a non-Worker script',
    message: execMessage("await tools.shell_command({ command: 'ls' });", { content: completed(run()) }),
    hidden: false,
  },
  {
    name: 'keeps a script that reaches indirect evaluation such as globalThis',
    message: execMessage(`${directCall}\nawait globalThis.fetch('https://example.test');`, {
      content: completed(run()),
    }),
    hidden: false,
  },
  {
    name: 'keeps a script that aliases the Worker call before calling it',
    message: execMessage(
      "const call = tools.mcp__cloudcli_workers__worker_get;\nawait call({ workerId: 'w1' });",
      { content: completed(run()) },
    ),
    hidden: false,
  },
  {
    name: 'keeps a script that reaches the tool through a computed property',
    message: execMessage("await tools['mcp__cloudcli_workers__worker_get']({ workerId: 'w1' });", {
      content: completed(run()),
    }),
    hidden: false,
  },
  {
    name: 'keeps a script the AST cannot parse',
    message: execMessage("await tools.mcp__cloudcli_workers__worker_get({ workerId: 'w1'", {
      content: completed(run()),
    }),
    hidden: false,
  },
  {
    name: 'keeps a tool input shape that is not the raw script or { code }',
    message: execMessage({ input: directCall }, { content: completed(run()) }),
    hidden: false,
  },
];

const extraCases: Case[] = [
  {
    name: 'keeps a run record with the error status',
    message: execMessage(directCall, { content: completed('{"workerId":"w1","runId":"r1","status":"error"}') }),
    hidden: false,
  },
  {
    name: 'keeps a run record with the rejected status',
    message: execMessage(directCall, { content: completed('{"workerId":"w1","runId":"r1","status":"rejected"}') }),
    hidden: false,
  },
  {
    name: 'keeps the unconfirmed unknown status',
    message: execMessage(directCall, { content: completed('{"workerId":"w1","runId":"r1","status":"unknown"}') }),
    hidden: false,
  },
  {
    name: 'keeps a Worker-like record carrying a diagnostic message',
    message: execMessage(directCall, {
      content: completed('{"workerId":"w1","runId":"r1","status":"completed","message":"worker not found"}'),
    }),
    hidden: false,
  },
  {
    name: 'keeps a diagnostic message inside MCP text JSON',
    message: execMessage(directCall, {
      content: completed(
        `[{"type":"text","text":${JSON.stringify('{"workerId":"w1","runId":"r1","status":"completed","message":"worker not found"}')}}]`,
      ),
    }),
    hidden: false,
  },
  {
    name: 'keeps a record that is not a real run receipt',
    message: execMessage(directCall, { content: completed('{"workerId":"w1","status":"completed"}') }),
    hidden: false,
  },
  {
    name: 'keeps an unrecognized status word',
    message: execMessage(directCall, { content: completed('{"workerId":"w1","runId":"r1","status":"ok"}') }),
    hidden: false,
  },
  {
    name: 'keeps an updatedAt record that carries other fields',
    message: execMessage(directCall, {
      content: completed('{"updatedAt":"2026-01-01T00:00:00.000Z","extra":1}'),
    }),
    hidden: false,
  },
  {
    name: 'keeps an acknowledged record that carries other fields',
    message: execMessage(directCall, { content: completed('{"acknowledged":2,"extra":1}') }),
    hidden: false,
  },
  {
    name: 'keeps a script that adds a tagged template after a Worker call',
    message: execMessage(`${directCall}\ntext\`done\`;`, {
      content: completed(run()),
    }),
    hidden: false,
  },
  {
    name: 'keeps a script that constructs another object',
    message: execMessage(`${directCall}\nnew Date();`, { content: completed(run()) }),
    hidden: false,
  },
  {
    name: 'keeps a script that assigns to a Worker field',
    message: execMessage(`const r = await ${getCall()};\nr.workerId = 'other';`, {
      content: completed(run()),
    }),
    hidden: false,
  },
  {
    name: 'keeps a script that rebinds a helper namespace before logging',
    message: execMessage(
      `const console = { log: notify };\nconst r = await ${getCall()};\nconsole.log(r);\ntext(r);`,
      { content: completed(run()) },
    ),
    hidden: false,
  },
  {
    name: 'keeps a script that binds text to another name',
    message: execMessage(`const t = text;\nt(await ${getCall()});`, { content: completed(run()) }),
    hidden: false,
  },
];

const nonExecCases: Case[] = [
  {
    name: 'ignores a non-exec tool',
    message: execMessage(directCall, { content: completed(run()) }, { toolName: 'sleep' }),
    hidden: false,
  },
  {
    name: 'ignores a message that is not a tool use',
    message: execMessage(directCall, { content: completed(run()) }, { isToolUse: false }),
    hidden: false,
  },
];

describe('Codex Worker exec visibility', () => {
  for (const testCase of [...cases, ...extraCases, ...nonExecCases]) {
    it(testCase.name, () => {
      expect(shouldHideWorkerExec(testCase.message)).toBe(testCase.hidden);
    });
  }
});
