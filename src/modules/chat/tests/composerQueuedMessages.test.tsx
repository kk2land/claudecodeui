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
import type { ChatMessage, LLMProvider, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * A busy session accepts up to five pending messages. These tests drive the
 * real hook, durable store and per-card handlers together.
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

test('a queued card without a durable ticket can still be edited by position', async () => {
  writeQueuedMessage('session-a', { content: 'head' });
  const { view } = renderBusyComposer();
  // Simulates a legacy entry restored without an id.
  await act(async () => {
    view.result.current.editQueuedDraft(undefined, 0);
  });
  assert.equal(view.result.current.input, 'head');
});

test('a busy session queues five messages and keeps the refused sixth in the composer', async () => {
  const { view, submit, messages } = renderBusyComposer();
  const prompts = ['first', 'second', 'third', 'fourth', 'fifth'];
  for (const prompt of prompts) await submit(prompt);
  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), prompts);
  assert.equal(view.result.current.queuedDraft?.content, 'first');

  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await act(async () => {
    view.result.current.setInput('sixth');
    view.result.current.setAttachedFiles([file]);
  });
  const uploadsBefore = vi.mocked(fetch).mock.calls.length;
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as never);
  });

  assert.deepEqual(
    readQueuedMessages('session-a').map(({ content }) => content),
    prompts,
    'the queue is unchanged rather than truncated or overwritten',
  );
  assert.equal(view.result.current.input, 'sixth', 'the refused text stays in the composer');
  assert.equal(view.result.current.attachedFiles[0], file, 'its attachment stays attached');
  assert.equal(vi.mocked(fetch).mock.calls.length, uploadsBefore, 'nothing was uploaded for a refused message');
  assert.ok(
    messages.some((message) => message.type === 'error' && /queue is full \(5\)/i.test(String(message.content ?? ''))),
    'the refusal is explained instead of silently ignored',
  );
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

test('moving ticketed and legacy cards saves the new order and restores it on a fresh load', async () => {
  const { api } = await import('@/shared/api');
  const save = vi.spyOn(api.user, 'saveDraft');
  const drafts = vi.spyOn(api.user, 'drafts');
  const initial = [{ id: 'a', content: 'first' }, { content: 'legacy' }, { id: 'c', content: 'third' }];
  drafts.mockResolvedValueOnce(Response.json({ drafts: [{ scope: 'session-a', text: '', queuedMessages: initial }] }));
  await hydrateChatDrafts();
  const { view } = renderBusyComposer();
  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['first', 'legacy', 'third']);

  await act(async () => { view.result.current.moveQueuedDraft(-1, undefined, 1); });
  assert.equal(view.result.current.queuedDraft?.content, 'legacy');
  await act(async () => { view.result.current.moveQueuedDraft(1, 'a', 1); });
  const expected = ['legacy', 'third', 'first'];
  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), expected);
  const saved = save.mock.calls.at(-1)?.[1] as { queuedMessages: Array<{ content: string }>; knownQueuedMessageIds: string[] };
  assert.deepEqual(saved.queuedMessages.map(({ content }) => content), expected);
  assert.deepEqual(saved.knownQueuedMessageIds, ['a', 'c']);

  view.unmount();
  resetChatDrafts();
  drafts.mockResolvedValueOnce(Response.json({ drafts: [{ scope: 'session-a', text: '', queuedMessages: saved.queuedMessages }] }));
  await hydrateChatDrafts();
  assert.deepEqual(renderBusyComposer().view.result.current.queuedDrafts.map(({ content }) => content), expected);
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
