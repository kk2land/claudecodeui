import { parse, type AnyNode } from 'acorn';

import type { ChatMessage } from '@/shared/types';

/**
 * A Codex `exec` row holds a "code mode" script whose Worker MCP calls the
 * transcript could not translate, so a routine Worker dispatch reads as its own
 * source and protocol JSON. This hides such a row only when the script is a
 * plain dispatch of the Worker calls it definitely awaits and the completion
 * carries a real Worker protocol payload with no failure. Anything unreadable
 * stays visible; the checks are syntactic, not an interpreter.
 */

/** The direct callee prefix of a Worker MCP tool. */
const WORKER_CALL_PREFIX = 'tools.mcp__cloudcli_workers__worker_';

/** Sandbox helpers a Worker dispatch may use to print or reshape a result. */
const HELPER_CALLS = new Set(['text', 'String', 'JSON.parse', 'JSON.stringify', 'console.log']);
const AGGREGATE_CALLS = new Set(['Promise.all', 'Promise.allSettled']);

/** Identifiers only meaningful as an accepted call target or tool object. */
const RESERVED_IDENTIFIERS = new Set(['Function', 'JSON', 'Promise', 'String', 'console', 'eval', 'globalThis', 'text', 'tools']);

/** Lifecycle statuses a Worker run or notification reports. */
const WORKER_STATUSES = new Set(['queued', 'starting', 'running', 'stopping', 'completed', 'failed', 'cancelled', 'interrupted', 'unknown']);

/** Statuses that mean the run did not finish cleanly, including an unconfirmed one. */
const FAILING_STATUSES = new Set(['failed', 'cancelled', 'interrupted', 'unknown', 'error', 'rejected']);

type CallNode = Extract<AnyNode, { type: 'CallExpression' }>;
type ProgramNode = Extract<AnyNode, { type: 'Program' }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Parses one JSON layer, or returns undefined when the text is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------
// Script recognition

/** A non-optional, non-computed direct callee name such as `text` or `JSON.parse`. */
function directCallName(node: CallNode): string | null {
  if (node.optional) {
    return null;
  }
  const callee = node.callee;
  if (callee.type === 'Identifier') {
    return callee.name;
  }
  if (callee.type !== 'MemberExpression' || callee.computed || callee.optional
    || callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier') {
    return null;
  }
  return `${callee.object.name}.${callee.property.name}`;
}

const isWorkerCall = (node: CallNode): boolean => (directCallName(node) ?? '').startsWith(WORKER_CALL_PREFIX);

/** Adds the Worker calls this top-level value definitely awaits. */
function collectAwaitedWorkers(value: AnyNode, into: Set<AnyNode>): void {
  if (value.type === 'AwaitExpression') {
    const awaited = value.argument;
    if (awaited.type !== 'CallExpression') {
      return;
    }
    if (isWorkerCall(awaited)) {
      into.add(awaited);
      return;
    }
    if (awaited.arguments.length !== 1 || !AGGREGATE_CALLS.has(directCallName(awaited) ?? '')) {
      return;
    }
    const [list] = awaited.arguments;
    if (list.type !== 'ArrayExpression') {
      return;
    }
    for (const element of list.elements) {
      if (element?.type === 'CallExpression' && isWorkerCall(element)) {
        into.add(element);
      }
    }
    return;
  }
  // `text(await …)` and the same inside JSON formatting helpers.
  if (value.type === 'CallExpression' && HELPER_CALLS.has(directCallName(value) ?? '')) {
    value.arguments.forEach((argument) => collectAwaitedWorkers(argument, into));
  }
}

/**
 * The Worker calls the script definitely reaches, or null when a top-level
 * statement is more than a dispatch or a formatting step: a branch, function,
 * loop or early return could leave a call unexecuted.
 */
function executedWorkerCalls(program: ProgramNode): Set<AnyNode> | null {
  const executed = new Set<AnyNode>();
  for (const statement of program.body) {
    if (statement.type === 'VariableDeclaration') {
      for (const declaration of statement.declarations) {
        if (declaration.init) {
          collectAwaitedWorkers(declaration.init, executed);
        }
      }
      continue;
    }
    if (statement.type === 'ExpressionStatement') {
      collectAwaitedWorkers(statement.expression, executed);
      continue;
    }
    return null;
  }
  return executed;
}

/**
 * Whether the program only calls the accepted helpers and, for every Worker
 * call, one it definitely awaits. New expressions, assignments, tagged
 * templates, imports and bound aliases are execution forms a dispatch never
 * needs, so they make the script unreadable.
 */
function isPlainScript(program: ProgramNode, executed: Set<AnyNode>): boolean {
  let plain = true;
  const inspect = (value: unknown) => {
    if (!plain) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const node = value as AnyNode;
    if (node.type === 'NewExpression' || node.type === 'TaggedTemplateExpression'
      || node.type === 'AssignmentExpression' || node.type === 'ImportExpression') {
      plain = false;
      return;
    }
    if (node.type === 'CallExpression') {
      const name = directCallName(node);
      if (!name || (!HELPER_CALLS.has(name) && !AGGREGATE_CALLS.has(name) && !name.startsWith(WORKER_CALL_PREFIX))) {
        plain = false;
        return;
      }
      if (name.startsWith(WORKER_CALL_PREFIX) && !executed.has(node)) {
        plain = false;
        return;
      }
      node.arguments.forEach(inspect);
      return;
    }
    // Property names are not references, so only computed keys are inspected.
    if (node.type === 'MemberExpression') {
      inspect(node.object);
      if (node.computed) {
        inspect(node.property);
      }
      return;
    }
    if (node.type === 'Property') {
      if (node.computed) {
        inspect(node.key);
      }
      inspect(node.value);
      return;
    }
    if (node.type === 'Identifier' && RESERVED_IDENTIFIERS.has(node.name)) {
      plain = false;
      return;
    }
    Object.values(node).forEach(inspect);
  };
  inspect(program);
  return plain;
}

/** Whether every call the script makes is one it definitely runs. */
function isWorkerOnlyScript(source: string): boolean {
  const program = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  }) as ProgramNode;
  const executed = executedWorkerCalls(program);
  return Boolean(executed && executed.size > 0 && isPlainScript(program, executed));
}

/**
 * The script from a persisted call's raw input, or the `{ code }` a live call
 * carries (possibly behind one JSON layer).
 */
function readScript(toolInput: unknown): string | null {
  if (isRecord(toolInput)) {
    return typeof toolInput.code === 'string' && toolInput.code.trim() ? toolInput.code : null;
  }
  if (typeof toolInput !== 'string' || !toolInput.trim()) {
    return null;
  }
  if (toolInput.trim().startsWith('{')) {
    const wrapped = parseJson(toolInput);
    if (isRecord(wrapped) && typeof wrapped.code === 'string' && wrapped.code.trim()) {
      return wrapped.code;
    }
  }
  return toolInput;
}

// ---------------------------
// Result judgement

/** A normal timing line that may follow the completion header, with or without its colon. */
const WALL_TIME_LINE = /^Wall time:?[ \t]*[\d:.]+[ \t]*(?:seconds?|s)?[ \t]*(?:\r?\n|$)/i;

/** Strips a genuine `Script completed` envelope; null for any other result. */
function readCompletedBody(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  // A live result can be the same envelope stringified as one JSON layer.
  const candidate = value.trimStart().startsWith('Script') ? value : parseJson(value);
  if (typeof candidate !== 'string') {
    return null;
  }
  const text = candidate.trimStart();
  const header = /^Script completed[ \t]*(?:\r?\n|$)/.exec(text);
  if (!header) {
    return null;
  }
  return text
    .slice(header[0].length)
    .replace(WALL_TIME_LINE, '')
    .replace(/^Output:[ \t]*(?:\r?\n|$)/, '');
}

/** The body's JSON values: one document or one per line; null for anything else. */
function readJsonValues(text: string): unknown[] | null {
  try {
    return [JSON.parse(text)];
  } catch {
    // Worker scripts can print one result per line instead of one document.
  }
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const values: unknown[] = [];
  for (const line of lines) {
    try {
      values.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return values.length > 0 ? values : null;
}

/** A Worker record, or a run/receipt/notification with run identity and lifecycle status. */
function isWorkerRecord(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.id === 'string' && typeof value.taskName === 'string') {
    return true;
  }
  if (typeof value.workerId !== 'string' || typeof value.status !== 'string' || !WORKER_STATUSES.has(value.status)) {
    return false;
  }
  return typeof value.runId === 'string' || typeof value.id === 'string';
}

/**
 * A real Worker protocol payload: a run or worker record, the single-field
 * receipts `worker_ack` and the compact plan view return, an MCP text item
 * wrapping one, or a collection of those. Other objects and text are refused.
 */
function isWorkerPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isWorkerPayload);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (isWorkerRecord(value)) {
    return true;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && (typeof value.acknowledged === 'number' || typeof value.updatedAt === 'string')) {
    return true;
  }
  if (typeof value.updatedAt === 'string' && typeof value.content === 'string') {
    return true;
  }
  if (value.type === 'text' && typeof value.text === 'string') {
    return isWorkerPayload(parseJson(value.text));
  }
  if (isRecord(value.worker)) {
    return isWorkerPayload(value.worker);
  }
  if (Array.isArray(value.workers)) {
    return value.workers.every(isWorkerPayload);
  }
  if (Array.isArray(value.activeWorkers)) {
    return value.activeWorkers.every(isWorkerPayload);
  }
  if (Array.isArray(value.content)) {
    return value.content.length > 0 && value.content.every(isWorkerPayload);
  }
  return false;
}

/** Whether a value carries an error itself rather than an empty placeholder. */
function isRealError(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return Boolean(value);
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return isRecord(value) && Object.keys(value).length > 0;
}

/**
 * Whether Worker protocol data reports a failure: an errored tool result, an
 * error or diagnostic message, a failed run status or a non-zero exit code.
 */
function reportsFailure(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(reportsFailure);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value.isError === true || value.success === false || isRealError(value.error) || isRealError(value.message)) {
    return true;
  }
  if (typeof value.status === 'string' && FAILING_STATUSES.has(value.status.trim().toLowerCase())) {
    return true;
  }
  if (typeof value.exitCode === 'number' && value.exitCode !== 0) {
    return true;
  }
  if (value.type === 'text' && typeof value.text === 'string') {
    return reportsFailure(parseJson(value.text));
  }
  return Object.values(value).some(reportsFailure);
}

/**
 * Whether a confirmed completion printed a clean Worker protocol payload. An
 * empty completion is kept: printing nothing is not evidence of success.
 */
function isCleanWorkerOutput(body: string): boolean {
  const text = body.trim();
  if (!text) {
    return false;
  }
  const values = readJsonValues(text);
  return values !== null && values.every((value) => isWorkerPayload(value) && !reportsFailure(value));
}

/**
 * Whether a Codex `exec` row is only routine Worker bookkeeping, so chat's
 * ChatMessagesPane can drop it. Every unconfirmed case keeps its card: a
 * missing or failed result, a mixed or deferred script, non-Worker output, and
 * any Worker failure reported inside the payload.
 */
export function shouldHideWorkerExec(message: ChatMessage): boolean {
  if (message.isToolUse !== true || message.toolName !== 'exec') {
    return false;
  }
  if (message.toolStatus === 'failed') {
    return false;
  }
  const result = message.toolResult;
  if (!result || result.isError === true) {
    return false;
  }
  try {
    // Confirm the run's own report before reading the script at all.
    const body = readCompletedBody(result.content);
    if (body === null) {
      return false;
    }
    const script = readScript(message.toolInput);
    if (!script || !isWorkerOnlyScript(script)) {
      return false;
    }
    return isCleanWorkerOutput(body);
  } catch {
    // A script or payload this cannot read is not a routine success.
    return false;
  }
}
