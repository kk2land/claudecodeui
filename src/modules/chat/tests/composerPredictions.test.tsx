import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import { ComposerPredictionOverlay, ComposerPredictionStatus } from '@/modules/chat/composer/ComposerPrediction';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useComposerPrediction } from '@/modules/chat/hooks/useComposerPrediction';
import { readStoredUiPreferences } from '@/shared/uiPreferences';
import { readDraftText, resetChatDrafts } from '@/shared/chatDrafts';
import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import type { CodexComposerPrediction, CodexComposerPredictionReason, CodexControls, Project, ProjectSession } from '@/shared/types';

/**
 * Native Codex composer predictions are shown as ghost text that is *not* the
 * composer draft, accepted only by plain Tab or an explicit button, and retired
 * by any user intent. These tests exercise the real composer hook and the real
 * overlay component rather than mirroring the hook's internals.
 */

const PROJECT: Project = { projectId: 'project-prediction', displayName: 'Prediction', fullPath: '/tmp/prediction' };
const SESSION: ProjectSession = { id: 'session-prediction' };

const nativeState = (prediction?: CodexComposerPrediction): CodexControls => ({
  sessionId: SESSION.id,
  state: {
    runtime: 'app-server', mode: 'default', phase: 'idle', turnId: null, goal: null, questions: [],
    ...(prediction ? { prediction } : {}),
  },
  goalsEnabled: true,
  predictionsSupported: true,
  pending: false, error: null, delivery: null,
  control: vi.fn().mockResolvedValue(undefined), steer: vi.fn().mockResolvedValue(undefined),
});

const ready = (text = 'Add a regression test for that path.'): CodexComposerPrediction => ({
  sourceTurnId: 'turn-1', status: 'ready', text,
});

type ComposerProps = {
  controls: CodexControls;
  eligible?: boolean;
  blocked?: boolean;
  isLoading?: boolean;
};

function renderComposer({ controls, eligible = true, blocked = false, isLoading = false }: ComposerProps) {
  const send = vi.fn();
  const cyclePermissionMode = vi.fn();
  const hook = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    provider: 'codex',
    permissionMode: 'default',
    cyclePermissionMode,
    resolvePermissionModeForProvider: (_provider, mode) => mode as never,
    currentProviderModel: 'gpt-5.4',
    currentProviderEffort: 'high',
    isLoading,
    codexControls: controls,
    composerPredictionsEligible: eligible,
    composerPredictionsBlocked: blocked,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: send,
    scrollToBottom() {},
    addMessage() {},
    setIsUserScrolledUp() {},
    setPendingPermissionRequests() {},
  }));
  return { ...hook, send, cyclePermissionMode };
}

/** Minimal keyboard event the composer handler accepts; jsdom is not needed for the rest. */
const key = (name: string, patch: Record<string, unknown> = {}) => ({
  key: name,
  shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
  nativeEvent: { isComposing: false },
  preventDefault: vi.fn(),
  ...patch,
}) as { preventDefault: { mock: { calls: unknown[] } } } & Record<string, unknown>;

beforeEach(() => {
  localStorage.clear();
  resetUserPreferences();
  resetChatDrafts();
  // The composer fetches commands/files on mount; answer with empty lists.
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(
    String(url).includes('/files') ? [] : { success: true, data: [], commands: [], drafts: [], preferences: {} },
  ), { status: 200 }))));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetChatDrafts();
});

test('the suggestion is ghost text, never the draft; Tab accepts it without sending or rotating permissions', () => {
  const { result, send, cyclePermissionMode } = renderComposer({ controls: nativeState(ready()) });

  act(() => { result.current.setInput(''); });
  assert.equal(result.current.composerPrediction.suggestion, 'Add a regression test for that path.');
  // The ghost text lives outside the draft: neither the input value nor the
  // persisted draft has been touched by merely displaying it.
  assert.equal(result.current.input, '');
  assert.equal(readDraftText(SESSION.id), '');

  const event = key('Tab');
  act(() => { result.current.handleKeyDown(event as never); });

  assert.equal(result.current.input, 'Add a regression test for that path.');
  // Accepting is a draft write, and the draft is persisted through the existing path.
  assert.equal(readDraftText(SESSION.id), 'Add a regression test for that path.');
  assert.equal(send.mock.calls.length, 0);
  assert.equal(cyclePermissionMode.mock.calls.length, 0);
  assert.equal(result.current.composerPrediction.suggestion, null);
  // No history entry was recorded by accepting.
  expect(JSON.parse(localStorage.getItem('input-history') ?? '{}')).toEqual({});
});

test('accepting leaves the text editable and never auto-submits', () => {
  const { result, send } = renderComposer({ controls: nativeState(ready('Run the full suite.')) });
  act(() => { result.current.composerPrediction.accept(); });
  assert.equal(result.current.input, 'Run the full suite.');
  assert.equal(send.mock.calls.length, 0);

  act(() => { result.current.setInput('Run the full suite.'); });
  assert.equal(result.current.input, 'Run the full suite.');
});

test('typing then clearing the box does not bring the same suggestion back', () => {
  const { result } = renderComposer({ controls: nativeState(ready()) });
  assert.equal(result.current.composerPrediction.suggestion, 'Add a regression test for that path.');

  act(() => { result.current.setInput('A'); });
  assert.equal(result.current.composerPrediction.suggestion, null);

  // The user deleted what they typed; this turn's suggestion stays retired.
  act(() => { result.current.setInput(''); });
  assert.equal(result.current.composerPrediction.suggestion, null);
});

test('Esc hides the suggestion and plain Tab then rotates permissions again', () => {
  const { result, cyclePermissionMode } = renderComposer({ controls: nativeState(ready()) });
  const escape = key('Escape');
  act(() => { result.current.handleKeyDown(escape as never); });
  assert.equal(escape.preventDefault.mock.calls.length, 1);
  assert.equal(result.current.composerPrediction.suggestion, null);

  const tab = key('Tab');
  act(() => { result.current.handleKeyDown(tab as never); });
  assert.equal(cyclePermissionMode.mock.calls.length, 1);
  assert.equal(result.current.input, '');
});

test('modified Tab, IME Tab and open mention/command menus keep their existing behavior', () => {
  for (const patch of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    const { result, cyclePermissionMode } = renderComposer({ controls: nativeState(ready()) });
    const tab = key('Tab', patch);
    act(() => { result.current.handleKeyDown(tab as never); });
    assert.equal(result.current.input, '');
    assert.equal(cyclePermissionMode.mock.calls.length, 1, `modified Tab ${JSON.stringify(patch)} must rotate permissions`);
  }

  const composing = renderComposer({ controls: nativeState(ready()) });
  const imeTab = key('Tab', { nativeEvent: { isComposing: true } });
  act(() => { composing.result.current.handleKeyDown(imeTab as never); });
  // A confirming IME key is never read as accepting the suggestion; the input
  // keeps exactly what the IME composed and the preview stays available.
  assert.equal(composing.result.current.input, '');
  assert.equal(composing.result.current.composerPrediction.suggestion, 'Add a regression test for that path.');
});

test('the suggestion is scoped to its session, turn and runtime and never revives after suppression', () => {
  const first = renderComposer({ controls: nativeState(ready()) });
  assert.ok(first.result.current.composerPrediction.suggestion);

  // SDK compatibility or another provider: no overlay even with a stale snapshot.
  const sdk = renderComposer({ controls: nativeState(ready()), eligible: false });
  assert.equal(sdk.result.current.composerPrediction.suggestion, null);
  // ...and no opt-in for that send.
  act(() => { sdk.result.current.setInput('hello'); });
  act(() => { void sdk.result.current.handleSubmit({ preventDefault() {} } as never); });

  // Attachments and an already-queued draft suppress the overlay.
  const attached = renderComposer({ controls: nativeState(ready()) });
  act(() => { attached.result.current.setAttachedFiles([new File(['x'], 'x.txt', { type: 'text/plain' })]); });
  assert.equal(attached.result.current.composerPrediction.suggestion, null);

  // A permission prompt owns the composer instead.
  const blocked = renderComposer({ controls: nativeState(ready()), blocked: true });
  assert.equal(blocked.result.current.composerPrediction.suggestion, null);

  // A live turn hides it without retiring the pending request...
  const running = renderComposer({ controls: nativeState(ready()), isLoading: true });
  assert.equal(running.result.current.composerPrediction.suggestion, null);
});

test('a new turn retires the previous suggestion and a late result cannot resurrect it', () => {
  const hook = renderHook(({ prediction }: { prediction?: CodexComposerPrediction }) => useComposerPrediction({
    enabled: true, sessionId: SESSION.id, prediction, busy: false, suppressed: false, input: '',
  }), { initialProps: { prediction: ready('turn-1 text') as CodexComposerPrediction } });
  assert.equal(hook.result.current.suggestion, 'turn-1 text');

  // The next turn starts and produces its own suggestion. Turn 1 is superseded.
  hook.rerender({ prediction: { sourceTurnId: 'turn-2', status: 'ready', text: 'turn-2 text' } });
  assert.equal(hook.result.current.suggestion, 'turn-2 text');

  // A delayed result still carrying turn-1 (an out-of-order re-publish) is
  // ignored rather than replacing the newer suggestion.
  hook.rerender({ prediction: { sourceTurnId: 'turn-1', status: 'ready', text: 'late turn-1 text' } });
  assert.equal(hook.result.current.suggestion, null);
});

test('clearing the prediction for a new turn retires the old result before a replacement arrives', () => {
  const hook = renderHook(({ prediction }: { prediction?: CodexComposerPrediction }) => useComposerPrediction({
    enabled: true, sessionId: SESSION.id, prediction, busy: false, suppressed: false, input: '',
  }), { initialProps: { prediction: ready() as CodexComposerPrediction | undefined } });
  assert.ok(hook.result.current.suggestion);

  hook.rerender({ prediction: undefined });
  assert.equal(hook.result.current.suggestion, null);
  hook.rerender({ prediction: ready('Late result from the previous turn.') });
  assert.equal(hook.result.current.suggestion, null);
});

test('native running, stopping and active-goal snapshots hide suggestions even before chat activity updates', () => {
  for (const phase of ['starting', 'running', 'stopping', 'stopFailed', 'failed'] as const) {
    const controls = nativeState(ready());
    controls.state!.phase = phase;
    const hook = renderComposer({ controls });
    assert.equal(hook.result.current.composerPrediction.suggestion, null, `${phase} cannot show a suggestion`);
    hook.unmount();
  }

  const controls = nativeState(ready());
  controls.state!.goal = {
    threadId: 'native-thread', objective: 'Finish the task', status: 'active',
    tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
  };
  const hook = renderComposer({ controls });
  assert.equal(hook.result.current.composerPrediction.suggestion, null);
});

test('switching sessions retires the suggestion so returning cannot show it again', () => {
  const hook = renderHook(({ sessionId, prediction }: { sessionId: string; prediction?: CodexComposerPrediction }) => useComposerPrediction({
    enabled: true, sessionId, prediction, busy: false, suppressed: false, input: '',
  }), { initialProps: { sessionId: SESSION.id as string, prediction: ready() as CodexComposerPrediction | undefined } });
  assert.ok(hook.result.current.suggestion);

  hook.rerender({ sessionId: 'other-session', prediction: undefined });
  assert.equal(hook.result.current.suggestion, null);

  // Back on the original session, the same snapshot must not repaint.
  hook.rerender({ sessionId: SESSION.id, prediction: ready() });
  assert.equal(hook.result.current.suggestion, null);
});

test('the persisted switch disables requests and survives a merge with other preferences', () => {
  writeUserPreference('uiPreferences', { showThinking: false, sidebarVisible: false });
  assert.equal(readStoredUiPreferences().showComposerPredictions, true);

  const enabled = renderComposer({ controls: nativeState(undefined) });
  assert.equal(enabled.result.current.composerPrediction.enabled, true);

  act(() => { enabled.result.current.composerPrediction.setEnabled(false); });
  assert.equal(enabled.result.current.composerPrediction.enabled, false);
  const stored = readStoredUiPreferences();
  assert.equal(stored.showComposerPredictions, false);
  // The write merges, so the unrelated preferences are preserved.
  assert.equal(stored.showThinking, false);
  assert.equal(stored.sidebarVisible, false);

  // Disabled in storage: no ghost text even for a ready snapshot.
  const disabled = renderComposer({ controls: nativeState(ready()) });
  assert.equal(disabled.result.current.composerPrediction.suggestion, null);
});

test('the send options carry an explicit per-turn opt-in and omit it when disabled', async () => {
  const on = renderComposer({ controls: nativeState(undefined) });
  act(() => { on.result.current.setInput('a message'); });
  await act(async () => { await on.result.current.handleSubmit({ preventDefault() {} } as never); });
  const onFrame = on.send.mock.calls.map(([message]) => message as { options: Record<string, unknown> })[0];
  assert.equal(onFrame.options.composerPredictions, true);

  writeUserPreference('uiPreferences', { ...readStoredUiPreferences(), showComposerPredictions: false });
  const off = renderComposer({ controls: nativeState(undefined) });
  act(() => { off.result.current.setInput('another message'); });
  await act(async () => { await off.result.current.handleSubmit({ preventDefault() {} } as never); });
  const offFrame = off.send.mock.calls.map(([message]) => message as { options: Record<string, unknown> })[0];
  assert.equal(offFrame.options.composerPredictions, false);
});

test('a first send keeps the prediction opt-in while its native runtime snapshot is still loading', async () => {
  const controls = nativeState();
  controls.state = null;
  const hook = renderComposer({ controls });
  act(() => { hook.result.current.setInput('Start the task.'); });
  await act(async () => { await hook.result.current.handleSubmit({ preventDefault() {} } as never); });
  const frame = hook.send.mock.calls.map(([message]) => message as { options: Record<string, unknown> })[0];
  assert.equal(frame.options.composerPredictions, true);
});

test('a queued message keeps the opt-in it was composed with', async () => {
  const queued = renderComposer({ controls: nativeState(undefined), isLoading: true });
  act(() => { queued.result.current.setInput('queue me'); });
  await act(async () => { await queued.result.current.handleSubmit({ preventDefault() {} } as never); });
  const stored = queued.result.current.queuedDraft;
  assert.equal(stored?.options?.composerPredictions, true);
  // Queueing a message is itself a suppression: nothing may show behind it.
  assert.equal(queued.result.current.composerPrediction.suggestion, null);
});

test('the overlay renders ghost text and its buttons accept or dismiss without submitting', () => {
  const accept = vi.fn();
  const dismiss = vi.fn();
  const view = render(<ComposerPredictionOverlay suggestion="Write the changelog." onAccept={accept} onDismiss={dismiss} />);
  assert.equal(screen.getByTestId('composer-prediction').textContent, 'Write the changelog.');

  fireEvent.click(screen.getByRole('button', { name: 'Use' }));
  assert.equal(accept.mock.calls.length, 1);

  fireEvent.click(screen.getByRole('button', { name: 'Hide suggestion' }));
  assert.equal(dismiss.mock.calls.length, 1);

  view.unmount();

  const status = render(<ComposerPredictionStatus enabled onChange={() => {}} unavailable />);
  assert.equal(screen.getByRole('button', { name: /Suggestions on/ }).getAttribute('aria-pressed'), 'true');
  assert.ok(screen.getByTestId('composer-prediction-unavailable').textContent);
  status.unmount();
});

test('pending, empty, failed, rejected and timed-out predictions report visible localized state', async () => {
  // The native request is outstanding: the composer says so instead of looking
  // like suggestions are simply broken.
  const pending = render(<ComposerPredictionStatus enabled onChange={() => {}} pending unavailable={false} />);
  assert.equal(screen.getByTestId('composer-prediction-pending').textContent, 'Waiting for a suggestion…');
  assert.equal(screen.queryByTestId('composer-prediction-unavailable'), null);
  pending.unmount();

  // Every classified reason has its own sentence; raw provider text is never used.
  const cases: Array<[CodexComposerPredictionReason, string]> = [
    ['empty', 'Codex returned no suggestion this time'],
    ['failed', 'Codex could not produce a suggestion'],
    ['rejected', 'Codex rejected the suggestion request'],
    ['request_failed', 'The suggestion request failed'],
    ['timeout', 'No suggestion arrived in time'],
  ];
  for (const [reason, expected] of cases) {
    const view = render(
      <ComposerPredictionStatus enabled onChange={() => {}} unavailable unavailableReason={reason} />,
    );
    assert.equal(screen.getByTestId('composer-prediction-unavailable').textContent, expected);
    view.unmount();
  }

  // A snapshot without a reason (an older publisher) keeps the generic copy.
  const generic = render(<ComposerPredictionStatus enabled onChange={() => {}} unavailable />);
  assert.equal(screen.getByTestId('composer-prediction-unavailable').textContent, 'No suggestion this time');
  generic.unmount();

  // Chinese gets localized text rather than an English fallback.
  await act(async () => { await i18n.changeLanguage('zh-CN'); });
  try {
    const zh = render(
      <ComposerPredictionStatus enabled onChange={() => {}} unavailable unavailableReason="timeout" />,
    );
    assert.equal(screen.getByTestId('composer-prediction-unavailable').textContent, '等待建议超时');
    zh.unmount();
  } finally {
    await act(async () => { await i18n.changeLanguage('en'); });
  }
});

test('a pending then empty prediction moves through visible states for the same turn', () => {
  const hook = renderHook(({ prediction }: { prediction?: CodexComposerPrediction }) => useComposerPrediction({
    enabled: true, sessionId: SESSION.id, prediction, busy: false, suppressed: false, input: '',
  }), { initialProps: {
    prediction: { sourceTurnId: 'turn-1', status: 'pending' } as CodexComposerPrediction,
  } });

  assert.equal(hook.result.current.pending, true);
  assert.equal(hook.result.current.unavailable, false);
  assert.equal(hook.result.current.suggestion, null);

  // The real `completed` result with null text arrives for the same turn.
  hook.rerender({ prediction: { sourceTurnId: 'turn-1', status: 'unavailable', reason: 'empty' } });
  assert.equal(hook.result.current.pending, false);
  assert.equal(hook.result.current.unavailable, true);
  assert.equal(hook.result.current.unavailableReason, 'empty');
  assert.equal(hook.result.current.suggestion, null);

  // Ready text continues to be the only thing that becomes ghost text.
  hook.rerender({ prediction: { sourceTurnId: 'turn-2', status: 'ready', text: 'Next step.' } });
  assert.equal(hook.result.current.suggestion, 'Next step.');
  assert.equal(hook.result.current.pending, false);
  assert.equal(hook.result.current.unavailable, false);
  assert.equal(hook.result.current.unavailableReason, undefined);
});

test('typing permanently retires a result, while a live turn only hides it', async () => {
  const typed = renderHook(({ input }: { input: string }) => useComposerPrediction({
    enabled: true, sessionId: SESSION.id, busy: false, suppressed: false, input,
    prediction: { sourceTurnId: 'turn-1', status: 'unavailable', reason: 'timeout' },
  }), { initialProps: { input: '' } });
  assert.equal(typed.result.current.unavailable, true);
  typed.rerender({ input: 'still editing' });
  assert.equal(typed.result.current.unavailable, false);
  assert.equal(typed.result.current.unavailableReason, undefined);
  // Clearing the input does not resurrect it: typing refused this turn for good.
  typed.rerender({ input: '' });
  assert.equal(typed.result.current.unavailable, false);

  // A live turn hides the note only; the same pending request shows again once
  // the turn ends, because the request itself was never refused.
  const busy = renderHook(({ isBusy }: { isBusy: boolean }) => useComposerPrediction({
    enabled: true, sessionId: SESSION.id, busy: isBusy, suppressed: false, input: '',
    prediction: { sourceTurnId: 'turn-2', status: 'pending' },
  }), { initialProps: { isBusy: true } });
  assert.equal(busy.result.current.pending, false);
  busy.rerender({ isBusy: false });
  assert.equal(busy.result.current.pending, true);
});
