import { useCallback, useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useCodexControls } from '@/modules/chat/hooks/useCodexControls';
import { api } from '@/shared/api';
import { readDraftText, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { CodexSessionState, Project, ServerEvent } from '@/shared/types';

const { listeners, subscribe } = vi.hoisted(() => ({
  listeners: new Set<(event: ServerEvent) => void>(),
  subscribe: vi.fn(),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilities: () => ({ codex: { nativeControls: { goal: false, predictions: false } } }),
}));

const PROJECT: Project = { projectId: 'project-1', displayName: 'Test', fullPath: '/tmp/project' };
const STATE: CodexSessionState = {
  runtime: 'app-server', mode: 'plan', phase: 'idle', turnId: null, goal: null, questions: [],
};
const createdSession = (id = 'created') => Response.json({
  success: true, data: { sessionId: id, sessionName: 'New session' },
});

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderComposer(initialSession: string | null = null) {
  const established = vi.fn();
  // Every control request is acknowledged so the calling control promise settles.
  const send = vi.fn((payload: unknown) => {
    const message = payload as { type: string; sessionId?: string; requestId?: string };
    if (message.type !== 'chat.control') return;
    queueMicrotask(() => {
      for (const listener of listeners) listener({
        kind: 'control_result', sessionId: message.sessionId, requestId: message.requestId,
        ok: true, codexState: STATE,
      } as ServerEvent);
    });
  });
  const hook = renderHook(({ project }: { project: Project }) => {
    // Match ChatInterface: both hooks receive the same established session.
    const [sessionId, setSessionId] = useState(initialSession);
    const onSessionEstablished = useCallback((id: string) => {
      established(id);
      setSessionId(id);
    }, []);
    const controls = useCodexControls({
      enabled: true, sessionId, project, options: {}, sendMessage: send,
      onSessionEstablished,
    });
    const composer = useChatComposerState({
      selectedProject: project, selectedSession: null, currentSessionId: sessionId,
      provider: 'codex', permissionMode: 'default', cyclePermissionMode() {},
      resolvePermissionModeForProvider: () => 'default',
      currentProviderModel: 'gpt-5.4', currentProviderEffort: 'high', isLoading: false,
      canAbortSession: false, tokenBudget: null, codexControls: controls,
      sendMessage: send, onSessionEstablished, scrollToBottom() {}, addMessage() {},
      setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
    });
    return { sessionId, controls, composer };
  }, { initialProps: { project: PROJECT } });
  return { ...hook, send, established };
}

// The draft store hydrates from the server after every control acknowledgement,
// so the stub keeps a real server-side copy instead of always returning none.
const serverDrafts = new Map<string, string>();

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  serverDrafts.clear();
  listeners.clear();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  // Model HTTP access: randomUUID is absent, but getRandomValues remains available.
  vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => (String(url).includes('/files')
    ? Response.json([])
    : Response.json({ success: true, commands: [], drafts: [], preferences: {} }))));
  vi.spyOn(api.user, 'saveDraft').mockImplementation(async (scope, draft) => {
    serverDrafts.set(scope, draft.text);
    return Response.json({ success: true });
  });
  vi.spyOn(api.user, 'deleteDraft').mockImplementation(async (scope) => {
    serverDrafts.delete(scope);
    return Response.json({ success: true });
  });
  vi.spyOn(api.user, 'drafts').mockImplementation(async () => Response.json({
    drafts: [...serverDrafts].map(([scope, text]) => ({ scope, text })),
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetChatDrafts();
});

test('switching a new chat to Plan mode moves its draft into the allocated session', async () => {
  const creation = deferredResponse();
  const create = vi.spyOn(api.providers, 'createSession').mockReturnValue(creation.promise);
  const hook = renderComposer();
  await act(async () => { hook.result.current.composer.setInput('write the handler'); });
  expect(readDraftText('project:project-1')).toBe('write the handler');

  let changing!: Promise<void>;
  act(() => { changing = hook.result.current.controls.control({ action: 'mode', mode: 'plan' }); });
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  // Typing while the session is being created must survive the handoff.
  await act(async () => { hook.result.current.composer.setInput('write the handler and tests'); });
  await act(async () => { creation.resolve(createdSession()); await changing; });

  expect(hook.result.current.sessionId).toBe('created');
  expect(hook.result.current.composer.input).toBe('write the handler and tests');
  expect(readDraftText('created')).toBe('write the handler and tests');
  expect(readDraftText('project:project-1')).toBe('');
  expect(hook.established).toHaveBeenCalledTimes(1);
  expect(hook.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'chat.control', sessionId: 'created', control: { action: 'mode', mode: 'plan' },
  }));
  expect(hook.send.mock.calls.filter(([payload]) => (payload as { type: string }).type === 'chat.send')).toHaveLength(0);
});

test('a failed session allocation leaves the project draft in place', async () => {
  vi.spyOn(api.providers, 'createSession').mockResolvedValue(
    new Response(JSON.stringify({ error: { message: 'Session creation failed.' } }), { status: 500 }),
  );
  const hook = renderComposer();
  await act(async () => { hook.result.current.composer.setInput('keep this prompt'); });
  await act(async () => {
    await expect(hook.result.current.controls.control({ action: 'mode', mode: 'plan' })).rejects.toThrow();
  });

  expect(hook.result.current.sessionId).toBeNull();
  expect(hook.established).not.toHaveBeenCalled();
  expect(hook.result.current.composer.input).toBe('keep this prompt');
  expect(readDraftText('project:project-1')).toBe('keep this prompt');
  expect(readDraftText('created')).toBe('');
});

test('navigating to another project during allocation moves neither draft', async () => {
  const creation = deferredResponse();
  vi.spyOn(api.providers, 'createSession').mockReturnValue(creation.promise);
  const hook = renderComposer();
  writeDraftText('project:project-2', 'other project draft');
  await act(async () => { hook.result.current.composer.setInput('original project draft'); });

  let changing!: Promise<unknown>;
  act(() => {
    changing = hook.result.current.controls.control({ action: 'mode', mode: 'plan' }).catch((error) => error);
  });
  await waitFor(() => expect(api.providers.createSession).toHaveBeenCalledTimes(1));
  hook.rerender({ project: { ...PROJECT, projectId: 'project-2', fullPath: '/tmp/other' } });
  await act(async () => {
    creation.resolve(createdSession());
    await changing;
  });

  expect(await changing).toBeInstanceOf(Error);
  expect(hook.established).not.toHaveBeenCalled();
  expect(hook.send).not.toHaveBeenCalled();
  expect(readDraftText('project:project-1')).toBe('original project draft');
  expect(readDraftText('project:project-2')).toBe('other project draft');
  expect(readDraftText('created')).toBe('');
  expect(hook.result.current.sessionId).toBeNull();
  expect(hook.result.current.composer.input).toBe('other project draft');
});

test('an existing session switches mode without touching any draft', async () => {
  const create = vi.spyOn(api.providers, 'createSession');
  writeDraftText('project:project-1', 'stale project draft');
  writeDraftText('other-session', 'another session draft');
  const hook = renderComposer('existing');
  await act(async () => { hook.result.current.composer.setInput('next message'); });

  await act(async () => { await hook.result.current.controls.control({ action: 'mode', mode: 'plan' }); });

  expect(create).not.toHaveBeenCalled();
  expect(hook.established).not.toHaveBeenCalled();
  expect(readDraftText('existing')).toBe('next message');
  expect(readDraftText('project:project-1')).toBe('stale project draft');
  expect(readDraftText('other-session')).toBe('another session draft');
  expect(hook.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'existing' }));
});
