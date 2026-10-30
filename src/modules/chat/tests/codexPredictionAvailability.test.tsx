import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ComposerPredictionStatus } from '@/modules/chat/composer/ComposerPrediction';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useCodexControls } from '@/modules/chat/hooks/useCodexControls';
import { api } from '@/shared/api';
import { resetChatDrafts } from '@/shared/chatDrafts';
import { resetUserPreferences } from '@/shared/userSettings';
import type { CodexSessionState, Project, ServerEvent } from '@/shared/types';

const { listeners, subscribe } = vi.hoisted(() => ({
  listeners: new Set<(event: ServerEvent) => void>(),
  subscribe: vi.fn(),
}));
vi.mock('@/shared/context/WebSocketContext', () => ({ useWebSocket: () => ({ subscribe }) }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useProviderCapabilities: () => ({ codex: { nativeControls: { predictions: true, goal: false } } }),
}));
// The Worker activity hook reads the public plugin context; no Worker is installed here.
vi.mock('@/modules/plugins', () => ({ usePlugins: () => ({ plugins: [] }) }));

const PROJECT: Project = { projectId: 'prediction-project', displayName: 'Prediction project', fullPath: '/tmp/prediction-project' };

beforeEach(async () => {
  localStorage.clear();
  resetChatDrafts();
  resetUserPreferences();
  listeners.clear();
  subscribe.mockImplementation((listener: (event: ServerEvent) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => Response.json(
    String(url).includes('/files') ? [] : {
      success: true, data: [], commands: [], drafts: [], preferences: {},
    },
  )));
  await i18n.changeLanguage('en');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetChatDrafts();
});

test('the first message of a new Codex chat opts into predictions before a native snapshot exists', async () => {
  vi.spyOn(api.providers, 'createSession').mockResolvedValue(Response.json({
    success: true, data: { sessionId: 'first-prediction-session' },
  }));
  const sendMessage = vi.fn();
  const hook = renderHook(() => {
    const controls = useCodexControls({
      enabled: true, sessionId: null, project: PROJECT, options: {}, sendMessage,
      onSessionEstablished() {},
    });
    const composer = useChatComposerState({
      selectedProject: PROJECT, selectedSession: null, currentSessionId: null,
      provider: 'codex', permissionMode: 'default', cyclePermissionMode() {},
      resolvePermissionModeForProvider: () => 'default',
      currentProviderModel: 'gpt-5.4', currentProviderEffort: 'high', isLoading: false,
      canAbortSession: false, tokenBudget: null, codexControls: controls,
      composerPredictionsEligible: controls.predictionsSupported,
      sendMessage, onSessionEstablished() {}, scrollToBottom() {}, addMessage() {},
      setIsUserScrolledUp() {}, setPendingPermissionRequests() {},
    });
    return { controls, composer };
  });
  expect(hook.result.current.controls.state).toBeNull();
  expect(hook.result.current.controls.predictionsSupported).toBe(true);
  act(() => { hook.result.current.composer.setInput('Explain the implementation.'); });
  await act(async () => {
    await hook.result.current.composer.handleSubmit({ preventDefault() {} } as never);
  });
  const sent = sendMessage.mock.calls.map(([message]) => message)
    .find((message) => message.type === 'chat.send');
  expect(sent?.options?.composerPredictions).toBe(true);
  expect(sent?.sessionId).toBe('first-prediction-session');
  hook.unmount();
});

test.each(['app-server', 'sdk'] as const)('an unsupported snapshot in %s has the appropriate composer availability', async (runtime) => {
  const state: CodexSessionState = {
    runtime, mode: 'default', phase: 'idle', turnId: null, goal: null,
    questions: [], predictionSupported: false,
  };
  const sendMessage = vi.fn((message: unknown) => {
    const control = message as { requestId: string; sessionId: string };
    queueMicrotask(() => {
      for (const listener of listeners) listener({
        kind: 'control_result', sessionId: control.sessionId,
        requestId: control.requestId, ok: true, codexState: state,
      } as ServerEvent);
    });
  });
  const hook = renderHook(() => useCodexControls({
    enabled: true, sessionId: 'unavailable-session', project: PROJECT,
    options: {}, sendMessage, onSessionEstablished() {},
  }));
  await waitFor(() => expect(hook.result.current.state?.runtime).toBe(runtime));
  expect(hook.result.current.predictionsSupported).toBe(false);
  expect(hook.result.current.predictionsUnsupported).toBe(runtime === 'app-server');
  if (hook.result.current.predictionsUnsupported) {
    render(<ComposerPredictionStatus unsupported enabled onChange={() => {}} unavailable={false} />);
    expect(screen.getByTestId('composer-prediction-unsupported').textContent).toContain('not supported');
    expect(screen.queryByRole('button')).toBeNull();
  }
  hook.unmount();
});
