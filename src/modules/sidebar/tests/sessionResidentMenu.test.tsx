import { expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import type { ComponentProps } from 'react';

import SessionOptions from '@/modules/sidebar/SessionOptions';
import { useResidentTaskAction } from '@/modules/sidebar/hooks/useResidentTaskAction';
import type { ProjectSession } from '@/shared/types';

/**
 * Real interaction coverage for the session menu's resident ("设为常驻") entry. The menu, the
 * capability hook and the adoption request are all the production ones; only the HTTP layer is
 * replaced, so these assert the three states a user sees: an idle session greyed out, a running
 * session adopting through the plugin route, and a bound session that cannot be adopted twice.
 */

const adoptCalls: string[] = [];
let capabilityProviders: Array<Record<string, unknown>> = [
  { provider: 'codex', supportsResidentTasks: true },
  { provider: 'claude', supportsResidentTasks: false },
];
let adoptResponse: () => Promise<unknown> = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ task: { taskId: 'resident-1' } }),
});

vi.mock('@/shared/api', () => ({
  api: {
    providerSessionId: async () => ({ ok: true, json: async () => ({ data: { sessionId: 'native-1' } }) }),
    providers: {
      capabilities: async () => ({ json: async () => ({ success: true, data: { providers: capabilityProviders } }) }),
    },
    plugins: {
      adoptResidentSession: async (sessionId: string) => {
        adoptCalls.push(sessionId);
        return adoptResponse();
      },
    },
  },
}));

const t = ((key: string) => key) as TFunction;
const noop = () => {};

/** Mounts the menu with the resident entry computed by the production hook. */
function MenuHost({ session, isProcessing }: { session: ProjectSession; isProcessing: boolean }) {
  const residentAction = useResidentTaskAction({
    session,
    provider: (session.__provider ?? 'codex'),
    isProcessing,
  });
  const props = {
    sessionId: session.id,
    sessionName: 'Session one',
    provider: session.__provider ?? 'codex',
    projectId: 'project-1',
    isProcessing,
    isEditing: false,
    renameDraft: '',
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onArchiveSession: noop,
    onDeleteSession: noop,
    residentAction,
    t,
  } satisfies ComponentProps<typeof SessionOptions>;
  return <SessionOptions {...props} />;
}

/** A projection as W1's session list reports it for a session that is not running right now. */
const residentInfo = (overrides: Record<string, unknown> = {}) => ({
  taskId: null,
  status: 'idle' as const,
  enabled: true,
  visible: true,
  adoptable: false,
  blockedReason: 'not_running' as const,
  ...overrides,
});

const session = (overrides: Partial<ProjectSession> = {}): ProjectSession => ({
  id: 'session-1',
  summary: 'Session one',
  __provider: 'codex',
  __projectId: 'project-1',
  ...overrides,
});

const openMenu = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Session options for Session one' }));
  });
};

test('an idle Codex session shows the resident entry greyed out, not hidden', async () => {
  render(<MenuHost session={session({ resident: residentInfo() })} isProcessing={false} />);
  await openMenu();

  const item = screen.getByRole('menuitem', { name: /设为常驻/ }) as HTMLButtonElement;
  expect(item.disabled).toBe(true);
  expect(screen.getByText('会话当前没有正在运行的任务')).toBeTruthy();
});

test('an unsupported provider never offers the entry', async () => {
  render(
    <MenuHost
      session={session({ __provider: 'claude', resident: residentInfo({ blockedReason: 'unsupported_provider' }) })}
      isProcessing
    />,
  );
  await openMenu();

  expect(screen.queryByRole('menuitem', { name: /设为常驻/ })).toBeNull();
});

test('a running session adopts through the plugin route and then reports the binding', async () => {
  adoptCalls.length = 0;
  // The list snapshot said "not running" before this turn started; the live state says it is.
  render(<MenuHost session={session({ resident: residentInfo() })} isProcessing />);
  await openMenu();

  const item = screen.getByRole('menuitem', { name: /设为常驻/ }) as HTMLButtonElement;
  expect(item.disabled).toBe(false);
  await act(async () => {
    fireEvent.click(item);
  });

  expect(adoptCalls).toEqual(['session-1']);
  // The menu stays open, so the confirmed binding replaces the offer in place.
  await waitFor(() => {
    const bound = screen.getByRole('menuitem', { name: /已设为常驻/ }) as HTMLButtonElement;
    expect(bound.disabled).toBe(true);
  });
});

test('a session the server reports as bound cannot be adopted again', async () => {
  adoptCalls.length = 0;
  render(
    <MenuHost
      session={session({
        resident: {
          taskId: 'resident-7',
          status: 'running',
          enabled: true,
          visible: true,
          adoptable: false,
          blockedReason: 'already_resident',
        },
      })}
      isProcessing
    />,
  );
  await openMenu();

  const bound = screen.getByRole('menuitem', { name: /已设为常驻/ }) as HTMLButtonElement;
  expect(bound.disabled).toBe(true);
  await act(async () => {
    fireEvent.click(bound);
  });
  expect(adoptCalls).toEqual([]);
});

test('a server refusal is shown in the menu instead of a fake success', async () => {
  adoptCalls.length = 0;
  adoptResponse = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: '该会话没有正在运行的任务' }),
  });
  render(<MenuHost session={session({ resident: residentInfo() })} isProcessing />);
  await openMenu();

  const item = screen.getByRole('menuitem', { name: /设为常驻/ });
  await act(async () => {
    fireEvent.click(item);
  });
  expect(adoptCalls).toEqual(['session-1']);
  await waitFor(() => expect(screen.getByText('该会话没有正在运行的任务')).toBeTruthy());
  expect(screen.queryByRole('menuitem', { name: /已设为常驻/ })).toBeNull();
});

test('a projection that still says running is greyed out once the turn has ended', async () => {
  adoptCalls.length = 0;
  render(
    <MenuHost
      session={session({ resident: residentInfo({ status: 'running', adoptable: true, blockedReason: null }) })}
      isProcessing={false}
    />,
  );
  await openMenu();

  const item = screen.getByRole('menuitem', { name: /设为常驻/ }) as HTMLButtonElement;
  expect(item.disabled).toBe(true);
  expect(screen.getByText('会话当前没有正在运行的任务')).toBeTruthy();
});

test('a session whose plugin is unavailable is refused even while a run is active', async () => {
  adoptCalls.length = 0;
  render(
    <MenuHost
      session={session({ resident: residentInfo({ blockedReason: 'plugin_unavailable' }) })}
      isProcessing
    />,
  );
  await openMenu();

  const item = screen.getByRole('menuitem', { name: /设为常驻/ }) as HTMLButtonElement;
  expect(item.disabled).toBe(true);
  expect(screen.getByText('常驻任务插件不可用')).toBeTruthy();
  await act(async () => {
    fireEvent.click(item);
  });
  expect(adoptCalls).toEqual([]);
});

test('without any projection the entry does not claim a running session is adoptable', async () => {
  adoptCalls.length = 0;
  render(<MenuHost session={session()} isProcessing />);
  await openMenu();

  const item = screen.getByRole('menuitem', { name: /设为常驻/ }) as HTMLButtonElement;
  expect(item.disabled).toBe(true);
  expect(screen.getByText('正在等待会话状态')).toBeTruthy();
});

test('the binding follows the server projection through adopt, delete and a later run', async () => {
  adoptCalls.length = 0;
  const staleIdle = residentInfo();
  const { rerender } = render(<MenuHost session={session({ resident: staleIdle })} isProcessing />);
  await openMenu();

  const adoptButton = screen.getByRole('menuitem', { name: /设为常驻/ }) as HTMLButtonElement;
  expect(adoptButton.disabled).toBe(false);
  await act(async () => {
    fireEvent.click(adoptButton);
  });
  expect(adoptCalls).toEqual(['session-1']);

  // The server's own binding arrives; the local confirmation yields to it.
  await act(async () => {
    rerender(
      <MenuHost
        session={session({ resident: residentInfo({ taskId: 'resident-1', status: 'running', blockedReason: 'already_resident' }) })}
        isProcessing
      />,
    );
  });
  const bound = screen.getByRole('menuitem', { name: /已设为常驻/ }) as HTMLButtonElement;
  expect(bound.disabled).toBe(true);

  // Deleting the task stops it, so the unbound projection arrives while the session is idle.
  await act(async () => {
    rerender(<MenuHost session={session({ resident: residentInfo() })} isProcessing={false} />);
  });
  expect((screen.getByRole('menuitem', { name: /设为常驻/ }) as HTMLButtonElement).disabled).toBe(true);

  // A later run makes the same session adoptable again — the local confirmation is not stuck.
  await act(async () => {
    rerender(<MenuHost session={session({ resident: residentInfo() })} isProcessing />);
  });
  const adoptAgain = screen.getByRole('menuitem', { name: /设为常驻/ }) as HTMLButtonElement;
  expect(adoptAgain.disabled).toBe(false);
  await act(async () => {
    fireEvent.click(adoptAgain);
  });
  expect(adoptCalls).toEqual(['session-1', 'session-1']);
});
