import { useCallback, useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useProviderRuntimeControls } from '@/modules/chat/hooks/useProviderRuntimeControls';
import { api } from '@/shared/api';
import { readDraftText, resetChatDrafts, writeDraftText } from '@/shared/chatDrafts';
import type { Project, ProviderRuntimeState } from '@/shared/types';

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilities: () => ({ dsh: { runtimeManagement: { modes: ['acp', 'headless'], stoppableModes: ['acp'] } } }),
}));
vi.mock('@/modules/plugins', () => ({
  usePlugins: () => ({ plugins: [{ name: 'worker', enabled: false }] }),
}));

const PROJECT: Project = { projectId: 'project-1', displayName: 'Test', fullPath: '/tmp/project' };
const STATE: ProviderRuntimeState = {
  runtime: 'headless', phase: 'idle', queueHeld: false, supportsPermissionRequests: false,
  diagnostics: { running: false, pid: null, startedAt: null, launcherPath: null, cliVersion: null },
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status });
const selectedRuntime = () => response({ ...STATE, runtime: 'acp', supportsPermissionRequests: true });
const createdSession = () => response({ sessionId: 'created', sessionName: 'New session' });

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderComposer(initialSession: string | null = null) {
  const send = vi.fn();
  const established = vi.fn();
  const addMessage = vi.fn();
  const hook = renderHook(({ project, newSessionTrigger }) => {
    // Match ChatInterface: both hooks receive the same established session.
    const [sessionId, setSessionId] = useState(initialSession);
    const onSessionEstablished = useCallback((id: string) => {
      established(id);
      setSessionId(id);
    }, []);
    const runtime = useProviderRuntimeControls({ provider: 'dsh', sessionId, project, newSessionTrigger, onSessionEstablished });
    const composer = useChatComposerState({
      selectedProject: project, selectedSession: null, currentSessionId: sessionId,
      provider: 'dsh', permissionMode: 'default', cyclePermissionMode() {},
      resolvePermissionModeForProvider: () => 'default', currentProviderModel: 'default', currentProviderEffort: 'default',
      isLoading: false, canAbortSession: false, tokenBudget: null, sendMessage: send,
      prepareSessionForSend: runtime.prepareSend, onSessionEstablished, addMessage,
      scrollToBottom() {}, setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
    });
    return { sessionId, runtime, composer };
  }, { initialProps: { project: PROJECT, newSessionTrigger: 0 } });
  return { ...hook, send, established, addMessage };
}

const submitEvent = () => ({ preventDefault() {} }) as Parameters<ReturnType<typeof useChatComposerState>['handleSubmit']>[0];

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.includes('/files') ? [] : { success: true, commands: [], files: [], drafts: [], preferences: {} },
  )))));
  vi.spyOn(api.providers, 'runtimeState').mockImplementation(() => Promise.resolve(response(STATE)));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetChatDrafts();
});

test('choosing a runtime migrates the latest new-chat draft and preserves its attachment', async () => {
  vi.spyOn(api.providers, 'createSession').mockResolvedValue(createdSession());
  const change = deferredResponse();
  const control = vi.spyOn(api.providers, 'controlRuntime').mockReturnValue(change.promise);
  const hook = renderComposer();
  const attachment = new File(['notes'], 'notes.txt', { type: 'text/plain' });
  await act(async () => {
    hook.result.current.composer.setInput('initial draft');
    hook.result.current.composer.setAttachedFiles([attachment]);
  });
  let changing!: Promise<void>;
  act(() => { changing = hook.result.current.runtime.control({ action: 'runtime', runtime: 'acp' }); });
  await waitFor(() => expect(control).toHaveBeenCalledTimes(1));
  await act(async () => { hook.result.current.composer.setInput('updated while changing runtime'); });
  await act(async () => { change.resolve(selectedRuntime()); await changing; });
  expect(hook.result.current.sessionId).toBe('created');
  expect(hook.result.current.composer.input).toBe('updated while changing runtime');
  expect(hook.result.current.composer.attachedFiles).toEqual([attachment]);
  expect(readDraftText('created')).toBe('updated while changing runtime');
  expect(readDraftText('project:project-1')).toBe('');
  expect(hook.established).toHaveBeenCalledTimes(1);
  expect(hook.send).not.toHaveBeenCalled();
});

test.each(['control-first', 'send-first'])('%s shares one allocation and waits for runtime confirmation before sending', async (order) => {
  const creation = deferredResponse();
  const create = vi.spyOn(api.providers, 'createSession').mockReturnValue(creation.promise);
  const change = deferredResponse();
  const control = vi.spyOn(api.providers, 'controlRuntime').mockReturnValue(change.promise);
  const hook = renderComposer();
  await act(async () => { hook.result.current.composer.setInput('first message'); });
  let changing!: Promise<void>, sending!: Promise<void>;
  act(() => {
    if (order === 'send-first') sending = hook.result.current.composer.handleSubmit(submitEvent());
    changing = hook.result.current.runtime.control({ action: 'runtime', runtime: 'acp' });
    if (order === 'control-first') sending = hook.result.current.composer.handleSubmit(submitEvent());
  });
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  await act(async () => { creation.resolve(createdSession()); });
  await waitFor(() => expect(control).toHaveBeenCalledWith('dsh', 'created', { action: 'runtime', runtime: 'acp' }));
  expect(hook.send).not.toHaveBeenCalled();
  await act(async () => { change.resolve(selectedRuntime()); await Promise.all([changing, sending]); });
  expect(create).toHaveBeenCalledTimes(1);
  expect(hook.established).toHaveBeenCalledTimes(1);
  expect(hook.send).toHaveBeenCalledTimes(1);
  expect(hook.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send', sessionId: 'created', content: 'first message' }));
  expect(hook.result.current.composer.input).toBe('');
  expect(readDraftText('created')).toBe('');
  expect(readDraftText('project:project-1')).toBe('');
});

test('a failed runtime change retains the draft and retry reuses the allocated session', async () => {
  const create = vi.spyOn(api.providers, 'createSession').mockResolvedValue(createdSession());
  const change = deferredResponse();
  const control = vi.spyOn(api.providers, 'controlRuntime').mockReturnValueOnce(change.promise).mockResolvedValue(selectedRuntime());
  const hook = renderComposer();
  await act(async () => { hook.result.current.composer.setInput('keep until ready'); });
  let changing!: Promise<unknown>, sending!: Promise<void>;
  act(() => {
    changing = hook.result.current.runtime.control({ action: 'runtime', runtime: 'acp' }).catch((error) => error);
    sending = hook.result.current.composer.handleSubmit(submitEvent());
  });
  await waitFor(() => expect(control).toHaveBeenCalledTimes(1));
  await act(async () => {
    change.resolve(new Response(JSON.stringify({ error: { message: 'Runtime change failed.' } }), { status: 409 }));
    await Promise.all([changing, sending]);
  });
  expect(hook.send).not.toHaveBeenCalled();
  expect(hook.result.current.composer.input).toBe('keep until ready');
  expect(hook.result.current.sessionId).toBeNull();
  await act(async () => { await hook.result.current.runtime.control({ action: 'runtime', runtime: 'acp' }); });
  expect(hook.result.current.composer.input).toBe('keep until ready');
  await act(async () => { await hook.result.current.composer.handleSubmit(submitEvent()); });
  expect(create).toHaveBeenCalledTimes(1);
  expect(hook.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'created', content: 'keep until ready' }));
});

test('navigation during a runtime change cancels the waiting send without moving either project draft', async () => {
  vi.spyOn(api.providers, 'createSession').mockResolvedValue(createdSession());
  const change = deferredResponse();
  const control = vi.spyOn(api.providers, 'controlRuntime').mockReturnValue(change.promise);
  const hook = renderComposer();
  writeDraftText('project:project-2', 'other project draft');
  await act(async () => { hook.result.current.composer.setInput('original project draft'); });
  let changing!: Promise<void>, sending!: Promise<void>;
  act(() => {
    changing = hook.result.current.runtime.control({ action: 'runtime', runtime: 'acp' });
    sending = hook.result.current.composer.handleSubmit(submitEvent());
  });
  await waitFor(() => expect(control).toHaveBeenCalledTimes(1));
  hook.rerender({ project: { ...PROJECT, projectId: 'project-2' }, newSessionTrigger: 0 });
  await act(async () => { change.resolve(selectedRuntime()); await Promise.all([changing, sending]); });
  expect(hook.established).not.toHaveBeenCalled();
  expect(hook.send).not.toHaveBeenCalled();
  expect(readDraftText('project:project-1')).toBe('original project draft');
  expect(hook.result.current.composer.input).toBe('other project draft');
  expect(readDraftText('created')).toBe('');
});

test('an existing session waits for runtime changes without allocating or navigating', async () => {
  const create = vi.spyOn(api.providers, 'createSession');
  const change = deferredResponse();
  const control = vi.spyOn(api.providers, 'controlRuntime').mockReturnValue(change.promise);
  const hook = renderComposer('existing');
  await act(async () => { hook.result.current.composer.setInput('next message'); });
  let changing!: Promise<void>, sending!: Promise<void>;
  act(() => {
    changing = hook.result.current.runtime.control({ action: 'runtime', runtime: 'acp' });
    sending = hook.result.current.composer.handleSubmit(submitEvent());
  });
  await waitFor(() => expect(control).toHaveBeenCalledTimes(1));
  expect(hook.send).not.toHaveBeenCalled();
  await act(async () => { change.resolve(selectedRuntime()); await Promise.all([changing, sending]); });
  expect(create).not.toHaveBeenCalled();
  expect(hook.established).not.toHaveBeenCalled();
  expect(hook.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'existing', content: 'next message' }));
});

test('a failed shared allocation can be retried without losing the first prompt', async () => {
  const creation = deferredResponse();
  const create = vi.spyOn(api.providers, 'createSession').mockReturnValueOnce(creation.promise).mockResolvedValue(createdSession());
  const control = vi.spyOn(api.providers, 'controlRuntime').mockResolvedValue(selectedRuntime());
  const hook = renderComposer();
  await act(async () => { hook.result.current.composer.setInput('retry this prompt'); });
  let changing!: Promise<unknown>, sending!: Promise<void>;
  act(() => {
    changing = hook.result.current.runtime.control({ action: 'runtime', runtime: 'acp' }).catch((error) => error);
    sending = hook.result.current.composer.handleSubmit(submitEvent());
  });
  await act(async () => {
    creation.resolve(new Response(JSON.stringify({ error: { message: 'Session creation failed.' } }), { status: 500 }));
    await Promise.all([changing, sending]);
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(control).not.toHaveBeenCalled();
  expect(hook.send).not.toHaveBeenCalled();
  expect(hook.result.current.composer.input).toBe('retry this prompt');
  await act(async () => { await hook.result.current.runtime.control({ action: 'runtime', runtime: 'acp' }); });
  await act(async () => { await hook.result.current.composer.handleSubmit(submitEvent()); });
  expect(create).toHaveBeenCalledTimes(2);
  expect(hook.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'created', content: 'retry this prompt' }));
});

test('starting another new chat in the same project prevents an old action from adopting it', async () => {
  vi.spyOn(api.providers, 'createSession').mockResolvedValue(createdSession());
  const change = deferredResponse();
  const control = vi.spyOn(api.providers, 'controlRuntime').mockReturnValue(change.promise);
  const hook = renderComposer();
  await act(async () => { hook.result.current.composer.setInput('project draft'); });
  let changing!: Promise<void>, sending!: Promise<void>;
  act(() => {
    changing = hook.result.current.runtime.control({ action: 'runtime', runtime: 'acp' });
    sending = hook.result.current.composer.handleSubmit(submitEvent());
  });
  await waitFor(() => expect(control).toHaveBeenCalledTimes(1));
  hook.rerender({ project: PROJECT, newSessionTrigger: 1 });
  await act(async () => { change.resolve(selectedRuntime()); await Promise.all([changing, sending]); });
  expect(hook.established).not.toHaveBeenCalled();
  expect(hook.send).not.toHaveBeenCalled();
  expect(hook.result.current.composer.input).toBe('project draft');
});

test('a send finishing its attachment upload reuses the session already established by runtime selection', async () => {
  const create = vi.spyOn(api.providers, 'createSession').mockResolvedValue(createdSession());
  vi.spyOn(api.providers, 'controlRuntime').mockResolvedValue(selectedRuntime());
  const upload = deferredResponse();
  const fetch = vi.mocked(globalThis.fetch);
  const fallback = fetch.getMockImplementation()!;
  fetch.mockImplementation((url, options) => String(url) === '/api/assets/files' && options?.method === 'POST'
    ? upload.promise : fallback(url, options));
  const hook = renderComposer();
  await act(async () => {
    hook.result.current.composer.setInput('read the attachment');
    hook.result.current.composer.setAttachedFiles([new File(['notes'], 'notes.txt', { type: 'text/plain' })]);
  });
  let sending!: Promise<void>;
  act(() => { sending = hook.result.current.composer.handleSubmit(submitEvent()); });
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/assets/files', expect.objectContaining({ method: 'POST' })));
  await act(async () => { await hook.result.current.runtime.control({ action: 'runtime', runtime: 'acp' }); });
  expect(hook.result.current.sessionId).toBe('created');
  expect(hook.send).not.toHaveBeenCalled();
  await act(async () => {
    upload.resolve(new Response(JSON.stringify({ attachments: [{ name: 'notes.txt', path: '/uploads/notes.txt', mimeType: 'text/plain' }] })));
    await sending;
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(hook.established).toHaveBeenCalledTimes(1);
  expect(hook.send).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'created', content: 'read the attachment' }));
});
