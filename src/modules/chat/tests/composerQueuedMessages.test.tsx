import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import {
  hydrateChatDrafts,
  readQueuedMessages,
  resetChatDrafts,
  writeQueuedMessage,
} from '@/shared/chatDrafts';
import { MAX_QUEUED_MESSAGES } from '@/shared/constants';
import type { ChatMessage, LLMProvider, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * A busy session accepts up to three pending messages, in the order they were
 * sent. These tests drive the real hook so the queueing branch, the durable
 * store and the per-card edit/delete handlers are exercised together.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };

vi.mock('@/shared/api', () => {
  const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });
  return {
    api: {
      user: {
        drafts: () => okJson({ success: true, drafts: [] }),
        saveDraft: () => okJson({ success: true }),
        deleteDraft: () => okJson({ success: true }),
        preferences: () => okJson({ success: true, preferences: {} }),
        savePreferences: () => okJson({ success: true, preferences: {} }),
      },
      commands: { list: () => okJson({ success: true, commands: [] }) },
      files: { search: () => okJson({ success: true, files: [] }) },
    },
  };
});

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify({ attachments: [{ name: 'notes.txt', path: '/uploads/notes.txt', mimeType: 'text/plain', size: 5 }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })));
});

const renderBusyComposer = (session: ProjectSession = { id: 'session-a' }, provider: LLMProvider = 'claude') => {
  const messages: ChatMessage[] = [];
  const view = renderHook(
    ({ activeSession }: { activeSession: ProjectSession }) => useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: activeSession,
      currentSessionId: activeSession.id,
      provider,
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading: true,
      canAbortSession: true,
      tokenBudget: null,
      sendMessage: () => undefined,
      scrollToBottom: () => undefined,
      addMessage: (message) => { messages.push(message); },
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
    { initialProps: { activeSession: session } },
  );
  const submit = async (text: string, files: File[] = []) => {
    await act(async () => {
      view.result.current.setInput(text);
      view.result.current.setAttachedFiles(files);
    });
    await act(async () => {
      await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
    });
  };
  return { view, submit, messages };
};

test('a busy session queues up to three messages and keeps them in FIFO order', async () => {
  const { view, submit } = renderBusyComposer();

  await submit('first');
  await submit('second');
  await submit('third');

  const queue = readQueuedMessages('session-a');
  assert.deepEqual(queue.map(({ content }) => content), ['first', 'second', 'third']);
  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['first', 'second', 'third']);
  assert.equal(view.result.current.queuedDraft?.content, 'first', 'the single-slot view is the head');
});

test('a queued card without a durable ticket can still be edited by position', async () => {
  writeQueuedMessage('session-a', { id: 'head', content: 'head' });
  const { view } = renderBusyComposer();
  // Simulates a legacy entry restored without an id.
  await act(async () => {
    view.result.current.editQueuedDraft(undefined, 0);
  });
  assert.equal(view.result.current.input, 'head');
});

test('a fourth message is refused visibly and keeps its text and attachments', async () => {
  const { view, submit, messages } = renderBusyComposer();
  await submit('first');
  await submit('second');
  await submit('third');

  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await act(async () => {
    view.result.current.setInput('fourth');
    view.result.current.setAttachedFiles([file]);
  });
  const uploadsBefore = vi.mocked(fetch).mock.calls.length;
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });

  assert.deepEqual(
    readQueuedMessages('session-a').map(({ content }) => content),
    ['first', 'second', 'third'],
    'the queue is unchanged rather than truncated or overwritten',
  );
  assert.equal(view.result.current.input, 'fourth', 'the refused text stays in the composer');
  assert.equal(view.result.current.attachedFiles[0], file, 'its attachment stays attached');
  assert.equal(vi.mocked(fetch).mock.calls.length, uploadsBefore, 'nothing was uploaded for a refused message');
  assert.ok(
    messages.some((message) => message.type === 'error' && /queue is full \(3\)/i.test(String(message.content ?? ''))),
    'the refusal is explained instead of silently ignored',
  );
  assert.ok(MAX_QUEUED_MESSAGES === 3);
});

test('editing one queued card removes only that entry and loads it into the composer', async () => {
  const { view, submit } = renderBusyComposer();
  await submit('first');
  await submit('second');
  await submit('third');

  const secondId = view.result.current.queuedDrafts[1]?.id;
  assert.ok(secondId);
  await act(async () => { view.result.current.editQueuedDraft(secondId); });

  assert.equal(view.result.current.input, 'second');
  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['first', 'third']);
  assert.deepEqual(readQueuedMessages('session-a').map(({ content }) => content), ['first', 'third']);
});

test('deleting one queued card leaves the others in order', async () => {
  const { view, submit } = renderBusyComposer();
  await submit('first');
  await submit('second');
  await submit('third');

  const firstId = view.result.current.queuedDrafts[0]?.id;
  await act(async () => { view.result.current.deleteQueuedDraft(firstId); });

  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['second', 'third']);
  assert.deepEqual(readQueuedMessages('session-a').map(({ content }) => content), ['second', 'third']);
});

test('a reload restores every queued card in order', async () => {
  writeQueuedMessage('session-a', { id: 'a', content: 'first', attachments: [] });
  writeQueuedMessage('session-a', { id: 'b', content: 'second', attachments: [] });
  writeQueuedMessage('session-a', { id: 'c', content: 'third', attachments: [] });

  const { view } = renderBusyComposer();

  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['first', 'second', 'third']);
});

test('queues are isolated per session', async () => {
  writeQueuedMessage('session-a', { id: 'a', content: 'for A', attachments: [] });
  const { view } = renderBusyComposer();
  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['for A']);

  await act(async () => { view.rerender({ activeSession: { id: 'session-b' } }); });
  assert.deepEqual(view.result.current.queuedDrafts, []);

  await act(async () => { view.rerender({ activeSession: { id: 'session-a' } }); });
  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['for A']);
});

test('hydrated queues from another device are adopted for the open session', async () => {
  const { view } = renderBusyComposer();
  const { api } = await import('@/shared/api');
  vi.spyOn(api.user, 'drafts').mockResolvedValue(new Response(JSON.stringify({
    drafts: [{
      scope: 'session-a',
      text: '',
      queuedMessages: [{ id: 'a', content: 'from laptop' }, { id: 'b', content: 'also from laptop' }],
    }],
  }), { status: 200 }));

  await act(async () => { await hydrateChatDrafts(); });

  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['from laptop', 'also from laptop']);
});
