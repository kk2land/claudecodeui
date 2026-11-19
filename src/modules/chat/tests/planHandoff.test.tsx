import assert from 'node:assert/strict';

import type { ContextType } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import PlanHandoffContext from '@/modules/chat/context/PlanHandoffContext';
import PermissionContext from '@/modules/chat/context/PermissionContext';
import { CodexControlPanel } from '@/modules/chat/composer/CodexControlPanel';
import { usePlanHandoff } from '@/modules/chat/hooks/usePlanHandoff';
import { PlanDisplay } from '@/modules/chat/tools/PlanDisplay';
import type { CodexControls, Project } from '@/shared/types';

type PlanHandoffContextValue = NonNullable<ContextType<typeof PlanHandoffContext>>;
type PlanHandoffLatestPlan = NonNullable<PlanHandoffContextValue['latestPlan']>;

const apiMocks = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock('@/shared/api', () => ({ api: { providers: { createSession: apiMocks.createSession } } }));

const project: Project = { projectId: 'p1', displayName: 'repo', fullPath: '/work/repo', path: '/work/repo' };

function createResponse(sessionId = 'target-session', sessionName = 'Plan') {
  return { ok: true, status: 200, json: async () => ({ data: { sessionId, sessionName } }) };
}

function panelHarness(options: {
  mode?: 'default' | 'plan';
  latestPlan?: PlanHandoffLatestPlan | null;
  pending?: boolean;
  handedOffTargetSessionId?: string | null;
  implementInNewSession?: () => Promise<void>;
} = {}) {
  const implementInNewSession = options.implementInNewSession ?? vi.fn(async () => {});
  const onExecutePlan = vi.fn();
  const control = vi.fn(async () => {});
  const controls = {
    state: { runtime: 'app-server', mode: options.mode ?? 'plan', questions: [], phase: 'idle' },
    error: null,
    pending: false,
    control,
  } as unknown as CodexControls;
  const context: PlanHandoffContextValue = {
    implementInNewSession,
    pending: options.pending ?? false,
    latestPlan: options.latestPlan === undefined
      ? { sourceSessionId: 'source-session', markdown: '# Plan' }
      : options.latestPlan,
    handedOffTargetSessionId: options.handedOffTargetSessionId ?? null,
  };
  const view = render(
    <PlanHandoffContext.Provider value={context}>
      <CodexControlPanel controls={controls} onExecutePlan={onExecutePlan} />
    </PlanHandoffContext.Provider>,
  );
  return { ...view, context, controls, control, onExecutePlan, implementInNewSession };
}

beforeEach(() => { vi.clearAllMocks(); });

test('the toolbar shows the new-session entry right after execute plan and sends the exact plan body', async () => {
  const markdown = '## 计划\n\n```ts\nconst answer = 42;\n```\n\n保留尾部空白  ';
  const { implementInNewSession } = panelHarness({
    latestPlan: { sourceSessionId: 'source-session', markdown },
  });

  const buttons = screen.getAllByRole('button');
  const executeIndex = buttons.findIndex((button) => button.textContent === 'Execute plan');
  const newSession = screen.getByRole('button', { name: 'New session' });
  assert.equal(buttons.indexOf(newSession), executeIndex + 1);
  assert.equal(newSession.getAttribute('title'), 'Implement the complete plan in a new session');

  fireEvent.click(newSession);
  await act(async () => { await Promise.resolve(); });
  assert.deepEqual((implementInNewSession as ReturnType<typeof vi.fn>).mock.calls, [[{ markdown }]]);
});

test('execute plan still only switches the mode and fills the prompt', async () => {
  const { control, onExecutePlan, implementInNewSession } = panelHarness();

  fireEvent.click(screen.getByRole('button', { name: 'Execute plan' }));
  await act(async () => { await Promise.resolve(); });

  assert.deepEqual(control.mock.calls, [[{ action: 'mode', mode: 'default' }]]);
  assert.equal(onExecutePlan.mock.calls.length, 1);
  assert.equal((implementInNewSession as ReturnType<typeof vi.fn>).mock.calls.length, 0);
});

test('the entry is hidden without plan mode or without a complete latest plan', () => {
  panelHarness({ mode: 'default' });
  assert.equal(screen.queryByRole('button', { name: 'New session' }), null);

  panelHarness({ latestPlan: null });
  assert.equal(screen.queryByRole('button', { name: 'New session' }), null);
});

test('a pending handoff disables the entry with the existing pending wording', () => {
  panelHarness({ pending: true });
  const button = screen.getByRole('button', { name: 'Starting new session…' });
  assert.equal((button as HTMLButtonElement).disabled, true);
});

test('a plan that already has a target is offered as opening that session', async () => {
  const { implementInNewSession } = panelHarness({ handedOffTargetSessionId: 'target-session' });

  const button = screen.getByRole('button', { name: 'Open session' });
  assert.equal(button.getAttribute('title'), 'Open the session already implementing this plan');
  // The misleading new-session wording is gone once the target exists.
  assert.equal(screen.queryByRole('button', { name: 'New session' }), null);

  // The hook owns navigation; the toolbar still routes the click through it.
  fireEvent.click(button);
  await act(async () => { await Promise.resolve(); });
  assert.equal((implementInNewSession as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

test('a creation failure stays beside the toolbar for its own plan and a retry is possible', async () => {
  const implementInNewSession = vi.fn(async () => { throw new Error('gateway unavailable'); });
  const first = { sourceSessionId: 'source-session', markdown: '# First plan' };
  const second = { sourceSessionId: 'source-session', markdown: '# Second plan' };
  const view = panelHarness({ latestPlan: first, implementInNewSession });

  fireEvent.click(screen.getByRole('button', { name: 'New session' }));
  await act(async () => { await Promise.resolve(); });
  assert.equal(screen.getByRole('alert').textContent, 'gateway unavailable');

  // Another plan invalidates the error instead of carrying it across the switch.
  view.rerender(
    <PlanHandoffContext.Provider value={{ ...view.context, latestPlan: second }}>
      <CodexControlPanel controls={view.controls} onExecutePlan={view.onExecutePlan} />
    </PlanHandoffContext.Provider>,
  );
  assert.equal(screen.queryByRole('alert'), null);

  fireEvent.click(screen.getByRole('button', { name: 'New session' }));
  await act(async () => { await Promise.resolve(); });
  assert.equal(implementInNewSession.mock.calls.length, 2);
  assert.equal(screen.getByRole('alert').textContent, 'gateway unavailable');

  // A different source session invalidates it even when the plan text is identical.
  view.rerender(
    <PlanHandoffContext.Provider value={{
      ...view.context,
      latestPlan: { ...second, sourceSessionId: 'other-session' },
    }}>
      <CodexControlPanel controls={view.controls} onExecutePlan={view.onExecutePlan} />
    </PlanHandoffContext.Provider>,
  );
  assert.equal(screen.queryByRole('alert'), null);
});

test('the plan card keeps only its permission footer and offers no new-session entry', () => {
  const handlePermissionDecision = vi.fn();
  render(
    <PermissionContext.Provider value={{
      pendingPermissionRequests: [{ requestId: 'r1', toolName: 'ExitPlanMode' }],
      handlePermissionDecision,
    }}>
      <PlanHandoffContext.Provider value={{
        implementInNewSession: vi.fn(async () => {}),
        pending: false,
        latestPlan: { sourceSessionId: 'source-session', markdown: '# Plan' },
        handedOffTargetSessionId: null,
      }}>
        <PlanDisplay title="Plan" content="## Step 1" toolName="ExitPlanMode" />
      </PlanHandoffContext.Provider>
    </PermissionContext.Provider>,
  );

  assert.equal(screen.queryByRole('button', { name: 'New session' }), null);
  assert.ok(screen.getByRole('button', { name: /^Build/ }));
  assert.ok(screen.getByRole('button', { name: 'Revise' }));
});

test('the hook creates one target, sends once to the returned id and carries the complete plan', async () => {
  apiMocks.createSession.mockResolvedValue(createResponse());
  const sendMessage = vi.fn();
  const onSessionEstablished = vi.fn();
  const onSessionProcessing = vi.fn();
  const markdown = '## Plan\n\n1. Keep every word';

  const { result } = renderHook(() => usePlanHandoff({
    enabled: true,
    project,
    sendMessage,
    onSessionEstablished,
    onSessionProcessing,
    sourceSessionId: 'source-session',
    content: 'Implement the plan.',
    model: 'gpt-native',
    effort: 'medium',
    permissionMode: 'default',
    resolvePermissionModeForProvider: (_provider, mode) => mode as 'default',
    modelSelection: { modelProvider: 'alpha', model: 'gpt-native' },
  }));

  await act(async () => { await result.current.implementInNewSession({ markdown }); });

  assert.equal(apiMocks.createSession.mock.calls.length, 1);
  assert.deepEqual(apiMocks.createSession.mock.calls[0][0], {
    provider: 'codex', projectPath: '/work/repo', initialMessage: markdown,
  });
  assert.deepEqual(onSessionEstablished.mock.calls[0],
    ['target-session', { provider: 'codex', project, summary: 'Plan' }]);
  assert.deepEqual(onSessionProcessing.mock.calls[0],
    ['target-session', { statusText: null, canInterrupt: true }]);
  assert.equal(sendMessage.mock.calls.length, 1);
  const frame = sendMessage.mock.calls[0][0];
  assert.equal(frame.type, 'chat.send');
  assert.equal(frame.sessionId, 'target-session');
  assert.equal(frame.content, 'Implement the plan.');
  assert.equal(frame.options.collaborationMode, 'default');
  assert.equal(frame.options.model, 'gpt-native');
  assert.equal(frame.options.effort, 'medium');
  assert.equal(frame.options.permissionMode, 'default');
  assert.deepEqual(frame.options.approvedPlan, {
    markdown,
    modelSelection: { modelProvider: 'alpha', model: 'gpt-native' },
  });
});

test('a second click while creation is in flight does not allocate another session', async () => {
  let resolveCreate: (value: unknown) => void = () => {};
  apiMocks.createSession.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
  const sendMessage = vi.fn();
  const { result } = renderHook(() => usePlanHandoff({
    enabled: true, project, sendMessage, onSessionEstablished: vi.fn(), sourceSessionId: 'source-session',
    content: 'Implement the plan.', model: 'm', effort: 'default', permissionMode: 'default',
    resolvePermissionModeForProvider: (_provider, mode) => mode as 'default',
  }));

  let first: Promise<void> = Promise.resolve();
  let second: Promise<void> = Promise.resolve();
  act(() => {
    first = result.current.implementInNewSession({ markdown: '# Plan' });
    second = result.current.implementInNewSession({ markdown: '# Plan' });
  });
  assert.equal(apiMocks.createSession.mock.calls.length, 1);

  await act(async () => {
    resolveCreate(createResponse());
    await Promise.all([first, second]);
  });
  assert.equal(sendMessage.mock.calls.length, 1);
});

test('creation failure dispatches nothing and carries no plan selection', async () => {
  apiMocks.createSession.mockResolvedValue({
    ok: false, status: 400, json: async () => ({ error: { message: 'projectPath is required.' } }),
  });
  const sendMessage = vi.fn();
  const onSessionEstablished = vi.fn();
  const { result } = renderHook(() => usePlanHandoff({
    enabled: true, project, sendMessage, onSessionEstablished, sourceSessionId: 'source-session',
    content: 'Implement the plan.', model: 'm', effort: 'default', permissionMode: 'default',
    resolvePermissionModeForProvider: (_provider, mode) => mode as 'default',
  }));

  await assert.rejects(
    () => result.current.implementInNewSession({ markdown: '# Plan' }),
    /projectPath is required\./,
  );
  assert.equal(sendMessage.mock.calls.length, 0);
  assert.equal(onSessionEstablished.mock.calls.length, 0);
});

test('a successfully handed-off plan is reopened instead of created again, while a revision or another source still creates', async () => {
  const markdown = '## Plan\n\n1. Keep every word';
  const revised = `${markdown}\n2. Then this`;
  const sendMessage = vi.fn();
  const onSessionEstablished = vi.fn();
  const onSessionProcessing = vi.fn();
  const onOpenSession = vi.fn();
  apiMocks.createSession.mockResolvedValue(createResponse('target-three'));
  apiMocks.createSession
    .mockResolvedValueOnce(createResponse('target-one'))
    .mockResolvedValueOnce(createResponse('target-two'));

  const { result, rerender } = renderHook(({ sourceSessionId }: { sourceSessionId: string }) => usePlanHandoff({
    enabled: true, project, sendMessage, onSessionEstablished, onSessionProcessing, onOpenSession,
    sourceSessionId, content: 'Implement the plan.', model: 'm', effort: 'default', permissionMode: 'default',
    resolvePermissionModeForProvider: (_provider, mode) => mode as 'default',
  }), { initialProps: { sourceSessionId: 'source-a' } });

  await act(async () => { await result.current.implementInNewSession({ markdown }); });
  assert.equal(apiMocks.createSession.mock.calls.length, 1);
  assert.equal(result.current.handedOffSessionIdFor({ markdown }), 'target-one');

  // The same source and the identical body only navigate: no second target, no
  // establishment, no processing mark and no second send.
  await act(async () => { await result.current.implementInNewSession({ markdown }); });
  assert.deepEqual(onOpenSession.mock.calls, [['target-one']]);
  assert.equal(apiMocks.createSession.mock.calls.length, 1);
  assert.equal(sendMessage.mock.calls.length, 1);
  assert.equal(onSessionEstablished.mock.calls.length, 1);
  assert.equal(onSessionProcessing.mock.calls.length, 1);
  assert.equal(result.current.handedOffSessionIdFor({ markdown: revised }), null);

  // A revised plan body is a first handoff of its own.
  await act(async () => { await result.current.implementInNewSession({ markdown: revised }); });
  assert.equal(apiMocks.createSession.mock.calls.length, 2);
  assert.equal(sendMessage.mock.calls.length, 2);
  assert.equal(onSessionEstablished.mock.calls.at(-1)?.[0], 'target-two');

  // Identical text from another source session must not reuse the first target.
  rerender({ sourceSessionId: 'source-b' });
  assert.equal(result.current.handedOffSessionIdFor({ markdown }), null);
  await act(async () => { await result.current.implementInNewSession({ markdown }); });
  assert.equal(apiMocks.createSession.mock.calls.length, 3);
  assert.equal(sendMessage.mock.calls.length, 3);
  assert.equal(onOpenSession.mock.calls.length, 1);
});

test('a failed handoff records no target, so the next click still creates one', async () => {
  apiMocks.createSession.mockResolvedValueOnce({
    ok: false, status: 500, json: async () => ({ error: { message: 'gateway unavailable' } }),
  });
  apiMocks.createSession.mockResolvedValueOnce(createResponse('target-after-retry'));
  const sendMessage = vi.fn();
  const onOpenSession = vi.fn();
  const { result } = renderHook(() => usePlanHandoff({
    enabled: true, project, sendMessage, onSessionEstablished: vi.fn(), onOpenSession,
    sourceSessionId: 'source-session',
    content: 'Implement the plan.', model: 'm', effort: 'default', permissionMode: 'default',
    resolvePermissionModeForProvider: (_provider, mode) => mode as 'default',
  }));

  await assert.rejects(
    () => result.current.implementInNewSession({ markdown: '# Plan' }),
    /gateway unavailable/,
  );
  assert.equal(result.current.handedOffSessionIdFor({ markdown: '# Plan' }), null);

  await act(async () => { await result.current.implementInNewSession({ markdown: '# Plan' }); });
  assert.equal(apiMocks.createSession.mock.calls.length, 2);
  assert.equal(sendMessage.mock.calls.length, 1);
  assert.equal(result.current.handedOffSessionIdFor({ markdown: '# Plan' }), 'target-after-retry');
  assert.equal(onOpenSession.mock.calls.length, 0);
});
