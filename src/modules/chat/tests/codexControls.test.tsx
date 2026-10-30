import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import { CodexControlPanel } from '@/modules/chat/composer/CodexControlPanel';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { readQueuedMessage, resetChatDrafts } from '@/shared/chatDrafts';
import type { CodexControls, CodexSessionState, Project, ProjectSession, ServerEvent, SessionActivityMap } from '@/shared/types';

const project: Project = { projectId: 'codex-project', displayName: 'Test', fullPath: '/tmp/project' };
function controls(patch: Partial<CodexSessionState> = {}): CodexControls {
  return { state: { runtime: 'app-server', mode: 'default', phase: 'running', turnId: 'turn-1', goal: null, questions: [], ...patch },
    goalsEnabled: true, pending: false, error: null, delivery: null, control: vi.fn().mockResolvedValue(undefined), steer: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  localStorage.clear(); resetChatDrafts();
  // Model HTTP access: randomUUID is absent, but getRandomValues remains available.
  vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(url.includes('/files') ? [] : { data: [], drafts: [] }), { status: 200 }))));
});
afterEach(() => { vi.unstubAllGlobals(); });

test('the queued card steers its saved message and locks edits while confirmation is pending', () => {
  const codex = controls(); const edit = vi.fn(); const remove = vi.fn();
  const view = render(<QueuedMessageCard content="queued guidance" controls={codex} onEdit={edit} onDelete={remove} />);
  fireEvent.click(screen.getByRole('button', { name: 'Steer' }));
  expect(codex.steer).toHaveBeenCalledTimes(1);
  expect(screen.getByText('queued guidance')).toBeTruthy();
  view.rerender(<QueuedMessageCard content="queued guidance" controls={{ ...codex, pending: true }} onEdit={edit} onDelete={remove} />);
  expect((screen.getByRole('button', { name: 'Steering…' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Delete queued message' }) as HTMLButtonElement).disabled).toBe(true);
  expect(remove).not.toHaveBeenCalled();
});

test('SDK compatibility hides steer; Plan tasks cannot be promoted into a running turn', () => {
  const codex = controls({ runtime: 'sdk' });
  const edit = vi.fn();
  const view = render(<QueuedMessageCard content="queued" controls={codex} onEdit={edit} onDelete={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
  expect(edit).toHaveBeenCalledTimes(1);
  view.rerender(<QueuedMessageCard content="queued" onEdit={edit} onDelete={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }));
  expect(edit).toHaveBeenCalledTimes(2);
  view.rerender(<QueuedMessageCard content="queued" controls={controls()} canSteerMode={false} onEdit={() => {}} onDelete={() => {}} />);
  expect((screen.getByRole('button', { name: 'Steer' }) as HTMLButtonElement).disabled).toBe(true);
});

test('native questions require every answer and submit the request-specific response', async () => {
  const codex = controls({ questions: [{ requestId: 'q-request', turnId: 'turn-1', isBlocking: true,
    questions: [{ id: 'format', header: 'Format', question: 'Which format?', isOther: true, isSecret: false, options: [{ label: 'JSON', description: 'Structured' }] }] }] });
  render(<CodexControlPanel controls={codex} onExecutePlan={() => {}} />);
  expect((screen.getByRole('button', { name: 'Send answers' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Which format?'), { target: { value: 'YAML' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
  await waitFor(() => expect(codex.control).toHaveBeenCalledWith({ action: 'answer', requestId: 'q-request', answers: { format: { answers: ['YAML'] } } }));
});

test('execute plan changes mode and fills a prompt for review', async () => {
  const codex = controls({ mode: 'plan', phase: 'idle', turnId: null }); const fill = vi.fn();
  render(<CodexControlPanel controls={codex} onExecutePlan={fill} />);
  fireEvent.click(screen.getByRole('button', { name: 'Execute plan' }));
  await waitFor(() => expect(fill).toHaveBeenCalledTimes(1));
  expect(codex.control).toHaveBeenCalledWith({ action: 'mode', mode: 'default' });
});

test('the process stop button works during a turn and disables once the process exits', async () => {
  const diagnostics = { running: true, pid: 43210, startedAt: 1_800_000_000_000, pendingRequests: 0, launcherPath: null, cliVersion: null };
  const codex = controls({ diagnostics });
  const view = render(<CodexControlPanel controls={codex} onExecutePlan={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
  expect(screen.queryByRole('combobox', { name: 'Runtime' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Restart app-server' })).toBeNull();
  const button = screen.getByRole('button', { name: 'Stop app-server' }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(codex.control).toHaveBeenCalledWith({ action: 'stop-app-server' }));
  view.rerender(<CodexControlPanel controls={{ ...codex, pending: true }} onExecutePlan={() => {}} />);
  expect(button.disabled).toBe(true);
  view.rerender(<CodexControlPanel controls={controls({ phase: 'idle', turnId: null, diagnostics: { ...diagnostics, running: false, pid: null, startedAt: null } })} onExecutePlan={() => {}} />);
  expect(button.disabled).toBe(true);
  expect(screen.queryByText('PID 43210')).toBeNull();
});

test('the Codex settings button shows Worker activity without changing its click target', () => {
  const codex = { ...controls(), hasActiveWorkers: true };
  const view = render(<CodexControlPanel controls={codex} onExecutePlan={() => {}} />);
  const button = screen.getByRole('button', { name: 'Codex' });
  expect(button.querySelector('.animate-spin')).not.toBeNull();
  expect(screen.getByRole('status').textContent).toContain('Worker');
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('true');

  view.rerender(<CodexControlPanel controls={{ ...codex, hasActiveWorkers: false }} onExecutePlan={() => {}} />);
  expect(button.querySelector('.animate-spin')).toBeNull();
  fireEvent.click(button);
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

function composer(codex: CodexControls, isLoading = true, processingSessions?: SessionActivityMap) {
  const send = vi.fn(); const add = vi.fn();
  const view = renderHook(() => useChatComposerState({ selectedProject: project, selectedSession: { id: 'codex-session' } as ProjectSession,
    currentSessionId: 'codex-session', provider: 'codex', codexControls: codex, permissionMode: 'default', cyclePermissionMode: () => {},
    resolvePermissionModeForProvider: () => 'default', currentProviderModel: 'test-model', currentProviderEffort: 'high',
    isLoading, processingSessions, canAbortSession: true, tokenBudget: null, sendMessage: send, scrollToBottom: () => {}, addMessage: add,
    setIsUserScrolledUp: () => {}, setPendingPermissionRequests: () => {} }));
  const submit = async (text: string) => {
    await act(async () => { view.result.current.setInput(text); });
    await act(async () => { await view.result.current.handleSubmit({ preventDefault() {} } as never); });
  };
  return { ...view, submit, send, add };
}

test('/goal pause bypasses the busy queue and does not send model text', async () => {
  const codex = controls(); const h = composer(codex);
  await h.submit('/goal pause');
  expect(codex.control).toHaveBeenCalledWith({ action: 'goal', operation: 'pause' });
  expect(h.result.current.queuedDraft).toBeNull();
  expect(h.send).not.toHaveBeenCalled();
});

test('the Goal panel stays hidden by default and appears only with server opt-in', () => {
  const codex = controls();
  const view = render(<CodexControlPanel controls={{ ...codex, goalsEnabled: undefined }} onExecutePlan={() => {}} />);
  expect(screen.queryByPlaceholderText('Goal objective')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Set goal', hidden: true })).toBeNull();
  view.rerender(<CodexControlPanel controls={codex} onExecutePlan={() => {}} />);
  expect(screen.getByRole('button', { name: 'Set goal', hidden: true })).toBeTruthy();
});

test('typing /goal while disabled reports an error without queuing or sending work', async () => {
  const codex = { ...controls(), goalsEnabled: false };
  const h = composer(codex);
  await h.submit('/goal build a feature');
  expect(codex.control).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
  expect(h.result.current.queuedDraft).toBeNull();
  expect(h.add).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', content: 'Goals are not enabled on this server.' }));
});

test('/plan alone is a control; /plan task becomes a durable Plan queue entry while busy', async () => {
  const codex = controls(); const h = composer(codex);
  await h.submit('/plan');
  expect(codex.control).toHaveBeenCalledWith({ action: 'mode', mode: 'plan' });
  await h.submit('/plan design the API');
  expect(h.result.current.queuedDraft?.content).toBe('design the API');
  expect(h.result.current.queuedDraft?.id).toBeTruthy();
  expect(h.result.current.queuedDraft?.options?.collaborationMode).toBe('plan');
  expect(h.send).not.toHaveBeenCalled();
});

test('ordinary busy input stays queued and retains its identity across store updates', async () => {
  const codex = controls(); const h = composer(codex);
  await h.submit('normal queued input');
  const id = h.result.current.queuedDraft?.id;
  await act(async () => { h.result.current.setInput('another draft'); });
  expect(h.result.current.queuedDraft?.id).toBe(id);
  expect(codex.control).not.toHaveBeenCalled(); expect(codex.steer).not.toHaveBeenCalled();
});

for (const running of [false, true]) {
  test(`an empty model rejects ${running ? 'queueing' : 'sending'} and preserves the typed prompt`, async () => {
    const codex = controls({ modelSelection: { modelProvider: 'beta', model: null } });
    const h = composer(codex, running);
    await h.submit('keep this unsent prompt');
    expect(h.send).not.toHaveBeenCalled();
    expect(h.result.current.input).toBe('keep this unsent prompt');
    expect(h.result.current.queuedDraft).toBeNull();
    expect(h.add).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', content: 'Choose a model below before sending prompts or running queued messages.' }));
  });
}

test('a multiline Plan task queued behind background work keeps its mode and durable identity', async () => {
  const h = composer(controls({ phase: 'idle', turnId: null }), false, new Map([
    ['codex-session', { statusText: null, canInterrupt: false, startedAt: 1, background: true, tasks: [] }],
  ]));
  await act(async () => { h.result.current.setInput('/plan\n/help design the API\ninclude tests'); });
  let pending!: Promise<void>;
  act(() => { pending = h.result.current.handleSubmit({ preventDefault() {} } as never); });
  await waitFor(() => expect(h.result.current.backgroundSendPrompt).not.toBeNull());
  await act(async () => {
    h.result.current.resolveBackgroundSendPrompt('queue');
    await pending;
  });
  const stored = readQueuedMessage('codex-session');
  expect(stored?.id).toBeTruthy();
  expect(stored?.id).toBe(h.result.current.queuedDraft?.id);
  expect(stored?.content).toBe('/help design the API\ninclude tests');
  expect(stored?.options?.collaborationMode).toBe('plan');
  expect(h.send).not.toHaveBeenCalled();
});

test('sending and stopping work without native randomUUID', async () => {
  const h = composer(controls({ phase: 'idle', turnId: null }), false);
  await h.submit('send over HTTP');
  const message = h.add.mock.calls.find(([entry]) => entry.type === 'user')?.[0];
  expect(message?.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'chat.send', options: expect.objectContaining({ clientMessageId: message.id }),
  }));

  act(() => h.result.current.handleAbortSession());
  const abort = h.send.mock.calls.find(([entry]) => entry.type === 'chat.abort')?.[0];
  expect(abort?.requestId).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  expect(abort.requestId).not.toBe(message.id);
});

test('control errors and native goal turn completion preserve busy state until the authoritative snapshot is idle', () => {
  let listener: (event: ServerEvent) => void = () => {};
  const idle = vi.fn(); const busy = vi.fn(); const append = vi.fn();
  const executionIdsRef = { current: new Map<string, string>() }; const lastSeqRef = { current: new Map<string, number>() };
  renderHook(() => useChatRealtimeHandlers({ isActive: true, subscribe: (fn) => { listener = fn; return () => {}; }, provider: 'codex',
    selectedSession: { id: 'codex-session' } as ProjectSession, currentSessionId: 'codex-session', setTokenBudget: () => {},
    pendingPermissionRequests: [], setPendingPermissionRequests: () => {}, streamTimerRef: { current: null }, accumulatedStreamRef: { current: '' },
    executionIdsRef, lastSeqRef, statusCheckSentAtRef: { current: new Map() }, onSessionProcessing: busy, onSessionIdle: idle,
    requestLatestMessages: async () => {}, sessionStore: { appendRealtime: append } as never }));
  listener({ kind: 'control_result', sessionId: 'codex-session', ok: false, error: 'steer rejected' } as ServerEvent);
  listener({ kind: 'complete', sessionId: 'codex-session', executionId: 'one', seq: 500, goalActive: true } as ServerEvent);
  expect(idle).not.toHaveBeenCalled(); expect(busy).toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
  listener({ kind: 'status', text: 'codex_control', sessionId: 'codex-session', executionId: 'two', seq: 1, codexState: controls().state } as ServerEvent);
  expect(executionIdsRef.current.get('codex-session')).toBe('two');
  // Native state frames do not advance the transcript cursor; subsequent item frames do.
  listener({ kind: 'text', sessionId: 'codex-session', executionId: 'two', seq: 2, id: 'item', content: 'next' } as ServerEvent);
  expect(lastSeqRef.current.get('codex-session')).toBe(2);
  listener({ kind: 'status', text: 'codex_control', sessionId: 'codex-session', codexState: controls({ phase: 'idle', turnId: null }).state } as ServerEvent);
  expect(idle).toHaveBeenCalledTimes(1);
});

test('native item snapshots replace one row while different items and turns stay separate', () => {
  const h = renderHook(() => useSessionStore());
  act(() => {
    for (const [id, content] of [['codex:t1:a', 'one'], ['codex:t1:b', 'tool follow-up'], ['codex:t1:a', 'one two'], ['codex:t2:a', 'second turn']]) {
      h.result.current.appendRealtime('snapshot-session', { id, kind: 'text', role: 'assistant', content, provider: 'codex', sessionId: 'snapshot-session', timestamp: new Date().toISOString() });
    }
  });
  const messages = h.result.current.getMessages('snapshot-session');
  expect(messages.map((message) => message.content)).toEqual(['one two', 'tool follow-up', 'second turn']);
});

for (const mobile of [false, true]) {
  test(`empty paused queues hide resume and queued messages restore it (${mobile ? 'mobile' : 'desktop'})`, () => {
    const value = controls({ queueHeld: true, phase: 'idle', turnId: null });
    const settingsContainer = mobile ? null : undefined;
    const view = render(<CodexControlPanel controls={value} onExecutePlan={() => {}} settingsContainer={settingsContainer} />);
    expect(screen.queryByRole('button', { name: 'Resume queue' })).toBeNull();
    if (mobile) expect(view.container.textContent).toBe('');
    view.rerender(<CodexControlPanel controls={value} onExecutePlan={() => {}} settingsContainer={settingsContainer} hasQueuedDraft />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume queue' }));
    expect(value.control).toHaveBeenCalledWith({ action: 'queue-resume' });
    view.rerender(<CodexControlPanel controls={value} onExecutePlan={() => {}} settingsContainer={settingsContainer} hasQueuedDraft={false} />);
    expect(screen.queryByRole('button', { name: 'Resume queue' })).toBeNull();
    expect(value.state?.queueHeld).toBe(true);
  });
}
