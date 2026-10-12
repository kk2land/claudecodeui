import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode } from '@/shared/types';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

function renderComposer(isLoading: boolean, supportsSteer = true, permissionMode: PermissionMode = 'default') {
  const sendMessage = vi.fn();
  const selectPermissionMode = vi.fn();
  const addMessage = vi.fn();
  const project = { projectId: 'project', displayName: 'Project', fullPath: '/tmp/project' };
  const session = { id: 'session-codex' };
  const view = renderHook(() => useChatComposerState({
    selectedProject: project,
    selectedSession: session, currentSessionId: 'session-codex', provider: 'codex',
    permissionMode, cyclePermissionMode: vi.fn(), selectPermissionMode, supportsSteer,
    resolvePermissionModeForProvider: (_provider, mode) => mode as PermissionMode,
    currentProviderModel: 'test-model', currentProviderEffort: 'medium',
    isLoading, canAbortSession: isLoading, tokenBudget: null,
    sendMessage, scrollToBottom: vi.fn(), addMessage,
    setIsUserScrolledUp: vi.fn(), setPendingPermissionRequests: vi.fn(),
  }));
  const submit = async (input: string) => {
    await act(async () => { view.result.current.setInput(input); });
    await act(async () => { await view.result.current.handleSubmit({ preventDefault: vi.fn() } as never); });
  };
  return { view, submit, sendMessage, selectPermissionMode, addMessage };
}

test('busy app-server sessions steer immediately without queuing or starting another turn', async () => {
  const composer = renderComposer(true);
  await composer.submit('focus on the failing test');
  expect(composer.sendMessage).toHaveBeenCalledWith({ type: 'chat.steer', sessionId: 'session-codex', content: 'focus on the failing test', options: { attachments: [] } });
  expect(composer.view.result.current.queuedDraft).toBeNull();
  expect(composer.addMessage).not.toHaveBeenCalled(); // server echoes only accepted steer input
  expect(composer.view.result.current.input).toBe('');
});

test('/plan toggles collaboration mode without sending a model turn', async () => {
  const composer = renderComposer(false);
  await composer.submit('/plan');
  expect(composer.selectPermissionMode).toHaveBeenCalledWith('plan');
  expect(composer.sendMessage).not.toHaveBeenCalled();
});

test('/plan toggles back to Default and remains available during a turn for the next prompt', async () => {
  const composer = renderComposer(true, true, 'plan');
  await composer.submit('/plan');
  expect(composer.selectPermissionMode).toHaveBeenCalledWith('default');
  expect(composer.sendMessage).not.toHaveBeenCalled();
});

test('/plan with a prompt sends that turn with Plan immediately', async () => {
  const composer = renderComposer(false);
  await composer.submit('/plan diagnose the build');
  expect(composer.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send', content: 'diagnose the build', options: expect.objectContaining({ permissionMode: 'plan' }) }));
});

test('a planning prompt during a turn is retained instead of pretending steer can change mode', async () => {
  const composer = renderComposer(true);
  await composer.submit('/plan diagnose the build');
  expect(composer.sendMessage).not.toHaveBeenCalled();
  expect(composer.view.result.current.input).toBe('/plan diagnose the build');
  expect(composer.addMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
});

test('without app-server capability, busy Codex sessions keep their existing queue', async () => {
  const composer = renderComposer(true, false);
  await composer.submit('next task');
  expect(composer.sendMessage).not.toHaveBeenCalled();
  expect(composer.view.result.current.queuedDraft?.content).toBe('next task');
});

test('choosing /plan from the slash menu submits its argument through the same Plan path', async () => {
  const composer = renderComposer(false);
  await act(async () => { composer.view.result.current.setInput('/plan diagnose the build'); });
  await act(async () => {
    composer.view.result.current.handleCommandSelect({ name: '/plan', namespace: 'builtin', type: 'builtin' }, 0, false);
  });
  expect(composer.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send', content: 'diagnose the build', options: expect.objectContaining({ permissionMode: 'plan' }) }));
});
