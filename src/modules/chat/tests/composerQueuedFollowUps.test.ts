import assert from 'node:assert/strict';

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { hydrateChatDrafts, readDraftText, readQueuedMessages, resetChatDrafts } from '@/shared/chatDrafts';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';

/** Upstream follow-up regressions retain this branch's separate FIFO turns and per-turn files. */
type StoredQueued = { id?: string; content: string; options?: Record<string, unknown>; attachments?: unknown[] };
type StoredDraft = { text: string; queuedMessages: StoredQueued[] };

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
let server: Map<string, StoredDraft>;
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  server = new Map();
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    const scope = String(body.scope ?? '');
    if (path.endsWith('/api/user/drafts')) {
      if (method === 'GET') return json({ drafts: [...server].map(([scope, draft]) => ({ scope, ...draft })) });
      if (method === 'PUT') {
        const current = server.get(scope) ?? { text: '', queuedMessages: [] };
        server.set(scope, {
          text: typeof body.text === 'string' ? body.text : '',
          queuedMessages: Array.isArray(body.queuedMessages) ? body.queuedMessages as StoredQueued[] : current.queuedMessages,
        });
      }
      if (method === 'DELETE') server.delete(scope);
      return json({ success: true });
    }
    if (path.includes('/api/assets/files')) {
      const form = init?.body as FormData;
      return json({ attachments: (form.getAll('files') as File[]).map((file) => ({ name: file.name, path: `/uploads/${file.name}` })) });
    }
    return json([]);
  }));
});

afterEach(() => {
  cleanup();
  resetChatDrafts();
  vi.unstubAllGlobals();
});

const render = () => {
  const view = renderHook(({ session }: { session: ProjectSession }) => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: session,
    currentSessionId: session.id,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'opus',
    currentProviderEffort: 'medium',
    isLoading: true,
    canAbortSession: true,
    tokenBudget: null,
    sendMessage: () => undefined,
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }), { initialProps: { session: { id: 'session-1' } } });
  const submit = async (text: string, files: File[] = []) => {
    await act(async () => {
      view.result.current.setInput(text);
      view.result.current.setAttachedFiles(files);
    });
    await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
    await waitFor(() => assert.equal(server.get('session-1')?.text, ''), { timeout: 5_000 });
  };
  return { view, submit };
};

test('follow-ups A, B and C remain separate in both the cards and durable queue', async () => {
  const { view, submit } = render();
  await submit('A');
  await submit('B');
  await submit('C');
  await waitFor(() => assert.deepEqual(server.get('session-1')?.queuedMessages.map(({ content }) => content), ['A', 'B', 'C']));
  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['A', 'B', 'C']);
  assert.equal(new Set(server.get('session-1')?.queuedMessages.map(({ id }) => id)).size, 3);
});

test('typing after dispatch does not restore the consumed head or overwrite the remaining queue', async () => {
  const { view, submit } = render();
  await submit('A');
  await submit('B');
  await waitFor(() => assert.equal(server.get('session-1')?.queuedMessages.length, 2));
  server.get('session-1')!.queuedMessages.shift();
  await act(async () => { view.result.current.setInput('still typing'); });
  await act(async () => { await hydrateChatDrafts(); });
  assert.equal(view.result.current.input, 'still typing');
  assert.deepEqual(readQueuedMessages('session-1').map(({ content }) => content), ['B']);
  await waitFor(() => assert.equal(server.get('session-1')?.text, 'still typing'), { timeout: 5_000 });
  assert.deepEqual(server.get('session-1')?.queuedMessages.map(({ content }) => content), ['B']);
});

test('editing a later card preserves other turns and restores its browser files', async () => {
  const { view, submit } = render();
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await submit('A');
  await submit('B', [file]);
  await submit('C');
  await act(async () => { view.result.current.editQueuedDraft(view.result.current.queuedDrafts[1].id); });
  assert.equal(view.result.current.input, 'B');
  assert.equal(view.result.current.attachedFiles[0], file);
  await waitFor(() => assert.deepEqual(server.get('session-1')?.queuedMessages.map(({ content }) => content), ['A', 'C']));
});

test("foreground refresh adopts another tab's new entry and retains this tab's files", async () => {
  const { view, submit } = render();
  const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await submit('A', [file]);
  server.get('session-1')!.queuedMessages.push({ id: 'other-tab', content: 'B', attachments: [] });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => assert.equal(view.result.current.queuedDrafts.length, 2));
  await act(async () => { view.result.current.editQueuedDraft(view.result.current.queuedDrafts[0].id); });
  assert.equal(view.result.current.attachedFiles[0], file);
  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['B']);
});

test('deleting one entry leaves later turns waiting in order', async () => {
  const { view, submit } = render();
  await submit('A');
  await submit('B');
  await submit('C');
  await act(async () => { view.result.current.deleteQueuedDraft(view.result.current.queuedDrafts[0].id); });
  await waitFor(() => assert.deepEqual(server.get('session-1')?.queuedMessages.map(({ content }) => content), ['B', 'C']));
  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['B', 'C']);
});

test('switching conversations restores each queue and draft independently', async () => {
  const { view, submit } = render();
  await submit('A');
  await act(async () => { view.result.current.setInput('draft for one'); });
  view.rerender({ session: { id: 'session-2' } });
  await waitFor(() => assert.equal(view.result.current.input, ''));
  assert.deepEqual(view.result.current.queuedDrafts, []);
  await act(async () => { view.result.current.setInput('draft for two'); });
  view.rerender({ session: { id: 'session-1' } });
  await waitFor(() => assert.equal(view.result.current.input, 'draft for one'));
  assert.deepEqual(view.result.current.queuedDrafts.map(({ content }) => content), ['A']);
  assert.equal(readDraftText('session-2'), 'draft for two');
});
