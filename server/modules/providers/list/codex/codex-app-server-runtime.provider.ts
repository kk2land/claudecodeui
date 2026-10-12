import { randomUUID } from 'node:crypto';

import { createCodexAppServerClient } from '@/modules/providers/list/codex/codex-app-server.client.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { appendFilesInputTag, buildCodexInputItems, normalizeImageDescriptors, createCompleteMessage, createNormalizedMessage } from '@/shared/index.js';
import type { AnyRecord, CodexAppServerConnection, ProviderPermissionDecision, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

type ActiveRun = {
  client: CodexAppServerConnection | null;
  threadId: string | null;
  turnId: string | null;
  aborted: boolean;
  finished: boolean;
  ready: Promise<void>;
  writer: ProviderRuntimeWriter;
  cwd: string;
  cancel(): void;
  controls: Set<Promise<AnyRecord>>;
};
const activeRuns = new Map<string, ActiveRun>();
const pendingRequests = new Map<string, {
  sessionId: string;
  rpcId: string | number;
  method: string;
  params: AnyRecord;
  message: AnyRecord;
  run: ActiveRun;
}>();

function send(writer: ProviderRuntimeWriter, message: unknown) {
  writer.send(writer.isWebSocketWriter ? message : JSON.stringify(message));
}

function buildInput(command: string, options: AnyRecord, cwd: string) {
  const prompt = appendFilesInputTag(command, options.files);
  const images = normalizeImageDescriptors(options.images);
  return buildCodexInputItems(prompt.trim() || (images.length ? 'Please analyze the attached image(s).' : ''), images, cwd)
    .map((item) => item.type === 'local_image' ? { ...item, type: 'localImage' } : item);
}

function clearRequest(requestId: string) {
  const request = pendingRequests.get(requestId);
  if (!request) return;
  pendingRequests.delete(requestId);
  send(request.run.writer, createNormalizedMessage({
    kind: 'permission_resolved', requestId, sessionId: request.sessionId, provider: 'codex',
  }));
}

function resolvePermission(requestId: string, decision: ProviderPermissionDecision) {
  const request = pendingRequests.get(requestId);
  if (!request || request.run.finished || request.run.aborted) return;
  let response: AnyRecord;
  if (request.method === 'item/tool/requestUserInput') {
    const supplied = (decision.updatedInput as AnyRecord | undefined)?.answers ?? {};
    const answers: AnyRecord = {};
    for (const question of request.params.questions ?? []) {
      const answer = supplied[question.id] ?? supplied[question.question];
      answers[question.id] = { answers: decision.allow && typeof answer === 'string' && answer.trim() ? [answer] : [] };
    }
    response = { answers };
  } else {
    response = { decision: decision.allow ? 'accept' : 'decline' };
  }
  request.run.client?.respond(request.rpcId, response);
  clearRequest(requestId);
}

/** Used by codexRuntime when CODEX_RUNTIME selects app-server, including live steer and approvals. */
export const codexAppServerRuntime = {
  async run(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext) {
    const sessionId = options.sessionId as string | undefined;
    const providerSessionId = context.resolveProviderSessionId(sessionId);
    const cwd = options.cwd || options.projectPath || process.cwd();
    let key = sessionId || providerSessionId || randomUUID();
    let releaseReady!: () => void;
    const run: ActiveRun = {
      client: null, threadId: providerSessionId, turnId: null, aborted: false, finished: false,
      ready: new Promise<void>((resolve) => { releaseReady = resolve; }), writer, cwd,
      cancel: () => {},
      controls: new Set(),
    };
    activeRuns.set(key, run);
    let finish!: (turn: AnyRecord) => void;
    let fail!: (error: Error) => void;
    const completion = new Promise<AnyRecord>((resolve, reject) => { finish = resolve; fail = reject; });
    run.cancel = () => { releaseReady(); finish({ status: 'interrupted' }); };
    // Failures can arrive during initialization, before we await completion.
    void completion.catch(() => {});
    const items = new Map<string, AnyRecord>();
    const emit = (message: AnyRecord) => send(writer, createNormalizedMessage({ ...message, kind: message.kind, sessionId: sessionId || run.threadId, provider: 'codex' }));
    const emitItem = (item: AnyRecord) => {
      if (item.type === 'userMessage') return; // chat.send already has an optimistic echo; steer echoes on acceptance.
      if (item.type === 'plan') {
        if (item.text) emit({ id: item.id, kind: 'tool_use', toolName: 'ExitPlanMode', toolId: item.id, toolInput: { plan: item.text } });
        return;
      }
      const itemType = ({ agentMessage: 'agent_message', commandExecution: 'command_execution', fileChange: 'file_change', mcpToolCall: 'mcp_tool_call', webSearch: 'web_search' } as Record<string, string>)[item.type] || item.type;
      const transformed: AnyRecord = {
        type: 'item', itemType, itemId: item.id, item,
        message: { content: item.type === 'reasoning' ? (item.summary ?? []).join('\n') : item.text },
        command: item.command, output: item.aggregatedOutput, exitCode: item.exitCode,
        status: item.status === 'inProgress' ? 'in_progress' : item.status,
        changes: (item.changes ?? []).map((change: AnyRecord) => ({ ...change, kind: change.kind?.type ?? change.kind })),
        server: item.server, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error,
        query: item.query,
      };
      if ((itemType === 'agent_message' || itemType === 'reasoning') && !transformed.message.content) return;
      for (const message of context.normalizeMessage(transformed, sessionId || run.threadId)) send(writer, message);
    };
    const onMessage = (message: AnyRecord) => {
      if (run.aborted || run.finished) return;
      const params = message.params ?? {};
      if (params.threadId && run.threadId && params.threadId !== run.threadId) return;
      if (message.id !== undefined) {
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'].includes(message.method)) {
          const requestId = `codex:${key}:${message.id}`;
          const toolName = message.method === 'item/tool/requestUserInput' ? 'AskUserQuestion'
            : message.method === 'item/fileChange/requestApproval' ? 'Edit' : 'Bash';
          const input = toolName === 'AskUserQuestion'
            ? { questions: (params.questions ?? []).map((question: AnyRecord) => ({ ...question, options: question.options ?? [] })) }
            : { command: params.command, reason: params.reason, changes: items.get(params.itemId)?.changes };
          const prompt = { kind: 'permission_request', requestId, toolName, input, sessionId: sessionId || run.threadId, provider: 'codex' };
          pendingRequests.set(requestId, { sessionId: key, rpcId: message.id, method: message.method, params, message: prompt, run });
          emit(prompt);
        } else if (message.method === 'item/permissions/requestApproval') {
          run.client?.respond(message.id, { permissions: {}, scope: 'turn' });
        } else if (message.method === 'mcpServer/elicitation/request') {
          run.client?.respond(message.id, { action: 'decline', content: null });
        } else {
          run.client?.respondError(message.id, `CloudCLI does not support ${message.method}.`);
        }
        return;
      }
      switch (message.method) {
        case 'turn/started': run.turnId = params.turn?.id ?? run.turnId; break;
        case 'turn/completed':
          if (!run.turnId || params.turn?.id === run.turnId) { run.finished = true; finish(params.turn); }
          break;
        case 'item/started':
        case 'item/completed':
          items.set(params.item.id, params.item);
          emitItem(params.item);
          break;
        case 'item/agentMessage/delta':
        case 'item/plan/delta': {
          const type = message.method === 'item/plan/delta' ? 'plan' : 'agentMessage';
          const item = items.get(params.itemId) ?? { id: params.itemId, type, text: '' };
          item.text = (item.text ?? '') + (params.delta ?? '');
          items.set(item.id, item);
          emitItem(item);
          break;
        }
        case 'item/reasoning/summaryTextDelta': {
          const item = items.get(params.itemId) ?? { id: params.itemId, type: 'reasoning', summary: [] };
          const index = params.summaryIndex ?? 0;
          item.summary[index] = (item.summary[index] ?? '') + (params.delta ?? '');
          items.set(item.id, item);
          emitItem(item);
          break;
        }
        case 'item/commandExecution/outputDelta': {
          const item = items.get(params.itemId);
          if (item) { item.aggregatedOutput = (item.aggregatedOutput ?? '') + (params.delta ?? ''); emitItem(item); }
          break;
        }
        case 'turn/plan/updated':
          emit({ id: `${params.turnId}_plan`, kind: 'tool_use', toolName: 'TodoWrite', toolId: `${params.turnId}_plan`, toolInput: { todos: (params.plan ?? []).map((step: AnyRecord) => ({ content: step.step, status: step.status === 'inProgress' ? 'in_progress' : step.status })) } });
          break;
        case 'thread/tokenUsage/updated': {
          const usage = params.tokenUsage ?? {};
          const total = usage.total ?? {};
          emit({ kind: 'status', text: 'token_budget', tokenBudget: {
            used: total.totalTokens ?? 0, total: usage.modelContextWindow ?? 200000,
            inputTokens: total.inputTokens ?? 0, outputTokens: total.outputTokens ?? 0,
            breakdown: { input: total.inputTokens ?? 0, output: total.outputTokens ?? 0 },
          } });
          break;
        }
        case 'serverRequest/resolved':
          clearRequest(`codex:${key}:${params.requestId}`);
          break;
        // Retryable errors are progress; only turn/completed determines terminal failure.
        case 'error':
          if (!params.willRetry) emit({ kind: 'error', content: params.error?.message || 'Codex app-server error' });
          break;
      }
    };
    try {
      const model = await context.resolveResumeModel(sessionId, options.model);
      if (run.aborted) return;
      run.client = (context.createCodexAppServer ?? createCodexAppServerClient)({ cwd, onMessage, onExit: fail });
      await run.client.initialize(true);
      if (run.aborted) return;
      const permissionMode = options.permissionMode ?? 'default';
      const thread = await run.client.call(providerSessionId ? 'thread/resume' : 'thread/start', {
        ...(providerSessionId ? { threadId: providerSessionId } : {}), cwd, model,
        sandbox: permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write',
        approvalPolicy: permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request',
      });
      if (run.aborted) return;
      run.threadId = thread.thread?.id;
      if (!run.threadId) throw new Error('Codex app-server returned no thread id.');
      if (!sessionId && !providerSessionId) {
        activeRuns.delete(key); key = run.threadId; activeRuns.set(key, run);
      }
      writer.setSessionId?.(run.threadId);
      if (!providerSessionId) emit({ kind: 'session_created', newSessionId: run.threadId });
      const planCommand = command.match(/^\/plan(?:\s+([\s\S]*))?$/);
      const catalog = await context.getProviderModels();
      const selected = catalog.OPTIONS.find((entry) => entry.value === (model || thread.model));
      const effort = selected?.effort?.values.some((entry) => entry.value === options.effort) ? options.effort : null;
      const turn = await run.client.call('turn/start', {
        threadId: run.threadId, input: buildInput(planCommand ? planCommand[1] || 'Create an implementation plan for this project.' : command, options, cwd),
        collaborationMode: { mode: permissionMode === 'plan' || planCommand ? 'plan' : 'default', settings: {
          model: model || thread.model, reasoning_effort: effort, developer_instructions: null,
        } },
      });
      run.turnId = turn.turn?.id ?? run.turnId;
      if (!run.turnId) throw new Error('Codex app-server returned no turn id.');
      releaseReady();
      const result = await completion;
      if (run.aborted) return;
      // A final notification can overtake a steer reply. Keep the child alive until
      // those replies settle so accepted guidance is echoed before terminal completion.
      await Promise.allSettled([...run.controls]);
      const failed = result.status === 'failed';
      if (failed) {
        emit({ kind: 'error', content: result.error?.message || 'Codex turn failed.' });
        notifyRunFailed({ userId: writer.userId || null, provider: 'codex', sessionId: options.sessionId || run.threadId, sessionName: options.sessionSummary, error: result.error });
      } else if (result.status === 'completed') {
        notifyRunStopped({ userId: writer.userId || null, provider: 'codex', sessionId: options.sessionId || run.threadId, sessionName: options.sessionSummary, stopReason: 'completed' });
      }
      send(writer, createCompleteMessage({ provider: 'codex', sessionId: sessionId || run.threadId, actualSessionId: run.threadId, exitCode: failed ? 1 : 0, aborted: result.status === 'interrupted' }));
    } catch (error) {
      if (!run.aborted) {
        emit({ kind: 'error', content: error instanceof Error ? error.message : String(error) });
        send(writer, createCompleteMessage({ provider: 'codex', sessionId: sessionId || run.threadId, exitCode: 1 }));
        notifyRunFailed({ userId: writer.userId || null, provider: 'codex', sessionId: options.sessionId || run.threadId, sessionName: options.sessionSummary, error });
      }
    } finally {
      run.finished = true;
      releaseReady();
      for (const [requestId, request] of pendingRequests) if (request.run === run) clearRequest(requestId);
      run.client?.close();
      if (activeRuns.get(key) === run) activeRuns.delete(key);
    }
  },
  async steer(sessionId: string, command: string, options: AnyRecord) {
    const run = activeRuns.get(sessionId);
    if (!run) return false;
    await run.ready;
    if (!run.client || !run.threadId || !run.turnId || run.finished || run.aborted) return false;
    const steering = run.client.call('turn/steer', { threadId: run.threadId, expectedTurnId: run.turnId, input: buildInput(command, options, run.cwd) });
    run.controls.add(steering);
    try { await steering; } finally { run.controls.delete(steering); }
    send(run.writer, createNormalizedMessage({
      // Accepted steer input gets a transient echo; history reconciliation retires local_ ids.
      id: `local_${randomUUID()}`, kind: 'text', role: 'user', content: command.trim() || (options.images?.length ? 'Please analyze the attached image(s).' : command),
      images: options.images, files: options.files, provider: 'codex', sessionId,
    }));
    return true;
  },
  async abort(sessionId: string) {
    const run = activeRuns.get(sessionId);
    if (!run || run.finished) return false;
    run.aborted = true;
    // Closing the transport also breaks initialization or a turn/start still waiting for its reply.
    if (run.client && run.threadId && run.turnId) {
      try { await run.client.call('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }); } catch { /* closing below cancels a broken child */ }
    }
    run.cancel();
    run.client?.close();
    return true;
  },
  permissions: {
    resolve: resolvePermission,
    listPending(sessionId: string) { return [...pendingRequests.values()].filter((entry) => entry.sessionId === sessionId).map((entry) => entry.message); },
  },
};
