import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { readDraftText, readQueuedMessage, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type * as ChatDrafts from '@/shared/chatDrafts';
import type { BackgroundSendChoice, PermissionMode, Project, ProjectSession, SessionActivityMap } from '@/shared/types';

/**
 * A session whose turn has ended with background work still running keeps
 * its composer usable — but a new turn replaces the CLI process that work
 * runs under, so the work is stopped or finishes where nothing listens. The
 * composer says so and asks before sending: send anyway, queue the message
 * until the work finishes (the server holds it while the work runs), or
 * cancel.
 */

const { writeQueuedMessage } = vi.hoisted(() => ({ writeQueuedMessage: vi.fn() }));

vi.mock('@/shared/chatDrafts', async (importOriginal) => {
  const actual = await importOriginal<typeof ChatDrafts>();
  return {
    ...actual,
    writeQueuedMessage: (...args: Parameters<typeof actual.writeQueuedMessage>) => {
      writeQueuedMessage(...args);
      actual.writeQueuedMessage(...args);
    },
  };
});

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };
const UPLOADED = { name: 'notes.txt', path: '/uploads/notes.txt', mimeType: 'text/plain', size: 5 };

const backgroundOnly: SessionActivityMap = new Map([[
  'session-1',
  {
    statusText: null,
    canInterrupt: false,
    startedAt: 1,
    background: true,
    tasks: [
      { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Audit the frontend', workflowName: 'frontend-architecture-audit', startedAt: 1 },
      { taskId: 'b1', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: 2, nested: true },
      { taskId: 'a1', toolUseId: 'toolu_agent', taskType: 'local_agent', description: 'Survey the repo', startedAt: 3 },
    ],
  },
]]);

const uploads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/assets/files'));

const render = (processingSessions: SessionActivityMap) => {
  const sent: Array<{ type: string; anchorId?: string }> = [];
  const view = renderHook(({ session }) =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: session,
      currentSessionId: session.id,
      provider: 'claude',
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: false,
      processingSessions,
      canAbortSession: false,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string }); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    { initialProps: { session: SESSION } },
  );
  const sends = () => sent.filter((message) => message.type === 'chat.send');
  return { view, sends, frames: () => sent };
};

type View = ReturnType<typeof render>['view'];

const startSubmit = (view: View) => {
  let pending!: Promise<void>;
  act(() => {
    pending = view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
  return pending;
};

// Submits, waits for the prompt, answers it, and lets the submit finish.
const submitAndAnswer = async (view: View, choice: BackgroundSendChoice) => {
  const pending = startSubmit(view);
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt(choice);
    await pending;
  });
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes('/api/assets/files')) {
      return new Response(JSON.stringify({ attachments: [UPLOADED] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  // The drafts store is module state; a message queued by one test must not
  // be restored into the next one's composer.
  resetChatDrafts();
  writeQueuedMessage.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('sending on a session with background work asks first, naming the session\'s own tasks', async () => {
  const { view, sends } = render(backgroundOnly);
  await act(async () => { view.result.current.setInput('hello'); });

  const pending = startSubmit(view);
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));

  assert.deepEqual(view.result.current.backgroundSendPrompt, {
    work: ['Workflow frontend-architecture-audit', 'Agent Survey the repo'],
  });
  assert.equal(sends().length, 0, 'nothing is sent while the prompt is open');

  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt('cancel');
    await pending;
  });
});

test('cancel (the default answer to Enter, Esc or a click outside) sends nothing and keeps the draft', async () => {
  const { view, sends } = render(backgroundOnly);
  await act(async () => { view.result.current.setInput('hello'); });

  await submitAndAnswer(view, 'cancel');

  assert.equal(sends().length, 0, 'declined: nothing is sent');
  assert.equal(writeQueuedMessage.mock.calls.length, 0, 'and nothing is queued');
  assert.equal(view.result.current.input, 'hello', 'and the draft stays in the composer');
  assert.equal(view.result.current.backgroundSendPrompt, null, 'and the prompt closes');
});

test('queue persists the message behind the work with its uploaded files, sends nothing, and clears the composer', async () => {
  const { view, sends } = render(backgroundOnly);
  await act(async () => {
    view.result.current.setInput('hello');
    view.result.current.setAttachedFiles([new File(['notes'], 'notes.txt', { type: 'text/plain' })]);
  });

  await submitAndAnswer(view, 'queue');

  assert.equal(sends().length, 0, 'queued: nothing is sent now');
  assert.equal(uploads().length, 1, 'the files uploaded before the prompt are not uploaded again');
  // Written synchronously at queue time (and again, identically, by the
  // composer's persistence effect — the same as queueing during a turn).
  assert.ok(writeQueuedMessage.mock.calls.length >= 1);
  assert.equal(writeQueuedMessage.mock.calls[0]?.[0], 'session-1');
  const stored = readQueuedMessage('session-1');
  assert.ok(stored?.id, 'the background queue has a durable ticket');
  assert.equal(stored.id, view.result.current.queuedDraft?.id, 'the store and composer retain the same ticket');
  assert.ok(writeQueuedMessage.mock.calls.every(([, draft]) => draft.id === stored.id));
  assert.equal(stored?.content, 'hello');
  assert.deepEqual(stored?.attachments, [UPLOADED]);
  assert.equal(stored?.options?.model, 'test-model');
  assert.equal(view.result.current.queuedDraft?.content, 'hello', 'the queued card shows the message');
  assert.equal(view.result.current.input, '', 'and the composer is cleared, as when queueing during a turn');
  assert.equal(view.result.current.attachedFiles.length, 0);
});

test('send anyway sends the message', async () => {
  const { view, sends } = render(backgroundOnly);
  await act(async () => { view.result.current.setInput('hello'); });

  await submitAndAnswer(view, 'send');

  assert.equal(sends().length, 1);
  assert.equal(writeQueuedMessage.mock.calls.length, 0);
});

test('an edit cannot be queued as an ordinary new message behind background work', async () => {
  const { view, frames } = render(backgroundOnly);
  await act(async () => {
    view.result.current.beginEditMessage({ type: 'user', content: 'replacement', transcriptAnchorId: 'turn-to-replace', timestamp: 1 });
  });
  await submitAndAnswer(view, 'queue');

  assert.equal(writeQueuedMessage.mock.calls.length, 0, 'a queued append must not silently replace the requested edit');
  assert.equal(frames().length, 0);
  assert.equal(view.result.current.input, 'replacement');
  assert.equal(view.result.current.editingAnchorId, 'turn-to-replace');
});

test('sending an edit over background work preserves its replacement anchor', async () => {
  const { view, frames } = render(backgroundOnly);
  await act(async () => {
    view.result.current.beginEditMessage({ type: 'user', content: 'replacement', transcriptAnchorId: 'turn-to-replace', timestamp: 1 });
  });
  const pending = startSubmit(view);
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
  assert.equal(view.result.current.backgroundSendPrompt?.canQueue, false);
  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt('send');
    await pending;
  });

  const edits = frames().filter((frame) => frame.type === 'chat.edit-send');
  assert.equal(edits.length, 1);
  assert.equal(edits[0].anchorId, 'turn-to-replace');
  assert.equal(view.result.current.editingAnchorId, null);
});

test('a second submit while the prompt is open neither opens another prompt nor sends', async () => {
  const { view, sends } = render(backgroundOnly);
  await act(async () => { view.result.current.setInput('hello'); });

  const first = startSubmit(view);
  await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));
  const prompt = view.result.current.backgroundSendPrompt;

  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });
  assert.equal(view.result.current.backgroundSendPrompt, prompt, 'the same prompt is still the open one');
  assert.equal(sends().length, 0);

  await act(async () => {
    view.result.current.resolveBackgroundSendPrompt('cancel');
    await first;
  });
  assert.equal(sends().length, 0, 'exactly zero sends');
});

for (const staleChoice of ['send', 'queue'] as const) {
  test(`switching sessions cancels the background prompt and ignores a stale ${staleChoice} choice`, async () => {
    const { view, sends } = render(backgroundOnly);
    writeDraftText('session-2', 'keep the other conversation draft');
    await act(async () => { view.result.current.setInput('message for the first conversation'); });
    const pending = startSubmit(view);
    await waitFor(() => assert.notEqual(view.result.current.backgroundSendPrompt, null));

    await act(async () => { view.rerender({ session: { id: 'session-2' } }); });
    assert.equal(view.result.current.backgroundSendPrompt, null, 'the old session prompt closes');
    await act(async () => {
      view.result.current.resolveBackgroundSendPrompt(staleChoice);
      await pending;
    });

    assert.equal(sends().length, 0, 'the abandoned submission does not send');
    assert.equal(writeQueuedMessage.mock.calls.length, 0, 'the abandoned submission does not queue');
    assert.equal(view.result.current.input, 'keep the other conversation draft');
    assert.equal(readDraftText('session-2'), 'keep the other conversation draft');
    assert.equal(readDraftText(SESSION.id), 'message for the first conversation');
  });
}

test('a session with nothing in the background sends without asking', async () => {
  const { view, sends } = render(new Map());
  await act(async () => { view.result.current.setInput('hello'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  assert.equal(view.result.current.backgroundSendPrompt, null);
  assert.equal(sends().length, 1);
});
