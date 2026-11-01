import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, test, vi } from 'vitest';

/**
 * TaskMaster is retired. A returning browser may still carry
 * `tasksEnabled: true` and a stored project selection, but neither may enable
 * the feature, call the installation/task/MCP endpoints, or subscribe to
 * TaskMaster websocket frames.
 */

const projectTaskmaster = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
const tasks = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
const mcpStatus = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
const installationStatus = vi.fn(async () => ({ ok: false, json: async () => ({}) }));

vi.mock('@/shared/api', () => ({
  api: {
    projectTaskmaster,
    browserUse: { settings: vi.fn() },
    taskmaster: { tasks, mcpStatus, installationStatus },
  },
}));

const AUTH = { user: { id: 1 }, token: 'token', isLoading: false };
vi.mock('@/modules/auth', () => ({
  useAuth: () => AUTH,
}));

const listeners = new Set<(event: unknown) => void>();
vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  }),
}));

const MIRROR_STORAGE_KEY = 'user-preferences';

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  projectTaskmaster.mockClear();
  tasks.mockClear();
  mcpStatus.mockClear();
  installationStatus.mockClear();
  listeners.clear();
});

test('a stored tasksEnabled=true still provides tasksEnabled=false and skips installation checks', async () => {
  localStorage.setItem(MIRROR_STORAGE_KEY, JSON.stringify({ tasksEnabled: true }));

  const {
    TasksSettingsProvider,
    useTasksSettings,
  } = await import('@/modules/task-master/context/TasksSettingsContext');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TasksSettingsProvider>{children}</TasksSettingsProvider>
  );
  const { result } = renderHook(() => useTasksSettings(), { wrapper });

  await waitFor(() => {
    assert.equal(result.current.isCheckingInstallation, false);
  });

  assert.equal(result.current.tasksEnabled, false);
  assert.equal(installationStatus.mock.calls.length, 0);
});

test('TaskMaster provider makes no project, task, MCP or websocket calls while closed', async () => {
  const {
    TaskMasterProvider,
    useTaskMaster,
  } = await import('@/modules/task-master/context/TaskMasterContext');

  const { result } = renderHook(() => useTaskMaster(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <TaskMasterProvider>{children}</TaskMasterProvider>
    ),
  });

  result.current.setCurrentProject({
    projectId: 'p1',
    displayName: 'p1',
    fullPath: '/tmp/p1',
    taskmaster: { hasTaskmaster: true },
  } as never);

  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(projectTaskmaster.mock.calls, []);
  assert.deepEqual(tasks.mock.calls, []);
  assert.deepEqual(mcpStatus.mock.calls, []);
  assert.equal(listeners.size, 0);
  assert.equal(result.current.currentProject, null);
});
