import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import QueuedMessageCard from '@/modules/chat/composer/QueuedMessageCard';
import { CodexControlPanel } from '@/modules/chat/composer/CodexControlPanel';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { CodexControls, CodexSessionState, Project, ProjectSession, ServerEvent } from '@/shared/types';

const project: Project = { projectId: 'codex-project', displayName: 'Test', fullPath: '/tmp/project' };
function controls(patch: Partial<CodexSessionState> = {}): CodexControls {
  return { state: { runtime: 'app-server', mode: 'default', phase: 'running', turnId: 'turn-1', goal: null, questions: [], ...patch },
    pending: false, error: null, delivery: null, control: vi.fn().mockResolvedValue(undefined), steer: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
  localStorage.clear(); resetChatDrafts();
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
  const view = render(<QueuedMessageCard content="queued" controls={codex} onEdit={() => {}} onDelete={() => {}} />);
  expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull();
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

function composer(codex: CodexControls) {
  const send = vi.fn(); const add = vi.fn();
  const view = renderHook(() => useChatComposerState({ selectedProject: project, selectedSession: { id: 'codex-session' } as ProjectSession,
    currentSessionId: 'codex-session', provider: 'codex', codexControls: codex, permissionMode: 'default', cyclePermissionMode: () => {},
    resolvePermissionModeForProvider: () => 'default', currentProviderModel: 'test-model', currentProviderEffort: 'high',
    isLoading: true, canAbortSession: true, tokenBudget: null, sendMessage: send, scrollToBottom: () => {}, addMessage: add,
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
