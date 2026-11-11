import { act, renderHook } from '@testing-library/react';
import type { KeyboardEvent, RefObject } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
import type { Project, SlashCommand } from '@/shared/types';

const { projectCommands, translate } = vi.hoisted(() => ({
  projectCommands: [] as SlashCommand[],
  // One stable `t` identity, because the hook memoizes on it; a fresh function
  // per render would recompute the command list in an endless effect loop.
  translate: (key: string) => key,
}));

vi.mock('@/shared/hooks/useProjectSlashCommands', () => ({
  useProjectSlashCommands: () => ({ commands: projectCommands, isLoading: false, error: false }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}));

const PROJECT = {
  projectId: 'project-1',
  name: 'Demo',
  displayName: 'Demo',
  fullPath: '/demo',
  path: '/demo',
} as Project;

const makeTextarea = () => {
  const textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  return { current: textarea } as RefObject<HTMLTextAreaElement>;
};

const renderSlashCommands = (input: string) => {
  const setInput = vi.fn();
  const onExecuteCommand = vi.fn();
  const textareaRef = makeTextarea();
  const hook = renderHook(
    ({ value }: { value: string }) => useSlashCommands({
      selectedProject: PROJECT,
      provider: 'claude',
      input: value,
      setInput,
      textareaRef,
      onExecuteCommand,
    }),
    { initialProps: { value: input } },
  );
  return { ...hook, setInput, onExecuteCommand };
};

const keyEvent = (key: string) => {
  const preventDefault = vi.fn();
  return {
    preventDefault,
    event: { key, preventDefault } as unknown as KeyboardEvent<HTMLTextAreaElement>,
  };
};

beforeEach(() => {
  projectCommands.length = 0;
  vi.clearAllMocks();
});

test('injects the local /todo command without waiting for the provider command list', () => {
  const { result } = renderSlashCommands('');

  const todo = result.current.slashCommands.find((command) => command.name === '/todo');
  expect(todo).toBeTruthy();
  expect(todo?.type).toBe('application');
  expect(todo?.metadata).toMatchObject({ application: true, local: true });
});

test('dedupes a same-name provider /todo in favour of the local command', () => {
  projectCommands.push({ name: '/todo', description: 'provider todo', type: 'custom' });

  const { result } = renderSlashCommands('');
  const matches = result.current.slashCommands.filter((command) => command.name === '/todo');

  expect(matches).toHaveLength(1);
  // The local command must win: it opens the project todo dialog, while a
  // provider command only knows how to run a turn.
  expect(matches[0].type).toBe('application');
  expect(matches[0].metadata).toMatchObject({ application: true, local: true });
});

test('Tab completes /todo into the input instead of executing it', () => {
  const { result, setInput, onExecuteCommand } = renderSlashCommands('/to');

  act(() => result.current.handleCommandInputChange('/to', 3));
  const { event, preventDefault } = keyEvent('Tab');
  act(() => {
    expect(result.current.handleCommandMenuKeyDown(event)).toBe(true);
  });

  expect(preventDefault).toHaveBeenCalled();
  expect(setInput).toHaveBeenCalledTimes(1);
  expect(String(setInput.mock.calls[0][0])).toContain('/todo ');
  expect(onExecuteCommand).not.toHaveBeenCalled();
});

test('clicking /todo in the menu only writes the prefix', () => {
  const { result, setInput, onExecuteCommand } = renderSlashCommands('');
  const todo = result.current.slashCommands.find((command) => command.name === '/todo')!;

  act(() => result.current.handleCommandSelect(todo, 0, false));

  expect(setInput).toHaveBeenCalledTimes(1);
  expect(String(setInput.mock.calls[0][0])).toContain('/todo ');
  expect(onExecuteCommand).not.toHaveBeenCalled();
});

test('a tail /todo line on Enter is handed to the composer before the query debounce', () => {
  const typed = '保留草稿\n/todo';
  const { result, onExecuteCommand } = renderSlashCommands(typed);

  // No timer advance: the 150 ms query debounce has not updated
  // `filteredCommands`, which still starts with /todo's application entry.
  act(() => result.current.handleCommandInputChange(typed, typed.length));
  const { event, preventDefault } = keyEvent('Enter');
  let handled: boolean | undefined;
  act(() => {
    handled = result.current.handleCommandMenuKeyDown(event);
  });

  expect(handled).toBe(false);
  expect(preventDefault).not.toHaveBeenCalled();
  expect(onExecuteCommand).not.toHaveBeenCalled();
  expect(result.current.showCommandMenu).toBe(false);
});

test('a fast Enter on a provider /help still executes it, not the stale first row', () => {
  projectCommands.push({ name: '/help', description: 'Show help', type: 'custom' });
  const typed = 'What does /help';
  const { result, onExecuteCommand } = renderSlashCommands(typed);

  act(() => result.current.handleCommandInputChange(typed, typed.length));
  const { event, preventDefault } = keyEvent('Enter');
  act(() => {
    result.current.handleCommandMenuKeyDown(event);
  });

  expect(preventDefault).toHaveBeenCalled();
  // The stale list starts with the /todo application entry; the typed word wins.
  expect(onExecuteCommand).toHaveBeenCalledTimes(1);
  expect(onExecuteCommand.mock.calls[0][0]).toMatchObject({ name: '/help' });
});

test('a fast Tab completes the typed provider command, not the stale first row', () => {
  projectCommands.push({ name: '/help', description: 'Show help', type: 'custom' });
  const typed = '/hel';
  const { result, setInput, onExecuteCommand } = renderSlashCommands(typed);

  act(() => result.current.handleCommandInputChange(typed, typed.length));
  const { event } = keyEvent('Tab');
  act(() => {
    result.current.handleCommandMenuKeyDown(event);
  });

  expect(setInput).toHaveBeenCalledTimes(1);
  expect(String(setInput.mock.calls[0][0])).toContain('/help ');
  expect(String(setInput.mock.calls[0][0])).not.toContain('/todo');
  expect(onExecuteCommand).not.toHaveBeenCalled();
});

test('Arrow selection indexes the live matches before the query debounce', () => {
  projectCommands.push(
    { name: '/review', description: 'Review', type: 'custom' },
    { name: '/run', description: 'Run', type: 'custom' },
  );
  const typed = '/r';
  const { result, onExecuteCommand } = renderSlashCommands(typed);

  act(() => result.current.handleCommandInputChange(typed, typed.length));
  // Both presses happen before the debounced query reaches `filteredCommands`.
  act(() => {
    result.current.handleCommandMenuKeyDown(keyEvent('ArrowDown').event);
    result.current.handleCommandMenuKeyDown(keyEvent('ArrowDown').event);
  });
  const { event, preventDefault } = keyEvent('Enter');
  act(() => {
    result.current.handleCommandMenuKeyDown(event);
  });

  expect(preventDefault).toHaveBeenCalled();
  expect(onExecuteCommand).toHaveBeenCalledTimes(1);
  expect(onExecuteCommand.mock.calls[0][0]).toMatchObject({ name: '/run' });
});

test('Enter on the exact /todo command is left to the composer submit', () => {
  const { result, onExecuteCommand } = renderSlashCommands('/todo');

  act(() => result.current.handleCommandInputChange('/todo', 5));
  const { event, preventDefault } = keyEvent('Enter');
  let handled: boolean | undefined;
  act(() => {
    handled = result.current.handleCommandMenuKeyDown(event);
  });

  expect(handled).toBe(false);
  expect(preventDefault).not.toHaveBeenCalled();
  expect(onExecuteCommand).not.toHaveBeenCalled();
  // The completion menu is closed so the composer's Enter is not reintercepted.
  expect(result.current.showCommandMenu).toBe(false);
});
