import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  sessionDraftsDb,
  sessionRuntimeDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  handleChatConnection,
  runDetachedChatTurn,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';
import type { AnyRecord, CodexSessionState, ProviderRuntimeGateway } from '@/shared/index.js';

const MARKDOWN = '# Approved plan\n\nFirst paragraph.\n\n- step `one`\n- 中文\n\n```ts\nconsole.log(1);\n```';

type Harness = {
  sessionId: string;
  userId: number;
  frames: AnyRecord[];
  runs: AnyRecord[];
  aborts: string[];
  state: CodexSessionState;
  send(data: AnyRecord): void;
  detached(options: AnyRecord): ReturnType<typeof runDetachedChatTurn>;
};

async function harness(
  provider: 'codex' | 'claude',
  options: { phase?: CodexSessionState['phase'] } = {},
  runTest: (h: Harness) => Promise<void>,
): Promise<void> {
  const previous = await mkdtemp(path.join(os.tmpdir(), 'codex-plan-'));
  const previousDb = process.env.DATABASE_PATH;
  const previousMode = process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
  closeConnection();
  process.env.DATABASE_PATH = path.join(previous, 'auth.db');
  // The handoff must force the native runtime even when the deployment default
  // names the SDK-compat mode.
  process.env.CLOUDCLI_CODEX_RUNTIME_MODE = 'sdk';
  await initializeDatabase();

  const sessionId = `plan-${provider}-${options.phase ?? 'idle'}`;
  const userId = Number(userDb.createUser(`plan-${provider}-${options.phase ?? 'idle'}`, 'hash').id);
  sessionsDb.createAppSession(sessionId, provider, previous);

  const state: CodexSessionState = {
    runtime: 'app-server',
    mode: 'default',
    phase: options.phase ?? 'idle',
    turnId: null,
    goal: null,
    questions: [],
  };
  const runs: AnyRecord[] = [];
  const aborts: string[] = [];
  const runtime: ProviderRuntimeGateway = {
    hasRuntime: () => true,
    hasBackgroundWork: () => false,
    getState: () => state,
    getPendingApprovalsForSession: () => [],
    resolveToolApproval: () => {},
    stopBackgroundTask: async () => false,
    abort: async (abortedProvider: string) => { aborts.push(abortedProvider); return true; },
    async run(runProvider: string, content: string, runOptions: AnyRecord) {
      runs.push({ provider: runProvider, content, options: runOptions });
    },
  } as never;

  const frames: AnyRecord[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    send(text: string) { frames.push(JSON.parse(text) as AnyRecord); },
  });
  handleChatConnection(socket as never, { user: { id: userId } } as never, { runtime });

  try {
    await runTest({
      sessionId, userId, frames, runs, aborts, state,
      send(data) { socket.emit('message', JSON.stringify({ sessionId, ...data })); },
      detached(detachedOptions) {
        return runDetachedChatTurn(
          { sessionId, userId, content: 'scheduled text', options: detachedOptions },
          { runtime },
        );
      },
    });
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    if (previousMode === undefined) delete process.env.CLOUDCLI_CODEX_RUNTIME_MODE;
    else process.env.CLOUDCLI_CODEX_RUNTIME_MODE = previousMode;
    await rm(previous, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 20); });

function lastFrame(frames: AnyRecord[]): AnyRecord | undefined {
  return frames.at(-1);
}

test('a valid plan on a new Codex target runs natively and saves its route', async () => {
  await harness('codex', {}, async (h) => {
    h.send({
      type: 'chat.send',
      content: 'run the plan',
      options: { clientMessageId: 'client-plan-1', approvedPlan: { markdown: MARKDOWN } },
    });
    await settle();

    assert.equal(h.runs.length, 1, 'the plan turn was dispatched');
    assert.equal(h.frames.some((frame) => frame.kind === 'chat_queued'), false);
    assert.equal(h.runs[0].options.approvedPlan.markdown, MARKDOWN, 'markdown is delivered verbatim');
    assert.equal(h.runs[0].options.clientMessageId, 'client-plan-1');
    const settings = sessionRuntimeDb.get(h.sessionId);
    assert.equal(settings.runtime, 'app-server', 'the target switches to the native runtime');
    assert.equal(settings.mode, 'default');
    assert.equal(settings.modelSelection, undefined);
  });
});

test('a plan that names a model route saves exactly that route', async () => {
  await harness('codex', {}, async (h) => {
    const modelSelection = { modelProvider: 'gateway-a', model: 'model-x' };
    h.send({
      type: 'chat.send',
      content: 'run the plan',
      options: { approvedPlan: { markdown: MARKDOWN, modelSelection } },
    });
    await settle();

    assert.equal(h.runs.length, 1);
    assert.deepEqual(h.runs[0].options.approvedPlan, { markdown: MARKDOWN, modelSelection });
    assert.deepEqual(sessionRuntimeDb.get(h.sessionId).modelSelection, modelSelection);
  });
});

test('a plan on a busy session is refused instead of queued', async () => {
  await harness('codex', { phase: 'running' }, async (h) => {
    h.send({ type: 'chat.send', content: 'run the plan', options: { approvedPlan: { markdown: MARKDOWN } } });
    await settle();

    assert.equal(lastFrame(h.frames)?.code, 'APPROVED_PLAN_BUSY');
    assert.equal(h.runs.length, 0);
    assert.equal(sessionDraftsDb.hasQueuedMessages(h.sessionId), false);
  });
});

test('a plan on a session that already has a native thread is refused', async () => {
  await harness('codex', {}, async (h) => {
    sessionsDb.assignProviderSessionId(h.sessionId, 'native-thread-1');
    h.send({ type: 'chat.send', content: 'run the plan', options: { approvedPlan: { markdown: MARKDOWN } } });
    await settle();

    assert.equal(lastFrame(h.frames)?.code, 'APPROVED_PLAN_REQUIRES_NEW_THREAD');
    assert.equal(h.runs.length, 0);
  });
});

test('a plan on another provider and a malformed plan are refused', async () => {
  await harness('claude', {}, async (h) => {
    h.send({ type: 'chat.send', content: 'run the plan', options: { approvedPlan: { markdown: MARKDOWN } } });
    await settle();
    assert.equal(lastFrame(h.frames)?.code, 'APPROVED_PLAN_UNSUPPORTED');
    assert.equal(h.runs.length, 0);
  });
  await harness('codex', {}, async (h) => {
    h.send({ type: 'chat.send', content: 'run the plan', options: { approvedPlan: { markdown: '   ' } } });
    await settle();
    assert.equal(lastFrame(h.frames)?.code, 'INVALID_APPROVED_PLAN');
    assert.equal(h.runs.length, 0);
  });
});

test('an edited message refuses a plan before any run or rewind', async () => {
  await harness('codex', {}, async (h) => {
    h.send({
      type: 'chat.edit-send',
      content: 'replacement',
      anchorId: 'message-1',
      options: { approvedPlan: { markdown: MARKDOWN } },
    });
    await settle();

    assert.equal(lastFrame(h.frames)?.code, 'APPROVED_PLAN_UNSUPPORTED');
    // Refused before the anchor lookup could report the anchor first.
    assert.equal(h.frames.some((frame) => frame.code === 'ANCHOR_REQUIRED'), false);
    assert.equal(h.frames.some((frame) => frame.kind === 'history_truncated'), false);
    assert.equal(h.runs.length, 0);
  });
});

test('a detached or queued turn refuses a plan before aborting anything', async () => {
  await harness('codex', { phase: 'running' }, async (h) => {
    const result = await h.detached({ approvedPlan: { markdown: MARKDOWN } });
    assert.equal(result.started, false);
    assert.match(result.error ?? '', /approved plan/i);
    assert.deepEqual(h.aborts, [], 'no run is aborted');
    assert.equal(h.runs.length, 0);
  });
});
